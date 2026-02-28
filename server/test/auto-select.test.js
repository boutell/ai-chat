// Set up in-memory DB before any app imports
process.env.AI_CHAT_DB = ':memory:';

const assert = require('assert');
const supertest = require('supertest');
const buildApp = require('../app');
const db = require('../db');
const { MODEL_TIERS } = require('../lib/model-selector');
const { OLLAMA_BASE } = require('../lib/ollama');

let app;
let request;

let ollamaAvailable = false;

before(async function () {
  this.timeout(10000);
  app = await buildApp();
  await app.ready();
  request = supertest(app.server);

  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (res.ok) {
      const data = await res.json();
      const models = (data.models || []).map(m => m.name);
      ollamaAvailable = models.length > 0;
    }
  } catch {
    // ollama not running
  }
  if (!ollamaAvailable) {
    console.log('  ⚠ ollama not available — auto-select tests will be skipped');
  }
});

after(async function () {
  if (app) {
    await app.close();
  }
});

// Helper: mock global.fetch
function mockFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => { global.fetch = original; };
}

// Helper to parse SSE events from the response text
function parseSSEEvents(text) {
  const events = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') {
        continue;
      }
      try {
        events.push(JSON.parse(data));
      } catch {
        // skip malformed
      }
    }
  }
  return events;
}

describe('POST /api/models/auto-select', function () {
  beforeEach(function () {
    db.exec('DELETE FROM settings');
  });

  it('auto-selects a model from real ollama and speed-tests it', async function () {
    if (!ollamaAvailable) {
      return this.skip();
    }
    this.timeout(300000);

    const res = await request.post('/api/models/auto-select')
      .buffer(true)
      .parse((res, cb) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => cb(null, data));
      });
    assert.strictEqual(res.status, 200);

    const events = parseSSEEvents(res.body);
    const ramEvent = events.find(e => e.step === 'ram');
    const resultEvent = events.find(e => e.step === 'result');

    assert.ok(ramEvent, 'Should have a ram detection event');
    assert.ok(ramEvent.ramGB > 0, 'Should report system RAM');
    assert.ok(resultEvent, 'Should have a result event');
    assert.ok(resultEvent.model, 'Should return a selected model name');

    // The selected model should be appropriate for this machine's RAM
    const ramGB = ramEvent.ramGB;
    const expectedTier = MODEL_TIERS.find(t => ramGB >= t.minRam);
    const tierIndex = MODEL_TIERS.findIndex(t => t.model === resultEvent.model);
    const expectedIndex = MODEL_TIERS.findIndex(t => t.model === expectedTier.model);
    assert.ok(tierIndex >= expectedIndex,
      `Selected ${resultEvent.model} but expected ${expectedTier.model} or a smaller fallback for ${ramGB}GB RAM`);

    // Should have persisted the selection
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
    assert.strictEqual(row.value, resultEvent.model);

    // Speed info should be present (unless last-resort fallback)
    if (resultEvent.speed) {
      assert.ok(resultEvent.speed.tokensPerSecond > 0, 'Speed test should report tokens/sec');
    }
  });

  it('streams error when ollama is completely unreachable', async function () {
    const restore = mockFetch(async () => {
      throw new Error('Connection refused');
    });

    try {
      const res = await request.post('/api/models/auto-select')
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => cb(null, data));
        });
      assert.strictEqual(res.status, 200);
      const events = parseSSEEvents(res.body);
      const errorEvent = events.find(e => e.error);
      assert.ok(errorEvent, 'Should have an error event');
    } finally {
      restore();
    }
  });

  it('streams error when all model pulls fail', async function () {
    this.timeout(5000);

    const restore = mockFetch(async (url) => {
      if (url.includes('/api/tags')) {
        return { ok: true, json: async () => ({ models: [] }) };
      }
      if (url.includes('/api/pull')) {
        return { ok: false, text: async () => 'pull failed' };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      const res = await request.post('/api/models/auto-select')
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => cb(null, data));
        });
      assert.strictEqual(res.status, 200);
      const events = parseSSEEvents(res.body);
      const errorEvent = events.find(e => e.error);
      assert.ok(errorEvent, 'Should have an error event');
    } finally {
      restore();
    }
  });
});
