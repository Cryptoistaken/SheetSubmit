import { devices, expect, test } from "@playwright/test";

test.use({ ...devices["Pixel 7"] }); // same mobile view as the local suite

// LIVE-site smoke (prod!). Skipped unless explicitly enabled:
//   LIVE_SMOKE=1 SS_SESSION=<ss_session cookie> E2E_BASE_URL=https://sheetsubmit.pages.dev
// What it does (minimal, reversible, owner-consented):
//   home loads authed -> create 1-row file -> open + type one cell ->
//   archive + purge it -> verify gone.
// What it NEVER does: press Check (no FB/check-service calls), take pool rows,
// touch anyone else's data. Pool gets 1 fake row for seconds, wiped on delete.
const LIVE = process.env.LIVE_SMOKE === "1";
const SS_SESSION = process.env.SS_SESSION ?? "";
const BASE = process.env.E2E_BASE_URL ?? "";

test.skip(!LIVE || !SS_SESSION || !BASE.includes("pages.dev"), "live smoke needs LIVE_SMOKE=1 + SS_SESSION + live E2E_BASE_URL");

test("live: create, type, delete one file", async ({ page }) => {
  const host = new URL(BASE).hostname;
  const token = SS_SESSION.replace(/^ss_session=/, "");
  await page.context().addCookies([
    { name: "ss_session", value: token, domain: host, path: "/" },
  ]);
  await page.addInitScript(() => {
    localStorage.setItem("ss_had_session", "1");
    // Prod web calls the backend directly (cross-origin, cookie not sent).
    // Pin the same-origin proxy so authed calls carry this session cookie.
    localStorage.setItem("ss_api_proxy", "1");
  });

  await page.goto("/");
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator("#homeTabBar")).toBeVisible({ timeout: 15000 });

  const created = await page.request.post("/api/files", {
    data: {
      name: `LIVE CHECK DELETE ME ${Date.now()}`,
      preset: "cookie",
      columns: [
        { key: "cookies", label: "cookies", width: 340 },
        { key: "uid", label: "uid", width: 120 },
      ],
      rows: [{ cookies: "c_user=61590000000001; xs=livecheck", uid: "61590000000001" }],
    },
  });
  const body = await created.text();
  expect(created.ok(), `live create failed: ${created.status()} ${body.slice(0, 300)}`).toBeTruthy();
  const file = JSON.parse(body) as { id: string };

  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible({ timeout: 15000 });
  await expect(page.locator("table.grid")).toContainText("61590000000001");

  // Type one more row the mobile way (double-tap pastes from clipboard).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((t) => navigator.clipboard.writeText(t), "c_user=61590000000002; xs=livecheck");
  await page.locator('td.dc[data-row="1"][data-col="cookies"]').dblclick();
  await expect(page.locator('td.dc[data-row="1"][data-col="uid"]')).toHaveAttribute(
    "aria-label", "61590000000002", { timeout: 8000 },
  );

  // Cleanup: archive (wipes pool rows) then purge, verify gone.
  const archived = await page.request.delete(`/api/files/${file.id}`);
  expect(archived.ok(), `live archive failed: ${archived.status()}`).toBeTruthy();
  const purged = await page.request.delete(`/api/archive/${file.id}`);
  expect(purged.ok(), `live purge failed: ${purged.status()}`).toBeTruthy();
  const gone = await page.request.get(`/api/files/${file.id}/full`);
  expect(gone.status()).toBe(404);
});
