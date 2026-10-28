import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: process.env.P5_E2E_BASELINE === '1' ? 'baseline.spec.ts' : ['journeys.spec.ts', 'resilience.spec.ts'],
  workers: 1, timeout: 60000, expect: { timeout: 10000 },
  // On CI, failures also become GitHub annotations (readable without signing in to the job log).
  reporter: process.env.CI ? [['github'], ['dot']] : 'list',
  webServer: process.env.P5_E2E_MANAGED === '1' ? undefined : { command: 'node --import tsx tools/phase2/e2e-server.mjs', cwd: process.cwd(), url: 'http://127.0.0.1:5189', reuseExistingServer: false, timeout: 90000 },
  // The browser runs in UTC everywhere (as on the CI runner), so a Vietnam-time machine
  // cannot hide dates computed from the device clock instead of the clinic's calendar.
  use: { baseURL: 'http://127.0.0.1:5189', timezoneId: 'UTC', actionTimeout: 10000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/phase2-e2e',
});
