import { describe, expect, it, mock } from "bun:test";

// xlsx seam: import/parse/build through the REAL xlsx lib (no mocks on the
// format itself — a workbook written by buildXlsx must read back through
// parseSheetRows/importXlsx). Only the api boundary (hydrateWaCache's
// getWaCache) is stubbed. buildCustomRows/splitRows already have their own
// suites; download writers that touch fs/DOM are covered only on the
// no-data path (returns false before any side effect).
const waHarness: { cache: Record<string, unknown>; throw: boolean } = { cache: {}, throw: false };

mock.module("@/lib/api", () => ({
  api: {
    getWaCache: async () => {
      if (waHarness.throw) throw new Error("down");
      return { cache: waHarness.cache };
    },
  },
}));

const XLSX = await import("xlsx");
const { importXlsx, buildXlsx, parseSheetRows, downloadSheetRows, hydrateWaCache, genId, todayStr } = await import("../xlsx");
const { buildDownloadOpts } = await import("../downloadOpts");

const COLS = [
  { key: "cookies", label: "cookies", width: 340 },
  { key: "twofakey", label: "2fa key", width: 200 },
  { key: "uid", label: "uid", width: 120 },
];

function toBuf(aoa: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("buildXlsx / parseSheetRows round-trip", () => {
  it("writes rows and reads them back cell-identical", async () => {
    const rows = [
      { cookies: "c_user=1; xs=a", twofakey: "ABCDEFGHJK", uid: "1" },
      { cookies: "c_user=2;", twofakey: "", uid: "2" },
    ];
    const back = await parseSheetRows(await buildXlsx(rows, COLS), COLS);
    expect(back).toEqual(rows);
  });

  it("drops fully-empty rows on write and strips the No_2Fa marker", async () => {
    const rows = [
      { cookies: "", twofakey: "", uid: "" },
      { cookies: "c_user=3;", twofakey: "No_2Fa", uid: "3" },
    ];
    const back = await parseSheetRows(await buildXlsx(rows, COLS), COLS);
    expect(back).toEqual([{ cookies: "c_user=3;", twofakey: "", uid: "3" }]);
  });

  it("parseSheetRows matches columns by label as well as key", async () => {
    const buf = toBuf([["cookies", "2fa key", "uid"], ["c_user=9;", "K".repeat(10), "9"]]);
    const back = await parseSheetRows(buf, COLS);
    expect(back).toEqual([{ cookies: "c_user=9;", twofakey: "K".repeat(10), uid: "9" }]);
  });

  it("parseSheetRows falls back to positional columns without a header", async () => {
    const buf = toBuf([["c_user=9;", "K".repeat(10), "9"]]);
    const back = await parseSheetRows(buf, COLS);
    expect(back).toEqual([{ cookies: "c_user=9;", twofakey: "K".repeat(10), uid: "9" }]);
  });
});

describe("importXlsx", () => {
  it("detects fb_cookie from headers and autofills uid from c_user", async () => {
    const buf = toBuf([
      ["cookies", "2fa key", "uid"],
      ["c_user=11; xs=1", "", ""],
      ["c_user=12;", "ABCDEFGHJK", "12"],
    ]);
    const res = await importXlsx(buf, "batch.xlsx", []);
    expect(res.type).toBe("fb_cookie");
    expect(res.name).toBe("batch");
    expect(res.dataCount).toBe(2);
    expect(res.rows[0].uid).toBe("11");
    expect(res.rows[1]).toMatchObject({ cookies: "c_user=12;", twofakey: "ABCDEFGHJK", uid: "12" });
    expect(typeof res.id).toBe("string");
  });

  it("reads headerless cookie blobs positionally from row 0", async () => {
    const buf = toBuf([["c_user=5; xs=1", "ABCDEFGHJK", ""]]);
    const res = await importXlsx(buf, "blob.xlsx", []);
    expect(res.type).toBe("fb_cookie");
    expect(res.dataCount).toBe(1);
    expect(res.rows[0]).toMatchObject({ cookies: "c_user=5; xs=1", twofakey: "ABCDEFGHJK", uid: "5" });
  });

  it("dedups the file name against existing files", async () => {
    const buf = toBuf([["cookies", "2fa key", "uid"], ["c_user=1;", "", "1"]]);
    const res = await importXlsx(buf, "batch.xlsx", [{ name: "batch" }]);
    expect(res.name).not.toBe("batch");
    expect(res.name.startsWith("batch (")).toBe(true);
  });

  it("rejects empty workbooks and header-only workbooks", async () => {
    await expect(importXlsx(toBuf([]), "e.xlsx", [])).rejects.toThrow("File is empty");
    await expect(importXlsx(toBuf([["cookies", "2fa key", "uid"]]), "h.xlsx", [])).rejects.toThrow("No data rows found");
  });
});

describe("buildDownloadOpts", () => {
  const rows = [
    { cookies: "c_user=1;", twofakey: "K".repeat(10), uid: "1", status: "good", wa_status: "eligible" },
    { cookies: "c_user=2;", twofakey: "K".repeat(10), uid: "2", status: "good", wa_status: "" },
    { cookies: "c_user=3;", twofakey: "", uid: "3", status: "good", wa_status: "" },
    { cookies: "", twofakey: "K".repeat(10), uid: "", status: "good", wa_status: "" },
    { cookies: "c_user=5;", twofakey: "", uid: "5", status: "bad", wa_status: "" },
    { cookies: "", twofakey: "", uid: "", status: "" },
  ];
  const byKey = Object.fromEntries(buildDownloadOpts(rows, COLS).map((o) => [o.key, o]));

  it("counts every live segment", () => {
    expect(byKey.all.count).toBe(5);
    expect(byKey.valid.count).toBe(4);
    expect(byKey.combo.count).toBe(2);
    expect(byKey.onlycookie.count).toBe(1);
    expect(byKey.only2fa.count).toBe(1);
    expect(byKey.wa.count).toBe(1);
    expect(byKey["valid-nwa"].count).toBe(3);
    expect(byKey.dead.count).toBe(1);
  });

  it("omits zero-count segments", () => {
    const keys = buildDownloadOpts([{ cookies: "c_user=1;", status: "good" }], COLS).map((o) => o.key);
    expect(keys).toContain("all");
    expect(keys).toContain("valid");
    expect(keys).not.toContain("dead");
    expect(keys).not.toContain("wa");
  });

  it("filters select exactly the rows they count", () => {
    for (const opt of buildDownloadOpts(rows, COLS)) {
      if (!opt.filter) continue;
      expect(rows.filter(opt.filter).length).toBe(opt.count);
    }
  });

  it("returns no options for an empty sheet", () => {
    expect(buildDownloadOpts([], COLS)).toEqual([]);
  });
});

describe("downloadSheetRows / hydrateWaCache", () => {
  it("downloadSheetRows returns false without touching fs when nothing is downloadable", async () => {
    expect(await downloadSheetRows([{ cookies: "", twofakey: "", uid: "" }], COLS, "x")).toBe(false);
    expect(await downloadSheetRows([], COLS, "x")).toBe(false);
  });

  it("hydrateWaCache fills eligible/ineligible rows from the cache", async () => {
    waHarness.throw = false;
    waHarness.cache = {
      "1": { status: "eligible", banReason: null, pageName: "P", linkedNumber: "N" },
      "2": { status: "ineligible", banReason: "b", pageName: null, linkedNumber: null },
      "3": { status: "unknown" },
    };
    const rows = [
      { cookies: "", uid: "1", wa_status: "" },
      { cookies: "c_user=2;", uid: "", wa_status: "" },
      { cookies: "c_user=3;", uid: "", wa_status: "" },
    ];
    await hydrateWaCache(rows);
    expect(rows[0].wa_status).toBe("eligible");
    expect(rows[0].wa_page_name).toBe("P");
    expect(rows[1].wa_status).toBe("ineligible");
    expect(rows[1].wa_ban_reason).toBe("b");
    expect(rows[2].wa_status).toBe("");
  });

  it("hydrateWaCache swallows cache failures and leaves rows untouched", async () => {
    waHarness.throw = true;
    const rows = [{ cookies: "c_user=1;", uid: "1", wa_status: "" }];
    await hydrateWaCache(rows);
    expect(rows[0].wa_status).toBe("");
    waHarness.throw = false;
  });
});

describe("genId / todayStr", () => {
  it("genId yields non-empty ids", () => {
    expect(genId().length).toBeGreaterThan(0);
    expect(todayStr().length).toBeGreaterThan(0);
  });
});
