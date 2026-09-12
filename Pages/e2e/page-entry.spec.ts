import { devices, expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { installFakeChecks, loadFixture } from "./helpers";

// Mobile-only spreadsheet tests: real touch flow (tap + double-tap paste),
// real fixtures test/*.xlsx, real app (local backend + test DB).
// Only the external liveness/page calls are faked via page.route.
test.use({
  ...devices["Pixel 7"],
});

interface PresetCfg {
  /** test name + fixture file + backend preset */
  label: string;
  xlsx: string;
  preset: "cookie" | "combo" | "page";
  columns: { key: string; label: string; width: number }[];
  /** type the 2fa column too (cookie files don't have one) */
  withTwofa: boolean;
  /** page files get the Page-eligible sweep; others only UID check */
  expectEligible: boolean;
  /** include the typo -> QuickEditBar-paste correction demo */
  typoDemo: boolean;
}

const PRESETS: PresetCfg[] = [
  {
    label: "cookie",
    xlsx: "cookie.xlsx",
    preset: "cookie",
    columns: [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "uid", label: "uid", width: 120 },
    ],
    withTwofa: false,
    expectEligible: false,
    typoDemo: false,
  },
  {
    label: "2fa",
    xlsx: "2fa.xlsx",
    preset: "combo",
    columns: [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "twofakey", label: "2fa key", width: 200 },
      { key: "uid", label: "uid", width: 120 },
    ],
    withTwofa: true,
    expectEligible: false,
    typoDemo: false,
  },
  {
    label: "page",
    xlsx: "Page.xlsx",
    preset: "page",
    columns: [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "twofakey", label: "2fa key", width: 200 },
      { key: "uid", label: "uid", width: 120 },
    ],
    withTwofa: true,
    expectEligible: true,
    typoDemo: true,
  },
];

test("mobile: page auto-check runs on paste, skips just-edited row", async ({ page }) => {
  const rows = loadFixture("Page.xlsx");
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    localStorage.setItem("ss_autoCheck", "true");
    localStorage.setItem("ss_pageSimple", "true");
  });
  const created = await page.request.post("/api/files", {
    data: {
      name: `e2e page auto ${Date.now()}`,
      preset: "page",
      columns: [
        { key: "cookies", label: "cookies", width: 340 },
        { key: "twofakey", label: "2fa key", width: 200 },
        { key: "uid", label: "uid", width: 120 },
      ],
      rows: [],
    },
  });
  expect(created.ok()).toBeTruthy();
  const file = (await created.json()) as { id: string };
  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible();

  const cell = (r: number, c: string) => page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);
  const gridRow = (r: number) => page.locator("table.grid tbody tr").nth(r);
  const copyToClipboard = async (text: string) => {
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      for (let k = 0; k < 20; k++) {
        if ((await page.evaluate(() => navigator.clipboard.readText())) === text) return;
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      }
      throw new Error('clipboard would not settle');
    };
  const nextAutoCheck = () =>
    page.waitForResponse(
      (res) => res.url().includes("/api/fb/check") && res.request().method() === "POST",
      { timeout: 10000 },
    );

  // Row 0 pasted: auto UID check fires with NO Check press (alive dot),
  // but its own auto page sweep excludes it (not eligible yet).
  let auto = nextAutoCheck();
  await copyToClipboard(rows[0].cookies);
  await cell(0, "cookies").dblclick();
  await auto;
  await copyToClipboard(rows[0].twofakey);
  await cell(0, "twofakey").dblclick();
  await expect(gridRow(0)).toHaveClass(/st-alive/, { timeout: 10000 });
  await expect(page.locator("tr.st-eligible")).toHaveCount(0);

  // Row 1 pasted: auto sweep now covers row 0 -> eligible, row 1 stays alive.
  auto = nextAutoCheck();
  await copyToClipboard(rows[1].cookies);
  await cell(1, "cookies").dblclick();
  await auto;
  await copyToClipboard(rows[1].twofakey);
  await cell(1, "twofakey").dblclick();
  await expect(gridRow(0)).toHaveClass(/st-eligible/, { timeout: 10000 });
  await expect(gridRow(1)).toHaveClass(/st-alive/);
  await expect(gridRow(1)).not.toHaveClass(/st-eligible/);

  // Toggle auto page-check off: row 2 pastes UID-check only (alive),
  // and row 1's pending sweep never runs — eligible count stays 1.
  await page.evaluate(() => localStorage.setItem("ss_pageSimple", "false"));
  auto = nextAutoCheck();
  await copyToClipboard(rows[2].cookies);
  await cell(2, "cookies").dblclick();
  await auto;
  await copyToClipboard(rows[2].twofakey);
  await cell(2, "twofakey").dblclick();
  await expect(gridRow(2)).toHaveClass(/st-alive/, { timeout: 10000 });
  await expect(gridRow(1)).not.toHaveClass(/st-eligible/);
  await expect(page.locator("tr.st-eligible")).toHaveCount(1);

  // Toggle back on + manual Check: sweep runs, all alive rows eligible.
  await page.evaluate(() => localStorage.setItem("ss_pageSimple", "true"));
  const [checkRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/fb/check") && r.request().method() === "POST",
      { timeout: 10000 },
    ),
    page.locator("button.check-split-main").click(),
  ]);
  expect(checkRes.ok()).toBeTruthy();
  await expect(page.locator("tr.st-eligible")).toHaveCount(3, { timeout: 10000 });
});

