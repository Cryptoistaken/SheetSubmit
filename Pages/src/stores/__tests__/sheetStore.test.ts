import { beforeEach, describe, expect, it, mock } from "bun:test";

// Bun has no `localStorage`. sheetStore reads it in openFile (inside try/catch)
// and in maybeAutoCheck (unprotected). Provide a minimal shim so the real store
// module can run unmodified under bun.
const _lsStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => _lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { _lsStore.set(k, String(v)); },
  removeItem: (k: string) => { _lsStore.delete(k); },
  clear: () => { _lsStore.clear(); },
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

interface PersistPayloadLike {
  rows: Array<Record<string, unknown>>;
  action?: string;
}

interface PersistCall {
  id: string;
  payload: PersistPayloadLike;
  admin?: boolean;
}

interface AppendOpLike {
  rowIdx: number;
  cols: Record<string, string>;
}

interface AppendPayloadLike {
  base: number;
  ops: AppendOpLike[];
  newLogs?: unknown[];
  undoNew?: unknown[];
  redoNew?: unknown[];
  dataCount?: number;
  action?: string;
}

interface AppendCall {
  id: string;
  payload: AppendPayloadLike;
}

interface Harness {
  getRowsCalls: number;
  getFileFullCalls: number;
  persistCalls: PersistCall[];
  nextPersist: Deferred<{ ok: boolean }> | null;
  appendCalls: AppendCall[];
  nextAppend: Deferred<{ ok: boolean; seq: number }> | null;
  fullRows: Array<Record<string, string>>;
  fullSeq: number;
  pageCheckCalls: string[];
  waCheckCalls: string[];
  getWaCacheCalls: string[][];
  nextPageCheck: ((cookie: string) => unknown) | null;
  nextWaCheck: ((cookie: string) => unknown) | null;
  waCache: Record<string, unknown>;
}

const harness: Harness = {
  getRowsCalls: 0,
  getFileFullCalls: 0,
  persistCalls: [],
  nextPersist: null,
  appendCalls: [],
  nextAppend: null,
  fullRows: [{ cookies: "", uid: "", twofakey: "" }],
  fullSeq: 0,
  pageCheckCalls: [],
  waCheckCalls: [],
  getWaCacheCalls: [],
  nextPageCheck: null,
  nextWaCheck: null,
  waCache: {},
};

// Fake the entire `@/lib/api` module BEFORE importing the store. sheetStore only
// calls these methods during the flows under test; the extra stubs exist so the
// module graph (fbcookie behavior etc.) imports cleanly.
mock.module("@/lib/api", () => ({
  api: {
    getFileFull: async (id: string) => {
      harness.getFileFullCalls++;
      return {
        file: { id, name: "pageTest", type: "fb_cookie", preset: "page", columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] } as unknown as Record<string, unknown>,
        rows: harness.fullRows,
        logs: [],
        undo: [],
        redo: [],
        seq: harness.fullSeq,
      };
    },
    getCrossDups: async () => ({ counts: {}, dups: {} }),
    getRows: async () => {
      harness.getRowsCalls++;
      return [{ cookies: "c_user=202;", uid: "202", twofakey: "" }];
    },
    persist: async (id: string, payload: unknown) => {
      harness.persistCalls.push({ id, payload: payload as PersistPayloadLike });
      if (harness.nextPersist) return harness.nextPersist.promise;
      return { ok: true };
    },
    append: async (id: string, payload: unknown) => {
      harness.appendCalls.push({ id, payload: payload as AppendPayloadLike });
      if (harness.nextAppend) return harness.nextAppend.promise;
      return { ok: true, seq: harness.fullSeq };
    },
    adminPersist: async (id: string, payload: unknown) => {
      harness.persistCalls.push({
        id,
        payload: payload as PersistPayloadLike,
        admin: true,
      });
      if (harness.nextPersist) return harness.nextPersist.promise;
      return { ok: true };
    },
    fbCheck: async () => ({ valid: [], dead: [], uncertain: [] }),
    getWaCache: async (uids: string[]) => {
      harness.getWaCacheCalls.push(uids);
      return { cache: harness.waCache as Record<string, unknown> };
    },
    pageCheck: async (cookie: string) => {
      harness.pageCheckCalls.push(cookie);
      if (harness.nextPageCheck) return harness.nextPageCheck(cookie) as null;
      return null;
    },
    waCheck: async (cookie: string) => {
      harness.waCheckCalls.push(cookie);
      if (harness.nextWaCheck) return harness.nextWaCheck(cookie) as null;
      return null;
    },
    // NOTE: no version-history stubs — that API is gone (restore-snapshot era).
    // If a stub is added here for an api method that no longer exists, delete
    // it: dead stubs hide seam drift between the store and lib/api.ts.
    adminFile: async (id: string) => ({ id, name: "Test", type: "fb_cookie" }),
    adminFileRows: async () => [],
    adminFileLogs: async () => [],
    adminUndo: async () => ({ undo: [], redo: [] }),
  },
}));

const { useSheetStore } = await import("../sheetStore");
import { NO_2FA_MARK, FILE_TYPE_DEFS } from "@/lib/types";
import { forgetFile } from "@/lib/idb";

function resetStore(): void {
  useSheetStore.setState({
    status: "idle",
    fileId: null,
    file: null,
    rows: [],
    columns: [],
    visibleCols: new Set(),
    undoStack: [],
    redoStack: [],
    apiLogs: [],
    logBase: 0,
    undoBase: 0,
    redoBase: 0,
    isDirty: false,
    changeJournal: [],
    lastSeq: 0,
    dirtyStructural: false,
    selectedCell: null,
    draft: "",
    qebOpen: false,
    inlineEdit: false,
    selectionMode: false,
    selectedItems: new Set(),
    selRows: new Set(),
    selCols: new Set(),
    dupCells: new Set(),
    dupRows: new Set(),
    invalidCells: new Set(),
    crossDupRows: new Set(),
    hasDuplicates: false,
    crossDups: {},
    checkRunning: false,
    pendingAutoCheck: false,
    bubbleActiveRow: -1,
    adminMode: false,
    adminOwnerId: null,
  });
  harness.getRowsCalls = 0;
  harness.getFileFullCalls = 0;
  harness.persistCalls = [];
  harness.nextPersist = null;
  harness.appendCalls = [];
  harness.nextAppend = null;
  harness.fullRows = [{ cookies: "", uid: "", twofakey: "" }];
  harness.fullSeq = 0;
  harness.pageCheckCalls = [];
  harness.waCheckCalls = [];
  harness.getWaCacheCalls = [];
  harness.nextPageCheck = null;
  harness.nextWaCheck = null;
  harness.waCache = {};
  _lsStore.clear();
  // Durable outbox (IDB mirror/snapshot) survives the in-memory reset by
  // design — clear it here or one test's unsynced edits replay into the next.
  void forgetFile("f1").catch(() => {});
}

beforeEach(resetStore);

async function openTestFile(): Promise<void> {
  await useSheetStore.getState().openFile("f1");
  const s = useSheetStore.getState();
  expect(s.fileId).toBe("f1");
  expect(s.status).toBe("ready");
  expect(s.isDirty).toBe(false);
  expect(s.lastSeq).toBe(0);
}

