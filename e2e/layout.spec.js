const { test, expect } = require('@playwright/test');

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

test.describe('Layout: sticky input and scrolling', () => {
  test('input stays visible and no double scrollbar with tall content', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');

    // Create a chat through the UI
    await page.getByRole('button', { name: 'New Chat' }).click();
    await expect(page.getByPlaceholder('Type a message')).toBeVisible();

    // Build tall mock content
    const longText = Array.from({ length: 80 }, (_, i) =>
      `Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`
    ).join('\n\n');

    // Inject messages into the Pinia store
    await page.evaluate((content) => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      store.currentMessages = [
        { role: 'user', content: 'Tell me a very long story.' },
        { role: 'assistant', content }
      ];
    }, longText);

    // Wait for render
    await page.waitForTimeout(500);

    // The input textarea should be visible in the viewport
    const textarea = page.getByPlaceholder('Type a message');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeInViewport();

    // Check there is no double scrollbar:
    // The html element should not show any scrollbar (Vuetify forces overflow-y: scroll)
    const htmlOverflow = await page.evaluate(() => {
      return window.getComputedStyle(document.documentElement).overflowY;
    });
    expect(htmlOverflow).not.toBe('scroll');

    // The v-main element SHOULD be scrollable (content overflows)
    const vMainScrollable = await page.evaluate(() => {
      const vMain = document.querySelector('.v-main');
      return vMain.scrollHeight > vMain.clientHeight;
    });
    expect(vMainScrollable).toBe(true);
  });

  test('New Chat button dismisses sidebar', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('load');

    // Sidebar should be open (Vuetify adds --active class when open)
    const drawer = page.locator('.v-navigation-drawer');
    await expect(drawer).toHaveClass(/v-navigation-drawer--active/);

    // Click New Chat
    await page.getByRole('button', { name: 'New Chat' }).click();

    // Sidebar should now be closed (--active class removed)
    await expect(drawer).not.toHaveClass(/v-navigation-drawer--active/);
  });
});
