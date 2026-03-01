import assert from 'assert';
import supertest from 'supertest';
import buildApp from '../app.js';
import db from '../db.js';
import { MODEL_TIERS } from '../lib/model-selector.js';
import { listLocalModels, _setChatStreamOverride, _setDownloadModelOverride } from '../lib/llm.js';

let app;
let request;

let modelsAvailable = false;

before(async function () {
  this.timeout(10000);
  app = await buildApp();
  await app.ready();
  request = supertest(app.server);

  const models = listLocalModels();
  modelsAvailable = models.length > 0;

  if (!modelsAvailable) {
    console.log('  ⚠ no local models — auto-select tests will be skipped');
  }
});

after(async function () {
  this.timeout(30000);
  if (app) {
    await app.close();
  }
});

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

  it('auto-selects a model and speed-tests it', async function () {
    if (!modelsAvailable) {
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

    // Should have persisted the selection
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('selected_model');
    assert.ok(row.value, 'Should have saved a model path');

    // Speed info should be present (unless last-resort fallback)
    if (resultEvent.speed) {
      assert.ok(resultEvent.speed.tokensPerSecond > 0, 'Speed test should report tokens/sec');
    }
  });

  it('emits ram detection and completes even when speed tests fail', async function () {
    this.timeout(30000);

    // Mock chat to simulate speed test failure
    _setChatStreamOverride(async () => {
      throw new Error('Speed test failed');
    });
    _setDownloadModelOverride(async () => {
      throw new Error('Download failed');
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
      const ramEvent = events.find(e => e.step === 'ram');
      assert.ok(ramEvent, 'Should have a ram detection event');
      assert.ok(ramEvent.ramGB > 0, 'Should report system RAM');

      // Either an error (no models to fall back to) or a result (existing model used as last resort)
      const hasOutcome = events.some(e => e.step === 'result' || e.error);
      assert.ok(hasOutcome, 'Should have either a result or error event');
    } finally {
      _setChatStreamOverride(null);
      _setDownloadModelOverride(null);
    }
  });
});