describe("sheetStore data-integrity", () => {
  it("flushPersist serializes concurrent appends", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");
    expect(useSheetStore.getState().isDirty).toBe(true);
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 0, cols: { uid: "111" } },
    ]);

    harness.nextAppend = deferred<{ ok: boolean; seq: number }>();
    const p1 = useSheetStore.getState().flushPersist();
    const p2 = useSheetStore.getState().flushPersist();
    await Promise.resolve(); // let the first chained run start

    // Only one append may be in-flight; the second flush waits on the chain.
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.base).toBe(0);
    expect(harness.appendCalls[0].payload.ops).toEqual([
      { rowIdx: 0, cols: { uid: "111" } },
    ]);

    harness.nextAppend.resolve({ ok: true, seq: 5 });
    await Promise.all([p1, p2]);

    // The second concurrent flush ran AFTER the first cleared isDirty, so it was
    // a serialized no-op — exactly one payload is sent (real store behavior).
    expect(harness.appendCalls.length).toBe(1);
    expect(useSheetStore.getState().isDirty).toBe(false);
    expect(useSheetStore.getState().lastSeq).toBe(5);
    expect(useSheetStore.getState().changeJournal).toEqual([]);

    // A subsequent edit still flushes through the same chain, in order.
    useSheetStore.getState().commitCell(0, "uid", "444");
    harness.nextAppend = deferred<{ ok: boolean; seq: number }>();
    const p3 = useSheetStore.getState().flushPersist();
    await Promise.resolve();
    expect(harness.appendCalls.length).toBe(2);
    expect(harness.appendCalls[1].payload.base).toBe(5);
    expect(harness.appendCalls[1].payload.ops).toEqual([
      { rowIdx: 0, cols: { uid: "444" } },
    ]);
    harness.nextAppend.resolve({ ok: true, seq: 6 });
    await p3;
    expect(useSheetStore.getState().isDirty).toBe(false);
    expect(useSheetStore.getState().lastSeq).toBe(6);
  });

  it("dirty-clear guard preserves newer edits made while a save is pending", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");

    harness.nextAppend = deferred<{ ok: boolean; seq: number }>();
    const p = useSheetStore.getState().flushPersist();
    await Promise.resolve();
    expect(harness.appendCalls.length).toBe(1);

    // Newer edit while the save is still pending → rows reference changes.
    useSheetStore.getState().commitCell(0, "uid", "222");
    expect(useSheetStore.getState().rows[0].uid).toBe("222");

    harness.nextAppend.resolve({ ok: true, seq: 5 });
    await p;

    // The resolved append must NOT clear the newer dirty state, journal or seq.
    expect(useSheetStore.getState().isDirty).toBe(true);
    expect(useSheetStore.getState().rows[0].uid).toBe("222");
    // Journal is coalesced per-row: the later commit on the same row replaces
    // the earlier one, so only the latest value survives.
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 0, cols: { uid: "222" } },
    ]);
    expect(useSheetStore.getState().lastSeq).toBe(0);
  });

  it("closeFile commits the open draft, awaits the final flush, then resets", async () => {
    await openTestFile();
    useSheetStore.getState().openInlineEdit(0, "uid");
    useSheetStore.getState().setDraft("777");
    expect(useSheetStore.getState().inlineEdit).toBe(true);

    harness.nextPersist = deferred<{ ok: boolean }>();
    const p = useSheetStore.getState().closeFile();
    await Promise.resolve();

    // Draft was folded into rows before the flush started.
    expect(useSheetStore.getState().rows[0].uid).toBe("777");
    expect(useSheetStore.getState().isDirty).toBe(true);
    expect(harness.persistCalls.length).toBe(1);

    harness.nextPersist.resolve({ ok: true });
    await p;

    const s = useSheetStore.getState();
    expect(s.fileId).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.isDirty).toBe(false);
    expect(s.selectedCell).toBeNull();
    expect(s.rows).toEqual([]);
    expect(s.changeJournal).toEqual([]);
    expect(s.lastSeq).toBe(0);
    expect(s.dirtyStructural).toBe(false);
  });

  it("closeFile with a clean file does not persist", async () => {
    await openTestFile();
    await useSheetStore.getState().closeFile();

    expect(harness.persistCalls.length).toBe(0);
    expect(harness.appendCalls.length).toBe(0);
    const s = useSheetStore.getState();
    expect(s.fileId).toBeNull();
    expect(s.status).toBe("idle");
    expect(s.isDirty).toBe(false);
    expect(s.selectedCell).toBeNull();
  });

  it("refreshSheet skips while dirty and fetches once clean", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "333");
    expect(useSheetStore.getState().isDirty).toBe(true);

    await useSheetStore.getState().refreshSheet();
    expect(harness.getRowsCalls).toBe(0); // skipped while dirty

    await useSheetStore.getState().flushPersist(); // simulate a completed save
    expect(useSheetStore.getState().isDirty).toBe(false);

    await useSheetStore.getState().refreshSheet();
    expect(harness.getRowsCalls).toBe(1);
    expect(useSheetStore.getState().rows[0].uid).toBe("202");
  });

  it("409 conflict refetches and re-applies the local journal onto server rows", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 0, cols: { uid: "111" } },
    ]);

    harness.nextAppend = deferred<{ ok: boolean; seq: number }>();
    const p = useSheetStore.getState().flushPersist();
    await Promise.resolve();
    expect(harness.appendCalls.length).toBe(1);

    // Server meanwhile moved on (someone else edited in parallel).
    harness.fullRows = [{ cookies: "c_user=999;", uid: "999", twofakey: "" }];
    harness.fullSeq = 7;
    harness.nextAppend.reject(new Error("409 Conflict - version conflict"));
    await p;

    const s = useSheetStore.getState();
    expect(s.rows[0].uid).toBe("111"); // local edit survived the re-apply
    expect(s.rows[0].cookies).toBe("c_user=999;"); // server row content kept
    expect(s.lastSeq).toBe(7); // advanced to the server seq
    expect(s.changeJournal).toEqual([{ rowIdx: 0, cols: { uid: "111" } }]); // still unsent
    expect(s.isDirty).toBe(true);

    // Next flush re-appends with base = the fresh server seq.
    harness.nextAppend = deferred<{ ok: boolean; seq: number }>();
    const p2 = useSheetStore.getState().flushPersist();
    await Promise.resolve();
    expect(harness.appendCalls.length).toBe(2);
    expect(harness.appendCalls[1].payload.base).toBe(7);
    expect(harness.appendCalls[1].payload.ops).toEqual([
      { rowIdx: 0, cols: { uid: "111" } },
    ]);
    harness.nextAppend.resolve({ ok: true, seq: 8 });
    await p2;
    expect(useSheetStore.getState().lastSeq).toBe(8);
    expect(useSheetStore.getState().changeJournal).toEqual([]);
    expect(useSheetStore.getState().isDirty).toBe(false);
  });

  it("structural changes fall back to a full persist and clear the journal", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");
    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length).toBe(1);
    expect(useSheetStore.getState().isDirty).toBe(false);

    // Structural mutation (deleteSelected) → full persist, not append.
    useSheetStore.getState().enterSelectionMode("cell", 0, "uid");
    useSheetStore.getState().deleteSelected();
    const s = useSheetStore.getState();
    expect(s.dirtyStructural).toBe(true);
    expect(s.isDirty).toBe(true);
    expect(s.rows[0].uid).toBe("");

    await useSheetStore.getState().flushPersist();

    expect(harness.appendCalls.length).toBe(1); // append not used for structural
    expect(harness.persistCalls.length).toBe(1); // full persist used instead
    expect(useSheetStore.getState().isDirty).toBe(false);
    expect(useSheetStore.getState().changeJournal).toEqual([]);
    expect(useSheetStore.getState().dirtyStructural).toBe(false);
  });

  it("cell edit during an in-flight structural persist appends instead of full-persisting", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");
    await useSheetStore.getState().flushPersist();
    expect(harness.persistCalls.length).toBe(0);

    // Structural change starts a full persist...
    useSheetStore.getState().enterSelectionMode("cell", 0, "uid");
    useSheetStore.getState().deleteSelected();
    expect(useSheetStore.getState().dirtyStructural).toBe(true);

    harness.nextPersist = deferred<{ ok: boolean }>();
    const p = useSheetStore.getState().flushPersist();
    await Promise.resolve();
    expect(harness.persistCalls.length).toBe(1);

    // ...and a cell edit lands while it is in flight (rows reference changes).
    useSheetStore.getState().commitCell(0, "uid", "222");
    expect(useSheetStore.getState().rows[0].uid).toBe("222");

    harness.nextPersist.resolve({ ok: true });
    await p;
    expect(useSheetStore.getState().dirtyStructural).toBe(false);

    // The pending cell edit must flush as a small append — not another full upload.
    await useSheetStore.getState().flushPersist();
    expect(harness.persistCalls.length).toBe(1);
    expect(harness.appendCalls.length).toBe(2);
    expect(harness.appendCalls[1].payload.ops).toEqual([
      { rowIdx: 0, cols: { uid: "222" } },
    ]);
  });

  it("check with changed results persists as an append; identical re-check sends nothing", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "c_user=202;", uid: "202", twofakey: "" }],
    });
    expect(useSheetStore.getState().rows[0].status).toBeUndefined();

    // First check flips status (undefined) -> "pending": small append, not a full persist.
    await useSheetStore.getState().runCheck();
    await useSheetStore.getState().flushPersist();

    expect(harness.persistCalls.length).toBe(0);
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.ops).toEqual([
      { rowIdx: 0, cols: { status: "pending" } },
    ]);
    expect(useSheetStore.getState().rows[0].status).toBe("pending");
    expect(useSheetStore.getState().isDirty).toBe(false);

    // Same result again -> nothing sent, check history not grown.
    const calls = harness.appendCalls.length + harness.persistCalls.length;
    await useSheetStore.getState().runCheck();
    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length + harness.persistCalls.length).toBe(calls);
    expect(useSheetStore.getState().rows[0].status).toBe("pending");
    expect(useSheetStore.getState().isDirty).toBe(false);
  });

  it("wa check flushes changed statuses as one delta append after all accounts finish; identical re-check sends nothing", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=202;", uid: "202", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" },
      ],
      columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] as never,
    });
    expect(useSheetStore.getState().rows[0].wa_status).toBe("");

    // clean miss -> ineligible (strict: only {eligible:false,error:null} is clean)
    harness.nextPageCheck = () => ({ eligible: false, error: null });
    await useSheetStore.getState().runWaChecks();
    await useSheetStore.getState().flushPersist();

    expect(harness.persistCalls.length).toBe(0);
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.ops).toEqual([
      {
        rowIdx: 0,
        cols: {
          wa_status: "ineligible",
          wa_ban_reason: "",
          wa_page_name: "",
          wa_linked_number: "",
        },
      },
    ]);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("ineligible");
    expect(useSheetStore.getState().isDirty).toBe(false);

    // Same WA result again -> nothing sent.
    const calls = harness.appendCalls.length + harness.persistCalls.length;
    await useSheetStore.getState().runWaChecks();
    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length + harness.persistCalls.length).toBe(calls);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("ineligible");
  });

  it("appends sync logs/undo/redo incrementally (only new entries)", async () => {
    await openTestFile();
    const logA = { username: "A", status: "done" };
    const logB = { username: "B", status: "done" };
    useSheetStore.setState({ apiLogs: [logA] });
    useSheetStore.getState().commitCell(0, "uid", "111");

    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.newLogs).toEqual([logA]);
    expect(harness.appendCalls[0].payload.ops).toEqual([
      { rowIdx: 0, cols: { uid: "111" } },
    ]);
    expect(useSheetStore.getState().logBase).toBe(1);

    // More log entries appear locally; the next append sends ONLY the new ones.
    useSheetStore.setState({ apiLogs: [logA, logB] });
    useSheetStore.getState().commitCell(0, "uid", "222");
    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length).toBe(2);
    expect(harness.appendCalls[1].payload.newLogs).toEqual([logB]);
    expect(harness.appendCalls[1].payload.undoNew).toEqual([
      { rowIdx: 0, colKey: "uid", prevVal: "111" },
    ]);
    expect(useSheetStore.getState().logBase).toBe(2);
  });

  it("undoNew delta only sends the unsynced tail of the undo stack", async () => {
    await openTestFile();
    const undoA = { rowIdx: 0, colKey: "uid", prevVal: "old1" };
    const undoB = { rowIdx: 1, colKey: "uid", prevVal: "old2" };
    useSheetStore.setState({
      undoStack: [undoA, undoB],
      undoBase: 1,
      changeJournal: [{ rowIdx: 0, cols: { uid: "999" } }],
      isDirty: true,
    });

    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.undoNew).toEqual([undoB]);
    expect(harness.appendCalls[0].payload.newLogs).toEqual([]);
    expect(harness.appendCalls[0].payload.redoNew).toEqual([]);
    expect(useSheetStore.getState().undoBase).toBe(2);
  });

  it("full persist resets sync bases; next append sends no stale entries", async () => {
    await openTestFile();
    const logA = { username: "A", status: "done" };
    const logB = { username: "B", status: "done" };
    useSheetStore.setState({ apiLogs: [logA, logB] });

    useSheetStore.getState().addRow(); // structural → full persist
    await useSheetStore.getState().flushPersist();
    expect(harness.persistCalls.length).toBe(1);
    expect(useSheetStore.getState().logBase).toBe(2);
    expect(useSheetStore.getState().undoBase).toBe(0);
    expect(useSheetStore.getState().redoBase).toBe(0);

    // A later append has no new log/undo/redo entries to send.
    useSheetStore.setState({
      changeJournal: [{ rowIdx: 0, cols: { uid: "999" } }],
      isDirty: true,
    });
    await useSheetStore.getState().flushPersist();
    expect(harness.appendCalls.length).toBe(1);
    expect(harness.appendCalls[0].payload.newLogs).toEqual([]);
    expect(harness.appendCalls[0].payload.undoNew).toEqual([]);
    expect(harness.appendCalls[0].payload.redoNew).toEqual([]);
  });

  it("changeJournal coalesces consecutive commits on the same row (latest value)", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "uid", "111");
    useSheetStore.getState().commitCell(0, "uid", "222");
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 0, cols: { uid: "222" } },
    ]);

    useSheetStore.getState().commitCell(1, "uid", "333");
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 0, cols: { uid: "222" } },
      { rowIdx: 1, cols: { uid: "333" } },
    ]);

    useSheetStore.getState().commitCell(0, "uid", "444");
    expect(useSheetStore.getState().changeJournal).toEqual([
      { rowIdx: 1, cols: { uid: "333" } },
      { rowIdx: 0, cols: { uid: "444" } },
    ]);
  });

  it("bubbleActiveRow resets on closeFile and openFile", async () => {
    await openTestFile();
    useSheetStore.setState({ bubbleActiveRow: 5 });
    await useSheetStore.getState().closeFile();
    expect(useSheetStore.getState().bubbleActiveRow).toBe(-1);

    await openTestFile();
    expect(useSheetStore.getState().bubbleActiveRow).toBe(-1);
  });

  it("incremental recomputeMarks keeps dup marks correct after editing a dup cell", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "", uid: "111", twofakey: "" },
        { cookies: "", uid: "111", twofakey: "" },
        { cookies: "", uid: "222", twofakey: "" },
      ],
      dupCells: new Set(["0:uid", "1:uid"]),
      dupRows: new Set([0, 1]),
      hasDuplicates: true,
    });

    // Break the duplicate from row 0's side: row 1 becomes unique too.
    useSheetStore.getState().commitCell(0, "uid", "333");
    let s = useSheetStore.getState();
    expect(s.rows[0].uid).toBe("333");
    expect(s.dupCells).toEqual(new Set());
    expect(s.dupRows).toEqual(new Set());
    expect(s.hasDuplicates).toBe(false);

    // Recreating the duplicate is refused at entry (blocked, not flagged).
    const { setToastFn } = await import("@/lib/toast");
    const toasted: string[] = [];
    setToastFn((m: string) => { toasted.push(m); });
    try {
      useSheetStore.getState().commitCell(0, "uid", "111");
      s = useSheetStore.getState();
      expect(s.rows[0].uid).toBe("333");
      expect(s.dupCells).toEqual(new Set());
      expect(toasted).toContain("Duplicate in this file");
    } finally {
      setToastFn(null);
    }

    // A pre-existing duplicate (server rows, undo) still re-marks, and
    // breaking it from row 1's side clears the stale partner mark.
    useSheetStore.setState({
      rows: [
        { cookies: "", uid: "111", twofakey: "" },
        { cookies: "", uid: "111", twofakey: "" },
        { cookies: "", uid: "222", twofakey: "" },
      ],
      dupCells: new Set(["0:uid", "1:uid"]),
      dupRows: new Set([0, 1]),
      hasDuplicates: true,
    });
    useSheetStore.getState().commitCell(1, "uid", "444");
    s = useSheetStore.getState();
    expect(s.dupCells).toEqual(new Set());
    expect(s.dupRows).toEqual(new Set());
    expect(s.hasDuplicates).toBe(false);
  });
});

