import assert from 'assert';
import supertest from 'supertest';
import buildApp from '../app.js';
import db from '../db.js';
import { listLocalModels, _setChatStreamOverride } from '../lib/llm.js';
import { _setIsAvailableOverride, _setRunCodeOverride } from '../lib/container.js';

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
// Tool calling SSE pipeline
// ──────────────────────────────────────────────

describe('Tool calling SSE pipeline', function () {
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

  it('streams toolCall and toolResult SSE events when tool is invoked', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    // Mock container as available
    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async (language, code) => {
      return { stdout: '4\n', stderr: '', exitCode: 0, timedOut: false };
    });

    // Mock chatStream to simulate the model calling run_code
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      onTextChunk('Let me calculate. ');

      // The model would call the function — simulate it
      if (functions && functions.run_code) {
        const result = await functions.run_code.handler({ language: 'python', code: 'print(2+2)' });
      }

      onTextChunk('The answer is 4.');
      return 'Let me calculate. The answer is 4.';
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

    // Should have token events
    const tokens = parsed.filter(e => e.token);
    assert.ok(tokens.length > 0, 'Should have token events');

    // Should have a toolCall event
    const toolCalls = parsed.filter(e => e.toolCall);
    assert.strictEqual(toolCalls.length, 1, 'Should have exactly one toolCall event');
    assert.strictEqual(toolCalls[0].toolCall.name, 'run_code');
    assert.strictEqual(toolCalls[0].toolCall.language, 'python');
    assert.strictEqual(toolCalls[0].toolCall.code, 'print(2+2)');

    // Should have a toolResult event
    const toolResults = parsed.filter(e => e.toolResult);
    assert.strictEqual(toolResults.length, 1, 'Should have exactly one toolResult event');
    assert.strictEqual(toolResults[0].toolResult.name, 'run_code');
    assert.strictEqual(toolResults[0].toolResult.output, '4\n');
    assert.strictEqual(toolResults[0].toolResult.exitCode, 0);

    // Should end with [DONE]
    assert.ok(events.includes('[DONE]'), 'Stream should end with [DONE]');
  });

  it('does not include tool events when container is unavailable', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    // Mock container as NOT available
    _setIsAvailableOverride(() => false);

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      // functions should be undefined when container is unavailable
      assert.ok(!functions, 'functions should not be provided when container is unavailable');
      onTextChunk('No tools here.');
      return 'No tools here.';
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

    // Should NOT have any tool events
    const toolCalls = parsed.filter(e => e.toolCall);
    assert.strictEqual(toolCalls.length, 0, 'Should have no toolCall events');

    const toolResults = parsed.filter(e => e.toolResult);
    assert.strictEqual(toolResults.length, 0, 'Should have no toolResult events');
  });

  it('streams toolResult with error info when code execution fails', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async (language, code) => {
      return { stdout: '', stderr: 'SyntaxError: invalid syntax', exitCode: 1, timedOut: false };
    });

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      if (functions && functions.run_code) {
        await functions.run_code.handler({ language: 'python', code: 'print(2+' });
      }
      onTextChunk('There was a syntax error.');
      return 'There was a syntax error.';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Run some bad code' });

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    const toolResults = parsed.filter(e => e.toolResult);
    assert.strictEqual(toolResults.length, 1);
    assert.strictEqual(toolResults[0].toolResult.stderr, 'SyntaxError: invalid syntax');
    assert.strictEqual(toolResults[0].toolResult.exitCode, 1);
  });

  it('streams toolResult with timedOut flag when code times out', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async () => {
      return { stdout: '', stderr: '', exitCode: 137, timedOut: true };
    });

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      if (functions && functions.run_code) {
        await functions.run_code.handler({ language: 'bash', code: 'sleep 60' });
      }
      onTextChunk('The code timed out.');
      return 'The code timed out.';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Run sleep 60' });

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    const toolResults = parsed.filter(e => e.toolResult);
    assert.strictEqual(toolResults.length, 1);
    assert.strictEqual(toolResults[0].toolResult.timedOut, true);
    assert.strictEqual(toolResults[0].toolResult.exitCode, 137);
  });

  it('system prompt mentions code execution when container is available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);

    let capturedMessages = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk }) => {
      // Capture only the first call (the real message), not title generation
      if (!capturedMessages) {
        capturedMessages = messages;
      }
      onTextChunk('OK');
      return 'OK';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    assert.ok(capturedMessages, 'Should have captured messages');
    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(systemMsg, 'Should have a system message');
    assert.ok(systemMsg.content.includes('run_code'), 'System prompt should mention run_code tool');
  });

  it('system prompt does NOT mention code execution when container is unavailable', async function () {
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

    assert.ok(capturedMessages, 'Should have captured messages');
    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(systemMsg, 'Should have a system message');
    assert.ok(!systemMsg.content.includes('run_code'), 'System prompt should NOT mention run_code tool');
  });
});
