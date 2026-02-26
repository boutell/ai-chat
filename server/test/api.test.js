// Set up in-memory DB before any app imports
process.env.AI_CHAT_DB = ':memory:';

const assert = require('assert');
const supertest = require('supertest');
const app = require('../app');
const db = require('../db');
const { OLLAMA_BASE, MODEL_TIERS, getSystemRamGB } = require('../lib/model-selector');

const request = supertest(app);

// Probe ollama once at startup
let ollamaAvailable = false;
let availableModels = [];
let testModel = null;

before(async function () {
  this.timeout(10000);
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      availableModels = (data.models || []).map(m => m.name);
      ollamaAvailable = availableModels.length > 0;
      if (ollamaAvailable) {
        // Pick the smallest available model for tests
        testModel = availableModels.sort((a, b) => a.length - b.length)[0];
        // Pre-select it so message tests can use it
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModel);
      }
    }
  } catch {
    // ollama not running
  }
  if (!ollamaAvailable) {
    console.log('  ⚠ ollama not available — some tests will be skipped');
  } else {
    console.log(`  ✓ ollama available, using model: ${testModel}`);
  }
});

// Helper: mock global.fetch (only used for failure-scenario tests)
function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

// Helper: create a readable stream of newline-delimited JSON
function makeOllamaStream(chunks) {
  const encoder = new TextEncoder();
  const data = chunks.map(c => encoder.encode(JSON.stringify(c) + '\n'));
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < data.length) {
        controller.enqueue(data[i++]);
      } else {
        controller.close();
      }
    }
  });
}

// Helper: parse SSE body text into an array of data payloads
function parseSSE(body) {
  return body.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6));
}

// Helper: supertest SSE request (buffers full response)
function sseRequest(url) {
  return request
    .post(url)
    .buffer(true)
    .parse((res, cb) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => cb(null, data));
    });
}

// ──────────────────────────────────────────────
// Chat CRUD — no ollama needed
// ──────────────────────────────────────────────