describe("bubble user flow (as a user uses it)", () => {
  it("key + cookie saves in strict 2FA-first order, copies the code, and advances", async () => {
    await openTestFile();
    const writes: string[] = [];
    const hadNav = "navigator" in globalThis;
    const prevNav = (globalThis as Record<string, unknown>).navigator;
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => { writes.push(t); } } },
      configurable: true,
      writable: true,
    });
    useSheetStore.setState({ isDesktop: false } as never);
    try {
      // The key anchors the row first — it waits key-only for its cookie.
      void useSheetStore.getState().bubbleSaveKey("JBSWY3DPEHPK3PXP");
      let s = useSheetStore.getState();
      expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
      expect(s.rows[0].cookies ?? "").toBe("");
      expect(s.bubbleActiveRow).toBe(0);
      expect(s.isDirty).toBe(true);
      await new Promise((r) => setTimeout(r, 0));
      s = useSheetStore.getState();
      expect(s.bubbleActiveRow).toBe(0);
      await new Promise((r) => setTimeout(r, 0));
      s = useSheetStore.getState();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/^\d{6}$/);

      // The cookie completes the key-anchored row and advances.
      useSheetStore.getState().bubbleSaveCookie("c_user=123; foo=bar;");
      s = useSheetStore.getState();
      expect(s.rows[0].cookies).toContain("c_user=123");
      expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
      expect(s.bubbleActiveRow).toBe(1);
      expect(s.invalidCells.has("0:cookies")).toBe(false);
    } finally {
      if (hadNav) {
        Object.defineProperty(globalThis, "navigator", { value: prevNav, configurable: true });
      } else {
        delete (globalThis as Record<string, unknown>).navigator;
      }
    }
  });

  it("long-press skip writes No_2Fa into the 2fa cell, persists it, and advances", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "c_user=1; x=y", uid: "1", twofakey: "" }],
      bubbleActiveRow: 0,
      isDirty: true,
      dirtyStructural: true,
    });
    useSheetStore.getState().bubbleSkipNo2FA();
    let s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe(NO_2FA_MARK);
    expect(s.rows[0].cookies).toBe("c_user=1; x=y");
    expect(s.bubbleActiveRow).toBe(1);
    expect(s.invalidCells.has("0:twofakey")).toBe(false);

    await useSheetStore.getState().flushPersist();
    s = useSheetStore.getState();
    expect(s.isDirty).toBe(false);
    const p = harness.persistCalls[harness.persistCalls.length - 1];
    expect((p.payload.rows as Array<Record<string, unknown>>)[0].twofakey).toBe(NO_2FA_MARK);

    // The marked row is complete, so the active row advances on the next scan.
    expect(useSheetStore.getState().bubbleGetActiveRow()).toBe(1);
  });

  it("No_2Fa marker rows are not flagged as duplicates of each other", async () => {
    await openTestFile();
    // Skip 2FA on two accounts via long-press — both get the No_2Fa marker.
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=1; a=b", uid: "1", twofakey: "" },
        { cookies: "c_user=2; a=b", uid: "2", twofakey: "" },
      ],
      bubbleActiveRow: 0,
      dupCells: new Set(),
      dupRows: new Set(),
      crossDupRows: new Set(),
      hasDuplicates: false,
    });
    useSheetStore.getState().bubbleSkipNo2FA(); // row 0 → marker, advances to 1
    useSheetStore.getState().bubbleSkipNo2FA(); // row 1 → marker, advances to 2
    let s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe(NO_2FA_MARK);
    expect(s.rows[1].twofakey).toBe(NO_2FA_MARK);
    // Two identical "No_2Fa" placeholders must NOT be a duplicate pair.
    expect(s.dupCells).toEqual(new Set());
    expect(s.dupRows).toEqual(new Set());
    expect(s.hasDuplicates).toBe(false);

    // A second run of long-presses on the same marker rows must not re-add any
    // stale marks either (alreadySkipped guard — no reset into a dirty state).
    useSheetStore.setState({ bubbleActiveRow: 0 });
    useSheetStore.getState().bubbleSkipNo2FA();
    s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe(NO_2FA_MARK);
    expect(s.dupCells.has("0:twofakey")).toBe(false);
  });

  it("pasting a key alongside a No_2Fa marker is not a duplicate & saves", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=2; a=b", uid: "2", twofakey: NO_2FA_MARK },
        { cookies: "c_user=3; a=b", uid: "3", twofakey: "" },
      ],
      bubbleActiveRow: 1,
    });
    useSheetStore.getState().bubbleSaveKey("JBSWY3DPEHPK3PXP");
    const s = useSheetStore.getState();
    expect(s.rows[1].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(s.dupCells.has("1:twofakey")).toBe(false);
    expect(s.dupCells.has("0:twofakey")).toBe(false);
  });

  it("pasting a key equal to another row's real key still blocks as duplicate", () => {
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=1; a=b", uid: "1", twofakey: "ABCDEFGHJKLM2345" },
        { cookies: "", uid: "0", twofakey: "" },
      ],
      bubbleActiveRow: 1,
    });
    useSheetStore.getState().bubbleSaveKey("ABCDEFGHJKLM2345");
    const s = useSheetStore.getState();
    expect(s.rows[1].twofakey).toBe("");
    expect(s.bubbleActiveRow).toBe(1);
  });

  it("long-press skip on a keyless row marks it and waits for the cookie", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "", uid: "", twofakey: "" }],
      bubbleActiveRow: 0,
    });
    useSheetStore.getState().bubbleSkipNo2FA();
    let s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe(NO_2FA_MARK);
    // Not complete yet (no cookie) — stays put so the cookie lands here.
    expect(s.bubbleActiveRow).toBe(0);
    expect(s.isDirty).toBe(true);
    // Its cookie completes the skipped row and advances.
    useSheetStore.getState().bubbleSaveCookie("c_user=9; x=y;");
    s = useSheetStore.getState();
    expect(s.rows[0].cookies).toContain("c_user=9");
    expect(s.rows[0].twofakey).toBe(NO_2FA_MARK);
    expect(s.bubbleActiveRow).toBe(1);
  });

  it("long-press skip does nothing when the row already has a 2FA key", () => {
    useSheetStore.setState({
      rows: [{ cookies: "c_user=1; x=y", uid: "1", twofakey: "JBSWY3DPEHPK3PXP" }],
      bubbleActiveRow: 0,
    });
    useSheetStore.getState().bubbleSkipNo2FA();
    const s = useSheetStore.getState();
    // Already complete — the active row must stay put and the key must remain.
    expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(s.bubbleActiveRow).toBe(0);
  });

  it("download strips the No_2Fa marker from the 2fa column", async () => {
    (globalThis as Record<string, unknown>).window = { APP_CONFIG: {} };
    const { buildXlsx, parseSheetRows } = await import("@/lib/xlsx");
    const cols = FILE_TYPE_DEFS.fb_cookie.columns;
    const buf = await buildXlsx(
      [
        { cookies: "c_user=1; a=b", uid: "1", twofakey: NO_2FA_MARK },
        { cookies: "c_user=2; a=b", uid: "2", twofakey: "JBSWY3DPEHPK3PXP" },
      ],
      cols,
    );
    const rows = await parseSheetRows(buf, cols);
    expect(rows[0].twofakey).toBe("");
    expect(rows[1].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(rows[0].cookies).toBe("c_user=1; a=b");
  });

  it("2FA-first: a key saves onto an empty row and waits for its cookie", async () => {
    await openTestFile();
    await useSheetStore.getState().bubbleSaveKey("JBSWY3DPEHPK3PXP");
    let s = useSheetStore.getState();
    // The old code toasted "Paste cookie first" and DROPPED the key.
    expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(s.rows[0].cookies ?? "").toBe("");
    expect(s.bubbleActiveRow).toBe(0);
    useSheetStore.getState().bubbleSaveCookie("c_user=777; foo=bar;");
    s = useSheetStore.getState();
    expect(s.rows[0].cookies).toContain("c_user=777");
    expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(s.bubbleActiveRow).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("strict key shape: spaced 32-char max key saves, longer blobs are refused", async () => {
    await openTestFile();
    // 33 chars is not a key — refused onto the empty row.
    await useSheetStore.getState().bubbleSaveKey("F5RVFGWOIZFJBQP3GRCSTPTTGGG2UMJKX");
    let s = useSheetStore.getState();
    expect(s.rows[0].twofakey ?? "").toBe("");
    // Max-length key with spaces strips to 32 base32 chars, saves, waits cookie.
    await useSheetStore.getState().bubbleSaveKey("F5RV FGWO IZFJ BQP3 GRCS TPTT GGG2 UMJK");
    s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe("F5RVFGWOIZFJBQP3GRCSTPTTGGG2UMJK");
    expect(s.bubbleActiveRow).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("2FA-first: a second key never overwrites the waiting key", async () => {
    await openTestFile();
    await useSheetStore.getState().bubbleSaveKey("JBSWY3DPEHPK3PXP");
    await useSheetStore.getState().bubbleSaveKey("ABCDEFGHIJ234567");
    const s = useSheetStore.getState();
    expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    expect(s.bubbleActiveRow).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("cookie before any key is refused (strict 2FA-first)", async () => {
    const { setToastFn } = await import("@/lib/toast");
    const toasted: string[] = [];
    setToastFn((m: string) => { toasted.push(m); });
    try {
      await openTestFile();
      useSheetStore.getState().bubbleSaveCookie("c_user=555; x=y;");
      const s = useSheetStore.getState();
      // Nothing saved — no row is anchored without its key first.
      expect(s.rows[0].cookies ?? "").toBe("");
      expect(s.rows[0].twofakey ?? "").toBe("");
      expect(s.isDirty).toBe(false);
      expect(toasted).toContain("Paste 2FA first");
    } finally {
      setToastFn(null);
    }
    await new Promise((r) => setTimeout(r, 20));
  });

  it("second cookie onto a legacy cookie-only row is refused", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "c_user=556; x=y;", uid: "", twofakey: "" }],
      bubbleActiveRow: 0,
    });
    useSheetStore.getState().bubbleSaveCookie("c_user=557; x=y;");
    const s = useSheetStore.getState();
    expect(s.rows[0].cookies).toContain("c_user=556");
    expect(s.rows[0].cookies).not.toContain("c_user=557");
    expect(s.bubbleActiveRow).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe("direct-edit 2FA guards", () => {
  const cols = [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }];

  it("commit to a locked row is refused loudly, never silent", async () => {
    const { setToastFn } = await import("@/lib/toast");
    const toasted: string[] = [];
    setToastFn((m: string) => { toasted.push(m); });
    try {
      await openTestFile();
      useSheetStore.setState({
        rows: [{ cookies: "c_user=11;", uid: "11", twofakey: "", _hold: true }],
        columns: cols as never,
      });
      useSheetStore.getState().commitCell(0, "twofakey", "JBSWY3DPEHPK3PXP");
      const s = useSheetStore.getState();
      expect(s.rows[0].twofakey).toBe("");
      expect(s.isDirty).toBe(false);
      expect(toasted.some((m) => m.toLowerCase().includes("lock"))).toBe(true);
    } finally {
      setToastFn(null);
    }
    await new Promise((r) => setTimeout(r, 20));
  });

  it("opening another cell commits the pending formula draft first", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "", uid: "", twofakey: "" }],
      columns: cols as never,
      selectedCell: { rowIdx: 0, colIdx: "cookies", originalVal: "" },
      draft: "c_user=9; x=y",
      qebOpen: true,
    });
    useSheetStore.getState().openQuickEdit(0, "twofakey");
    const s = useSheetStore.getState();
    expect(s.rows[0].cookies).toBe("c_user=9; x=y");
    expect(s.selectedCell).toEqual({ rowIdx: 0, colIdx: "twofakey", originalVal: "" });
    await new Promise((r) => setTimeout(r, 20));
  });

  it("cookie+key blob pasted in the cookies cell splits the key out", async () => {
    await openTestFile();
    useSheetStore.setState({ rows: [{ cookies: "", uid: "", twofakey: "" }], columns: cols as never });
    useSheetStore.getState().commitCell(0, "cookies", "c_user=321; a=b\njbsw y3dp ehpk 3pxp");
    const s = useSheetStore.getState();
    expect(s.rows[0].cookies).toBe("c_user=321; a=b");
    expect(s.rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    const op = s.changeJournal.find((o) => o.rowIdx === 0);
    expect(op?.cols.cookies).toBe("c_user=321; a=b");
    expect(op?.cols.twofakey).toBe("JBSWY3DPEHPK3PXP");
    await new Promise((r) => setTimeout(r, 20));
  });

  it("direct twofakey paste normalizes exactly like the bubble", async () => {
    await openTestFile();
    useSheetStore.setState({ rows: [{ cookies: "", uid: "", twofakey: "" }], columns: cols as never });
    useSheetStore.getState().commitCell(0, "twofakey", "jbsw y3dp ehpk 3pxp");
    expect(useSheetStore.getState().rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    await new Promise((r) => setTimeout(r, 20));
  });

  it("No_2Fa marker passes through untouched", async () => {
    await openTestFile();
    useSheetStore.setState({ rows: [{ cookies: "c_user=5;", uid: "5", twofakey: "" }], columns: cols as never });
    useSheetStore.getState().commitCell(0, "twofakey", NO_2FA_MARK);
    expect(useSheetStore.getState().rows[0].twofakey).toBe(NO_2FA_MARK);
    await new Promise((r) => setTimeout(r, 20));
  });

  it("blob pasted in the key cell picks the key line, not the cookie", async () => {
    await openTestFile();
    useSheetStore.setState({ rows: [{ cookies: "", uid: "", twofakey: "" }], columns: cols as never });
    useSheetStore.getState().commitCell(0, "twofakey", "c_user=44; a=b\nJBSWY3DPEHPK3PXP");
    expect(useSheetStore.getState().rows[0].twofakey).toBe("JBSWY3DPEHPK3PXP");
    await new Promise((r) => setTimeout(r, 20));
  });

  it("bulk clear skips locked rows", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=61;", uid: "61", twofakey: "" },
        { cookies: "c_user=62;", uid: "62", twofakey: "", _approved: true },
      ],
      columns: cols as never,
      selectionMode: true,
      selectedItems: new Set(["0:cookies", "1:cookies"]),
    });
    useSheetStore.getState().deleteSelected();
    const s = useSheetStore.getState();
    expect(s.rows[0].cookies).toBe("");
    expect(s.rows[1].cookies).toBe("c_user=62;");
    await new Promise((r) => setTimeout(r, 20));
  });

  it("structural persist sends a slim payload (no undo/redo/logs dead weight)", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "c_user=71;", uid: "71", twofakey: "" }],
      columns: cols as never,
      isDirty: true,
      dirtyStructural: true,
    });
    await useSheetStore.getState().flushPersist("test-slim");
    await new Promise((r) => setTimeout(r, 20));
    const p = harness.persistCalls[harness.persistCalls.length - 1];
    const keys = Object.keys(p.payload);
    expect(keys).toContain("rows");
    expect(keys).toContain("base");
    expect(keys).not.toContain("logs");
    expect(keys).not.toContain("undo");
    expect(keys).not.toContain("redo");
  });
});

