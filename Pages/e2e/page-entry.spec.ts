import { devices, expect, test, type Page } from "@playwright/test";
import * as path from "node:path";
import XLSX from "xlsx";
import { loginAs } from "./auth";

// Mobile-only spreadsheet tests: real touch flow (tap + double-tap paste),
// real fixtures test/*.xlsx, real app (local backend + test DB).
// Only the external liveness/page calls are faked via page.route.
test.use({
  ...devices["Pixel 7"],
});

interface FixtureRow {
  cookies: string;
  twofakey: string;
  uid: string;
}

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

function loadFixture(xlsx: string): FixtureRow[] {
  const file = path.resolve(import.meta.dirname, "../../test", xlsx);
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

// Deterministic demo mapping: first half of rows alive (+ Page-eligible
// for page files), second half dead. (5-row files: 3 alive, 2 dead.)
async function installFakeChecks(page: Page, rows: FixtureRow[]) {
  const half = Math.ceil(rows.length / 2);
  const valid = rows.slice(0, half).map((r) => r.uid);
  const dead = rows.slice(half).map((r) => r.uid);

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
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ eligible: valid.slice(0, 2).includes(uid), banReason: null, linkedNumber: null, error: null }),
    });
  });
  await page.route("**/api/wa/cache*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ cache: {} }),
    });
  });
}

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

test("mobile: page-500 typed cell-by-cell + check + no loss", async ({ page }) => {
  test.setTimeout(600000); // 1000 double-tap pastes, local but many
  const rows = loadFixture("Page500.xlsx");
  expect(rows.length).toBe(500);
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    localStorage.setItem("ss_autoCheck", "true");
    localStorage.setItem("ss_pageSimple", "true");
  });
  const created = await page.request.post("/api/files", {
    data: {
      name: `e2e page 500 typed ${Date.now()}`,
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
  expect(created.ok(), `create file failed: ${created.status()} ${body.slice(0, 500)}`).toBeTruthy();
  const file = JSON.parse(body) as { id: string };
  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible();

  const cell = (r: number, c: string) => page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);
  // Pasting a 2fa key auto-copies its TOTP code to the clipboard a moment
  // later — so verify each write stuck before pasting (else the code wins).
  const copyToClipboard = async (text: string) => {
    const write = (t: string) => navigator.clipboard.writeText(t);
    const read = () => navigator.clipboard.readText();
    await page.evaluate(write, text);
    for (let k = 0; k < 20; k++) {
      if ((await page.evaluate(read)) === text) return;
      await page.evaluate(write, text);
    }
    throw new Error("clipboard would not settle");
  };
  const showMoreBtn = page.getByText(/Show \d+ more rows\./);

  // Type all 500 rows like a user: cookie -> 2fa per row, uid auto-fills.
  // The app auto-creates 10 spare rows near the end — just reveal them.
  // Under load a double-tap can split into two single taps (edit bar opens,
  // nothing pastes) — so every paste verifies and retries until it lands.
  const pasteAndVerify = async (r: number, c: string, text: string, verify: () => Promise<void>) => {
    for (let t = 0; t < 5; t++) {
      await copyToClipboard(text);
      await cell(r, c).dblclick({ timeout: 10000 });
      try {
        await verify();
        if (t > 0) console.log(`  row ${r} col ${c}: pasted after ${t + 1} tries`);
        return;
      } catch {
        console.log(`  row ${r} col ${c}: retry ${t + 1} (edit bar split?)`);
      }
    }
    await copyToClipboard(text);
    await cell(r, c).dblclick({ timeout: 10000 });
    await verify();
  };
  const normKey = (k: string) => k.replace(/[\s\-]/g, "").toUpperCase();
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    if ((await showMoreBtn.count()) > 0) {
      await showMoreBtn.first().click();
    }
    await pasteAndVerify(i, "cookies", rows[i].cookies, () =>
      expect(cell(i, "uid")).toHaveAttribute("aria-label", rows[i].uid, { timeout: 2000 }),
    );
    await pasteAndVerify(i, "twofakey", rows[i].twofakey, () =>
      expect(cell(i, "twofakey")).toHaveAttribute("aria-label", normKey(rows[i].twofakey), { timeout: 2000 }),
    );
    if (i % 25 === 0) {
      await expect(cell(i, "uid")).toHaveAttribute("aria-label", rows[i].uid);
      console.log(`row ${i}: ok, +${Math.round(Date.now() - t0)}ms total`);
    }
  }

  const [checkRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/fb/check") && r.request().method() === "POST",
      { timeout: 15000 },
    ),
    page.locator("button.check-split-main").click(),
  ]);
  expect(checkRes.ok()).toBeTruthy();

  // Fake says first 250 alive+eligible, last 250 dead. Poll the server
  // until client sweeps + debounced persists converge.
  const counts = async () => {
    const res = await page.request.get(`/api/files/${file.id}/rows`);
    if (!res.ok()) return { data: -1, good: -1, bad: -1, eligible: -1 };
    const all = (await res.json()) as Record<string, unknown>[];
    const data = all.filter((x) => x["cookies"] || x["uid"]);
    return {
      data: data.length,
      good: data.filter((x) => x["status"] === "good").length,
      bad: data.filter((x) => x["status"] === "bad").length,
      eligible: data.filter((x) => String(x["check_status"] ?? "") === "eligible").length,
    };
  };
  await expect
    .poll(async () => (await counts()).good, { timeout: 60000 })
    .toBe(250);
  await expect
    .poll(async () => (await counts()).bad, { timeout: 60000 })
    .toBe(250);
  await expect
    .poll(async () => (await counts()).eligible, { timeout: 60000 })
    .toBe(250);

  // Grid spot-check: first viewport rows colored eligible.
  await expect(page.locator("tr.st-eligible").first()).toBeVisible();

  // No loss: all 500 rows complete on the server.
  const saved = await page.request.get(`/api/files/${file.id}/rows`);
  expect(saved.ok()).toBeTruthy();
  const savedRows = ((await saved.json()) as Record<string, unknown>[]).filter(
    (x) => x["cookies"] || x["uid"],
  );
  expect(savedRows.length).toBe(500);
  for (const r of rows) {
    const hit = savedRows.find((d) => String(d["uid"] ?? "") === r.uid);
    expect(hit, `uid ${r.uid} missing on server`).toBeTruthy();
    expect(String(hit!["cookies"] ?? "")).toContain(`c_user=${r.uid}`);
    expect(String(hit!["twofakey"] ?? "")).toBe(r.twofakey.replace(/[\s\-]/g, "").toUpperCase());
  }
});
