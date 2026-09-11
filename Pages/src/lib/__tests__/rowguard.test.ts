import { describe, expect, it } from "bun:test";

// Row-loss guards: isDataRow (Fix 3), replaceCapMessage (Fix 2),
// isPersistConflict (Fix 1, backend predicate — shared.ts is import-pure).
import { isDataRow, replaceCapMessage } from "../types";
import { isPersistConflict, pushSnapshot, selectFeedRows, FILE_ROW_LIMIT, FILE_SNAPSHOT_LIMIT } from "../../../../backend/src/lib/shared";

const COLS = [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa", width: 200 }, { key: "uid", label: "uid", width: 120 }];

describe("isDataRow", () => {
  it("treats padding rows as empty (all column keys blank + blank status)", () => {
    expect(isDataRow({ cookies: "", twofakey: "", uid: "", status: "" }, COLS)).toBe(false);
  });

  it("treats missing/undefined rows as empty", () => {
    expect(isDataRow(null as unknown as Record<string, string>, COLS)).toBe(false);
    expect(isDataRow(undefined as unknown as Record<string, string>, COLS)).toBe(false);
  });

  it("keeps rows with any column value", () => {
    expect(isDataRow({ cookies: "c_user=1;", twofakey: "", uid: "", status: "" }, COLS)).toBe(true);
  });

  it("keeps uid-only rows (cookies cleared but account identity remains)", () => {
    expect(isDataRow({ cookies: "", twofakey: "", uid: "123", status: "" }, COLS)).toBe(true);
  });

  it("keeps status-only rows (verdict with cleared cells)", () => {
    expect(isDataRow({ cookies: "", twofakey: "", status: "bad" }, COLS)).toBe(true);
  });

  it("still drops wa-only rows (no account identity, not user data)", () => {
    expect(isDataRow({ cookies: "", twofakey: "", wa_status: "eligible" }, COLS)).toBe(false);
  });
});

describe("replaceCapMessage", () => {
  it("returns null when everything fits", () => {
    expect(replaceCapMessage(100, 500)).toBeNull();
    expect(replaceCapMessage(500, 500)).toBeNull();
    expect(replaceCapMessage(NaN, 500)).toBeNull();
  });

  it("refuses over-cap uploads with the cap named (strict, never truncate)", () => {
    const msg = replaceCapMessage(600, 500);
    expect(msg).not.toBeNull();
    expect(msg!).toContain("500");
    expect(msg!.toLowerCase()).toContain("split");
  });
});

describe("file limits", () => {
  it("strict 500 rows per file", () => {
    expect(FILE_ROW_LIMIT).toBe(500);
  });

  it("pushSnapshot keeps newest-first, capped", () => {
    const mk = (seq: number) => ({ rows: [{ uid: String(seq) }], seq, ts: seq });
    let snaps = pushSnapshot([], mk(1));
    snaps = pushSnapshot(snaps, mk(2));
    snaps = pushSnapshot(snaps, mk(3));
    snaps = pushSnapshot(snaps, mk(4));
    expect(snaps.length).toBe(FILE_SNAPSHOT_LIMIT);
    expect(snaps.map((s) => s.seq)).toEqual([4, 3, 2]);
  });

  it("pushSnapshot drops malformed entries", () => {
    const snaps = pushSnapshot([{ rows: null } as unknown as { rows: never[]; seq: number; ts: number }], { rows: [], seq: 1, ts: 1 });
    expect(snaps.length).toBe(1);
  });
});

describe("selectFeedRows", () => {
  const r = (uid: string, cookies = `c_user=${uid}; x=y`, twofakey = "K") => ({ cookies, uid, twofakey });

  it("feeds new keys only, skips unchanged rows", () => {
    const old = [r("1"), r("2")];
    const now = [r("1"), r("2"), r("3")];
    const feed = selectFeedRows(old, now);
    expect(feed.map((x) => x.uid)).toEqual(["3"]);
  });

  it("feeds rows whose pool content changed (key edit, status flip)", () => {
    const old = [r("1"), r("2")];
    const now = [r("1"), { ...r("2"), twofakey: "NEWKEY" }];
    const feed = selectFeedRows(old, now);
    expect(feed.map((x) => x.uid)).toEqual(["2"]);
  });

  it("removed rows are not fed (removal is handled by delete paths)", () => {
    const feed = selectFeedRows([r("1"), r("2")], [r("1")]);
    expect(feed).toEqual([]);
  });

  it("keyless rows never feed", () => {
    const feed = selectFeedRows([], [{ cookies: "", twofakey: "", uid: "" }]);
    expect(feed).toEqual([]);
  });
});

describe("isPersistConflict", () => {
  it("no conflict on matching base", () => {
    expect(isPersistConflict(7, 7)).toBe(false);
  });

  it("conflict on stale base (the two-editor overwrite case)", () => {
    expect(isPersistConflict(7, 8)).toBe(true);
  });

  it("missing or non-integer base means no guard (old clients keep working)", () => {
    expect(isPersistConflict(undefined, 8)).toBe(false);
    expect(isPersistConflict("8", 8)).toBe(false);
    expect(isPersistConflict(8.5, 8)).toBe(false);
  });
});

describe("destructive call-site guards", () => {
  async function src(path: string) {
    return Bun.file(new URL(path, import.meta.url)).text();
  }

  it("every deleteDeadRows call site confirms first (Fix 4 holds)", async () => {
    for (const f of [
      "../../components/sheet/SheetToolbar.tsx",
      "../../components/sheet/QuickEditBar.tsx",
    ]) {
      const text = await src(f);
      expect(text.includes("deleteDeadRows")).toBe(true);
      const idx = text.indexOf("deleteDeadRows");
      // a confirm( must exist in the same file before the destructive call
      expect(text.lastIndexOf("confirm(", idx) >= 0).toBe(true);
    }
  });

  it("every replace-upload path warns about the grid cap (Fix 2 holds)", async () => {
    for (const f of [
      "../../components/sheet/SheetToolbar.tsx",
      "../../components/sheet/UploadOverlay.tsx",
    ]) {
      const text = await src(f);
      expect(text.includes('applyUpload("replace"')).toBe(true);
      expect(text.includes("replaceCapMessage")).toBe(true);
    }
  });
});
