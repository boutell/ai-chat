import db from '../db.js';
import { getSelectedModelPath } from '../lib/model-selector.js';
import { chatStream, chatComplete } from '../lib/llm.js';
import { isAvailable as isContainerAvailable, runCode } from '../lib/container.js';

function extractPython(text) {
  const fenceMatch = text.match(/```(?:python)?\s*\n([\s\S]*?)```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return text.trim();
}

async function chatsPlugin(fastify, opts) {
  // List all chats (most recent first)
  fastify.get('/', async (request, reply) => {
    const chats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
    return chats;
  });

  // Create a new chat
  fastify.post('/', {
    schema: {
      body: {
        type: 'object',
        properties: {
          title: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const title = request.body.title;
    const result = db.prepare('INSERT INTO chats (title) VALUES (?)').run(title || 'New Chat');
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(result.lastInsertRowid);
    return reply.code(201).send(chat);
  });

  // Get a chat with its messages
  fastify.get('/:id', async (request, reply) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(request.params.id);
    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(request.params.id);
    return { ...chat, messages };
  });

  // Delete a chat
  fastify.delete('/:id', async (request, reply) => {
    const result = db.prepare('DELETE FROM chats WHERE id = ?').run(request.params.id);
    if (result.changes === 0) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
    return { success: true };
  });

  // Update chat title
  fastify.patch('/:id', {
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const title = request.body.title;
    db.prepare('UPDATE chats SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(title, request.params.id);
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(request.params.id);
    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }
    return chat;
  });

  // Send a message and stream assistant response
  fastify.post('/:id/messages', {
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request, reply) => {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(request.params.id);
    if (!chat) {
      return reply.code(404).send({ error: 'Chat not found' });
    }

    const content = request.body.content;

    // Save user message
    db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(request.params.id, 'user', content);
    db.prepare('UPDATE chats SET updated_at = datetime(\'now\') WHERE id = ?').run(request.params.id);

    // Build message history
    const messages = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(request.params.id);

    const containerAvailable = await isContainerAvailable();

    let systemContent;
    if (containerAvailable) {
      systemContent = 'Generate a Python program to answer the user\'s prompt. The Python program should print its response, not return it. Do not output anything else. There is no display or GUI. All output must be printed as text. Available packages: numpy, pandas, sympy, scipy, beautifulsoup4, requests, and all Python standard library modules.';
    } else {
      systemContent = 'You are a helpful AI assistant.';
    }
    const systemMessage = { role: 'system', content: systemContent };

    const modelPath = getSelectedModelPath();
    if (!modelPath) {
      return reply.code(503).send({ error: 'No model selected. Please run auto-select first.' });
    }

    // Set up SSE — hijack the response so Fastify doesn't manage it
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const abortController = new AbortController();
    let clientDisconnected = false;

    res.on('close', () => {
      clientDisconnected = true;
      abortController.abort();
    });

    try {
      if (containerAvailable) {
        // Code-first path: model generates Python, we run it
        await codeFirstPath(res, systemMessage, messages, modelPath, abortController, () => clientDisconnected);
      } else {
        // Plain chat path: regular streaming
        await plainChatPath(res, systemMessage, messages, modelPath, abortController, () => clientDisconnected);
      }

      // Save the response
      const fullResponse = res._codeFirstOutput || res._plainChatOutput || '';
      db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(request.params.id, 'assistant', fullResponse);
      db.prepare('UPDATE chats SET updated_at = datetime(\'now\') WHERE id = ?').run(request.params.id);

      const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ? AND role = \'assistant\'').get(request.params.id);
      if (messageCount.count === 1 && chat.title === 'New Chat') {
        generateTitle(request.params.id, content, fullResponse, modelPath);
      }

      if (!clientDisconnected) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      if (err.name === 'AbortError' || clientDisconnected) {
        // Client disconnected — do nothing
      } else {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  });
}

const MAX_RETRIES = 2;

async function codeFirstPath(res, systemMessage, messages, modelPath, abortController, isDisconnected) {
  let retries = 0;
  let conversationMessages = [systemMessage, ...messages];

  while (retries <= MAX_RETRIES) {
    // Signal phase
    if (!isDisconnected()) {
      const phase = retries === 0 ? 'generating' : 'retrying';
      res.write(`data: ${JSON.stringify({ phase })}\n\n`);
    }

    // Collect the model's full response (which should be Python code)
    let fullResponse = '';
    await chatStream(modelPath, conversationMessages, {
      onTextChunk: (chunk) => {
        if (!isDisconnected()) {
          fullResponse += chunk;
          res.write(`data: ${JSON.stringify({ codeToken: chunk })}\n\n`);
        }
      },
      signal: abortController.signal
    });

    const code = extractPython(fullResponse);

    // Run the code
    if (!isDisconnected()) {
      res.write(`data: ${JSON.stringify({ phase: 'running' })}\n\n`);
    }

    const result = await runCode('python', code);
    const hasError = result.exitCode !== 0;

    if (hasError && retries < MAX_RETRIES) {
      // Retry: add the error as context and loop
      retries++;
      const stderr = result.stderr || '(no output)';
      let errorFeedback = `The code produced an error:\n${stderr}\n`;
      if (stderr.includes('ModuleNotFoundError') || stderr.includes('ImportError')) {
        errorFeedback += 'That module is not installed. Do not use it. Use only print() and built-in Python modules. Generate the corrected Python program.';
      } else {
        errorFeedback += 'Please fix the code and try again. Generate only the corrected Python program.';
      }
      conversationMessages = [
        ...conversationMessages,
        { role: 'assistant', content: fullResponse },
        { role: 'user', content: errorFeedback }
      ];
      continue;
    }

    // Send final result
    if (!isDisconnected()) {
      res.write(`data: ${JSON.stringify({
        result: {
          code,
          output: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode
        }
      })}\n\n`);
    }

    // The visible response is the program's printed output
    res._codeFirstOutput = result.stdout || result.stderr || '';
    return;
  }
}

async function plainChatPath(res, systemMessage, messages, modelPath, abortController, isDisconnected) {
  let fullResponse = '';

  await chatStream(modelPath, [systemMessage, ...messages], {
    onTextChunk: (chunk) => {
      if (!isDisconnected()) {
        fullResponse += chunk;
        res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
      }
    },
    signal: abortController.signal
  });

  res._plainChatOutput = fullResponse;
}

// Auto-generate chat title (fire-and-forget)
async function generateTitle(chatId, userMessage, assistantMessage, modelPath) {
  try {
    const title = await chatComplete(modelPath, [
      {
        role: 'system',
        content: 'Generate a short title (3-6 words) for this conversation. Reply with ONLY the title, no quotes or punctuation.'
      },
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantMessage.substring(0, 500) },
      { role: 'user', content: 'Generate a short title for this conversation.' }
    ]);
    const trimmed = title.trim().substring(0, 100);
    if (trimmed) {
      db.prepare('UPDATE chats SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(trimmed, chatId);
    }
  } catch {
    // title generation is best-effort
  }
}

export { extractPython };
export default chatsPlugin;