describe('Chat CRUD API', function () {
  beforeEach(function () {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM chats');
    db.exec('DELETE FROM settings');
  });

  describe('POST /api/chats', function () {
    it('creates a new chat with default title', async function () {
      const res = await request.post('/api/chats').send({});
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.title, 'New Chat');
      assert.ok(res.body.id);
    });

    it('creates a chat with a custom title', async function () {
      const res = await request.post('/api/chats').send({ title: 'My Chat' });
      assert.strictEqual(res.status, 201);
      assert.strictEqual(res.body.title, 'My Chat');
    });
  });

  describe('GET /api/chats', function () {
    it('returns empty array when no chats exist', async function () {
      const res = await request.get('/api/chats');
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body, []);
    });

    it('returns chats sorted by most recent first', async function () {
      const first = (await request.post('/api/chats').send({ title: 'First' })).body;
      db.prepare("UPDATE chats SET updated_at = datetime('now', '-1 minute') WHERE id = ?").run(first.id);
      await request.post('/api/chats').send({ title: 'Second' });
      const res = await request.get('/api/chats');
      assert.strictEqual(res.body.length, 2);
      assert.strictEqual(res.body[0].title, 'Second');
      assert.strictEqual(res.body[1].title, 'First');
    });
  });

  describe('GET /api/chats/:id', function () {
    it('returns chat with its messages', async function () {
      const chat = (await request.post('/api/chats').send({})).body;
      db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(chat.id, 'user', 'hello');

      const res = await request.get(`/api/chats/${chat.id}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.id, chat.id);
      assert.strictEqual(res.body.messages.length, 1);
      assert.strictEqual(res.body.messages[0].content, 'hello');
    });

    it('returns 404 for nonexistent chat', async function () {
      const res = await request.get('/api/chats/9999');
      assert.strictEqual(res.status, 404);
    });
  });

  describe('PATCH /api/chats/:id', function () {
    it('updates chat title', async function () {
      const chat = (await request.post('/api/chats').send({})).body;
      const res = await request.patch(`/api/chats/${chat.id}`).send({ title: 'Updated' });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.title, 'Updated');
    });

    it('returns 400 without title', async function () {
      const chat = (await request.post('/api/chats').send({})).body;
      const res = await request.patch(`/api/chats/${chat.id}`).send({});
      assert.strictEqual(res.status, 400);
    });
  });

  describe('DELETE /api/chats/:id', function () {
    it('deletes a chat and its messages', async function () {
      const chat = (await request.post('/api/chats').send({})).body;
      db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)').run(chat.id, 'user', 'hello');

      const res = await request.delete(`/api/chats/${chat.id}`);
      assert.strictEqual(res.status, 200);

      const get = await request.get(`/api/chats/${chat.id}`);
      assert.strictEqual(get.status, 404);

      // Messages should be cascade-deleted
      const msgs = db.prepare('SELECT * FROM messages WHERE chat_id = ?').all(chat.id);
      assert.strictEqual(msgs.length, 0);
    });

    it('returns 404 for nonexistent chat', async function () {
      const res = await request.delete('/api/chats/9999');
      assert.strictEqual(res.status, 404);
    });
  });
});

// ──────────────────────────────────────────────
// Message streaming — real ollama
// ──────────────────────────────────────────────

describe('Message streaming (POST /api/chats/:id/messages)', function () {
  beforeEach(function () {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM chats');
    db.exec('DELETE FROM settings');
    if (testModel) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModel);
    }
  });

  it('saves user message and streams real assistant response via ollama', async function () {
    if (!ollamaAvailable) return this.skip();
    this.timeout(120000);

    const chat = (await request.post('/api/chats').send({})).body;

    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Reply with exactly the word "hello" and nothing else.' });

    assert.strictEqual(res.status, 200);

    const events = parseSSE(res.body);

    // Must have token events and a [DONE] terminator
    assert.ok(events.includes('[DONE]'), 'Stream should end with [DONE]');

    const tokens = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(e => e && e.token);
    assert.ok(tokens.length > 0, 'Should have received token events');

    // Full response should be concatenated tokens
    const fullText = tokens.map(t => t.token).join('');
    assert.ok(fullText.length > 0, `Expected non-empty response, got: "${fullText}"`);

    // Verify DB persistence
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at').all(chat.id);
    assert.strictEqual(messages.length, 2, 'Should have user + assistant messages');
    assert.strictEqual(messages[0].role, 'user');
    assert.strictEqual(messages[0].content, 'Reply with exactly the word "hello" and nothing else.');
    assert.strictEqual(messages[1].role, 'assistant');
    assert.strictEqual(messages[1].content, fullText);
  });

  it('returns 404 for nonexistent chat', async function () {
    const res = await request
      .post('/api/chats/9999/messages')
      .send({ content: 'hello' });
    assert.strictEqual(res.status, 404);
  });

  it('returns 400 when content is missing', async function () {
    const chat = (await request.post('/api/chats').send({})).body;
    const res = await request
      .post(`/api/chats/${chat.id}/messages`)
      .send({});
    assert.strictEqual(res.status, 400);
  });

  it('streams error gracefully when ollama is unreachable', async function () {
    this.timeout(5000);
    const chat = (await request.post('/api/chats').send({})).body;

    const restore = mockFetch(async () => {
      throw new Error('Connection refused');
    });

    try {
      const res = await sseRequest(`/api/chats/${chat.id}/messages`)
        .send({ content: 'test' });

      assert.strictEqual(res.status, 200); // SSE always starts 200
      assert.ok(res.body.includes('Connection refused'), 'Should report connection error');
      assert.ok(res.body.includes('[DONE]'), 'Should end with [DONE]');
    } finally {
      restore();
    }
  });
});

// ──────────────────────────────────────────────
// Model management — real ollama where possible
// ──────────────────────────────────────────────

describe('Model management API', function () {
  beforeEach(function () {
    db.exec('DELETE FROM settings');
  });

  describe('GET /api/models/status', function () {
    it('returns real ollama status and available models', async function () {
      if (!ollamaAvailable) return this.skip();

      const res = await request.get('/api/models/status');
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.ollamaConnected, true);
      assert.ok(Array.isArray(res.body.available), 'available should be an array');
      assert.ok(res.body.available.length > 0, 'Should list available models');
    });

    it('reports disconnected when ollama is unreachable', async function () {
      const restore = mockFetch(async () => {
        throw new Error('Connection refused');
      });

      try {
        const res = await request.get('/api/models/status');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.ollamaConnected, false);
        assert.deepStrictEqual(res.body.available, []);
      } finally {
        restore();
      }
    });
  });

  describe('GET /api/models/available', function () {
    it('lists models from real ollama', async function () {
      if (!ollamaAvailable) return this.skip();

      const res = await request.get('/api/models/available');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0);
      assert.ok(res.body[0].name, 'Each model should have a name');
    });
  });

  describe('POST /api/models/select', function () {
    it('sets the selected model and persists it', async function () {
      const modelName = testModel || 'some-model';
      const res = await request.post('/api/models/select').send({ model: modelName });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.selectedModel, modelName);

      // Verify persistence in DB
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
      assert.strictEqual(row.value, modelName);
    });

    it('returns 400 without model name', async function () {
      const res = await request.post('/api/models/select').send({});
      assert.strictEqual(res.status, 400);
    });
  });

  describe('POST /api/models/auto-select', function () {
    it('auto-selects a model from real ollama and speed-tests it', async function () {
      if (!ollamaAvailable) return this.skip();
      this.timeout(120000);

      const res = await request.post('/api/models/auto-select');
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.model, 'Should return a selected model name');
      assert.ok(res.body.ramGB > 0, 'Should report system RAM');

      // The selected model should be appropriate for this machine's RAM
      const ramGB = res.body.ramGB;
      const expectedTier = MODEL_TIERS.find(t => ramGB >= t.minRam);
      // It should either be the tier pick or a fallback (smaller)
      const tierIndex = MODEL_TIERS.findIndex(t => t.model === res.body.model);
      const expectedIndex = MODEL_TIERS.findIndex(t => t.model === expectedTier.model);
      assert.ok(tierIndex >= expectedIndex,
        `Selected ${res.body.model} but expected ${expectedTier.model} or a smaller fallback for ${ramGB}GB RAM`);

      // Should have persisted the selection
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
      assert.strictEqual(row.value, res.body.model);

      // Speed info should be present (unless last-resort fallback)
      if (res.body.speed) {
        assert.ok(res.body.speed.tokensPerSecond > 0, 'Speed test should report tokens/sec');
      }
    });

    it('returns 500 when ollama is completely unreachable', async function () {
      const restore = mockFetch(async () => {
        throw new Error('Connection refused');
      });

      try {
        const res = await request.post('/api/models/auto-select');
        assert.strictEqual(res.status, 500);
        assert.ok(res.body.error.includes('Auto-select failed'));
      } finally {
        restore();
      }
    });

    it('returns 500 when all model pulls fail', async function () {
      this.timeout(5000);

      const restore = mockFetch(async (url) => {
        if (url.includes('/api/tags')) {
          // No models locally available
          return { ok: true, json: async () => ({ models: [] }) };
        }
        if (url.includes('/api/pull')) {
          return { ok: false, text: async () => 'pull failed' };
        }
        throw new Error(`Unexpected fetch: ${url}`);
      });

      try {
        const res = await request.post('/api/models/auto-select');
        assert.strictEqual(res.status, 500);
        assert.ok(res.body.error, 'Should return an error message');
      } finally {
        restore();
      }
    });
  });
});