describe("page ledger — auto vs manual + review regressions", () => {
  function ledger(fileId: string): Record<string, unknown> {
    const raw = (globalThis as unknown as { localStorage: { getItem: (k: string) => string | null } }).localStorage.getItem(`ss_pageLedger:${fileId}`);
    return raw ? JSON.parse(raw) : {};
  }
  const pageCols = [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }];

  it("clean no-page increments; error/null do not", async () => {
    await openTestFile();
    useSheetStore.setState({ rows: [{ cookies: "c_user=100;", uid: "100", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }], columns: pageCols as never });
    _lsStore.set("ss_waCheck", "true");
    harness.nextPageCheck = () => ({ eligible: false, error: null });
    await useSheetStore.getState().runWaChecks();
    await useSheetStore.getState().flushPersist();
    expect(harness.pageCheckCalls.length).toBe(1);
    expect((ledger("f1")["100"] as { p: number }).p).toBe(1);
    // error must not increment
    harness.pageCheckCalls = [];
    harness.nextPageCheck = () => ({ eligible: false, error: "timeout" });
    useSheetStore.setState({ rows: [{ cookies: "c_user=100;", uid: "100", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "error" }] });
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(1);
    expect((ledger("f1")["100"] as { p: number }).p).toBe(1);
    // null response must not increment (strict clean miss)
    harness.pageCheckCalls = [];
    harness.nextPageCheck = () => null;
    useSheetStore.setState({ rows: [{ cookies: "c_user=101;", uid: "101", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }] });
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(1);
    expect(ledger("f1")["101"]).toBeUndefined();
    expect(useSheetStore.getState().rows[0].wa_status).toBe("error");
  });

  it("3 clean strikes trigger exactly one waCheck; WA fail exhausts; auto skips but manual includes", async () => {
    await openTestFile();
    _lsStore.set("ss_waCheck", "true");
    useSheetStore.setState({ rows: [{ cookies: "c_user=200;", uid: "200", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }], columns: pageCols as never });
    harness.nextPageCheck = () => ({ eligible: false, error: null });
    harness.nextWaCheck = () => ({ eligible: false, error: null });
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(1);
    expect(harness.waCheckCalls.length).toBe(0);
    expect((ledger("f1")["200"] as { p: number }).p).toBe(1);
    useSheetStore.setState({ rows: [{ cookies: "c_user=200;", uid: "200", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "ineligible" }] });
    harness.pageCheckCalls = [];
    await useSheetStore.getState().runWaChecks();
    expect((ledger("f1")["200"] as { p: number }).p).toBe(2);
    useSheetStore.setState({ rows: [{ cookies: "c_user=200;", uid: "200", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "ineligible" }] });
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(1);
    expect(harness.waCheckCalls.length).toBe(1);
    expect((ledger("f1")["200"] as { w: boolean }).w).toBe(true);
    // auto now skips exhausted
    useSheetStore.setState({ rows: [{ cookies: "c_user=200;", uid: "200", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "ineligible" }] });
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(0);
    // manual page includes exhausted
    harness.nextPageCheck = () => ({ eligible: true, pageName: "P", linkedNumber: null });
    await useSheetStore.getState().runWaChecksFiltered(() => true);
    expect(harness.pageCheckCalls.length).toBe(1);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("eligible");
    // manual-wa includes exhausted
    useSheetStore.setState({ rows: [{ cookies: "c_user=201;", uid: "201", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "ineligible" }], columns: pageCols as never });
    _lsStore.set(`ss_pageLedger:f1`, JSON.stringify({ "201": { p: 3, w: true } }));
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(0);
    harness.nextWaCheck = () => ({ eligible: true, linkedNumber: "123" });
    await useSheetStore.getState().runWaChecksWaFiltered(() => true);
    expect(harness.waCheckCalls.length).toBe(1);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("eligible");
  });

  it("cache hit eligible skips live calls for auto and manual-wa", async () => {
    await openTestFile();
    _lsStore.set("ss_waCheck", "true");
    _lsStore.set("ss_checkWa", "true");
    useSheetStore.setState({ rows: [{ cookies: "c_user=300;", uid: "300", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }], columns: pageCols as never });
    harness.waCache = { "300": { status: "eligible", banReason: null, error: null, pageName: "Cached", linkedNumber: null, ts: Date.now() } } as unknown as Record<string, unknown>;
    await useSheetStore.getState().runWaChecks();
    expect(harness.pageCheckCalls.length).toBe(0);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("eligible");
    expect(useSheetStore.getState().rows[0].wa_page_name).toBe("Cached");
    // manual-wa also cache-first
    useSheetStore.setState({ rows: [{ cookies: "c_user=301;", uid: "301", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }], columns: pageCols as never });
    harness.waCache = { "301": { status: "eligible", banReason: null, error: null, pageName: "CachedWA", linkedNumber: null, ts: Date.now() } } as unknown as Record<string, unknown>;
    harness.pageCheckCalls = []; harness.waCheckCalls = []; harness.getWaCacheCalls = [];
    await useSheetStore.getState().runWaChecksWaFiltered(() => true);
    expect(harness.waCheckCalls.length).toBe(0);
    expect(harness.getWaCacheCalls.length).toBe(1);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("eligible");
  });

  it("page sweep skips dead, held, approved and already-eligible rows", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=401;", uid: "401", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "", _dead: true },
        { cookies: "c_user=402;", uid: "402", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "", _hold: true },
        { cookies: "c_user=403;", uid: "403", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "", _approved: true },
        { cookies: "c_user=404;", uid: "404", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "eligible" },
      ],
      columns: pageCols as never,
    });
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecksFiltered(() => true);
    expect(harness.pageCheckCalls.length).toBe(0);
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecksWaFiltered(() => true);
    expect(harness.waCheckCalls.length).toBe(0);
    const rows = useSheetStore.getState().rows;
    expect(rows[0].wa_status).toBe("");
    expect(rows[3].wa_status).toBe("eligible");
  });

  it("applyUpload replace hydrates cached eligibility without live checks", async () => {
    await openTestFile();
    useSheetStore.setState({ columns: pageCols as never });
    _lsStore.set("ss_autoCheck", "false");
    harness.waCache = { "700": { status: "eligible", banReason: null, error: null, pageName: "Cached", linkedNumber: "123", ts: Date.now() } } as unknown as Record<string, unknown>;
    harness.pageCheckCalls = []; harness.waCheckCalls = []; harness.getWaCacheCalls = []; harness.persistCalls = [];
    useSheetStore.getState().applyUpload("replace", [{ cookies: "c_user=700;", uid: "700", twofakey: "JBSWY3DPEHPK3PXP" }]);
    // rows land immediately with blank wa_status (no blocking on network)
    expect(useSheetStore.getState().rows[0].wa_status).toBeFalsy();
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.getWaCacheCalls.length).toBe(1);
    expect(harness.pageCheckCalls.length).toBe(0);
    expect(harness.waCheckCalls.length).toBe(0);
    expect(useSheetStore.getState().rows[0].wa_status).toBe("eligible");
    expect(useSheetStore.getState().rows[0].wa_page_name).toBe("Cached");
    expect(useSheetStore.getState().rows[0].wa_linked_number).toBe("123");
    // debounced persist carries the eligibility to the server copy (pool feed)
    await new Promise((r) => setTimeout(r, 400));
    const last = harness.persistCalls[harness.persistCalls.length - 1];
    expect(last.payload.rows[0].wa_status).toBe("eligible");
  });

  it("applyUpload append hydrates cached ineligible without live checks", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [{ cookies: "c_user=701;", uid: "701", twofakey: "JBSWY3DPEHPK3PXP" }],
      columns: pageCols as never,
    });
    _lsStore.set("ss_autoCheck", "false");
    harness.waCache = { "702": { status: "ineligible", banReason: "banned", error: null, pageName: null, linkedNumber: null, ts: Date.now() } } as unknown as Record<string, unknown>;
    harness.pageCheckCalls = []; harness.waCheckCalls = []; harness.getWaCacheCalls = [];
    useSheetStore.getState().applyUpload("append", [{ cookies: "c_user=702;", uid: "702", twofakey: "JBSWY3DPEHPK3PXP" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.getWaCacheCalls.length).toBe(1);
    expect(harness.pageCheckCalls.length).toBe(0);
    expect(harness.waCheckCalls.length).toBe(0);
    const rows = useSheetStore.getState().rows;
    const appended = rows.find((r) => r.uid === "702");
    expect(appended?.wa_status).toBe("ineligible");
    expect(appended?.wa_ban_reason).toBe("banned");
    // untouched row keeps blank status (no cache entry)
    expect(rows.find((r) => r.uid === "701")?.wa_status).toBeFalsy();
  });

  it("same cuser rows in same sweep do not double WA", async () => {
    await openTestFile();
    _lsStore.set("ss_waCheck", "true");
    _lsStore.set(`ss_pageLedger:f1`, JSON.stringify({ "400": { p: 2, w: false } }));
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=400;", uid: "400", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" },
        { cookies: "c_user=400;", uid: "400", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" },
      ], columns: pageCols as never
    });
    harness.nextPageCheck = () => ({ eligible: false, error: null });
    harness.nextWaCheck = () => ({ eligible: false, error: null });
    harness.pageCheckCalls = []; harness.waCheckCalls = [];
    await useSheetStore.getState().runWaChecks();
    // two pageChecks (one per row) but only one waCheck for the shared cuser
    expect(harness.pageCheckCalls.length).toBe(2);
    expect(harness.waCheckCalls.length).toBe(1);
    expect((ledger("f1")["400"] as { w: boolean }).w).toBe(true);
  });

  it("cookie edit resets ledger for new cuser", async () => {
    await openTestFile();
    _lsStore.set(`ss_pageLedger:f1`, JSON.stringify({ "500": { p: 2, w: false }, "501": { p: 3, w: true } }));
    useSheetStore.setState({ rows: [{ cookies: "c_user=500;", uid: "500", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" }], columns: pageCols as never });
    useSheetStore.getState().commitCell(0, "cookies", "c_user=501; new=1");
    expect(ledger("f1")["501"]).toBeUndefined();
    expect((ledger("f1")["500"] as { p: number }).p).toBe(2);
  });

  it("bulk merge does not exclude row 0", async () => {
    await openTestFile();
    _lsStore.set("ss_waCheck", "true");
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=600;", uid: "600", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" },
        { cookies: "c_user=601;", uid: "601", twofakey: "JBSWY3DPEHPK3PXP", status: "good", wa_status: "" },
      ], columns: pageCols as never
    });
    // stub pageCheck to mark eligible, if bulk incorrectly excluded row 0, only one call would happen
    harness.nextPageCheck = () => ({ eligible: true, pageName: "P" });
    // use internal core with bulk sentinel -1 (no exclusion) — merge uses null sentinel
    await (useSheetStore.getState() as unknown as { _pageSweepCore: (m: string, f?: unknown, e?: number) => Promise<void> })._pageSweepCore("auto-page", undefined, null as unknown as number);
    expect(harness.pageCheckCalls.length).toBe(2);
  });

  it("isPageFile false when no columns", async () => {
    const { isPageFile } = await import("@/features/filetypes");
    // no columns -> false even with preset page (production behavior)
    expect(isPageFile({ id: "x", name: "pageTest", type: "fb_cookie", preset: "page" } as unknown as never)).toBe(false);
    // with columns -> true
    expect(isPageFile({ id: "x", name: "pageTest", type: "fb_cookie", preset: "page", columns: pageCols } as unknown as never)).toBe(true);
  });
});

