const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120000,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'cd server && node app.js',
      port: 3000,
      reuseExistingServer: true,
      env: {
        // Use a separate test DB file so e2e tests don't pollute dev data
        AI_CHAT_DB: path.join(__dirname, 'server', 'ai-chat-test.db')
      }
    },
    {
      command: 'cd client && npx vite',
      port: 5173,
      reuseExistingServer: true
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
