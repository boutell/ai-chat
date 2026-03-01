const { test, expect } = require('@playwright/test');

// These tests exercise real model downloading and selection.
// They require network access to HuggingFace.

// Clean up all chats via API
async function deleteAllChats(request) {
  const res = await request.get('/api/chats');
  const chats = await res.json();
  for (const chat of chats) {
    await request.delete(`/api/chats/${chat.id}`);
  }
}

// Clear selected model so auto-detect will re-run
async function clearSelectedModel(request) {
  await request.delete('/api/models/selected');
}

test.describe('Model selection E2E', () => {
  // These tests involve real model downloads and inference
  test.describe.configure({ timeout: 600000 });

  test.beforeEach(async ({ page }) => {
    await deleteAllChats(page.request);
  });

  test('auto-select tries Ministral 3B before Ministral 8B', async ({ page }) => {
    // Use the API directly to run auto-select and capture SSE events —
    // this is the reliable way to verify ordering (UI polling is racy)
    await clearSelectedModel(page.request);

    const response = await page.request.fetch('/api/models/auto-select', {
      method: 'POST'
    });
    const body = await response.text();

    // Parse SSE events
    const events = body.split('\n')
      .filter(line => line.startsWith('data: '))
      .map(line => line.slice(6))
      .filter(data => data !== '[DONE]')
      .map(data => { try { return JSON.parse(data); } catch { return null; } })
      .filter(Boolean);

    // Find all download and test events in order
    const downloadAndTestEvents = events.filter(
      e => e.step === 'pulling' || e.step === 'testing'
    );

    expect(downloadAndTestEvents.length).toBeGreaterThan(0);

    // Find the indices of the first Ministral 3B and first Ministral 8B events
    const first3bIndex = downloadAndTestEvents.findIndex(
      e => e.model === 'Ministral 3B'
    );
    const first8bIndex = downloadAndTestEvents.findIndex(
      e => e.model === 'Ministral 8B'
    );

    // Ministral 3B must be attempted (downloaded or tested)
    expect(first3bIndex).toBeGreaterThanOrEqual(0);

    // If Ministral 8B was also tried, 3B must have come first
    if (first8bIndex >= 0) {
      expect(first3bIndex).toBeLessThan(first8bIndex);
    }
  });

  test('Ministral 3B downloads successfully', async ({ page }) => {
    // Check current available models
    const statusRes = await page.request.get('/api/models/status');
    const status = await statusRes.json();

    // Find Ministral 3B in available list
    const ministral3b = status.available.find(m => m.name === 'Ministral 3B');
    expect(ministral3b).toBeTruthy();

    if (ministral3b.downloaded) {
      // Already downloaded — verify it can be selected via API
      const selectRes = await page.request.post('/api/models/select', {
        headers: { 'Content-Type': 'application/json' },
        data: { model: ministral3b.id }
      });
      expect(selectRes.ok()).toBe(true);
    } else {
      // Not downloaded — trigger download via select endpoint
      const selectRes = await page.request.fetch('/api/models/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ model: ministral3b.id })
      });
      expect(selectRes.ok()).toBe(true);
    }

    // Verify via API that Ministral 3B is now available and downloaded
    const afterRes = await page.request.get('/api/models/status');
    const afterStatus = await afterRes.json();
    const model = afterStatus.available.find(m => m.name === 'Ministral 3B');
    expect(model).toBeTruthy();
    expect(model.downloaded).toBe(true);
  });

  test('selecting an undownloaded model via UI downloads it successfully', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Get current model list
    const statusRes = await page.request.get('/api/models/status');
    const status = await statusRes.json();

    // Find any undownloaded model
    const undownloaded = status.available.find(m => !m.downloaded);
    if (!undownloaded) {
      test.skip(true, 'All available models are already downloaded');
      return;
    }

    // Click the model chip to open the dropdown
    await page.locator('.v-app-bar .v-chip').click();

    // Find and click the undownloaded model
    const menuItem = page.getByRole('listitem').filter({ hasText: undownloaded.name });
    await expect(menuItem).toBeVisible();
    await menuItem.click();

    // Should show downloading progress (chip text changes)
    const chip = page.locator('.v-app-bar .v-chip');

    // Wait for download to complete — the chip should eventually show the model name
    await expect(chip).toContainText(undownloaded.name, { timeout: 300000 });

    // Verify via API that the model is now downloaded and selected
    const afterRes = await page.request.get('/api/models/status');
    const afterStatus = await afterRes.json();
    expect(afterStatus.selectedModelName).toBe(undownloaded.name);

    const model = afterStatus.available.find(m => m.name === undownloaded.name);
    expect(model).toBeTruthy();
    expect(model.downloaded).toBe(true);
  });

  test('chat input is disabled when no model is selected', async ({ page }) => {
    // Clear selected model
    await clearSelectedModel(page.request);

    // Block the status response to return null selectedModel, and block
    // auto-select indefinitely so we can observe the disabled state
    let releaseAutoSelect;
    const autoSelectBlocked = new Promise(resolve => { releaseAutoSelect = resolve; });

    // Intercept at the browser level — block the auto-select POST
    await page.route('**/models/auto-select', async (route) => {
      await autoSelectBlocked;
      // Return a minimal SSE response
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'data: {"step":"ram","ramGB":14}\n\ndata: [DONE]\n\n'
      });
    });

    // Intercept status to return no selected model
    await page.route('**/models/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          selectedModel: null,
          selectedModelName: null,
          available: []
        })
      });
    });

    await page.goto('/');

    // Create a chat so the input appears
    await page.getByRole('button', { name: 'New Chat' }).click();

    const input = page.getByPlaceholder('Type a message');

    // Input should be disabled when no model is selected
    await expect(input).toBeDisabled({ timeout: 5000 });

    // Release the auto-select and remove intercepts
    releaseAutoSelect();
    await page.unroute('**/models/auto-select');
    await page.unroute('**/models/status');

    // Reload without intercepts — now auto-select runs for real and input enables
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'New Chat' }).click();

    await expect(page.getByPlaceholder('Type a message')).toBeEnabled({ timeout: 300000 });
  });

  test('models too large for system RAM do not appear in menu', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Open the model dropdown
    await page.locator('.v-app-bar .v-chip').click();

    // Mistral Small 22B requires 32GB — should NOT appear on this machine
    const menuItems = page.locator('.v-list-item-title');
    const allNames = await menuItems.allTextContents();

    // This machine has ~14GB RAM, so Mistral Small 22B (32GB min) should be hidden
    expect(allNames).not.toContain('Mistral Small 22B');

    // But smaller models should be present
    expect(allNames).toContain('Ministral 3B');
  });
});
