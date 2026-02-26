const express = require('express');
const router = express.Router();
const db = require('../db');
const { getSelectedModel, OLLAMA_BASE } = require('../lib/model-selector');

// List all chats (most recent first)
router.get('/', (req, res) => {
  const chats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
  res.json(chats);
});

// Create a new chat
router.post('/', (req, res) => {
  const { title } = req.body;
  const result = db.prepare('INSERT INTO chats (title) VALUES (?)').run(title || 'New Chat');
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(chat);
});

// Get a chat with its messages
router.get('/:id', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ ...chat, messages });
});

// Delete a chat
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Chat not found' });
  res.json({ success: true });
});

// Update chat title
router.patch('/:id', (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  db.prepare('UPDATE chats SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(title, req.params.id);
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  res.json(chat);
});

// Send a message and stream assistant response
router.post('/:id/messages', async (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Content is required' });

  // Save user message
  db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'user', content);
  db.prepare('UPDATE chats SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

  // Build message history
  const messages = db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(req.params.id);

  const now = new Date();
  const systemMessage = {
    role: 'system',
    content: `You are a helpful AI assistant. The current date and time is ${now.toLocaleString()}. Be concise and helpful.`
  };

  const model = getSelectedModel() || 'mistral-small-3.1';

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  try {
    const ollamaRes = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [systemMessage, ...messages],
        stream: true
      })
    });

    if (!ollamaRes.ok) {
      const errText = await ollamaRes.text();
      res.write(`data: ${JSON.stringify({ error: `Ollama error: ${errText}` })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    let fullResponse = '';
    const reader = ollamaRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message && json.message.content) {
            fullResponse += json.message.content;
            res.write(`data: ${JSON.stringify({ token: json.message.content })}\n\n`);
          }
          if (json.done) {
            // Save assistant message
            db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(req.params.id, 'assistant', fullResponse);
            db.prepare('UPDATE chats SET updated_at = datetime(\'now\') WHERE id = ?').run(req.params.id);

            // Auto-title after first assistant response
            const messageCount = db.prepare('SELECT COUNT(*) as count FROM messages WHERE chat_id = ? AND role = \'assistant\'').get(req.params.id);
            if (messageCount.count === 1 && chat.title === 'New Chat') {
              generateTitle(req.params.id, content, fullResponse, model);
            }

            res.write('data: [DONE]\n\n');
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }

    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Auto-generate chat title (fire-and-forget)
async function generateTitle(chatId, userMessage, assistantMessage, model) {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Generate a short title (3-6 words) for this conversation. Reply with ONLY the title, no quotes or punctuation.'
          },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantMessage.substring(0, 500) },
          { role: 'user', content: 'Generate a short title for this conversation.' }
        ],
        stream: false
      })
    });
    if (res.ok) {
      const data = await res.json();
      const title = data.message.content.trim().substring(0, 100);
      if (title) {
        db.prepare('UPDATE chats SET title = ?, updated_at = datetime(\'now\') WHERE id = ?').run(title, chatId);
      }
    }
  } catch {
    // title generation is best-effort
  }
}

module.exports = router;
