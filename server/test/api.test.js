import assert from 'assert';
import supertest from 'supertest';
import buildApp from '../app.js';
import db from '../db.js';
import { getSystemRamGB, pathToModelId } from '../lib/model-selector.js';
import { listLocalModels, _setChatStreamOverride } from '../lib/llm.js';

let app;
let request;

// Probe for available local models at startup
let modelsAvailable = false;
let testModelPath = null;
let testModelId = null;

before(async function () {
  this.timeout(120000);
  app = await buildApp();
  await app.ready();
  request = supertest(app.server);

  // Check if any local models are available
  const models = listLocalModels();
  modelsAvailable = models.length > 0;

  if (modelsAvailable) {
    testModelPath = models[0].path;
    testModelId = models[0].name;
    // Pre-select it so message tests can use it
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModelId);
    console.log(`  ✓ local model available: ${testModelId}`);

    // Warm up the model
    try {
      await request.post('/api/chats').send({});
      const chat = db.prepare('SELECT * FROM chats ORDER BY id DESC LIMIT 1').get();
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModelId);
      const warmupRes = await request.post(`/api/chats/${chat.id}/messages`)
        .send({ content: 'hi' })
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => cb(null, data));
        });
      console.log(`  ✓ model warmed up`);
      // Clean up warmup chat
      db.exec('DELETE FROM messages');
      db.exec('DELETE FROM chats');
    } catch {
      // warmup is best-effort
    }
  } else {
    console.log('  ⚠ no local models — some tests will be skipped');
  }
});

after(async function () {
  if (app) {
    await app.close();
  }
});

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
// Chat CRUD — no model needed
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
// Message streaming — real local model
// ──────────────────────────────────────────────

describe('Message streaming (POST /api/chats/:id/messages)', function () {
  beforeEach(function () {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM chats');
    db.exec('DELETE FROM settings');
    if (testModelId) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModelId);
    }
  });

  it('saves user message and streams real assistant response', async function () {
    if (!modelsAvailable) {
      return this.skip();
    }
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

  it('returns 503 when selected model cannot be resolved', async function () {
    this.timeout(10000);
    const chat = (await request.post('/api/chats').send({})).body;

    // Set a model ID that doesn't correspond to any local file
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', 'nonexistent-model');

    const res = await request
      .post(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    assert.strictEqual(res.status, 503);
  });

  it('streams error gracefully when model fails to load', async function () {
    if (!modelsAvailable) {
      return this.skip();
    }
    this.timeout(10000);
    const chat = (await request.post('/api/chats').send({})).body;

    _setChatStreamOverride(async () => {
      throw new Error('Model failed to load');
    });

    try {
      const res = await sseRequest(`/api/chats/${chat.id}/messages`)
        .send({ content: 'test' });

      assert.strictEqual(res.status, 200); // SSE always starts 200
      assert.ok(res.body.includes('Model failed to load'), 'Should report model error');
      assert.ok(res.body.includes('[DONE]'), 'Should end with [DONE]');
    } finally {
      _setChatStreamOverride(null);
    }
  });
});

// ──────────────────────────────────────────────
// Model management
// ──────────────────────────────────────────────

describe('Model management API', function () {
  beforeEach(function () {
    db.exec('DELETE FROM settings');
  });

  describe('GET /api/models/status', function () {
    it('returns model status with id, name, and downloaded fields', async function () {
      const res = await request.get('/api/models/status');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body.available), 'available should be an array');
      // Should include tier models appropriate for this machine's RAM
      assert.ok(res.body.available.length > 0, 'should have at least one available model');
      assert.ok(res.body.available[0].id, 'each model should have an id');
      assert.ok(res.body.available[0].name, 'each model should have a name');
      assert.strictEqual(typeof res.body.available[0].downloaded, 'boolean', 'each model should have a downloaded flag');
    });
  });

  describe('GET /api/models/available', function () {
    it('lists available models with id, name, and downloaded', async function () {
      const res = await request.get('/api/models/available');
      assert.strictEqual(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0, 'should have at least one model');
      assert.ok(res.body[0].id, 'each model should have an id');
      assert.ok(res.body[0].name, 'each model should have a name');
      assert.strictEqual(typeof res.body[0].downloaded, 'boolean', 'each model should have a downloaded flag');
    });
  });

  describe('POST /api/models/select', function () {
    it('sets the selected model by ID and persists it', async function () {
      if (!testModelId) {
        return this.skip();
      }
      const res = await request.post('/api/models/select').send({ model: testModelId });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.selectedModel, testModelId);
      assert.ok(res.body.selectedModelName, 'should return a display name');

      // Verify persistence in DB
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
      assert.strictEqual(row.value, testModelId);
    });

    it('returns 404 for unknown model ID', async function () {
      const res = await request.post('/api/models/select').send({ model: 'nonexistent-model' });
      assert.strictEqual(res.status, 404);
    });

    it('returns 400 without model name', async function () {
      const res = await request.post('/api/models/select').send({});
      assert.strictEqual(res.status, 400);
    });
  });

});