describe("undo / redo / selection / rows", () => {
  it("undo restores the previous value and redo reapplies it", async () => {
    await openTestFile();
    useSheetStore.getState().commitCell(0, "cookies", "c_user=9;");
    expect(useSheetStore.getState().rows[0].cookies).toBe("c_user=9;");
    expect(useSheetStore.getState().rows[0].uid).toBe("9");
    useSheetStore.getState().undo();
    expect(useSheetStore.getState().rows[0].cookies).toBe("");
    expect(useSheetStore.getState().rows[0].uid).toBe("");
    useSheetStore.getState().redo();
    expect(useSheetStore.getState().rows[0].cookies).toBe("c_user=9;");
    expect(useSheetStore.getState().rows[0].uid).toBe("9");
  });

  it("undo with an empty stack changes nothing", async () => {
    await openTestFile();
    const before = useSheetStore.getState().rows;
    useSheetStore.getState().undo();
    useSheetStore.getState().redo();
    expect(useSheetStore.getState().rows).toBe(before);
    expect(useSheetStore.getState().isDirty).toBe(false);
  });

  it("a new edit clears the redo stack", async () => {
    await openTestFile();
    const st = () => useSheetStore.getState();
    st().commitCell(0, "cookies", "c_user=1;");
    st().undo();
    expect(st().rows[0].cookies).toBe("");
    st().commitCell(0, "cookies", "c_user=2;");
    st().redo();
    expect(st().rows[0].cookies).toBe("c_user=2;");
  });

  it("selectAllCells selects every cell; unselectAll exits", async () => {
    await openTestFile();
    const st = () => useSheetStore.getState();
    st().selectAllCells();
    expect(st().selectionMode).toBe(true);
    expect(st().selectedItems.size).toBe(st().rows.length * st().columns.length);
    st().unselectAll();
    expect(st().selectionMode).toBe(false);
    expect(st().selectedItems.size).toBe(0);
  });

  it("selectRange with an unknown column selects nothing", async () => {
    await openTestFile();
    const st = () => useSheetStore.getState();
    st().selectRange(0, "nope", 5, "alsono", false);
    expect(st().selectionMode).toBe(false);
    expect(st().selectedItems.size).toBe(0);
  });

  it("deleteSelected clears the rectangle, marks dirty, and stays undoable", async () => {
    await openTestFile();
    useSheetStore.setState({
      rows: [
        { cookies: "c_user=1;", uid: "1", twofakey: "" },
        { cookies: "c_user=2;", uid: "2", twofakey: "" },
      ],
    });
    const st = () => useSheetStore.getState();
    st().selectRange(0, "cookies", 1, "uid", false);
    expect(st().selectedItems.size).toBe(6);
    st().deleteSelected();
    expect(st().rows[0].cookies).toBe("");
    expect(st().rows[1].uid).toBe("");
    expect(st().isDirty).toBe(true);
    expect(st().selectionMode).toBe(false);
    expect(st().undoStack.length).toBe(1);
    st().undo();
    expect(st().rows[0].cookies).toBe("c_user=1;");
  });

  it("deleteSelected without a selection does nothing", async () => {
    await openTestFile();
    useSheetStore.getState().deleteSelected();
    expect(useSheetStore.getState().isDirty).toBe(false);
    expect(useSheetStore.getState().undoStack.length).toBe(0);
  });

  it("addRow appends a page of empty rows and refuses at the cap", async () => {
    await openTestFile();
    const st = () => useSheetStore.getState();
    expect(st().rows.length).toBe(100);
    st().addRow();
    expect(st().rows.length).toBe(200);
    expect(st().rows.slice(100).every((r) => !r.cookies && !r.uid && !r.twofakey)).toBe(true);
    useSheetStore.setState({ rows: Array.from({ length: 500 }, () => ({})) });
    st().addRow();
    expect(st().rows.length).toBe(500);
  });

  it("applyRestore swaps in server rows, pads, and stays undoable", async () => {
    await openTestFile();
    const st = () => useSheetStore.getState();
    st().commitCell(0, "cookies", "c_user=9;");
    st().applyRestore([{ cookies: "c_user=1;", uid: "1", twofakey: "" }], 42);
    expect(st().rows[0].cookies).toBe("c_user=1;");
    expect(st().rows.length).toBe(100);
    expect(st().lastSeq).toBe(42);
    expect(st().isDirty).toBe(false);
    expect(st().changeJournal).toEqual([]);
    st().undo();
    expect(st().rows[0].cookies).toBe("c_user=9;");
  });
});
describe("paste-duplicate block", () => {
  const cols = [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }];

  it("rejects a uid already present in another row", async () => {
    const { setToastFn } = await import("@/lib/toast");
    const toasted: string[] = [];
    setToastFn((m: string) => { toasted.push(m); });
    try {
      await openTestFile();
      useSheetStore.setState({
        columns: cols as never,
        rows: [
          { cookies: "c_user=11;", uid: "11", twofakey: "" },
          { cookies: "c_user=22;", uid: "22", twofakey: "" },
        ],
      });
      useSheetStore.getState().commitCell(0, "uid", "22");
      const s = useSheetStore.getState();
      expect(s.rows[0].uid).toBe("11");
      expect(s.isDirty).toBe(false);
      expect(toasted).toContain("Duplicate in this file");
    } finally {
      setToastFn(null);
    }
  });

  it("accepts a uid no other row has", async () => {
    await openTestFile();
    useSheetStore.setState({
      columns: cols as never,
      rows: [
        { cookies: "c_user=11;", uid: "11", twofakey: "" },
        { cookies: "c_user=22;", uid: "22", twofakey: "" },
      ],
    });
    useSheetStore.getState().commitCell(0, "uid", "33");
    expect(useSheetStore.getState().rows[0].uid).toBe("33");
  });

  it("accepts clearing a row out of a pre-existing duplicate", async () => {
    await openTestFile();
    useSheetStore.setState({
      columns: cols as never,
      rows: [
        { cookies: "c_user=22;", uid: "22", twofakey: "" },
        { cookies: "c_user=22;", uid: "22", twofakey: "" },
      ],
    });
    useSheetStore.getState().commitCell(0, "uid", "23");
    expect(useSheetStore.getState().rows[0].uid).toBe("23");
  });

  it("rejects a 2fa key already present in another row", async () => {
    const { setToastFn } = await import("@/lib/toast");
    const toasted: string[] = [];
    setToastFn((m: string) => { toasted.push(m); });
    try {
      await openTestFile();
      useSheetStore.setState({
        columns: cols as never,
        rows: [
          { cookies: "c_user=11;", uid: "11", twofakey: "KEYAAA" },
          { cookies: "c_user=22;", uid: "22", twofakey: "KEYBBB" },
        ],
      });
      useSheetStore.getState().commitCell(0, "twofakey", "KEYBBB");
      expect(useSheetStore.getState().rows[0].twofakey).toBe("KEYAAA");
      expect(toasted).toContain("Duplicate in this file");
    } finally {
      setToastFn(null);
    }
  });
});
