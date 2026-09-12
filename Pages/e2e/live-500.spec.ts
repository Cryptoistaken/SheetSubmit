import { devices, expect, test } from "@playwright/test";
import * as path from "node:path";
import XLSX from "xlsx";

// LIVE 500-row test (prod!). Skipped unless explicitly enabled:
//   LIVE_500=1 SS_SESSION=<ss_session> E2E_BASE_URL=https://sheetsubmit.pages.dev
// Owner-consented bulk run with FAKE generated data:
//   - unique pool password per run -> fake rows NEVER touch shared pools
//   - auto-checks OFF while typing -> exactly ONE manual Check at the end
//   - archive + purge after -> verify 404
// Expectation on live: fake UIDs come back DEAD from the real check service,
// fake cookies never eligible. This proves render/type/persist/check at scale.
const LIVE = process.env.LIVE_500 === "1";
const SS_SESSION = process.env.SS_SESSION ?? "";
const BASE = process.env.E2E_BASE_URL ?? "";

test.use({ ...devices["Pixel 7"] });

test.skip(!LIVE || !SS_SESSION || !BASE.includes("pages.dev"), "live 500 needs LIVE_500=1 + SS_SESSION + live E2E_BASE_URL");

interface FixtureRow {
  cookies: string;
  twofakey: string;
  uid: string;
}

