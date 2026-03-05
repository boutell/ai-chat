import assert from 'assert';
import supertest from 'supertest';
import buildApp from '../app.js';
import db from '../db.js';
import { listLocalModels, _setChatStreamOverride } from '../lib/llm.js';
import { _setIsAvailableOverride, _setRunCodeOverride, _autoPrintPython } from '../lib/container.js';
import { _setIsAvailableOverride as setWebSearchAvailableOverride, _setSearchOverride, isAvailable as wsIsAvailable } from '../lib/web-search.js';

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
// Python auto-print
// ──────────────────────────────────────────────

describe('Python auto-print', function () {
  it('wraps a single-line expression in print()', function () {
    assert.strictEqual(_autoPrintPython('2 + 2'), 'print(2 + 2)');
  });

  it('wraps a single-line variable reference in print()', function () {
    assert.strictEqual(_autoPrintPython('result'), 'print(result)');
  });

  it('does not wrap a single-line assignment', function () {
    assert.strictEqual(_autoPrintPython('x = 5'), 'x = 5');
  });

  it('does not wrap a single-line print call', function () {
    assert.strictEqual(_autoPrintPython('print(42)'), 'print(42)');
  });

  it('wraps last bare expression in multi-line script', function () {
    const code = 'x = 10\ny = 20\nx + y';
    const result = _autoPrintPython(code);
    assert.ok(result.endsWith('print(x + y)'), `Expected print wrap, got: ${result}`);
    assert.ok(result.startsWith('x = 10'), 'Should preserve earlier lines');
  });

  it('wraps last bare tuple expression in multi-line script', function () {
    const code = 'total = sum([1,2,3])\navg = total / 3\ntotal, avg';
    const result = _autoPrintPython(code);
    assert.ok(result.endsWith('print(total, avg)'), `Expected print wrap, got: ${result}`);
  });

  it('does not modify multi-line script that already has print()', function () {
    const code = 'x = 10\nprint(x)\nx + 5';
    assert.strictEqual(_autoPrintPython(code), code);
  });

  it('does not wrap indented last lines (inside a block)', function () {
    const code = 'for i in range(3):\n    i * 2';
    assert.strictEqual(_autoPrintPython(code), code);
  });

  it('does not wrap a last-line assignment in multi-line script', function () {
    const code = 'x = 10\ny = x + 5';
    assert.strictEqual(_autoPrintPython(code), code);
  });

  it('handles augmented assignment', function () {
    const code = 'x = 10\nx += 5';
    assert.strictEqual(_autoPrintPython(code), code);
  });

  it('does not wrap comments or empty last lines', function () {
    const code = 'x = 10\n# done';
    assert.strictEqual(_autoPrintPython(code), code);
  });
});

// ──────────────────────────────────────────────
// Web search module
// ──────────────────────────────────────────────

