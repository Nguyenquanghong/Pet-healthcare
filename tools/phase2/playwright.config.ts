import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './ui', workers: 1, timeout: 30000,
  // On CI, failures also become GitHub annotations (readable without signing in to the job log).
  reporter: process.env.CI ? [['github'], ['dot']] : 'list',
  webServer: {
    command: 'node tools/phase2/ui-server.mjs',
    cwd: process.cwd(), url: 'http://127.0.0.1:5187', reuseExistingServer: false,
  },
  // The browser runs in UTC everywhere (as on the CI runner), so a Vietnam-time machine
  // cannot hide dates computed from the device clock instead of the clinic's calendar.
  use: { baseURL: 'http://127.0.0.1:5187', timezoneId: 'UTC', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/phase2-ui',
});
