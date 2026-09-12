import { devices, expect, test } from "@playwright/test";
import { loginAs } from "./auth";
import { cell as cellLoc, copyToClipboard, installFakeChecks, loadFixture, normKey } from "./helpers";

// Deep scale test: 500 rows typed cell-by-cell (1000 double-tap pastes), one
// manual Check, then a full field-by-field no-loss proof.
// Excluded from the fast default suite (`test:e2e` filters @deep):
//   bun run test:e2e:deep   (or: npx playwright test e2e --grep @deep)
test.use({
  ...devices["Pixel 7"],
});

test("mobile: page-500 typed cell-by-cell + check + no loss", { tag: "@deep" }, async ({ page }) => {
  test.setTimeout(600000); // 1000 double-tap pastes, local but many
  const rows = loadFixture("Page500.xlsx");
  expect(rows.length).toBe(500);
  await loginAs(page);
  await installFakeChecks(page, rows);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  // Speed: no per-paste UID/page sweeps while typing 1000 cells — one manual
  // Check at the end exercises the real sweep instead.
  await page.addInitScript(() => {
    localStorage.setItem("ss_autoCheck", "false");
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

  const cell = (r: number, c: string) => cellLoc(page, r, c);
  const showMoreBtn = page.getByText(/Show \d+ more rows\./);

  // Type all 500 rows like a user: cookie -> 2fa per row, uid auto-fills.
  // The app auto-creates 10 spare rows near the end — just reveal them.
  // Under load a double-tap can split into two single taps (edit bar opens,
  // nothing pastes) — so every paste verifies and retries until it lands.
  const pasteAndVerify = async (r: number, c: string, text: string, verify: () => Promise<void>) => {
    for (let t = 0; t < 5; t++) {
      await copyToClipboard(page, text);
      await cell(r, c).dblclick({ timeout: 10000 });
      try {
        await verify();
        if (t > 0) console.log(`  row ${r} col ${c}: pasted after ${t + 1} tries`);
        return;
      } catch {
        console.log(`  row ${r} col ${c}: retry ${t + 1} (edit bar split?)`);
      }
    }
    await copyToClipboard(page, text);
    await cell(r, c).dblclick({ timeout: 10000 });
    await verify();
  };
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

  // Enable paste auto-checks again for the final manual Check sweep.
  await page.evaluate(() => localStorage.setItem("ss_autoCheck", "true"));
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

  // No loss: all 500 rows complete on the server. Persists are debounced and
  // retried after failures — poll until the last edits flush (this still fails
  // hard when a value never converges: that would be real data loss).
  await expect
    .poll(
      async () => {
        const saved = await page.request.get(`/api/files/${file.id}/rows`);
        if (!saved.ok()) return `rows fetch ${saved.status()}`;
        const savedRows = ((await saved.json()) as Record<string, unknown>[]).filter(
          (x) => x["cookies"] || x["uid"],
        );
        if (savedRows.length !== rows.length) return `rows ${savedRows.length}/${rows.length}`;
        for (const r of rows) {
          const hit = savedRows.find((d) => String(d["uid"] ?? "") === r.uid);
          if (!hit) return `uid ${r.uid} missing on server`;
          if (!String(hit["cookies"] ?? "").includes(`c_user=${r.uid}`)) return `cookies missing for ${r.uid}`;
          if (String(hit["twofakey"] ?? "") !== normKey(r.twofakey)) {
            return `2fa missing for ${r.uid}: ${JSON.stringify(hit["twofakey"] ?? null)}`;
          }
        }
        return "complete";
      },
      { timeout: 120000, message: "server rows never converged (data loss)" },
    )
    .toBe("complete");
});
