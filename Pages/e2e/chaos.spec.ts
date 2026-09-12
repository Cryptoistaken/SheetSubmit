import { devices, expect, test, type Page } from "@playwright/test";
import { loginAs } from "./auth";
import { cell, createPageFile, expectConverged, installFakeChecks, loadFixture, pasteRow } from "./helpers";

// Chaos suite: hostile environments around the same no-loss guarantee —
// offline/reconnect, slow link, backgrounded app, low-end CPU, crash recovery
// (IndexedDB mirror replay). Serial (real OS clipboard; see playwright config).
test.use({
  ...devices["Pixel 7"],
});

async function openFreshFile(page: Page, tag: string) {
  const rows = loadFixture("Page.xlsx");
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const id = await createPageFile(page, `e2e chaos ${tag} ${Date.now()}`);
  await page.goto(`/file/${id}`);
  await expect(page.locator("table.grid")).toBeVisible();
  return { rows, id };
}

test("chaos: offline edits survive reconnect (no loss)", async ({ page }) => {
  test.setTimeout(150000);
  const { rows, id } = await openFreshFile(page, "offline");
  await pasteRow(page, 0, rows[0], true); // baseline lands online
  await page.context().setOffline(true);
  await pasteRow(page, 1, rows[1], true); // commits locally while offline
  await pasteRow(page, 2, rows[2], true);
  // Local grid kept both rows even though the server could not be reached.
  await expect(cell(page, 2, "uid")).toHaveAttribute("aria-label", rows[2].uid);
  await page.context().setOffline(false);
  await expectConverged(page, id, rows.slice(0, 3), true);
});

test("chaos: slow link (400ms latency, 50KB/s) loses nothing", async ({ page }) => {
  test.setTimeout(240000);
  const { rows, id } = await openFreshFile(page, "slowlink");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 400,
    downloadThroughput: 50 * 1024,
    uploadThroughput: 30 * 1024,
  });
  await pasteRow(page, 0, rows[0], true);
  await pasteRow(page, 1, rows[1], true);
  await pasteRow(page, 2, rows[2], true);
  await expectConverged(page, id, rows.slice(0, 3), true, 120000);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
});

test("chaos: backgrounding mid-edit then returning loses nothing", async ({ page }) => {
  test.setTimeout(120000);
  const { rows, id } = await openFreshFile(page, "background");
  await pasteRow(page, 0, rows[0], true);
  // App goes to background: the store flushes pending edits on hide.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(250);
  // Back to foreground: any still-pending edits flush again.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expectConverged(page, id, rows.slice(0, 1), true);
});

test("chaos: 6x CPU throttled (low-end) device loses nothing", async ({ page }) => {
  test.setTimeout(300000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const { rows, id } = await openFreshFile(page, "lowend");
  await pasteRow(page, 0, rows[0], true);
  await pasteRow(page, 1, rows[1], true);
  await expectConverged(page, id, rows.slice(0, 2), true, 180000);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});

test("chaos: crash while offline — reopen replays the IndexedDB mirror", async ({ page, context }) => {
  test.setTimeout(180000);
  const { rows, id } = await openFreshFile(page, "crash");
  await pasteRow(page, 0, rows[0], true); // baseline lands online
  await context.setOffline(true);
  await pasteRow(page, 1, rows[1], true); // commit lives only in memory + IDB mirror
  await page.waitForTimeout(400); // let the mirror write settle
  await page.close(); // simulated app kill (unload flush cannot reach the server offline)
  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto(`/file/${id}`);
  await expect(reopened.locator("table.grid")).toBeVisible();
  await expectConverged(reopened, id, rows.slice(0, 2), true);
});
