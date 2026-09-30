import { defineConfig } from "@playwright/test";

// Run against a seeded LOCAL demo API + frontend. Does not start or reset a DB.
export default defineConfig({
  testDir: "./tests/e2e",
  workers: 1,
  timeout: 60_000,
  webServer: process.env.E2E_START_FRONTEND === "1" ? {
    command: "npm run dev -w frontend -- --host 127.0.0.1 --port 5173 --strictPort",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
  } : undefined,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:5173",
    channel: process.env.E2E_BROWSER_CHANNEL || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