for (const cfg of PRESETS) {
  test(`mobile: double-tap paste ${cfg.label}.xlsx cell-by-cell, row by row`, async ({ page }) => {
    const rows = loadFixture(cfg.xlsx);
    expect(rows.length).toBe(5);
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // Quiet typing first (no per-paste check storms on 500 rows), one big
  // Check at the end. Auto-check behavior is covered by the 5-row test.
  await page.addInitScript(() => {
    localStorage.setItem("ss_autoCheck", "false");
    localStorage.setItem("ss_pageSimple", "false");
  });
    // Empty sheet like a user starting fresh — the grid pads to 100 blank rows.
    // NOTE: columns must be stored (like a real xlsx upload detects them),
    // otherwise the file type (esp. page) is not recognized.
    const created = await page.request.post("/api/files", {
      data: { name: `e2e ${cfg.label} mobile ${Date.now()}`, preset: cfg.preset, columns: cfg.columns, rows: [] },
    });
    const body = await created.text();
    expect(created.ok(), `create ${cfg.label} file failed: ${created.status()} ${body.slice(0, 500)}`).toBeTruthy();
    const file = JSON.parse(body) as { id: string };
    await page.goto(`/file/${file.id}`);
    await expect(page.locator("table.grid")).toBeVisible();

    const cell = (r: number, c: string) => page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);
    const copyToClipboard = async (text: string) => {
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      for (let k = 0; k < 20; k++) {
        if ((await page.evaluate(() => navigator.clipboard.readText())) === text) return;
        await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      }
      throw new Error('clipboard would not settle');
    };

    if (cfg.typoDemo) {
      // Typo like a real user: junk cookie double-tapped in -> red invalid cell.
      await copyToClipboard("junk-without-cuser");
      await cell(0, "cookies").dblclick();
      await expect(cell(0, "cookies")).toHaveClass(/cell-invalid/);

      // Correct it the mobile way: tap a scratch cell first (settles any
      // selection state), then tap the typo cell to open the QuickEditBar,
      // then Paste commits the clipboard over the typo. Single taps open
      // the bar after the 400ms double-tap window, so wait it out twice.
      await copyToClipboard(rows[0].cookies);
      await page.keyboard.press("Escape");
      await cell(9, "cookies").tap();
      await page.waitForTimeout(600);
      await cell(0, "cookies").tap();
      await page.waitForTimeout(600);
      await page.locator('.qeb-bar button[aria-label="Paste cell"]').click();
      await expect(cell(0, "cookies")).not.toHaveClass(/cell-invalid/);
      await expect(cell(0, "uid")).toHaveAttribute("aria-label", rows[0].uid);
    }

    // Type every row cell-by-cell: cookie (-> 2fa), uid auto-fills from c_user.
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 || !cfg.typoDemo) {
        await copyToClipboard(rows[i].cookies);
        await cell(i, "cookies").dblclick();
        await expect(cell(i, "uid")).toHaveAttribute("aria-label", rows[i].uid);
      }
      if (cfg.withTwofa) {
        await copyToClipboard(rows[i].twofakey);
        await cell(i, "twofakey").dblclick();
        await expect(cell(i, "twofakey")).not.toHaveClass(/cell-invalid/);
      }
    }

    // Each commit auto-ran the fake checks; force one full sweep too.
  // One big Check at the end over all 500 typed rows.
  await page.evaluate(() => {
    localStorage.setItem("ss_autoCheck", "true");
    localStorage.setItem("ss_pageSimple", "true");
  });
  const [checkRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/api/fb/check") && r.request().method() === "POST",
      ),
      page.locator("button.check-split-main").click(),
    ]);
    expect(checkRes.ok()).toBeTruthy();

    // Fake says first 3 alive, last 2 dead (page files: alive ones eligible).
    if (cfg.expectEligible) {
      await expect(page.locator("tr.st-eligible").first()).toBeVisible({ timeout: 10000 });
    } else {
      await expect(page.locator("tr.st-alive").first()).toBeVisible({ timeout: 10000 });
    }
    await expect(page.locator("tr.st-dead").first()).toBeVisible({ timeout: 10000 });

    // Nothing lost: every fixture row must exist on screen AND on the server.
    // Persist is debounced — poll the server until it converges (local: fast).
    const gridText = await page.locator("table.grid").innerText();
    for (const r of rows) {
      expect(gridText).toContain(r.uid);
      if (cfg.withTwofa) {
        expect(gridText).toContain(r.twofakey.replace(/[\s\-]/g, "").toUpperCase().slice(0, 8));
      }
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
      if (cfg.withTwofa) {
        expect(String(hit!["twofakey"] ?? "")).toBe(r.twofakey.replace(/[\s\-]/g, "").toUpperCase());
      }
    }
  });
}
