import type { Page } from "@playwright/test";

// Log in without Telegram: mint a real ss_session cookie through the
// TEST-ONLY /api/test/login route (backend needs ALLOW_TEST_AUTH=1).
// page.request shares cookies with the page context, so after this POST the
// browser is authenticated. Must run before the first page.goto().
export async function loginAs(page: Page, uid = "e2e-user") {
  const res = await page.request.post("/api/test/login", {
    data: { uid, name: "E2E User" },
  });
  if (!res.ok()) throw new Error(`test login failed: ${res.status()}`);
  await page.addInitScript(() => {
    localStorage.setItem("ss_had_session", "1");
  });
}
