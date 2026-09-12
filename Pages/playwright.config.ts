import { defineConfig } from "@playwright/test";

// Automated browser tests (real Chromium, like a user but scripted).
// Needs the app running: backend (ALLOW_TEST_AUTH=1, test DB — never prod)
// + web build served via Pages/server.js so /api is same-origin.
//   E2E_BASE_URL=http://127.0.0.1:8080 bunx playwright test
// Auth bypasses Telegram: tests mint ss_session via POST /api/test/login
// (404s unless the backend has ALLOW_TEST_AUTH=1). See e2e/auth.ts.
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // Single worker: these tests paste through the REAL OS clipboard
  // (navigator.clipboard + double-tap), so parallel browsers steal each
  // other's clipboard contents. Serial keeps settle loops deterministic.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