function loadFixture(): FixtureRow[] {
  const file = path.resolve(import.meta.dirname, "../../test/Page500.xlsx");
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

test("live: type 500 fake rows, check, delete", async ({ page }) => {
  test.setTimeout(1800000); // live latency x 1000 pastes + one big sweep
  const rows = loadFixture();
  expect(rows.length).toBe(500);
  const host = new URL(BASE).hostname;
  await page.context().addCookies([
    { name: "ss_session", value: SS_SESSION.replace(/^ss_session=/, ""), domain: host, path: "/" },
  ]);
  await page.addInitScript(() => {
    localStorage.setItem("ss_had_session", "1");
    localStorage.setItem("ss_api_proxy", "1"); // same-origin API so the cookie is sent
    localStorage.setItem("ss_autoCheck", "false"); // quiet typing; one Check at end
    localStorage.setItem("ss_pageSimple", "false");
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const password = `e2e-live-${Date.now()}`; // isolated pool: nobody else sees these rows
  const created = await page.request.post("/api/files", {
    data: {
      name: `LIVE 500 DELETE ME ${Date.now()}`,
      preset: "page",
      password,
      columns: [
        { key: "cookies", label: "cookies", width: 340 },
        { key: "twofakey", label: "2fa key", width: 200 },
        { key: "uid", label: "uid", width: 120 },
      ],
      rows: [],
    },
  });
  const body = await created.text();
  expect(created.ok(), `live create failed: ${created.status()} ${body.slice(0, 300)}`).toBeTruthy();
  const file = JSON.parse(body) as { id: string };
  await page.goto(`/file/${file.id}`);
  await expect(page.locator("table.grid")).toBeVisible({ timeout: 20000 });

  const cell = (r: number, c: string) => page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);
  const copyToClipboard = async (text: string) => {
    await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    for (let k = 0; k < 20; k++) {
      if ((await page.evaluate(() => navigator.clipboard.readText())) === text) return;
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
    }
    throw new Error("clipboard would not settle");
  };
  const pasteAndVerify = async (r: number, c: string, text: string, verify: () => Promise<void>) => {
    for (let t = 0; t < 5; t++) {
      await copyToClipboard(text);
      await cell(r, c).dblclick({ timeout: 15000 });
      try {
        await verify();
        if (t > 0) console.log(`  row ${r} col ${c}: pasted after ${t + 1} tries`);
        return;
      } catch {
        console.log(`  row ${r} col ${c}: retry ${t + 1}`);
      }
    }
    await copyToClipboard(text);
    await cell(r, c).dblclick({ timeout: 15000 });
    await verify();
  };
  const normKey = (k: string) => k.replace(/[\s\-]/g, "").toUpperCase();
  const addRowBtn = page.getByRole("button", { name: "Add row" });
  const showMoreBtn = page.getByText(/Show \d+ more rows\./);
  const t0 = Date.now();

  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % 100 === 0) {
      // Works with or without the auto-spare-rows build: explicit batch add.
      await addRowBtn.click();
      if ((await showMoreBtn.count()) > 0) {
        await showMoreBtn.first().click();
      }
      console.log(`row ${i}: batch, +${Math.round(Date.now() - t0)}ms total`);
    } else if ((await showMoreBtn.count()) > 0) {
      await showMoreBtn.first().click();
    }
    await pasteAndVerify(i, "cookies", rows[i].cookies, () =>
      expect(cell(i, "uid")).toHaveAttribute("aria-label", rows[i].uid, { timeout: 3000 }),
    );
    await pasteAndVerify(i, "twofakey", rows[i].twofakey, () =>
      expect(cell(i, "twofakey")).toHaveAttribute("aria-label", normKey(rows[i].twofakey), { timeout: 3000 }),
    );
    if (i % 25 === 0) console.log(`row ${i}: ok, +${Math.round(Date.now() - t0)}ms total`);
  }

  // One manual Check over everything (real services, fake data).
  await page.evaluate(() => {
    localStorage.setItem("ss_autoCheck", "true");
    localStorage.setItem("ss_pageSimple", "true");
  });
  const [checkRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/fb/check") && r.request().method() === "POST",
      { timeout: 60000 },
    ),
    page.locator("button.check-split-main").click(),
  ]);
  expect(checkRes.ok()).toBeTruthy();

  const counts = async () => {
    const res = await page.request.get(`/api/files/${file.id}/rows`);
    if (!res.ok()) return { data: -1, judged: -1, eligible: -1 };
    const all = (await res.json()) as Record<string, unknown>[];
    const data = all.filter((x) => x["cookies"] || x["uid"]);
    return {
      data: data.length,
      judged: data.filter((x) => x["status"] === "good" || x["status"] === "bad").length,
      eligible: data.filter((x) => String(x["check_status"] ?? "") === "eligible").length,
    };
  };
  await expect.poll(async () => (await counts()).data, { timeout: 120000 }).toBe(500);
  const final = await counts();
  console.log(`live verdicts: ${JSON.stringify(final)} (fake data: expect all judged, ~0 eligible)`);
  await expect.poll(async () => (await counts()).judged, { timeout: 300000 }).toBe(500);

  // No loss: spot-check first/middle/last rows fully.
  const saved = await page.request.get(`/api/files/${file.id}/rows`);
  expect(saved.ok()).toBeTruthy();
  const savedRows = ((await saved.json()) as Record<string, unknown>[]).filter(
    (x) => x["cookies"] || x["uid"],
  );
  expect(savedRows.length).toBe(500);
  for (const r of [rows[0], rows[249], rows[499]]) {
    const hit = savedRows.find((d) => String(d["uid"] ?? "") === r.uid);
    expect(hit, `uid ${r.uid} missing on live`).toBeTruthy();
    expect(String(hit!["cookies"] ?? "")).toContain(`c_user=${r.uid}`);
    expect(String(hit!["twofakey"] ?? "")).toBe(normKey(r.twofakey));
  }

  // Cleanup: archive (wipes the isolated pool rows) then purge, verify gone.
  // Prod caches the file list ~5s, so an instant purge can 404 — retry it.
  const archived = await page.request.delete(`/api/files/${file.id}`);
  expect(archived.ok(), `live archive failed: ${archived.status()}`).toBeTruthy();
  let purgedOk = false;
  for (let k = 0; k < 8 && !purgedOk; k++) {
    const purged = await page.request.delete(`/api/archive/${file.id}`);
    purgedOk = purged.ok();
    if (!purgedOk) await page.waitForTimeout(2000);
  }
  expect(purgedOk, "live purge failed after retries").toBeTruthy();
  const gone = await page.request.get(`/api/files/${file.id}/full`);
  expect(gone.status()).toBe(404);
  console.log("live file archived + purged, pool rows wiped");
});
