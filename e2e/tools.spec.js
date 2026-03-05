const { test, expect } = require('@playwright/test');

// Check if models are available via the API
async function checkModels(request) {
  try {
    const res = await request.get('/api/models/status');
    if (!res.ok()) {
      return { available: false };
    }
    const data = await res.json();
    return {
      available: (data.available || []).length > 0 || !!data.selectedModel,
      selectedModel: data.selectedModel,
      models: data.available || []
    };
  } catch {
    return { available: false };
  }
}

// Select a model that supports function calling (Ministral or Llama 3)
// Returns the model id if found, or null
async function selectFunctionCallingModel(request) {
  const status = await checkModels(request);
  if (!status.available) {
    return null;
  }
  // Prefer downloaded Ministral or Llama models — these support function calling
  const candidates = (status.models || []).filter(m =>
    m.downloaded && (
      m.name.toLowerCase().includes('ministral') ||
      m.name.toLowerCase().includes('mistral') ||
      m.name.toLowerCase().includes('llama')
    )
  );
  if (candidates.length === 0) {
    return null;
  }
  // Pick the smallest (last in list, since tiers are largest-first)
  const pick = candidates[candidates.length - 1];
  const res = await request.post('/api/models/select', { data: { model: pick.id } });
  if (!res.ok()) {
    return null;
  }
  return pick.id;
}

// Clean up all chats via API
async function deleteAllChats(request) {
  const res = await request.get('/api/chats');
  const chats = await res.json();
  for (const chat of chats) {
    await request.delete(`/api/chats/${chat.id}`);
  }
}

// Check tool availability via the API
async function checkToolsStatus(request) {
  try {
    const res = await request.get('/api/tools/status');
    if (!res.ok()) {
      return { containerAvailable: false, webSearchAvailable: false };
    }
    return await res.json();
  } catch {
    return { containerAvailable: false, webSearchAvailable: false };
  }
}

async function checkContainerAvailable(request) {
  const status = await checkToolsStatus(request);
  return status.containerAvailable === true;
}

test.beforeEach(async ({ page }) => {
  await deleteAllChats(page.request);
});

// ──────────────────────────────────────────────
// Tool call UI rendering
// ──────────────────────────────────────────────

test.describe('Tool call UI', () => {
  test.describe.configure({ timeout: 180000 });

  test('tool call expansion panel appears when model uses run_code', async ({ page }) => {
    const containerAvailable = await checkContainerAvailable(page.request);
    test.skip(!containerAvailable, 'no container runtime available');

    const modelId = await selectFunctionCallingModel(page.request);
    test.skip(!modelId, 'no function-calling model available');

    await page.goto('/');
    await page.waitForLoadState('load');

    // Ask a math question that should trigger tool use
    const input = page.getByPlaceholder('Type a message');
    await input.fill('What is 238420 times 234? Use the run_code tool to calculate this.');
    await input.press('Enter');

    // User message should appear
    await expect(page.locator('.user-text').first()).toContainText('238420');

    // Wait for tool call panel to appear — this is the expansion panel
    const toolPanel = page.locator('.tool-calls .v-expansion-panel');
    await expect(toolPanel.first()).toBeVisible({ timeout: 120000 });

    // Panel title should indicate code was run
    await expect(toolPanel.first().locator('.v-expansion-panel-title')).toContainText('Ran');

    // Expand the panel to see code
    await toolPanel.first().locator('.v-expansion-panel-title').click();

    // Should see the code that was executed
    const codeBlock = toolPanel.first().locator('.tool-code pre');
    await expect(codeBlock).toBeVisible();
    const code = await codeBlock.textContent();
    expect(code).toContain('238420');

    // The assistant should produce a text response with the correct answer
    const assistantBubble = page.locator('.markdown-body').first();
    await expect(assistantBubble).toContainText('55,790,280', { timeout: 60000 }).catch(() => {
      // Model may format without commas
      return expect(assistantBubble).toContainText('55790280', { timeout: 5000 });
    });
  });

  test('tool call shows error status for failed code execution', async ({ page }) => {
    const containerAvailable = await checkContainerAvailable(page.request);
    test.skip(!containerAvailable, 'no container runtime available');

    const modelId = await selectFunctionCallingModel(page.request);
    test.skip(!modelId, 'no function-calling model available');

    await page.goto('/');
    await page.waitForLoadState('load');

    // Ask to run invalid code
    const input = page.getByPlaceholder('Type a message');
    await input.fill('Use the run_code tool to run this Python code: print(1/0)');
    await input.press('Enter');

    // Wait for tool call panel
    const toolPanel = page.locator('.tool-calls .v-expansion-panel');
    await expect(toolPanel.first()).toBeVisible({ timeout: 120000 });

    // Expand to see stderr
    await toolPanel.first().locator('.v-expansion-panel-title').click();
    const stderrBlock = toolPanel.first().locator('.tool-stderr');
    await expect(stderrBlock).toBeVisible({ timeout: 5000 });
  });
});

// ──────────────────────────────────────────────
// Web search UI
// ──────────────────────────────────────────────

test.describe('Web search UI', () => {
  test.describe.configure({ timeout: 180000 });

  test('web search expansion panel appears when model uses web_search', async ({ page }) => {
    const status = await checkToolsStatus(page.request);
    test.skip(!status.webSearchAvailable, 'no TAVILY_API_KEY configured');

    const modelId = await selectFunctionCallingModel(page.request);
    test.skip(!modelId, 'no function-calling model available');

    await page.goto('/');
    await page.waitForLoadState('load');

    const input = page.getByPlaceholder('Type a message');
    await input.fill('Use the web_search tool to search for "latest news today"');
    await input.press('Enter');

    // Wait for tool call panel to appear
    const toolPanel = page.locator('.tool-calls .v-expansion-panel');
    await expect(toolPanel.first()).toBeVisible({ timeout: 120000 });

    // Panel title should indicate a web search
    await expect(toolPanel.first().locator('.v-expansion-panel-title')).toContainText('Searched the web');

    // Expand the panel to see results
    await toolPanel.first().locator('.v-expansion-panel-title').click();

    // Should see search result links
    const resultLinks = toolPanel.first().locator('.search-result-link');
    await expect(resultLinks.first()).toBeVisible({ timeout: 10000 });
  });
});

// ──────────────────────────────────────────────
// Graceful degradation without container
// ──────────────────────────────────────────────

test.describe('Tool degradation', () => {
  test('app works normally without container runtime', async ({ page }) => {
    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    await page.goto('/');
    await page.waitForLoadState('load');

    // Should load without errors
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await expect(page.locator('.v-app-bar-title')).toContainText('AI Chat');
    expect(errors).toEqual([]);
  });
});
