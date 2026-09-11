import { beforeEach, describe, expect, it, mock } from "bun:test";

// Offline-open seam: when getFileFull throws (dead network / killed server),
// openFile must fall back to the last IDB snapshot, or report status "error"
// when there is nothing to show. The api module is stubbed to always fail so
// only the local path can satisfy these tests.
const _lsStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => _lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { _lsStore.set(k, String(v)); },
  removeItem: (k: string) => { _lsStore.delete(k); },
  clear: () => { _lsStore.clear(); },
};

mock.module("@/lib/api", () => ({
  api: {
    getFileFull: async () => { throw new Error("network down"); },
    getCrossDups: async () => ({ counts: {}, dups: {} }),
  },
}));

const { useSheetStore } = await import("../sheetStore");
const { snapshotFile, forgetFile } = await import("@/lib/idb");
import type { Row, SheetFile } from "@/lib/types";

const COLS = [
  { key: "cookies", label: "cookies", width: 340 },
  { key: "twofakey", label: "2fa key", width: 200 },
  { key: "uid", label: "uid", width: 120 },
];

const SNAP_FILE = {
  id: "f1",
  name: "snap",
  type: "fb_cookie",
  columns: COLS,
} as unknown as SheetFile;

const SNAP_ROWS: Row[] = [{ cookies: "c_user=3;", uid: "3", twofakey: "" }];

beforeEach(async () => {
  useSheetStore.setState({
    status: "idle",
    fileId: null,
    file: null,
    rows: [],
    columns: [],
    isDirty: false,
    changeJournal: [],
    lastSeq: 0,
    dirtyStructural: false,
    undoStack: [],
    redoStack: [],
  });
  await forgetFile("f1").catch(() => {});
});

describe("openFile offline fallback", () => {
  it("opens the last snapshot with queued edits when the server is unreachable", async () => {
    await snapshotFile("f1", SNAP_ROWS, 7, SNAP_FILE);
    await useSheetStore.getState().openFile("f1");
    const s = useSheetStore.getState();
    expect(s.status).toBe("ready");
    expect(s.fileId).toBe("f1");
    expect(s.rows[0].cookies).toBe("c_user=3;");
    expect(s.rows.length).toBe(100);
    expect(s.lastSeq).toBe(7);
    expect(s.isDirty).toBe(false);
  });

  it("reports an error when the server is unreachable and no snapshot exists", async () => {
    await useSheetStore.getState().openFile("f1");
    const s = useSheetStore.getState();
    expect(s.status).toBe("error");
    expect(s.fileId).toBeNull();
  });
});
