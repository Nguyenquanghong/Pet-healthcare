import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui', workers: 1, timeout: 30000,
  webServer: {
    command: 'node tools/phase2/ui-server.mjs',
    cwd: process.cwd(), url: 'http://127.0.0.1:5187', reuseExistingServer: false,
  },
  use: { baseURL: 'http://127.0.0.1:5187', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/phase2-ui',
});
