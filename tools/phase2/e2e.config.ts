import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: process.env.ACTIVITY_D4_E2E==='1'?['activity.spec.ts']:process.env.CQRS_Q5_E2E==='1'?['cqrs-q5.spec.ts']:process.env.CQRS_Q4_E2E==='1'?['cqrs.spec.ts']:process.env.P5_E2E_BASELINE === '1' ? 'baseline.spec.ts' : ['journeys.spec.ts', 'resilience.spec.ts'],
  workers: 1, timeout: 60000, expect: { timeout: 10000 },
  webServer: process.env.P5_E2E_MANAGED === '1' ? undefined : { command: 'node --import tsx tools/phase2/e2e-server.mjs', cwd: process.cwd(), url: 'http://127.0.0.1:5189', reuseExistingServer: false, timeout: 90000 },
  use: { baseURL: 'http://127.0.0.1:5189', actionTimeout: 10000, trace: process.env.CQRS_Q4_E2E==='1'?'off':'retain-on-failure', screenshot: 'only-on-failure' },
  outputDir: '../../test-results/phase2-e2e',
});
