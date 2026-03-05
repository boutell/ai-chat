import db from '../db.js';
import { getSelectedModelPath } from '../lib/model-selector.js';
import { chatStream, chatComplete } from '../lib/llm.js';
import { getChatFunctions } from '../lib/tools.js';
import { isAvailable as isContainerAvailable } from '../lib/container.js';
import { isAvailable as isWebSearchAvailable } from '../lib/web-search.js';

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

    const now = new Date();
    const dayOfWeek = now.toLocaleDateString('en-US', { weekday: 'long' });
    const containerAvailable = await isContainerAvailable();
    const webSearchAvailable = isWebSearchAvailable();
    let systemContent = `You are a helpful AI assistant. The day of the week is ${dayOfWeek}. The current date and time is ${now.toLocaleString()}. Be concise and helpful.`;
    if (containerAvailable) {
      systemContent += `
You have access to a run_code tool that executes code in a sandboxed container. ALWAYS use it for any math beyond trivial arithmetic — multiplication, division, exponents, algebra, unit conversions, etc. Never guess at calculations. Also use it for data processing, code verification, or any task where running code would produce a more accurate answer. Available languages: python, javascript, bash. The container has no network access.
Rules for generated code:
- Code MUST print all output to the console (use print() in Python, console.log() in JavaScript, echo in bash). Code runs as a script, not a REPL — bare expressions produce no output.
- Solve the entire problem in a SINGLE tool call whenever possible. For example, if asked to calculate totals AND draw a chart, do both in one script, not two separate calls.
- Only built-in standard library modules are available. Do NOT import third-party packages (no pandas, numpy, matplotlib, requests, etc.). Use only modules that ship with Python, Node.js, or bash.`;
    }
    if (webSearchAvailable) {
      systemContent += '\nYou have access to a web_search tool for looking up current information, facts, news, or anything you\'re unsure about. Use it when the question involves recent events, specific data you might not know, or when accuracy matters.';
    }
    if (containerAvailable || webSearchAvailable) {
      systemContent += '\nIMPORTANT: After running code, ALWAYS use show_output to display the results to the user. NEVER copy, retype, or recreate tool output in your response — that is slow and error-prone. Instead, call show_output with format "code" and then add your commentary. This applies to ALL tool output: calculations, tables, charts, ASCII art, data, etc. The show_output tool displays results instantly and perfectly.';
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
      let fullResponse = '';

      // Set up tool functions if any tools are available
      const onToolEvent = (event) => {
        if (clientDisconnected) {
          return;
        }
        if (event.type === 'toolCall') {
          if (event.name === 'run_code') {
            res.write(`data: ${JSON.stringify({ toolCall: { name: event.name, language: event.language, code: event.code } })}\n\n`);
          } else if (event.name === 'web_search') {
            res.write(`data: ${JSON.stringify({ toolCall: { name: event.name, query: event.query } })}\n\n`);
          }
        } else if (event.type === 'toolResult') {
          if (event.name === 'run_code') {
            res.write(`data: ${JSON.stringify({ toolResult: { name: event.name, output: event.output, stderr: event.stderr, exitCode: event.exitCode, timedOut: event.timedOut } })}\n\n`);
          } else if (event.name === 'web_search') {
            res.write(`data: ${JSON.stringify({ toolResult: { name: event.name, results: event.results, answer: event.answer } })}\n\n`);
          }
        } else if (event.type === 'inject') {
          fullResponse += event.text;
          res.write(`data: ${JSON.stringify({ inject: event.text })}\n\n`);
        }
      };
      const functions = (containerAvailable || webSearchAvailable) ? await getChatFunctions(onToolEvent) : undefined;

      await chatStream(modelPath, [systemMessage, ...messages], {
        onTextChunk: (chunk) => {
          if (!clientDisconnected) {
            fullResponse += chunk;
            res.write(`data: ${JSON.stringify({ token: chunk })}\n\n`);
          }
        },
        signal: abortController.signal,
        functions
      });

      // Save the complete response
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

export default chatsPlugin;