describe('Web search module', function () {
  afterEach(function () {
    setWebSearchAvailableOverride(null);
    _setSearchOverride(null);
  });

  it('isAvailable override controls availability', function () {
    setWebSearchAvailableOverride(() => true);
    assert.strictEqual(wsIsAvailable(), true);

    setWebSearchAvailableOverride(() => false);
    assert.strictEqual(wsIsAvailable(), false);

    setWebSearchAvailableOverride(null);
  });

  it('search override intercepts API calls', async function () {
    _setSearchOverride(async (query) => ({
      results: [{ title: 'Mock', url: 'https://mock.com', content: 'Mock result' }],
      answer: 'Mock answer'
    }));

    const { search } = await import('../lib/web-search.js');
    const result = await search('test query');
    assert.strictEqual(result.answer, 'Mock answer');
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.results[0].title, 'Mock');
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

  it('returns webSearchAvailable from /api/tools/status', async function () {
    setWebSearchAvailableOverride(() => true);
    const res = await request.get('/api/tools/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.webSearchAvailable, true);
  });

  it('returns webSearchAvailable false when no key', async function () {
    setWebSearchAvailableOverride(() => false);
    const res = await request.get('/api/tools/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.webSearchAvailable, false);
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
    setWebSearchAvailableOverride(null);
    _setSearchOverride(null);
  });

  it('streams toolCall and toolResult SSE events when tool is invoked', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async (language, code) => {
      return { stdout: '4\n', stderr: '', exitCode: 0, timedOut: false };
    });

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      onTextChunk('Let me calculate. ');
      if (functions && functions.run_code) {
        await functions.run_code.handler({ language: 'python', code: 'print(2+2)' });
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

    const tokens = parsed.filter(e => e.token);
    assert.ok(tokens.length > 0, 'Should have token events');

    const toolCalls = parsed.filter(e => e.toolCall);
    assert.strictEqual(toolCalls.length, 1, 'Should have exactly one toolCall event');
    assert.strictEqual(toolCalls[0].toolCall.name, 'run_code');
    assert.strictEqual(toolCalls[0].toolCall.language, 'python');
    assert.strictEqual(toolCalls[0].toolCall.code, 'print(2+2)');

    const toolResults = parsed.filter(e => e.toolResult);
    assert.strictEqual(toolResults.length, 1, 'Should have exactly one toolResult event');
    assert.strictEqual(toolResults[0].toolResult.name, 'run_code');
    assert.strictEqual(toolResults[0].toolResult.output, '4\n');
    assert.strictEqual(toolResults[0].toolResult.exitCode, 0);

    assert.ok(events.includes('[DONE]'), 'Stream should end with [DONE]');
  });

  it('does not include tool events when no tools available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);
    setWebSearchAvailableOverride(() => false);

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      assert.ok(!functions, 'functions should not be provided when no tools available');
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

    assert.strictEqual(parsed.filter(e => e.toolCall).length, 0);
    assert.strictEqual(parsed.filter(e => e.toolResult).length, 0);
  });

  it('streams toolResult with error info when code execution fails', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async () => {
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

    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(!systemMsg.content.includes('run_code'), 'System prompt should NOT mention run_code tool');
  });

  // ──────────────────────────────────────────────
  // Web search tool tests
  // ──────────────────────────────────────────────

  it('streams web_search toolCall and toolResult SSE events', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);
    setWebSearchAvailableOverride(() => true);
    _setSearchOverride(async (query) => ({
      results: [
        { title: 'Test Result', url: 'https://example.com', content: 'Test content here' }
      ],
      answer: 'This is a test answer'
    }));

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      assert.ok(functions.web_search, 'Should have web_search function');
      await functions.web_search.handler({ query: 'test query' });
      onTextChunk('Search results returned.');
      return 'Search results returned.';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Search for something' });

    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    const toolCall = parsed.find(e => e.toolCall && e.toolCall.name === 'web_search');
    assert.ok(toolCall, 'Should have a web_search toolCall event');
    assert.strictEqual(toolCall.toolCall.query, 'test query');

    const toolResult = parsed.find(e => e.toolResult && e.toolResult.name === 'web_search');
    assert.ok(toolResult, 'Should have a web_search toolResult event');
    assert.strictEqual(toolResult.toolResult.answer, 'This is a test answer');
    assert.strictEqual(toolResult.toolResult.results.length, 1);
    assert.strictEqual(toolResult.toolResult.results[0].title, 'Test Result');
  });

  it('does not offer web_search when unavailable', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);
    setWebSearchAvailableOverride(() => false);

    let receivedFunctions = 'not-set';
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      receivedFunctions = functions;
      onTextChunk('Hello');
      return 'Hello';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    assert.strictEqual(receivedFunctions, undefined, 'functions should be undefined when no tools available');
  });

  it('system prompt mentions web search when available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => false);
    setWebSearchAvailableOverride(() => true);
    _setSearchOverride(async () => ({ results: [], answer: null }));

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
    assert.ok(systemMsg.content.includes('web_search'), 'System prompt should mention web_search');
    assert.ok(!systemMsg.content.includes('run_code'), 'System prompt should not mention run_code');
  });

  // ──────────────────────────────────────────────
  // show_output tool tests
  // ──────────────────────────────────────────────

  it('show_output injects tool output via SSE inject event', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async () => {
      return { stdout: 'CHART_DATA_HERE\nLINE2\n', stderr: '', exitCode: 0, timedOut: false };
    });

    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      // Model runs code first
      await functions.run_code.handler({ language: 'python', code: 'print("CHART_DATA_HERE\\nLINE2")' });
      onTextChunk('Here is the chart:\n\n');
      // Then calls show_output to display the result
      await functions.show_output.handler({ content: 'stdout', format: 'code' });
      onTextChunk('\nDone!');
      return 'Here is the chart:\n\nDone!';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Make a chart' });

    assert.strictEqual(res.status, 200);
    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    // Should have an inject event
    const injects = parsed.filter(e => e.inject);
    assert.strictEqual(injects.length, 1, 'Should have exactly one inject event');
    assert.ok(injects[0].inject.includes('CHART_DATA_HERE'), 'Inject should contain the tool output');
    assert.ok(injects[0].inject.startsWith('```'), 'Inject should be wrapped in code block');

    // The saved message should include injected content
    const messages = db.prepare('SELECT * FROM messages WHERE chat_id = ? AND role = ?').all(chat.id, 'assistant');
    assert.ok(messages[0].content.includes('CHART_DATA_HERE'), 'Saved message should include injected output');
  });

  it('show_output returns empty message when no previous tool result', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);

    let showOutputResult = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      // Call show_output without any prior tool call
      showOutputResult = await functions.show_output.handler({ content: 'stdout', format: 'plain' });
      onTextChunk('Nothing to show.');
      return 'Nothing to show.';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'Show output' });

    assert.strictEqual(showOutputResult, '(no previous tool output to display)');

    // No inject events should have been emitted
    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    assert.strictEqual(parsed.filter(e => e.inject).length, 0, 'Should have no inject events');
  });

  it('show_output can inject stderr or all content', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    _setRunCodeOverride(async () => {
      return { stdout: 'out-text', stderr: 'err-text', exitCode: 1, timedOut: false };
    });

    let allInjectText = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      await functions.run_code.handler({ language: 'python', code: 'x' });
      const result = await functions.show_output.handler({ content: 'all', format: 'plain' });
      onTextChunk('Done');
      return 'Done';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    const res = await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    const events = parseSSE(res.body);
    const parsed = events
      .filter(e => e !== '[DONE]')
      .map(e => { try { return JSON.parse(e); } catch { return null; } })
      .filter(Boolean);

    const injects = parsed.filter(e => e.inject);
    assert.strictEqual(injects.length, 1);
    assert.ok(injects[0].inject.includes('out-text'), 'Should contain stdout');
    assert.ok(injects[0].inject.includes('err-text'), 'Should contain stderr');
  });

  it('system prompt mentions show_output when tools are available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);

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
    assert.ok(systemMsg.content.includes('show_output'), 'System prompt should mention show_output');
  });

  it('offers both tools when both are available', async function () {
    if (!testModelId) {
      return this.skip();
    }
    this.timeout(15000);

    _setIsAvailableOverride(() => true);
    setWebSearchAvailableOverride(() => true);
    _setSearchOverride(async () => ({ results: [], answer: null }));

    let capturedMessages = null;
    let capturedFunctions = null;
    _setChatStreamOverride(async (modelPath, messages, { onTextChunk, functions }) => {
      if (!capturedMessages) {
        capturedMessages = messages;
        capturedFunctions = functions;
      }
      onTextChunk('OK');
      return 'OK';
    });

    const chat = (await request.post('/api/chats').send({})).body;
    await sseRequest(`/api/chats/${chat.id}/messages`)
      .send({ content: 'test' });

    const systemMsg = capturedMessages.find(m => m.role === 'system');
    assert.ok(systemMsg.content.includes('web_search'), 'System prompt should mention web_search');
    assert.ok(systemMsg.content.includes('run_code'), 'System prompt should mention run_code');
    assert.ok(capturedFunctions, 'Functions should be provided');
    assert.ok(capturedFunctions.run_code, 'Should have run_code function');
    assert.ok(capturedFunctions.web_search, 'Should have web_search function');
  });
});
