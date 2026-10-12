import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: process.env.P5_E2E_BASELINE === '1' ? 'baseline.spec.ts' : ['journeys.spec.ts', 'resilience.spec.ts'],
  workers: 1, timeout: 60000, expect: { timeout: 10000 },
  webServer: process.env.P5_E2E_MANAGED === '1' ? undefined : { command: 'node --import tsx tools/phase2/e2e-server.mjs', cwd: process.cwd(), url: 'http://127.0.0.1:5189', reuseExistingServer: false, timeout: 90000 },
  use: { baseURL: 'http://127.0.0.1:5189', actionTimeout: 10000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/phase2-e2e',
});
