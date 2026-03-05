const { defineConfig } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 120000,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5174',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure'
  },
  webServer: [
    {
      command: 'cd server && node app.js',
      port: 3001,
      reuseExistingServer: true,
      env: {
        PORT: '3001',
        AI_CHAT_DB: path.join(__dirname, 'server', 'ai-chat-test.db'),
        AI_CHAT_NAMESPACE: 'ai-chat-test'
      }
    },
    {
      command: 'cd client && npx vite',
      port: 5174,
      reuseExistingServer: true,
      env: {
        VITE_PORT: '5174',
        VITE_API_PORT: '3001'
      }
    }
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
