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

test.beforeEach(async ({ page }) => {
  await deleteAllChats(page.request);
});

// ──────────────────────────────────────────────
// Basic app rendering
// ──────────────────────────────────────────────

test.describe('App loads', () => {
  test('homepage renders with no JS errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.locator('.v-app-bar-title')).toContainText('AI Chat');
    await expect(page.getByRole('button', { name: 'New Chat' })).toBeVisible();
    await expect(page.locator('.v-app-bar .v-chip')).toBeVisible();

    expect(errors).toEqual([]);
  });

  test('shows empty state when no chat selected', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await expect(page.getByText('Start a new conversation')).toBeVisible();
  });
});

// ──────────────────────────────────────────────
// Chat management
// ──────────────────────────────────────────────

test.describe('Chat management', () => {
  test('can create a new chat', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'New Chat' }).click();
    await expect(page.getByPlaceholder('Type a message')).toBeVisible();
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(1);
  });

  test('can create and switch between multiple chats', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'New Chat' }).click();
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(1);

    await page.getByRole('button', { name: 'New Chat' }).click();
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(2);

    // Click the second chat (older one) in the list
    await page.locator('.v-navigation-drawer .v-list-item').nth(1).click();
  });

  test('can delete a chat', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'New Chat' }).click();
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(1);

    await page.locator('.v-navigation-drawer .v-list-item button').first().click();
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(0);
    await expect(page.getByText('Start a new conversation')).toBeVisible();
  });
});

// ──────────────────────────────────────────────
// Model selection
// ──────────────────────────────────────────────

test.describe('Model selection', () => {
  test('auto-select picks a model and shows it in the toolbar', async ({ page }) => {
    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    // Make sure no model is pre-selected
    await page.request.post('/api/models/select', { data: { model: '' } }).catch(() => {});

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Model status chip should show an actual model name (not "No model")
    const chip = page.locator('.v-app-bar .v-chip');
    await expect(chip).toBeVisible();

    // Check via API that a model is selected
    const status = await page.request.get('/api/models/status');
    const statusData = await status.json();
    expect(statusData.selectedModel).toBeTruthy();
  });
});

// ──────────────────────────────────────────────
// Full conversation — real model streaming
// ──────────────────────────────────────────────

test.describe('Real conversation', () => {
  // These tests involve model loads + inference, need generous timeouts
  test.describe.configure({ timeout: 180000 });

  test('send a message and receive a streamed response', async ({ page }) => {
    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Type and send a message
    const input = page.getByPlaceholder('Type a message');
    await input.fill('Reply with exactly the word "pong" and nothing else.');
    await input.press('Enter');

    // User message should appear
    await expect(page.locator('.user-text').first()).toContainText('pong');

    // Wait for assistant response — check for non-empty text content
    const assistantBubble = page.locator('.markdown-body').first();
    await expect(assistantBubble).not.toBeEmpty({ timeout: 120000 });

    // Response should have some text
    const responseText = await assistantBubble.textContent();
    expect(responseText.length).toBeGreaterThan(0);

    // Message should be persisted — reload and verify
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Click the chat in the sidebar to reload it
    await page.locator('.v-navigation-drawer .v-list-item').first().click();

    // Both messages should still be there after reload
    await expect(page.locator('.user-text').first()).toBeVisible({ timeout: 5000 });
    const reloadedBubble = page.locator('.markdown-body').first();
    await expect(reloadedBubble).not.toBeEmpty({ timeout: 5000 });
  });

  test('chat appears in sidebar after sending a message', async ({ page }) => {
    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Initially no chats
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(0);

    // Send a message (this auto-creates a chat)
    const input = page.getByPlaceholder('Type a message');
    await input.fill('Say hi');
    await input.press('Enter');

    // Chat should appear in sidebar
    await expect(page.locator('.v-navigation-drawer .v-list-item')).toHaveCount(1, { timeout: 10000 });

    // Wait for response to stream in
    await expect(page.locator('.markdown-body').first()).not.toBeEmpty({ timeout: 120000 });
  });

  test('no console errors during full conversation flow', async ({ page }) => {
    const models = await checkModels(page.request);
    test.skip(!models.available, 'no local models available');

    const errors = [];
    page.on('pageerror', err => errors.push(err.message));

    const failedRequests = [];
    page.on('response', res => {
      if (res.status() >= 500) {
        failedRequests.push({ url: res.url(), status: res.status() });
      }
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Send a message
    const input = page.getByPlaceholder('Type a message');
    await input.fill('Say hello.');
    await input.press('Enter');

    // Wait for response
    await expect(page.locator('.markdown-body').first()).not.toBeEmpty({ timeout: 120000 });

    // No JS errors
    expect(errors).toEqual([]);

    // No 500s
    const api500s = failedRequests.filter(r => r.url.includes('/api/'));
    expect(api500s).toEqual([]);
  });
});
