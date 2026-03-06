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
// Code-first UI
// ──────────────────────────────────────────────

test.describe('Code-first UI', () => {
  test.describe.configure({ timeout: 180000 });

  test('math question shows code panel and correct output', async ({ page }) => {
    const containerAvailable = await checkContainerAvailable(page.request);
    test.skip(!containerAvailable, 'no container runtime available');

    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    await page.goto('/');
    await page.waitForLoadState('load');

    const input = page.getByPlaceholder('Type a message');
    await input.fill('What is 237 * 419?');
    await input.press('Enter');

    // User message should appear
    await expect(page.locator('.user-text').first()).toContainText('237');

    // Wait for the code panel to appear
    const codePanel = page.locator('.code-panel .v-expansion-panel');
    await expect(codePanel.first()).toBeVisible({ timeout: 120000 });

    // Panel title should say "View code"
    await expect(codePanel.first().locator('.v-expansion-panel-title')).toContainText('View code');

    // The assistant should show the correct answer in the output
    const assistantBubble = page.locator('.markdown-body').first();
    await expect(assistantBubble).toContainText('99303', { timeout: 60000 });

    // Expand to see code
    await codePanel.first().locator('.v-expansion-panel-title').click();
    const codeBlock = codePanel.first().locator('pre code');
    await expect(codeBlock).toBeVisible();
    const code = await codeBlock.textContent();
    expect(code).toContain('237');
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
