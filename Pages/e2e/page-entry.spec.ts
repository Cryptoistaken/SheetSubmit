import { devices, expect, test, type Page } from "@playwright/test";
import * as path from "node:path";
import XLSX from "xlsx";
import { loginAs } from "./auth";

// Mobile-only Page spreadsheet test: real touch flow (tap + double-tap paste),
// real fixture test/Page.xlsx, real app (local backend + test DB).
// Only the external liveness/page calls are faked via page.route.
test.use({
  ...devices["Pixel 7"],
});

interface FixtureRow {
  cookies: string;
  twofakey: string;
  uid: string;
}

function loadPageFixture(): FixtureRow[] {
  const file = path.resolve(import.meta.dirname, "../../test/Page.xlsx");
  const wb = XLSX.readFile(file);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: "" });
  return json
    .map((r) => {
      const cookies = String(r[0] ?? "");
      const twofakey = String(r[1] ?? "");
      const uid = cookies.match(/c_user=(\d+)/)?.[1] ?? "";
      return { cookies, twofakey, uid };
    })
    .filter((r) => r.cookies.includes("c_user="));
}

// Deterministic demo mapping from the 5 fixture rows:
// first 3 UIDs alive + Page-eligible, last 2 dead, first 2 WA-eligible.
async function installFakeChecks(page: Page, rows: FixtureRow[]) {
  const valid = rows.slice(0, 3).map((r) => r.uid);
  const dead = rows.slice(3).map((r) => r.uid);
  const waEligible = rows.slice(0, 2).map((r) => r.uid);

  await page.route("**/api/fb/check", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ valid, dead, uncertain: [] }),
    });
  });
  await page.route("**/api/fb/page-simple", async (route) => {
    let post: Record<string, unknown> = {}; try { post = (route.request().postDataJSON() as Record<string, unknown>) ?? {}; } catch { post = {}; }
    const uid = String(post.cookie ?? "").match(/c_user=(\d+)/)?.[1] ?? "";
    const eligible = valid.includes(uid);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        eligible,
        banReason: null,
        linkedNumber: null,
        pageName: eligible ? "Demo Page" : null,
        error: null,
      }),
    });
  });
  await page.route("**/api/fb/page-advanced", async (route) => {
    let post: Record<string, unknown> = {}; try { post = (route.request().postDataJSON() as Record<string, unknown>) ?? {}; } catch { post = {}; }
    const uid = String(post.cookie ?? "").match(/c_user=(\d+)/)?.[1] ?? "";
    const eligible = waEligible.includes(uid);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ eligible, banReason: null, linkedNumber: null, error: null }),
    });
  });
  await page.route("**/api/wa/cache*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cache: {} }),
    });
  });
  return { valid, dead };
}

test("mobile: double-tap paste Page.xlsx cell-by-cell, row by row", async ({ page }) => {
  const rows = loadPageFixture();
  expect(rows.length).toBe(5);
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    localStorage.setItem("ss_autoCheck", "true");
    localStorage.setItem("ss_pageSimple", "true");
  });
  // Empty sheet like a user starting fresh — the grid pads to 100 blank rows.
  // NOTE: columns must be stored (like a real xlsx upload detects them),
  // otherwise isPageFile() is false and the Page sweep never runs.
  const created = await page.request.post("/api/files", {
    data: {
      name: `e2e page mobile ${Date.now()}`,
      preset: "page",
      columns: [
        { key: "cookies", label: "cookies", width: 340 },
        { key: "twofakey", label: "2fa key", width: 200 },
        { key: "uid", label: "uid", width: 120 },
      ],
      rows: [],
    },
  });
  const body = await created.text();
  expect(created.ok(), `create page file failed: ${created.status()} ${body.slice(0, 500)}`).toBeTruthy();
  const file = JSON.parse(body) as { id: string };
  page.on("request", (r) => {
    if (r.url().includes("/api/")) console.log(`API> ${r.method()} ${r.url().split("/api/")[1]}`);
  });
  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible();

  const cell = (r: number, c: string) => page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);
  const copyToClipboard = (text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);

  // Typo like a real user: junk cookie double-tapped in -> red invalid cell.
  await copyToClipboard("junk-without-cuser");
  await cell(0, "cookies").dblclick();
  await expect(cell(0, "cookies")).toHaveClass(/cell-invalid/);

  // Correct it the mobile way: tap a scratch cell first (settles any
  // selection state), then tap the typo cell to open the QuickEditBar,
  // then Paste commits the clipboard over the typo.
  await copyToClipboard(rows[0].cookies);
  await page.keyboard.press("Escape");
  await cell(9, "cookies").tap();
  await cell(0, "cookies").tap();
  await page.locator('.qeb-bar button[aria-label="Paste cell"]').click();
  await expect(cell(0, "cookies")).not.toHaveClass(/cell-invalid/);
  await expect(cell(0, "uid")).toHaveAttribute("aria-label", rows[0].uid);

  // Type every row cell-by-cell: cookie -> 2fa, uid auto-fills from c_user.
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) {
      await copyToClipboard(rows[i].cookies);
      await cell(i, "cookies").dblclick();
      await expect(cell(i, "uid")).toHaveAttribute("aria-label", rows[i].uid);
    }
    await copyToClipboard(rows[i].twofakey);
    await cell(i, "twofakey").dblclick();
    await expect(cell(i, "twofakey")).not.toHaveClass(/cell-invalid/);
  }

  // Each commit auto-ran the fake UID + Page checks; force one full sweep too.
  const [checkRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/fb/check") && r.request().method() === "POST",
    ),
    page.locator("button.check-split-main").click(),
  ]);
  expect(checkRes.ok()).toBeTruthy();

  // Fake says: first 3 alive+eligible, last 2 dead (local = fast, 10s max).
  await expect(page.locator("tr.st-eligible").first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator("tr.st-dead").first()).toBeVisible({ timeout: 10000 });

  // Nothing lost: every fixture row must exist on screen AND on the server.
  // Persist is debounced — poll the server until it converges (local: fast).
  const gridText = await page.locator("table.grid").innerText();
  for (const r of rows) {
    expect(gridText).toContain(r.uid);
    expect(gridText).toContain(r.twofakey.replace(/[\s\-]/g, "").toUpperCase().slice(0, 8));
  }
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/files/${file.id}/rows`);
        if (!res.ok()) return -1;
        const all = (await res.json()) as Record<string, unknown>[];
        return all.filter((x) => x["cookies"] || x["uid"]).length;
      },
      { timeout: 10000 },
    )
    .toBe(rows.length);
  const saved = await page.request.get(`/api/files/${file.id}/rows`);
  expect(saved.ok()).toBeTruthy();
  const savedRows = (await saved.json()) as Record<string, unknown>[];
  const dataRows = savedRows.filter((r) => r["cookies"] || r["uid"]);
  expect(dataRows.length).toBe(rows.length);
  for (const r of rows) {
    const hit = dataRows.find((d) => String(d["uid"] ?? "") === r.uid);
    expect(hit, `uid ${r.uid} missing on server`).toBeTruthy();
    expect(String(hit!["cookies"] ?? "")).toContain(`c_user=${r.uid}`);
    expect(String(hit!["twofakey"] ?? "")).toBe(r.twofakey.replace(/[\s\-]/g, "").toUpperCase());
  }
});
