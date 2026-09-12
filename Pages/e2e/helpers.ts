import { expect, type Page } from "@playwright/test";
import * as path from "node:path";
import XLSX from "xlsx";

// Shared mobile-e2e helpers (page-entry + page-500 + chaos specs).
export interface FixtureRow {
  cookies: string;
  twofakey: string;
  uid: string;
}

export const PAGE_COLUMNS = [
  { key: "cookies", label: "cookies", width: 340 },
  { key: "twofakey", label: "2fa key", width: 200 },
  { key: "uid", label: "uid", width: 120 },
];

export function loadFixture(xlsx: string): FixtureRow[] {
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
export async function installFakeChecks(page: Page, rows: FixtureRow[]) {
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
      body: JSON.stringify({ eligible, banReason: null, linkedNumber: null, pageName: eligible ? "Demo Page" : null, error: null }),
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
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ cache: {} }) });
  });
}

/** Create an empty page file through the API (test user must be logged in). */
export async function createPageFile(page: Page, name: string): Promise<string> {
  const created = await page.request.post("/api/files", {
    data: { name, preset: "page", columns: PAGE_COLUMNS, rows: [] },
  });
  const body = await created.text();
  expect(created.ok(), `create file failed: ${created.status()} ${body.slice(0, 300)}`).toBeTruthy();
  return (JSON.parse(body) as { id: string }).id;
}

export const cell = (page: Page, r: number, c: string) =>
  page.locator(`td.dc[data-row="${r}"][data-col="${c}"]`);

export const normKey = (k: string) => k.replace(/[\s\-]/g, "").toUpperCase();

export async function copyToClipboard(page: Page, text: string): Promise<void> {
  const write = (t: string) => navigator.clipboard.writeText(t);
  await page.evaluate(write, text);
  for (let k = 0; k < 20; k++) {
    if ((await page.evaluate(() => navigator.clipboard.readText())) === text) return;
    await page.evaluate(write, text);
  }
  throw new Error("clipboard would not settle");
}

/** Double-tap paste one fixture row (cookies [+ 2fa]) and verify the cell values. */
export async function pasteRow(page: Page, r: number, row: FixtureRow, withTwofa: boolean): Promise<void> {
  await copyToClipboard(page, row.cookies);
  await cell(page, r, "cookies").dblclick({ timeout: 10000 });
  await expect(cell(page, r, "uid")).toHaveAttribute("aria-label", row.uid, { timeout: 5000 });
  if (withTwofa) {
    await copyToClipboard(page, row.twofakey);
    await cell(page, r, "twofakey").dblclick({ timeout: 10000 });
    await expect(cell(page, r, "twofakey")).toHaveAttribute("aria-label", normKey(row.twofakey), { timeout: 5000 });
  }
}

/** Server rows that carry data, read through the API request context. */
export async function serverRows(page: Page, fileId: string): Promise<Record<string, unknown>[]> {
  const res = await page.request.get(`/api/files/${fileId}/rows`);
  if (!res.ok()) return [];
  return ((await res.json()) as Record<string, unknown>[]).filter((x) => x["cookies"] || x["uid"]);
}

/** Poll until every fixture row is complete on the server (real loss fails). */
export async function expectConverged(page: Page, fileId: string, rows: FixtureRow[], withTwofa: boolean, timeout = 60000): Promise<void> {
  await expect
    .poll(
      async () => {
        const saved = await serverRows(page, fileId);
        if (saved.length < rows.length) return `rows ${saved.length}/${rows.length}`;
        for (const r of rows) {
          const hit = saved.find((d) => String(d["uid"] ?? "") === r.uid);
          if (!hit) return `uid ${r.uid} missing`;
          if (!String(hit["cookies"] ?? "").includes(`c_user=${r.uid}`)) return `cookies missing for ${r.uid}`;
          if (withTwofa && String(hit["twofakey"] ?? "") !== normKey(r.twofakey)) return `2fa missing for ${r.uid}`;
        }
        return "complete";
      },
      { timeout, message: "server rows never converged (data loss)" },
    )
    .toBe("complete");
}
