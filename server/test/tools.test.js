import assert from 'assert';
import supertest from 'supertest';
import buildApp from '../app.js';
import db from '../db.js';
import { listLocalModels, _setChatStreamOverride } from '../lib/llm.js';
import { _setIsAvailableOverride, _setRunCodeOverride } from '../lib/container.js';
import { _setIsAvailableOverride as setWebSearchAvailableOverride } from '../lib/web-search.js';
import { extractPython } from '../routes/chats.js';

let app;
let request;

let testModelId = null;

before(async function () {
  this.timeout(30000);
  app = await buildApp();
  await app.ready();
  request = supertest(app.server);

  const models = listLocalModels();
  if (models.length > 0) {
    testModelId = models[0].name;
  }
});

after(async function () {
  if (app) {
    await app.close();
  }
});

function parseSSE(body) {
  return body.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6));
}

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
// extractPython
// ──────────────────────────────────────────────

describe('extractPython', function () {
  it('strips ```python fences', function () {
    const input = '```python\nprint(42)\n```';
    assert.strictEqual(extractPython(input), 'print(42)');
  });

  it('strips bare ``` fences', function () {
    const input = '```\nprint(42)\n```';
    assert.strictEqual(extractPython(input), 'print(42)');
  });

  it('returns trimmed text when no fences', function () {
    assert.strictEqual(extractPython('  print(42)  '), 'print(42)');
  });

  it('handles multiline code in fences', function () {
    const input = '```python\nx = 2\nprint(x * 3)\n```';
    assert.strictEqual(extractPython(input), 'x = 2\nprint(x * 3)');
  });
});

// ──────────────────────────────────────────────
// Container module
// ──────────────────────────────────────────────

describe('Container module', function () {
  afterEach(function () {
    _setIsAvailableOverride(null);
    _setRunCodeOverride(null);
  });

  it('isAvailable override controls availability', async function () {
    const { isAvailable } = await import('../lib/container.js');

    _setIsAvailableOverride(() => true);
    assert.strictEqual(await isAvailable(), true);

    _setIsAvailableOverride(() => false);
    assert.strictEqual(await isAvailable(), false);

    _setIsAvailableOverride(null);
  });

  it('runCode override intercepts execution', async function () {
    const { runCode } = await import('../lib/container.js');

    _setRunCodeOverride(async (language, code) => {
      return { stdout: `mock: ${language} ${code}`, stderr: '', exitCode: 0, timedOut: false };
    });

    const result = await runCode('python', 'print(42)');
    assert.strictEqual(result.stdout, 'mock: python print(42)');
    assert.strictEqual(result.exitCode, 0);
  });
});

// ──────────────────────────────────────────────
// Tools status API
// ──────────────────────────────────────────────

describe('Tools status API', function () {
  afterEach(function () {
    _setIsAvailableOverride(null);
    setWebSearchAvailableOverride(null);
  });

  it('returns containerAvailable from /api/tools/status', async function () {
    _setIsAvailableOverride(() => true);
    const res = await request.get('/api/tools/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.containerAvailable, true);
  });
});

// ──────────────────────────────────────────────
// Code-first SSE pipeline
// ──────────────────────────────────────────────

describe('Code-first SSE pipeline', function () {
  beforeEach(function () {
    db.exec('DELETE FROM messages');
    db.exec('DELETE FROM chats');
    db.exec('DELETE FROM settings');
    if (testModelId) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('selected_model', testModelId);
    }
  });

  afterEach(function () {
    _setChatStreamOverride(null);
    _setIsAvailableOverride(null);
    _setRunCodeOverride(null);
  });

  it('generates code, runs it, and streams result events', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async (language, code) => {
      return { stdout: '4\n', stderr: '', exitCode: 0, timedOut: false };
    });

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      const code = 'print(2+2)';
      onTextChunk(code);
      return code;
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'What is 2+2?' });

    assert.strictEqual(res.status, 200);

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    // Should have phase events
    const phases = parsed.filter(e => e.phase);
    assert.ok(phases.some(p => p.phase === 'generating'), 'Should have generating phase');
    assert.ok(phases.some(p => p.phase === 'running'), 'Should have running phase');

    // Should have codeToken events
    const codeTokens = parsed.filter(e => e.codeToken);
    assert.ok(codeTokens.length > 0, 'Should have codeToken events');

    // Should have result event
    const results = parsed.filter(e => e.result);
    assert.strictEqual(results.length, 1, 'Should have exactly one result event');
    assert.strictEqual(results[0].result.code, 'print(2+2)');
    assert.strictEqual(results[0].result.output, '4\n');
    assert.strictEqual(results[0].result.exitCode, 0);

    // Persisted message should be the output
    const savedMessages = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND role = ?').all(chat.id, 'assistant');
    assert.strictEqual(savedMessages[0].content, '4\n');

    assert.ok(events.includes('[DONE]'), 'Stream should end with [DONE]');
  });

  it('retries on syntax error then succeeds', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);

    let callCount = 0;
    _setRunCodeOverride(async (language, code) => {
      callCount++;
      if (callCount === 1) {
        return { stdout: '', stderr: 'SyntaxError: invalid syntax', exitCode: 1, timedOut: false };
      }
      return { stdout: '4\n', stderr: '', exitCode: 0, timedOut: false };
    });

    let streamCallCount = 0;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      streamCallCount++;
      if (streamCallCount === 1) {
        const code = 'print(2+';
        onTextChunk(code);
        return code;
      }
      const code = 'print(2+2)';
      onTextChunk(code);
      return code;
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'What is 2+2?' });

    assert.strictEqual(res.status, 200);

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    // Should have retrying phase
    const phases = parsed.filter(e => e.phase);
    assert.ok(phases.some(p => p.phase === 'retrying'), 'Should have retrying phase');

    // Final result should be successful
    const results = parsed.filter(e => e.result);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].result.output, '4\n');
    assert.strictEqual(results[0].result.exitCode, 0);
  });

  it('falls back to plain chat when no container', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      onTextChunk('Hello there!');
      return 'Hello there!';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Hello' });

    assert.strictEqual(res.status, 200);

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    // Should have token events (plain chat), no phase/codeToken/result
    const tokens = parsed.filter(e => e.token);
    assert.ok(tokens.length > 0, 'Should have token events');
    assert.strictEqual(parsed.filter(e => e.phase).length, 0, 'Should not have phase events');
    assert.strictEqual(parsed.filter(e => e.codeToken).length, 0, 'Should not have codeToken events');
    assert.strictEqual(parsed.filter(e => e.result).length, 0, 'Should not have result events');
  });

  it('uses code-first system prompt when container available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async () => {
      return { stdout: 'OK\n', stderr: '', exitCode: 0, timedOut: false };
    });

    let capturedMessages = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      if (!capturedMessages) {
        capturedMessages = messages;
      }
      onTextChunk('print("OK")');
      return 'print("OK")';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(systemMsg.content.includes('Generate a Python program'), 'System prompt should instruct code generation');
    assert.ok(systemMsg.content.includes('print'), 'System prompt should mention print');
  });

  it('uses plain system prompt when container unavailable', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);

    let capturedMessages = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      if (!capturedMessages) {
        capturedMessages = messages;
      }
      onTextChunk('OK');
      return 'OK';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(systemMsg.content.includes('helpful AI assistant'), 'System prompt should be plain assistant');
    assert.ok(!systemMsg.content.includes('Python'), 'System prompt should NOT mention Python');
  });
});
