import { create } from "zustand";
import { api, type AppendOp, type AppendPayload } from "@/lib/api";
import {
  fileColumns,
  isDataRow,
  isNo2FAMark,
  NO_2FA_MARK,
  type ColumnDef,
  type CrossDupEntry,
  type Row,
  type SheetFile,
  type CheckCacheEntry,
} from "@/lib/types";
import { checkStatusOf, applyCheckFields, CHECK_FIELDS } from "@/lib/check";
import { getFileBehavior, isPageFile } from "@/features/filetypes";
import { toast } from "@/lib/toast";
import { mirrorPending, snapshotFile, applyMirror, idbGet, idbDel, mirrorKey, snapKey } from "@/lib/idb";
import type { JournalMirror, FileSnapshot } from "@/lib/idb";
import { vibrate } from "@/lib/utils";
import { hydrateCheckCache } from "@/lib/xlsx";
import { poolRowKey } from "@/lib/live";
import { IS_DESKTOP } from "@/lib/device";
import { getCachedTOTP } from "@/features/filetypes/totp";

// ── Simple/advanced ledger (device only, per file, keyed by c_user) ──
type LedgerEntry = { s: number; a: boolean };
type Ledger = Record<string, LedgerEntry>;
function ledgerKey(fileId: string): string {
  return `ss_pageLedger:${fileId}`;
}
function loadLedger(fileId: string | null): Ledger {
  if (!fileId) return {};
  try {
    const raw = localStorage.getItem(ledgerKey(fileId));
    if (!raw) return {};
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? (j as Ledger) : {};
  } catch {
    return {};
  }
}
function saveLedger(fileId: string | null, ledger: Ledger): void {
  if (!fileId) return;
  try {
    localStorage.setItem(ledgerKey(fileId), JSON.stringify(ledger));
  } catch {
    // ignore
  }
}
function resetLedgerEntry(fileId: string | null, cuser: string | null | undefined): void {
  if (!fileId || !cuser) return;
  const ledger = loadLedger(fileId);
  if (ledger[cuser]) {
    delete ledger[cuser];
    saveLedger(fileId, ledger);
  }
}
function extractCUser(cookies: string | null | undefined): string | null {
  if (!cookies) return null;
  const m = cookies.match(/c_user=(\d+)/);
  return m ? m[1] : null;
}
// pending trigger for auto sweep exclusion
let pendingAutoTriggerRow: number | null = null;


export interface CellDelta {
  rowIdx: number;
  colKey: string;
  prevVal: string;
}

export interface CellBatchDelta {
  type: "cells";
  deltas: CellDelta[];
}

export interface RowsDelta {
  type: "rows";
  prevRows: Row[];
}

export type UndoEntry = CellDelta | CellBatchDelta | RowsDelta;

export interface SelectedCell {
  rowIdx: number;
  colIdx: string;
  originalVal: string;
}

export type SheetStatus = "idle" | "loading" | "ready" | "error";

export type CellStyle = { bg?: string; color?: string; bold?: boolean };
export type CellStylesMap = Record<string, CellStyle>;

export function parseStyles(row: Row): CellStylesMap {
  const raw = row._cellStyles as string | undefined;
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as CellStylesMap) : {};
  } catch {
    return {};
  }
}

function stringifyStyles(map: CellStylesMap): string {
  return JSON.stringify(map);
}

export function makeEmptyRow(columns: ColumnDef[]): Row {
  const nr: Row = {};
  columns.forEach((c) => {
    nr[c.key] = "";
  });
  nr.status = "";
  return nr;
}

/** fb_cookie dedup key: uid, else c_user extracted from cookies (old
 * dedupKeyForRow). Used by merge + version diff/summaries. */
export function dedupKeyForRow(row: Row): string | null {
  if (row.uid) return row.uid;
  if (row.cookies) {
    const m = row.cookies.match(/c_user=(\d+)/);
    if (m) return m[1];
  }
  return null;
}

interface MarkResult {
  dupCells: Set<string>;
  dupRows: Set<number>;
  crossDupRows: Set<number>;
  hasDuplicates: boolean;
}

function recomputeMarks(
  rows: Row[],
  crossDups: Record<string, unknown[]>,
  columns: ColumnDef[],
): MarkResult {
  const dupCells = new Set<string>();
  const dupRows = new Set<number>();
  const crossDupRows = new Set<number>();

  for (const col of columns) {
    const valMap = new Map<string, number[]>();
    rows.forEach((row, rowIdx) => {
      const val = (row[col.key] ?? "").trim();
      // The bubble's "No 2FA" placeholder is display-only — never treat
      // two skipped rows as duplicates of each other.
      if (!val || isNo2FAMark(col.key, val)) return;
      const list = valMap.get(val);
      if (list) list.push(rowIdx);
      else valMap.set(val, [rowIdx]);
    });
    valMap.forEach((idxs) => {
      if (idxs.length > 1) {
        for (const rowIdx of idxs) {
          dupCells.add(`${rowIdx}:${col.key}`);
          dupRows.add(rowIdx);
        }
      }
    });
  }

  rows.forEach((row, rowIdx) => {
    let uid = row.uid ?? row.username;
    if (!uid && row.cookies) {
      const m = row.cookies.match(/c_user=(\d+)/);
      if (m) uid = m[1];
    }
    if (uid && crossDups[uid]) {
      crossDupRows.add(rowIdx);
    }
  });

  return { dupCells, dupRows, crossDupRows, hasDuplicates: dupCells.size > 0 };
}

/** Incremental marks recompute for a single edited row. Reads the current
 * dup/crossDup sets from the store, drops the edited row, recomputes its dup
 * cells (and collision partners) from scratch, and rebuilds any column where
 * the row previously held a dup mark that is no longer valid. */
function recomputeMarksForRow(
  rows: Row[],
  crossDups: Record<string, unknown[]>,
  columns: ColumnDef[],
  rowIdx: number,
): MarkResult {
  const prev = useSheetStore.getState();
  const dupCells = new Set(prev.dupCells);
  const dupRows = new Set(prev.dupRows);
  const crossDupRows = new Set(prev.crossDupRows);

  const oldCells: string[] = [];
  dupCells.forEach((c) => {
    if (c.startsWith(rowIdx + ":")) oldCells.push(c);
  });
  oldCells.forEach((c) => dupCells.delete(c));
  dupRows.delete(rowIdx);
  crossDupRows.delete(rowIdx);

  const row = rows[rowIdx];
  if (row) {
    let uid = row.uid ?? row.username;
    if (!uid && row.cookies) {
      const m = row.cookies.match(/c_user=(\d+)/);
      if (m) uid = m[1];
    }
    if (uid && crossDups[uid]) crossDupRows.add(rowIdx);

    for (const col of columns) {
      const val = (row[col.key] ?? "").trim();
      if (!val || isNo2FAMark(col.key, val)) continue;
      const collisions: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (i === rowIdx) continue;
        const other = (rows[i][col.key] ?? "").trim();
        if (other === val && !isNo2FAMark(col.key, other)) collisions.push(i);
      }
      if (collisions.length > 0) {
        dupCells.add(`${rowIdx}:${col.key}`);
        dupRows.add(rowIdx);
        collisions.forEach((i) => {
          dupCells.add(`${i}:${col.key}`);
          dupRows.add(i);
        });
      }
    }

    oldCells.forEach((cell) => {
      const sep = cell.indexOf(":");
      const colKey = cell.slice(sep + 1);
      if (!colKey || dupCells.has(`${rowIdx}:${colKey}`)) return;
      dupCells.forEach((c) => {
        if (c.slice(c.indexOf(":") + 1) === colKey) dupCells.delete(c);
      });
      const valMap = new Map<string, number[]>();
      rows.forEach((r, i) => {
        const v = (r[colKey] ?? "").trim();
        if (!v) return;
        const list = valMap.get(v);
        if (list) list.push(i);
        else valMap.set(v, [i]);
      });
      valMap.forEach((idxs) => {
        if (idxs.length > 1) {
          for (const ri of idxs) {
            dupCells.add(`${ri}:${colKey}`);
          }
        }
      });
    });
  }

  const finalDupRows = new Set<number>();
  dupCells.forEach((c) => {
    finalDupRows.add(Number(c.slice(0, c.indexOf(":"))));
  });

  return {
    dupCells,
    dupRows: finalDupRows,
    crossDupRows,
    hasDuplicates: dupCells.size > 0,
  };
}

function updateSelFlags(
  items: Set<string>,
  numCols: number,
  numRows: number,
): { selRows: Set<number>; selCols: Set<string> } {
  const rowCounts = new Map<string, number>();
  const colCounts = new Map<string, number>();
  for (const key of items) {
    const parts = key.split(":");
    const r = parts[0];
    const c = parts[1];
    rowCounts.set(r, (rowCounts.get(r) ?? 0) + 1);
    colCounts.set(c, (colCounts.get(c) ?? 0) + 1);
  }
  const selRows = new Set<number>();
  rowCounts.forEach((n, r) => {
    if (n === numCols) selRows.add(Number(r));
  });
  const selCols = new Set<string>();
  colCounts.forEach((n, c) => {
    if (n === numRows) selCols.add(c);
  });
  return { selRows, selCols };
}

export interface SheetState {
  status: SheetStatus;
  fileId: string | null;
  file: SheetFile | null;
  rows: Row[];
  columns: ColumnDef[];
  visibleCols: Set<string>;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  apiLogs: unknown[];
  logBase: number;
  undoBase: number;
  redoBase: number;
  isDirty: boolean;
  changeJournal: AppendOp[];
  lastSeq: number;
  dirtyStructural: boolean;
  structuralVersion: number;
  selectedCell: SelectedCell | null;
  draft: string;
  qebOpen: boolean;
  inlineEdit: boolean;
  selectionMode: boolean;
  selectedItems: Set<string>;
  selRows: Set<number>;
  selCols: Set<string>;
  dupCells: Set<string>;
  dupRows: Set<number>;
  invalidCells: Set<string>;
  crossDupRows: Set<number>;
  hasDuplicates: boolean;
  crossDups: Record<string, unknown[]>;
  checkRunning: boolean;
  pendingAutoCheck: boolean;
  isDesktop: boolean;
  adminMode: boolean;
  adminOwnerId: string | null;
  // Archived viewer: view + copy + UID-check only. All mutations no-op.
  archivedMode: boolean;

  openFile: (id: string) => Promise<void>;
  openFileAdmin: (id: string, ownerId: string) => Promise<void>;
  openFileArchived: (id: string) => Promise<void>;
  closeFile: () => Promise<void>;
  refreshSheet: () => Promise<void>;
  commitCell: (rowIdx: number, colKey: string, value: string) => void;
  persist: (action?: string) => void;
  flushPersist: (action?: string, viaUnload?: boolean) => Promise<void>;
  undo: () => void;
  redo: () => void;
  openQuickEdit: (rowIdx: number, colKey: string) => void;
  openInlineEdit: (rowIdx: number, colKey: string) => void;
  setDraft: (value: string) => void;
  commitQuickEdit: () => void;
  cancelQuickEdit: () => void;
  moveEdit: (dRow: number, dCol: number) => void;
  quickEditPaste: () => Promise<void>;
  quickEditClear: () => void;
  quickEditCopy: () => Promise<void>;
  enterSelectionMode: (
    type: "cell" | "col" | "row",
    row: number,
    col: string | null,
  ) => void;
  toggleSelection: (
    type: "cell" | "col" | "row",
    row: number,
    col: string | null,
  ) => void;
  exitSelectionMode: () => void;
  selectAllCells: () => void;
  unselectAll: () => void;
  selectCellOnly: (rowIdx: number, colKey: string) => void;
  focusCell: (rowIdx: number, colKey: string) => void;
  selectRange: (
    r1: number,
    c1: string,
    r2: number,
    c2: string,
    additive: boolean,
  ) => void;
  deleteSelected: () => void;
  copySelected: () => Promise<void>;
  addRow: () => void;
  doubleTap: (rowIdx: number, colKey: string) => Promise<void>;
  tripleTapRow: (rowIdx: number) => Promise<void>;
  tripleTapCol: (colKey: string) => Promise<void>;
  onDotDoubleTap: (rowIdx: number) => Promise<void>;
  onDotHold: (rowIdx: number) => {
    logs: unknown[];
    label: string;
    crossInfo: CrossDupEntry[];
    check: { status: string; banReason?: string | null } | null;
  } | null;
  toggleVisibleCol: (colKey: string) => void;
  runCheck: (triggerRowIdx?: number) => Promise<void>;
  runPageChecks: () => Promise<void>;
  runPageChecksFiltered: (filter: (row: Row, idx: number) => boolean) => Promise<void>;
  runPageChecksAdvanced: (filter: (row: Row, idx: number) => boolean) => Promise<void>;
  maybeAutoCheck: (rowIdx: number | null | undefined, colKey: string) => void;
  _pageSweepCore?: (mode: "auto-simple" | "manual-simple" | "manual-advanced", filter?: (row: Row, idx: number) => boolean, excludeIdx?: number | null) => Promise<void>;
  restoreVersion: (v: number) => Promise<boolean>;
  applyRestore: (rows: Row[], seq: number, file?: SheetFile | null) => void;
  mergeRows: (incoming: Row[]) => void;
  applyLiveStates: (states: Record<string, { hold?: boolean; approved?: boolean; dead?: boolean }>) => void;
  applyUpload: (mode: "replace" | "append", incoming: Row[]) => void;
  removeEmptyRows: () => void;
  deleteDeadRows: () => void;
  bubbleActiveRow: number;
  bubbleGetActiveRow: () => number;
  bubbleAdvanceActiveRow: () => void;
  bubbleSaveCookie: (text: string) => void;
  bubbleSaveKey: (text: string) => Promise<void>;
  bubbleSkipNo2FA: () => void;
  setCellStyle: (
    rowIdx: number,
    colKey: string,
    patch: { bg?: string | null; color?: string | null; bold?: boolean | null },
  ) => void;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistTimerFileId: string | null = null;
let openSeq = 0;
let structuralCounter = 0;
let saveChain: Promise<void> = Promise.resolve();
const MAX_JOURNAL = 10000;
// Grid caps: at most 500 rows in the sheet buffer, revealed 100 at a time.
export const MAX_GRID_ROWS = 500;
export const GRID_PAGE = 100;

// Merge new ops into existing journal by rowIdx+col instead of replacing whole
// rows. The old `filter(rowIdx)+push` pattern dropped `status` when a later
// page sweep added only `wa_*` for the same row — file looked correct in
// memory (blue/green) but server only got `wa_*`, so reload showed white.
function mergeJournal(
  base: { rowIdx: number; cols: Record<string, string> }[],
  extra: { rowIdx: number; cols: Record<string, string> }[],
) {
  const m = new Map<number, Record<string, string>>();
  base.forEach((op) => m.set(op.rowIdx, { ...op.cols }));
  extra.forEach((c) => m.set(c.rowIdx, { ...m.get(c.rowIdx), ...c.cols }));
  return [...m].map(([rowIdx, cols]) => ({ rowIdx, cols }));
}

export const useSheetStore = create<SheetState>()((set, get) => ({
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
  structuralVersion: 0,
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
  isDesktop: IS_DESKTOP,
  bubbleActiveRow: -1,
  adminMode: false,
  adminOwnerId: null,
  archivedMode: false,

  openFile: async (id) => {
    const seq = ++openSeq;
    pendingAutoTriggerRow = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistTimerFileId = null; }
    set({ status: "loading", adminMode: false, adminOwnerId: null, archivedMode: false, pendingAutoCheck: false });
    try {
      const [full, crossDups] = await Promise.all([
        api.getFileFull(id),
        api.getCrossDups(id).then((d) => d?.dups ?? {}).catch(() => ({})),
      ]);
      const f = full.file;
      if (!f?.id) throw new Error("File not found");
      if (seq !== openSeq) return;
      const columns = fileColumns(f);
      let visibleCols = new Set<string>(columns.map((c) => c.key));
      try {
        const saved = localStorage.getItem(`ss_cols_${id}`);
        if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
      } catch {
        // ignore malformed saved columns
      }
      const rows: Row[] = [...(full.rows ?? [])];
      void snapshotFile(id, full.rows ?? [], full.seq ?? 0, f).catch(() => {});
      const resumed = await resumeLocal(id, rows);
      if (seq !== openSeq) return;
      const finalRows = resumed ? resumed.rows : rows;
      while (finalRows.length < 100) finalRows.push(makeEmptyRow(columns));
      const undoStack = (full.undo ?? []) as UndoEntry[];
      const redoStack = (full.redo ?? []) as UndoEntry[];
      const apiLogs = full.logs ?? [];
      set({
        status: "ready",
        fileId: id,
        file: f,
        rows: finalRows,
        columns,
        visibleCols,
        undoStack,
        redoStack,
        apiLogs,
        logBase: apiLogs.length,
        undoBase: undoStack.length,
        redoBase: redoStack.length,
        isDirty: !!resumed,
        changeJournal: resumed?.journal ?? [],
        lastSeq: full.seq ?? 0,
        dirtyStructural: resumed?.structural ?? false,
        selectedCell: null,
        draft: "",
        qebOpen: false,
        inlineEdit: false,
        selectionMode: false,
        selectedItems: new Set(),
        selRows: new Set(),
        selCols: new Set(),
        invalidCells: new Set(),
        crossDups,
        checkRunning: false,
        pendingAutoCheck: false,
        bubbleActiveRow: -1,
        ...recomputeMarks(finalRows, crossDups, columns),
      });
      if (resumed) void get().flushPersist();
    } catch {
      // Offline / server down: open the last snapshot with queued edits.
      // Quiet by design — a transient toast only, never a blocking banner.
      try {
        const snap = await idbGet<FileSnapshot>(snapKey(id));
        const sf = snap?.file as SheetFile | undefined;
        if (!snap || !sf?.id || seq !== openSeq) throw new Error("no snapshot");
        const columns = fileColumns(sf);
        let visibleCols = new Set<string>(columns.map((c) => c.key));
        try {
          const saved = localStorage.getItem(`ss_cols_${id}`);
          if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
        } catch {
          // ignore malformed saved columns
        }
        const resumed = await resumeLocal(id, [...(snap.rows ?? [])]);
        const finalRows = resumed ? resumed.rows : [...(snap.rows ?? [])];
        while (finalRows.length < 100) finalRows.push(makeEmptyRow(columns));
        set({
          status: "ready",
          fileId: id,
          file: sf,
          rows: finalRows,
          columns,
          visibleCols,
          undoStack: [],
          redoStack: [],
          apiLogs: [],
          logBase: 0,
          undoBase: 0,
          redoBase: 0,
          isDirty: !!resumed,
          changeJournal: resumed?.journal ?? [],
          lastSeq: snap.seq,
          dirtyStructural: resumed?.structural ?? false,
          selectedCell: null,
          draft: "",
          qebOpen: false,
          inlineEdit: false,
          selectionMode: false,
          selectedItems: new Set(),
          selRows: new Set(),
          selCols: new Set(),
          invalidCells: new Set(),
          crossDups: {},
          checkRunning: false,
          pendingAutoCheck: false,
          bubbleActiveRow: -1,
          ...recomputeMarks(finalRows, {}, columns),
        });
        toast("You are offline. Showing the last saved version.");
      } catch {
        set({ status: "error" });
      }
    }
  },

  closeFile: async () => {
    openSeq++;
    pendingAutoTriggerRow = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistTimerFileId = null; }
    set({ pendingAutoCheck: false });
    const st = get();
    // Archived viewer never mutates: skip the draft-commit + final flush.
    if (!st.archivedMode) {
      if (st.selectedCell && (st.qebOpen || st.inlineEdit)) {
        const rows = st.rows.slice();
        rows[st.selectedCell.rowIdx] = { ...rows[st.selectedCell.rowIdx], [st.selectedCell.colIdx]: st.draft };
        set({ rows, isDirty: true, dirtyStructural: true, structuralVersion: ++structuralCounter });
      }
      if (get().isDirty) await get().flushPersist();
    }
    set({
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
      archivedMode: false,
    });
  },

  openFileAdmin: async (id, ownerId) => {
    const seq = ++openSeq;
    pendingAutoTriggerRow = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistTimerFileId = null; }
    set({ status: "loading", adminMode: true, adminOwnerId: ownerId, pendingAutoCheck: false });
    try {
      const [f, rowsRes, logsRes, undoData] = await Promise.all([
        api.adminFile(id),
        api.adminFileRows(id),
        api.adminFileLogs(id),
        api.adminUndo(id),
      ]);
      if (!f?.id) throw new Error("File not found");
      if (seq !== openSeq) return;
      const columns = fileColumns(f);
      let visibleCols = new Set<string>(columns.map((c) => c.key));
      try {
        const saved = localStorage.getItem(`ss_cols_${id}`);
        if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
      } catch {
        // ignore malformed saved columns
      }
      const rows: Row[] = [...(rowsRes ?? [])];
      void snapshotFile(id, rowsRes ?? [], f.seq ?? 0, f).catch(() => {});
      const resumed = await resumeLocal(id, rows);
      if (seq !== openSeq) return;
      const finalRows = resumed ? resumed.rows : rows;
      while (finalRows.length < 100) finalRows.push(makeEmptyRow(columns));
      const undoStack = (undoData?.undo ?? []) as UndoEntry[];
      const redoStack = (undoData?.redo ?? []) as UndoEntry[];
      const apiLogs = logsRes ?? [];
      set({
        status: "ready",
        fileId: id,
        file: f,
        rows: finalRows,
        columns,
        visibleCols,
        undoStack,
        redoStack,
        apiLogs,
        logBase: apiLogs.length,
        undoBase: undoStack.length,
        redoBase: redoStack.length,
        isDirty: !!resumed,
        changeJournal: resumed?.journal ?? [],
        lastSeq: f.seq ?? 0,
        dirtyStructural: resumed?.structural ?? false,
        selectedCell: null,
        draft: "",
        qebOpen: false,
        inlineEdit: false,
        selectionMode: false,
        selectedItems: new Set(),
        selRows: new Set(),
        selCols: new Set(),
        invalidCells: new Set(),
        crossDups: {},
        checkRunning: false,
        pendingAutoCheck: false,
        bubbleActiveRow: -1,
        archivedMode: false,
        ...recomputeMarks(finalRows, {}, columns),
      });
      if (resumed) void get().flushPersist();
    } catch {
      set({ status: "error" });
    }
  },

  // Archived viewer: view + copy + UID-check only. No snapshots, no local
  // resume, no persist — the file stays archived until explicitly restored.
  openFileArchived: async (id) => {
    const seq = ++openSeq;
    pendingAutoTriggerRow = null;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; persistTimerFileId = null; }
    set({ status: "loading", adminMode: false, adminOwnerId: null, archivedMode: true, pendingAutoCheck: false });
    try {
      const full = await api.getArchiveFull(id);
      const f = full.file;
      if (!f?.id) throw new Error("File not found");
      if (seq !== openSeq) return;
      const columns = fileColumns(f);
      let visibleCols = new Set<string>(columns.map((c) => c.key));
      try {
        const saved = localStorage.getItem(`ss_cols_${id}`);
        if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
      } catch {
        // ignore malformed saved columns
      }
      const finalRows = [...(full.rows ?? [])];
      while (finalRows.length < 100) finalRows.push(makeEmptyRow(columns));
      set({
        status: "ready",
        fileId: id,
        file: f,
        rows: finalRows,
        columns,
        visibleCols,
        undoStack: [],
        redoStack: [],
        apiLogs: [],
        logBase: 0,
        undoBase: 0,
        redoBase: 0,
        isDirty: false,
        changeJournal: [],
        lastSeq: full.seq ?? 0,
        dirtyStructural: false,
        selectedCell: null,
        draft: "",
        qebOpen: false,
        inlineEdit: false,
        selectionMode: false,
        selectedItems: new Set(),
        selRows: new Set(),
        selCols: new Set(),
        invalidCells: new Set(),
        crossDups: {},
        checkRunning: false,
        pendingAutoCheck: false,
        bubbleActiveRow: -1,
        archivedMode: true,
        ...recomputeMarks(finalRows, {}, columns),
      });
    } catch {
      if (seq === openSeq) set({ status: "error" });
    }
  },

  refreshSheet: async () => {
    const fileId = get().fileId;
    if (!fileId) return;
    if (get().archivedMode) return;
    if (get().isDirty || get().changeJournal.length || get().dirtyStructural) return;
    const rowsBefore = get().rows;
    try {
      const rowsRes = get().adminMode
        ? await api.adminFileRows(fileId)
        : await api.getRows(fileId);
      if (fileId !== get().fileId) return;
      // A local edit landed while the fetch was in flight — applying the stale
      // snapshot would wipe it. Bail if dirty or rows identity changed.
      if (get().isDirty || get().changeJournal.length || get().dirtyStructural) return;
      if (get().rows !== rowsBefore) return;
      const columns = get().columns;
      const rows: Row[] = [...(rowsRes ?? [])];
      while (rows.length < 100) rows.push(makeEmptyRow(columns));
      set({ rows, ...recomputeMarks(rows, get().crossDups, columns) });
    } catch {
      // swallow
    }
  },

  commitCell: (rowIdx, colKey, value) => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const row = s.rows[rowIdx];
    if (!row) return;
    if (row._hold || row._approved) {
      // Locked rows reject edits — say so loudly instead of dropping silently
      // (users thought pasted keys "vanished").
      toast("This row is on hold. Editing is locked.");
      return;
    }
    if (colKey === "twofakey" && value && value !== NO_2FA_MARK) {
      // Normalize like the bubble does (spaces/dashes out, uppercase) so
      // direct pastes dedup and pool-match exactly like bubble entries. A
      // multi-line paste keeps the first non-cookie line (cookie-first blobs
      // belong in the cookies cell, which splits them — see below).
      const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
      const candidate = lines.find((l) => !/c_user=\d+/.test(l)) ?? lines[0] ?? "";
      value = candidate.replace(/[\s\-]/g, "").toUpperCase();
    }
    let extraKey = "";
    if (colKey === "cookies" && !row.twofakey && value.includes("\n")) {
      // "cookie + key" blob pasted into the cookie cell: split the key line
      // into the 2FA cell instead of trapping it invisibly in cookies.
      const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const cookieLine = lines.find((l) => /c_user=\d+/.test(l));
        const keyLine = lines.find((l) => l !== cookieLine && /^[A-Z2-7]{10,}$/.test(l.replace(/[\s\-]/g, "").toUpperCase()));
        if (cookieLine && keyLine) {
          value = cookieLine;
          extraKey = keyLine.replace(/[\s\-]/g, "").toUpperCase();
        }
      }
    }
    const prevVal = row[colKey] ?? "";
    if (value === prevVal && !extraKey) return;
    // Same-file duplicates can never pool — block them at entry instead of
    // writing a row the grid would immediately flag orange. (Cross-file
    // duplicates are only known after the server scan, so they flag instead.)
    const dupHit = (key: string, val: string): boolean => {
      const v = val.trim();
      if (!v || isNo2FAMark(key, v)) return false;
      return s.rows.some((r, i) => i !== rowIdx && ((r[key] ?? "").trim() === v));
    };
    if (dupHit(colKey, value) || (extraKey ? dupHit("twofakey", extraKey) : false)) {
      toast("This value already exists in this file.");
      return;
    }
    if (colKey === "cookies" && isPageFile(s.file)) {
      const newCUser = extractCUser(value);
      if (newCUser) resetLedgerEntry(s.fileId, newCUser);
    }
    const prevRow = { ...row };
    const newRows = s.rows.slice();
    newRows[rowIdx] = { ...row, [colKey]: value };
    if (extraKey) newRows[rowIdx] = { ...newRows[rowIdx], twofakey: extraKey };
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    const newInvalid = new Set(s.invalidCells);
    if (behavior?.onCellChange) {
      behavior.onCellChange({
        rows: newRows,
        rowIdx,
        colKey,
        value,
        invalidCells: newInvalid,
        showToast: toast,
      });
    }
    // A single edit may change multiple columns of the same row (e.g. pasting a
    // cookie also autofills the uid cell via onCellChange). Record ONE undo
    // entry covering all of them so undo/redo act as a single interaction.
    const deltas: CellDelta[] = [];
    s.columns.forEach((c) => {
      const before = prevRow[c.key] ?? "";
      const after = newRows[rowIdx][c.key] ?? "";
      if (before !== after) {
        deltas.push({ rowIdx, colKey: c.key, prevVal: before });
      }
    });
    if (!deltas.length) deltas.push({ rowIdx, colKey, prevVal });
    const undoStack: UndoEntry[] = [...s.undoStack];
    if (deltas.length > 1) undoStack.push({ type: "cells", deltas });
    else undoStack.push(deltas[0]);
    if (undoStack.length > 100) undoStack.shift();
    const journalCols: Record<string, string> = {};
    deltas.forEach((d) => {
      journalCols[d.colKey] = newRows[rowIdx][d.colKey] ?? "";
    });
    const prevCols = s.changeJournal.find((op) => op.rowIdx === rowIdx)?.cols;
    const changeJournal: AppendOp[] = [
      ...s.changeJournal.filter((op) => op.rowIdx !== rowIdx),
      { rowIdx, cols: { ...prevCols, ...journalCols } },
    ];
    if (changeJournal.length > MAX_JOURNAL) {
      // journal overflow: force a flush first instead of silently dropping oldest ops
      toast("Syncing changes.");
      void get().flushPersist();
    }
    set({
      rows: newRows,
      undoStack,
      redoStack: [],
      isDirty: true,
      changeJournal,
      invalidCells: newInvalid,
      ...recomputeMarksForRow(newRows, s.crossDups, s.columns, rowIdx),
    });
    // Keep 10 spare empty rows below the edited row so users never hit a
    // wall at the bottom — no manual "Add row" needed while typing down.
    // Padding only (never dirty): trims and sparse appends ignore it.
    const grown = get();
    if (!grown.archivedMode && rowIdx >= grown.rows.length - 10 && grown.rows.length < MAX_GRID_ROWS) {
      const add = Math.min(10, MAX_GRID_ROWS - grown.rows.length);
      if (add > 0) {
        set({ rows: grown.rows.concat(Array.from({ length: add }, () => makeEmptyRow(grown.columns))) });
      }
    }
    get().maybeAutoCheck(rowIdx, colKey);
    get().persist();
    if (
      colKey === "twofakey" &&
      value &&
      !s.isDesktop &&
      /^[A-Z2-7]{10,}$/.test(value.replace(/[\s\-]/g, "").toUpperCase())
    ) {
      void getCachedTOTP(value)
        .then((r) => {
          if (!r) return;
          if (get().fileId !== s.fileId) return;
          navigator.clipboard.writeText(r.code).catch(() => {});
        })
        .catch(() => {});
    }
  },

  persist: (action) => {
    const fileId = get().fileId;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimerFileId = fileId;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      // stale timer from a previous file must not flush into the new file
      if (persistTimerFileId !== get().fileId) return;
      void get().flushPersist(action);
    }, action ? 0 : 300);
    // Durable outbox mirror (save-raw-first): every mutation lands in IndexedDB
    // synchronously, so a killed app / dead network loses nothing. Full rows
    // only when a structural change is pending (bounded: 500/file).
    if (fileId) {
      const st = get();
      void mirrorPending(fileId, st.changeJournal, st.dirtyStructural, st.dirtyStructural ? st.rows : undefined, st.lastSeq).catch(() => {});
    }
  },

  flushPersist: async (action, viaUnload) => {
    const run = async () => {
      const s = get();
      if (!s.fileId || !s.file) return;
      // Archived viewer never writes back.
      if (s.archivedMode) return;
      const columns = fileColumns(s.file);
      let dataCount = 0;
      let lastData = -1;
      s.rows.forEach((row, idx) => {
        const hasData = isDataRow(row, columns);
        if (hasData) {
          dataCount++;
          lastData = idx;
        }
      });
      if (action || s.dirtyStructural || s.adminMode) {
        if (!s.isDirty) return;
        const keepCount = Math.min(s.rows.length, Math.max(lastData + 51, 100));
        const trimmed = s.rows.slice(0, keepCount);
        // Slim payload: server only reads rows/base/action/dataCount/userId.
        // ( undo/redo/logs used to ride along — dead weight on every save.)
        const payload: {
          rows: Row[];
          base: number;
          dataCount: number;
          action?: string;
          userId?: string;
        } = {
          rows: trimmed,
          base: s.lastSeq,
          dataCount,
        };
        if (action) payload.action = action;
        const startStruct = s.structuralVersion;
        let resp: { ok: boolean; seq?: number } | undefined;
        try {
          if (s.adminMode) {
            payload.userId = s.adminOwnerId ?? undefined;
            resp = await api.adminPersist(s.fileId, payload);
          } else {
            resp = await api.persist(s.fileId, payload, { keepalive: !!viaUnload });
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          if (errMsg.startsWith("409") && errMsg.includes("version conflict")) {
            // Another writer saved first. Reload their version, stash ours in
            // Undo (restorable), re-apply unsent cell edits on top, and continue
            // with the fresh base — never silently overwrite their rows.
            try {
              let freshRows: Row[] | null = null;
              let freshSeq: number | null = null;
              let freshFile = null;
              if (s.adminMode) {
                const f = await api.adminFile(s.fileId);
                if (!f?.id) return;
                freshFile = f;
                freshRows = await api.adminFileRows(s.fileId);
                freshSeq = f.seq ?? null;
              } else {
                const fresh = await api.getFileFull(s.fileId);
                if (!fresh.file?.id) return;
                freshFile = fresh.file;
                freshRows = fresh.rows ?? [];
                freshSeq = fresh.seq ?? null;
              }
              const cur = get();
              if (cur.fileId !== s.fileId) return;
              const undoStack: UndoEntry[] = [...cur.undoStack, { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) }];
              if (undoStack.length > 100) undoStack.shift();
              const rows: Row[] = [...(freshRows ?? [])];
              while (rows.length < 100) rows.push(makeEmptyRow(fileColumns(cur.file)));
              const liveJournal = get().changeJournal.length ? get().changeJournal : s.changeJournal;
              liveJournal.forEach((op) => {
                const row = rows[op.rowIdx];
                if (!row) return;
                rows[op.rowIdx] = { ...row, ...op.cols };
              });
              set({
                file: (freshFile ?? cur.file) as SheetFile,
                rows,
                undoStack,
                redoStack: [],
                changeJournal: liveJournal,
                lastSeq: freshSeq ?? s.lastSeq,
                isDirty: liveJournal.length > 0,
                dirtyStructural: false,
                ...recomputeMarks(rows, cur.crossDups, cur.columns),
              });
              syncMirror(s.fileId);
              toast("Updated with the latest version. Your changes are in Undo.");
            } catch {
              toast("Sync conflict detected. Retrying.");
            }
            return;
          }
          if (errMsg.startsWith("409")) {
            // Server refused the structural save (e.g. deleted rows are on hold
            // and locked). Keep local dirty state and tell the owner why.
            toast(errMsg.split(" - ").slice(1).join(" - ").trim() || "These rows are on hold. Editing is locked.");
            return;
          }
          toast("Sync failed. Retrying.");
          return;
        }
        const cur = get();
        if (cur.fileId === s.fileId && cur.rows === s.rows) {
          set({
            isDirty: false,
            changeJournal: [],
            lastSeq: resp?.seq ?? s.lastSeq,
            dirtyStructural: false,
            logBase: cur.apiLogs.length,
            undoBase: cur.undoStack.length,
            redoBase: cur.redoStack.length,
          });
          void snapshotFile(s.fileId, trimmed, resp?.seq ?? s.lastSeq).catch(() => {});
          syncMirror(s.fileId);
          trimMemoryRows();
        } else if (cur.fileId === s.fileId && resp) {
          // Newer edits landed while the structural persist was in flight. The
          // structural change was already sent; keep dirtyStructural only if a
          // NEW structural change arrived (cell edits belong in the journal and
          // can go out as a small append instead of another full upload).
          // Adopt the new seq too — our rows are on the server, so the next
          // append must use it as base instead of 409ing.
          set({ dirtyStructural: cur.structuralVersion !== startStruct, lastSeq: resp.seq });
        }
      } else {
        if (s.changeJournal.length === 0 && !s.isDirty) return;
        const payload: AppendPayload = {
          base: s.lastSeq,
          ops: s.changeJournal,
          newLogs: s.apiLogs.slice(s.logBase),
          undoNew: s.undoStack.slice(s.undoBase),
          redoNew: s.redoStack.slice(s.redoBase),
          dataCount,
        };
        try {
          const resp = await api.append(s.fileId, payload, { keepalive: !!viaUnload });
          const cur = get();
          if (cur.fileId === s.fileId && cur.rows === s.rows) {
            set({
              changeJournal: [],
              lastSeq: resp.seq,
              isDirty: false,
              logBase: cur.apiLogs.length,
              undoBase: cur.undoStack.length,
              redoBase: cur.redoStack.length,
            });
            void snapshotFile(s.fileId, cur.rows, resp.seq).catch(() => {});
            syncMirror(s.fileId);
            trimMemoryRows();
          } else if (cur.fileId === s.fileId && resp) {
            // Newer edits landed mid-flight, but our ops still applied (the
            // server moved to resp.seq). Adopt it as the next base — reusing
            // the stale base would 409, refetch the whole file and remount
            // the grid on every overlapping save. Journal resend is a
            // last-writer-wins merge of the same values, so it stays safe.
            set({ lastSeq: resp.seq });
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          if (errMsg.startsWith("409")) {
            // Version conflict: the append base is stale. Refetch the server's
            // latest state and re-apply our unsent journal onto it so local
            // edits survive; the next flush re-appends with the new base.
            try {
              const fresh = await api.getFileFull(s.fileId);
              const f = fresh.file;
              const cur = get();
              if (!f?.id || cur.fileId !== s.fileId) return;
              const freshCols = fileColumns(f);
              const rows: Row[] = [...(fresh.rows ?? [])];
              while (rows.length < 100) rows.push(makeEmptyRow(freshCols));
              const liveJournal = get().changeJournal.length ? get().changeJournal : s.changeJournal;
              liveJournal.forEach((op) => {
                const row = rows[op.rowIdx];
                if (!row) return;
                rows[op.rowIdx] = { ...row, ...op.cols };
              });
              set({
                rows,
                changeJournal: liveJournal,
                lastSeq: fresh.seq ?? s.lastSeq,
                isDirty: true,
                ...recomputeMarks(rows, cur.crossDups, cur.columns),
              });
              syncMirror(s.fileId);
            } catch {
              toast("Sync conflict detected. Retrying.");
            }
          } else {
            toast("Sync failed. Retrying.");
          }
        }
      }
    };
    saveChain = saveChain.then(run).catch(() => {});
    await saveChain;
  },

  undo: () => {
    const s = get();
    if (!s.undoStack.length) return;
    const undoStack = s.undoStack.slice();
    const delta = undoStack.pop();
    if (!delta) return;
    const redoStack = s.redoStack.slice();
    let rows = s.rows;
    if ("type" in delta && delta.type === "cells") {
      const redoDeltas: CellDelta[] = [];
      const newRows = rows.slice();
      delta.deltas.forEach((d) => {
        const row = newRows[d.rowIdx];
        const currentVal = row ? (row[d.colKey] ?? "") : "";
        redoDeltas.push({ rowIdx: d.rowIdx, colKey: d.colKey, prevVal: currentVal });
        if (row) {
          newRows[d.rowIdx] = { ...row, [d.colKey]: d.prevVal };
        }
      });
      redoStack.push({ type: "cells", deltas: redoDeltas });
      rows = newRows;
    } else if ("type" in delta) {
      redoStack.push({ type: "rows", prevRows: rows.map((r) => ({ ...r })) });
      rows = delta.prevRows.map((r) => ({ ...r }));
    } else {
      const row = rows[delta.rowIdx];
      const currentVal = row ? (row[delta.colKey] ?? "") : "";
      redoStack.push({
        rowIdx: delta.rowIdx,
        colKey: delta.colKey,
        prevVal: currentVal,
      });
      if (row) {
        const newRows = rows.slice();
        newRows[delta.rowIdx] = { ...row, [delta.colKey]: delta.prevVal };
        rows = newRows;
      }
    }
    set({
      rows,
      undoStack,
      redoStack,
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      ...recomputeMarks(rows, s.crossDups, s.columns),
    });
    get().persist();
  },

  redo: () => {
    const s = get();
    if (!s.redoStack.length) return;
    const redoStack = s.redoStack.slice();
    const delta = redoStack.pop();
    if (!delta) return;
    const undoStack = s.undoStack.slice();
    let rows = s.rows;
    if ("type" in delta && delta.type === "cells") {
      const undoDeltas: CellDelta[] = [];
      const newRows = rows.slice();
      delta.deltas.forEach((d) => {
        const row = newRows[d.rowIdx];
        const currentVal = row ? (row[d.colKey] ?? "") : "";
        undoDeltas.push({ rowIdx: d.rowIdx, colKey: d.colKey, prevVal: currentVal });
        if (row) {
          newRows[d.rowIdx] = { ...row, [d.colKey]: d.prevVal };
        }
      });
      undoStack.push({ type: "cells", deltas: undoDeltas });
      rows = newRows;
    } else if ("type" in delta) {
      undoStack.push({ type: "rows", prevRows: rows.map((r) => ({ ...r })) });
      rows = delta.prevRows.map((r) => ({ ...r }));
    } else {
      const row = rows[delta.rowIdx];
      const currentVal = row ? (row[delta.colKey] ?? "") : "";
      undoStack.push({
        rowIdx: delta.rowIdx,
        colKey: delta.colKey,
        prevVal: currentVal,
      });
      if (row) {
        const newRows = rows.slice();
        newRows[delta.rowIdx] = { ...row, [delta.colKey]: delta.prevVal };
        rows = newRows;
      }
    }
    set({
      rows,
      undoStack,
      redoStack,
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      ...recomputeMarks(rows, s.crossDups, s.columns),
    });
    get().persist();
  },

  openQuickEdit: (rowIdx, colKey) => {
    // Archived viewer is read-only (view + copy + UID-check only).
    if (get().archivedMode) return;
    // Commit any pending draft first — grid call sites do this, but toolbar
    // and overlay actions can leave one behind; never silently abandon it.
    const sc = get().selectedCell;
    if (sc && (sc.rowIdx !== rowIdx || sc.colIdx !== colKey)) get().commitQuickEdit();
    const row = get().rows[rowIdx];
    if (!row) return;
    if (row._hold || row._approved) return;
    set({
      selectedCell: { rowIdx, colIdx: colKey, originalVal: row[colKey] ?? "" },
      draft: row[colKey] ?? "",
      qebOpen: true,
      inlineEdit: false,
    });
  },

  openInlineEdit: (rowIdx, colKey) => {
    // Archived viewer is read-only (view + copy + UID-check only).
    if (get().archivedMode) return;
    const sc = get().selectedCell;
    if (sc && (sc.rowIdx !== rowIdx || sc.colIdx !== colKey)) get().commitQuickEdit();
    const row = get().rows[rowIdx];
    if (!row) return;
    if (row._hold || row._approved) return;
    set({
      selectedCell: { rowIdx, colIdx: colKey, originalVal: row[colKey] ?? "" },
      draft: row[colKey] ?? "",
      qebOpen: false,
      inlineEdit: true,
    });
  },

  setDraft: (value) => {
    set({ draft: value });
  },

  commitQuickEdit: () => {
    const sc = get().selectedCell;
    if (!sc) return;
    // Archived viewer is read-only — drop any draft without writing.
    if (get().archivedMode) {
      set({ qebOpen: false, inlineEdit: false, selectedCell: null });
      return;
    }
    get().commitCell(sc.rowIdx, sc.colIdx, get().draft);
    set({ qebOpen: false, inlineEdit: false, selectedCell: null });
  },

  cancelQuickEdit: () => {
    set({ qebOpen: false, inlineEdit: false, selectedCell: null });
  },

  moveEdit: (dRow, dCol) => {
    const sc = get().selectedCell;
    if (!sc) return;
    const rowIdx = sc.rowIdx;
    const colIdx = sc.colIdx;
    const keepInline = get().inlineEdit;
    get().commitQuickEdit();
    const visible = get().columns.filter((c) => get().visibleCols.has(c.key));
    if (!visible.length) return;
    let colKey = colIdx;
    if (dCol !== 0) {
      const idx = visible.findIndex((c) => c.key === colIdx);
      if (idx !== -1) {
        const next = Math.min(Math.max(idx + dCol, 0), visible.length - 1);
        colKey = visible[next].key;
      }
    }
    const newRow = Math.min(
      Math.max(rowIdx + dRow, 0),
      get().rows.length - 1,
    );
    if (keepInline) get().openInlineEdit(newRow, colKey);
    else get().openQuickEdit(newRow, colKey);
  },

  quickEditPaste: async () => {
    // Archived viewer is read-only (view + copy + UID-check only).
    if (get().archivedMode) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast("Please allow clipboard access to continue.");
      return;
    }
    if (!text) return;
    const sc = get().selectedCell;
    if (!sc) return;
    set({ draft: text });
    get().commitCell(sc.rowIdx, sc.colIdx, text);
  },

  quickEditClear: () => {
    // Archived viewer is read-only (view + copy + UID-check only).
    if (get().archivedMode) return;
    const sc = get().selectedCell;
    if (!sc) return;
    set({ draft: "" });
    get().commitCell(sc.rowIdx, sc.colIdx, "");
  },

  quickEditCopy: async () => {
    const sc = get().selectedCell;
    if (!sc) return;
    try {
      await navigator.clipboard.writeText(get().draft);
      vibrate();
      toast("Copied to clipboard.");
    } catch {
      toast("Unable to copy. Please try again.");
    }
  },

  enterSelectionMode: (type, row, col) => {
    vibrate(15);
    const s = get();
    const selectedItems = new Set<string>();
    if (type === "cell") {
      if (col !== null) selectedItems.add(`${row}:${col}`);
    } else if (type === "col") {
      if (col !== null) {
        for (let i = 0; i < s.rows.length; i++) selectedItems.add(`${i}:${col}`);
      }
    } else if (type === "row") {
      for (const c of s.columns) selectedItems.add(`${row}:${c.key}`);
    }
    const { selRows, selCols } = updateSelFlags(
      selectedItems,
      s.columns.length,
      s.rows.length,
    );
    set({
      qebOpen: false,
      inlineEdit: false,
      selectedCell: null,
      selectionMode: true,
      selectedItems,
      selRows,
      selCols,
    });
  },

  toggleSelection: (type, row, col) => {
    const s = get();
    const selectedItems = new Set(s.selectedItems);
    if (type === "cell") {
      if (col !== null) {
        const key = `${row}:${col}`;
        if (selectedItems.has(key)) selectedItems.delete(key);
        else selectedItems.add(key);
      }
    } else if (type === "col") {
      if (col !== null) {
        const allInCol =
          s.rows.length > 0 &&
          s.rows.every((_, i) => selectedItems.has(`${i}:${col}`));
        if (allInCol) {
          for (let i = 0; i < s.rows.length; i++)
            selectedItems.delete(`${i}:${col}`);
        } else {
          for (let i = 0; i < s.rows.length; i++)
            selectedItems.add(`${i}:${col}`);
        }
      }
    } else if (type === "row") {
      const allInRow = s.columns.every((c) =>
        selectedItems.has(`${row}:${c.key}`),
      );
      if (allInRow) {
        for (const c of s.columns) selectedItems.delete(`${row}:${c.key}`);
      } else {
        for (const c of s.columns) selectedItems.add(`${row}:${c.key}`);
      }
    }
    const { selRows, selCols } = updateSelFlags(
      selectedItems,
      s.columns.length,
      s.rows.length,
    );
    if (selectedItems.size === 0) {
      get().exitSelectionMode();
      return;
    }
    set({ selectionMode: true, selectedItems, selRows, selCols });
  },

  exitSelectionMode: () => {
    set({
      selectionMode: false,
      selectedItems: new Set(),
      selRows: new Set(),
      selCols: new Set(),
    });
  },

  selectAllCells: () => {
    const s = get();
    const selectedItems = new Set<string>();
    for (let i = 0; i < s.rows.length; i++) {
      for (const col of s.columns) {
        selectedItems.add(`${i}:${col.key}`);
      }
    }
    const { selRows, selCols } = updateSelFlags(
      selectedItems,
      s.columns.length,
      s.rows.length,
    );
    set({
      qebOpen: false,
      inlineEdit: false,
      selectedCell: null,
      selectionMode: true,
      selectedItems,
      selRows,
      selCols,
    });
  },

  unselectAll: () => {
    get().exitSelectionMode();
  },

  selectCellOnly: (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    set({
      selectedCell: { rowIdx, colIdx: colKey, originalVal: row[colKey] ?? "" },
      draft: row[colKey] ?? "",
      qebOpen: false,
      inlineEdit: false,
      selectionMode: false,
      selectedItems: new Set(),
      selRows: new Set(),
      selCols: new Set(),
    });
  },

  focusCell: (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    set({
      selectedCell: { rowIdx, colIdx: colKey, originalVal: row[colKey] ?? "" },
      draft: row[colKey] ?? "",
      qebOpen: false,
      inlineEdit: false,
      selectionMode: false,
      selectedItems: new Set(),
      selRows: new Set(),
      selCols: new Set(),
    });
    try {
      const td = document.querySelector<HTMLElement>(
        `td.dc[data-row="${rowIdx}"][data-col="${colKey}"]`,
      );
      td?.scrollIntoView({ block: "nearest" });
    } catch {
      // swallow — scrolling is best-effort
    }
  },

  selectRange: (r1, c1, r2, c2, additive) => {
    const s = get();
    const colIndex = new Map<string, number>();
    s.columns.forEach((c, i) => colIndex.set(c.key, i));
    const i1 = colIndex.get(c1);
    const i2 = colIndex.get(c2);
    if (i1 === undefined || i2 === undefined) return;
    const minCol = Math.min(i1, i2);
    const maxCol = Math.max(i1, i2);
    const minRow = Math.max(0, Math.min(r1, r2));
    const maxRow = Math.min(s.rows.length - 1, Math.max(r1, r2));
    if (minRow > maxRow) return;
    const selectedItems = additive ? new Set(s.selectedItems) : new Set<string>();
    for (let r = minRow; r <= maxRow; r++) {
      for (let ci = minCol; ci <= maxCol; ci++) {
        const col = s.columns[ci];
        if (col) selectedItems.add(`${r}:${col.key}`);
      }
    }
    const { selRows, selCols } = updateSelFlags(
      selectedItems,
      s.columns.length,
      s.rows.length,
    );
    set({
      selectionMode: true,
      qebOpen: false,
      inlineEdit: false,
      selectedCell: null,
      selectedItems,
      selRows,
      selCols,
    });
  },

  deleteSelected: () => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    if (!s.selectionMode) return;
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    const rows = s.rows.slice();
    const newInvalid = new Set(s.invalidCells);
    const deltas: CellDelta[] = [];
    let locked = 0;
    s.selectedItems.forEach((key) => {
      const parts = key.split(":");
      const rowIdx = Number(parts[0]);
      const colKey = parts[1];
      const row = rows[rowIdx];
      if (!row) return;
      // Locked rows are never cleared — same rule as commitCell.
      if (row._hold || row._approved) {
        locked++;
        return;
      }
      const prevVal = row[colKey] ?? "";
      if (prevVal !== "") deltas.push({ rowIdx, colKey, prevVal });
      rows[rowIdx] = { ...row, [colKey]: "" };
      if (behavior?.onCellChange) {
        behavior.onCellChange({
          rows,
          rowIdx,
          colKey,
          value: "",
          invalidCells: newInvalid,
          showToast: toast,
        });
      }
    });
    const undoStack: UndoEntry[] = [...s.undoStack];
    if (deltas.length > 1) undoStack.push({ type: "cells", deltas });
    else if (deltas.length === 1) undoStack.push(deltas[0]);
    if (undoStack.length > 100) undoStack.shift();
    set({
      rows,
      undoStack,
      redoStack: [],
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      invalidCells: newInvalid,
      ...recomputeMarks(rows, s.crossDups, s.columns),
    });
    get().exitSelectionMode();
    get().persist();
    if (locked) toast(`${locked} locked rows were skipped.`);
  },

  copySelected: async () => {
    const s = get();
    if (!s.selectionMode) return;
    const byRow = new Map<number, Array<{ col: string; val: string }>>();
    s.selectedItems.forEach((key) => {
      const parts = key.split(":");
      const rowIdx = Number(parts[0]);
      const colKey = parts[1];
      const entry = {
        col: colKey,
        val: s.rows[rowIdx] ? (s.rows[rowIdx][colKey] ?? "") : "",
      };
      const list = byRow.get(rowIdx);
      if (list) list.push(entry);
      else byRow.set(rowIdx, [entry]);
    });
    const colOrder = s.columns.map((c) => c.key);
    const colOrderMap = new Map<string, number>();
    colOrder.forEach((k, i) => colOrderMap.set(k, i));
    const sortedRows = [...byRow.keys()].sort((a, b) => a - b);
    const lines: string[] = [];
    sortedRows.forEach((ri) => {
      const cells = byRow.get(ri);
      if (!cells) return;
      cells.sort(
        (a, b) => (colOrderMap.get(a.col) ?? 0) - (colOrderMap.get(b.col) ?? 0),
      );
      lines.push(cells.map((c) => c.val).join("\t"));
    });
    const text = lines.join("\n");
    if (!text) {
      toast("Please select cells first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);

      get().exitSelectionMode();
    } catch {
      toast("Unable to copy. Please try again.");
    }
  },

  addRow: () => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const room = MAX_GRID_ROWS - s.rows.length;
    if (room <= 0) {
      toast(`Row limit reached. Maximum ${MAX_GRID_ROWS} rows allowed.`);
      return;
    }
    const n = Math.min(GRID_PAGE, room);
    const rows = s.rows.concat(
      Array.from({ length: n }, () => makeEmptyRow(s.columns)),
    );
    set({ rows, isDirty: true, dirtyStructural: true, structuralVersion: ++structuralCounter });
    get().persist();
    if (n < GRID_PAGE) toast(`Row limit reached. Maximum ${MAX_GRID_ROWS} rows allowed.`);
  },

  doubleTap: async (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    const val = row[colKey] ?? "";
    if (!val) {
      // Archived viewer is read-only: empty cells have nothing to copy.
      if (get().archivedMode) return;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast("Please allow clipboard access to continue.");
        return;
      }
      if (!text) return;
      vibrate();
      get().commitCell(rowIdx, colKey, text);
    } else {
      try {
        await navigator.clipboard.writeText(val);
        vibrate();
      } catch {
        toast("Unable to copy. Please try again.");
      }
    }
    // The first tap of the double-tap already opened the QEB with a stale
    // draft; leaving it open means the next commit wipes the value the
    // double-tap just pasted/copied. Close it but keep the cell selected.
    // Align the draft with the cell value too — otherwise the NEXT cell's
    // tap commits this stale draft and wipes the pasted value back to "".
    const synced = get().rows[rowIdx]?.[colKey] ?? "";
    set({ qebOpen: false, inlineEdit: false, draft: String(synced) });
  },

  tripleTapRow: async (rowIdx) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    const vals = get().columns.map((c) => ({ key: c.key, val: row[c.key] ?? "" }));
    const hasData = vals.some((v) => v.val);
    if (hasData) {
      const text = vals.map((v) => v.val).join("\t");
      navigator.clipboard
        .writeText(text)
        .then(() => {
          vibrate();
        })
        .catch(() => {
          toast("Unable to copy. Please try again.");
        });
    } else {
      // Archived viewer is read-only: pasting into empty rows is disabled.
      if (get().archivedMode) return;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast("Please allow clipboard access to continue.");
        return;
      }
      if (!text) return;
      const parts = text.split("\t");
      const cells: Array<{ rowIdx: number; colKey: string; value: string }> = [];
      vals.forEach((v, i) => {
        if (parts[i] !== undefined) {
          cells.push({ rowIdx, colKey: v.key, value: parts[i] });
        }
      });
      applyCells(cells);
    }
  },

  tripleTapCol: async (colKey) => {
    const s = get();
    const vals: Array<{ idx: number; val: string }> = [];
    s.rows.forEach((row, i) => {
      const v = row[colKey] ?? "";
      if (v) vals.push({ idx: i, val: v });
    });
    if (vals.length) {
      const text = vals.map((v) => v.val).join("\n");
      navigator.clipboard
        .writeText(text)
        .then(() => {
          vibrate();
    
        })
        .catch(() => {
          toast("Unable to copy. Please try again.");
        });
    } else {
      // Archived viewer is read-only: pasting into empty rows is disabled.
      if (get().archivedMode) return;
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast("Please allow clipboard access to continue.");
        return;
      }
      if (!text) return;
      const parts = text.split("\n").filter((p) => p);
      const cells: Array<{ rowIdx: number; colKey: string; value: string }> = [];
      parts.forEach((val, i) => {
        if (s.rows[i]) cells.push({ rowIdx: i, colKey, value: val });
      });
      applyCells(cells);
    }
  },

  onDotDoubleTap: async (rowIdx) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    const behavior = getFileBehavior(get().file?.type ?? "fb_cookie");
    if (behavior?.onDotDoubleTap) {
      const result = await behavior.onDotDoubleTap(row);
      if (result?.action === "totp_copied") {
        await navigator.clipboard.writeText(result.code).catch(() => {});
        toast("Verification code copied.");
      }
    }
  },

  onDotHold: (rowIdx) => {
    const s = get();
    const row = s.rows[rowIdx];
    if (!row) return null;
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (!behavior?.onDotHold) return null;
    const result = behavior.onDotHold(row, s.apiLogs);
    if (result?.action !== "show_logs") return null;
    let uid = row.uid ?? null;
    if (!uid && row.cookies) {
      const m = row.cookies.match(/c_user=(\d+)/);
      if (m) uid = m[1];
    }
    const crossInfo =
      uid && s.crossDups[uid]
        ? (s.crossDups[uid] as CrossDupEntry[]).filter(
            (e) => e.fileId !== s.fileId,
          )
        : [];
    const check = checkStatusOf(row)
      ? {
          status: checkStatusOf(row),
          banReason: (row.check_ban_reason ?? row.wa_ban_reason) ?? undefined,
          pageName: (row.check_page_name ?? row.wa_page_name) ?? undefined,
          linkedNumber: (row.check_linked_number ?? row.wa_linked_number) ?? undefined,
        }
      : null;
    return { logs: result.logs, label: result.label, crossInfo, check };
  },

  toggleVisibleCol: (colKey) => {
    const s = get();
    const visibleCols = new Set(s.visibleCols);
    if (visibleCols.has(colKey)) visibleCols.delete(colKey);
    else visibleCols.add(colKey);
    set({ visibleCols });
    if (s.fileId) {
      localStorage.setItem(`ss_cols_${s.fileId}`, JSON.stringify([...visibleCols]));
    }
  },


  runCheck: async (triggerRowIdx?: number) => {
    const s = get();
    if (s.checkRunning) return;
    if (s.hasDuplicates) {
      toast("Please resolve duplicates first.");
      return;
    }
    if (s.invalidCells.size > 0) {
      toast("Please fix invalid cells first.");
      return;
    }
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (!behavior?.checkAccounts) return;
    const uidOn = localStorage.getItem("ss_autoCheck") !== "false";
    const isPage = isPageFile(s.file);
    const simpleOn = localStorage.getItem("ss_pageSimple") === "true";
    const advancedOn = localStorage.getItem("ss_pageAdvanced") === "true";
    // Archived viewer: Check always runs the UID check (toggle-independent),
    // never simple/advanced sweeps.
    const shouldDoUid = uidOn || s.archivedMode;
    // Archived viewer: UID-check only, never simple/advanced sweeps.
    const shouldDispatchChecks = !s.archivedMode && isPage && (simpleOn || advancedOn);
    if (!shouldDoUid && !shouldDispatchChecks) return;
    const dispatchChecks = () => {
      // Archived viewer: UID-check only, never simple/advanced sweeps.
      if (get().archivedMode) return;
      const curIsPage = isPageFile(get().file);
      if (!curIsPage) return;
      const curSimpleOn = localStorage.getItem("ss_pageSimple") === "true";
      const curAdvancedOn = localStorage.getItem("ss_pageAdvanced") === "true";
      const isAuto = triggerRowIdx != null;
      if (isAuto) {
        if (curSimpleOn) void (get() as unknown as { _pageSweepCore: (m: string, f?: unknown, e?: unknown) => Promise<void> })._pageSweepCore("auto-simple", undefined, triggerRowIdx);
      } else {
        if (curSimpleOn) void (get() as unknown as { _pageSweepCore: (m: string, f?: unknown, e?: unknown) => Promise<void> })._pageSweepCore("manual-simple");
        else if (curAdvancedOn) void (get() as unknown as { _pageSweepCore: (m: string, f?: unknown, e?: unknown) => Promise<void> })._pageSweepCore("manual-advanced");
      }
    };
    if (!shouldDoUid) {
      dispatchChecks();
      return;
    }
    const rows = s.rows.map((r) => ({ ...r }));
    rows.forEach((row) => {
      const isEmpty = s.columns.every((c) => !row[c.key]);
      if (isEmpty) row.status = "";
    });
    set({ checkRunning: true });
    try {
      const result = await behavior.checkAccounts(rows);
      const showSummary = () => {
        const doToast = () => {
          if (
            typeof document !== "undefined" &&
            document.body.classList.contains("bubble-mode")
          ) {
            const parts: string[] = [];
            if (result.valid > 0) parts.push(result.valid + " alive");
            if (result.dead > 0) parts.push(result.dead + " dead");
            if (result.uncertain > 0) parts.push(result.uncertain + " uncertain");

          } else {
            const parts: string[] = [];
            if (result.valid > 0) parts.push(result.valid + " valid");
            if (result.dead > 0) parts.push(result.dead + " dead");
            if (result.uncertain > 0) parts.push(result.uncertain + " uncertain");

          }
        };
        if (get().pendingAutoCheck) {
          dispatchChecks();
          doToast();
          set({ pendingAutoCheck: false });
          const pending = pendingAutoTriggerRow;
          pendingAutoTriggerRow = null;
          // pending null == bulk (no single row), use -1 sentinel to keep auto with no exclusion
          const nextTrigger = pending == null ? (-1 as unknown as number) : pending;
          void get().runCheck(nextTrigger);
          return;
        }
        doToast();
        dispatchChecks();
      };
      const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
      rows.forEach((row, i) => {
        const prev = s.rows[i] ?? {};
        const cols: Record<string, string> = {};
        let diff = false;
        new Set([...Object.keys(prev), ...Object.keys(row)]).forEach((k) => {
          const pv = (prev as Record<string, unknown>)[k];
          const nv = (row as Record<string, unknown>)[k];
          if (pv !== nv) {
            diff = true;
            cols[k] = nv == null ? "" : String(nv);
          }
        });
        if (diff) changed.push({ rowIdx: i, cols });
      });
      const changedByRow = new Map(changed.map((c) => [c.rowIdx, c]));
      if (changed.length === 0) {
        set({ checkRunning: false });
        showSummary();
        return;
      }
      const apiLogs = s.apiLogs.slice();
      changed.forEach(({ rowIdx }) => {
        const row = rows[rowIdx];
        let uid = row.uid ?? null;
        if (!uid && row.cookies) {
          const m = row.cookies.match(/c_user=(\d+)/);
          if (m) uid = m[1];
        }
        if (uid) {
          const response =
            row.status === "good" ? "valid" : row.status === "bad" ? "dead" : "uncertain";
          apiLogs.push({
            username: uid,
            status: "done",
            calls: [{ type: "check", request: "UID " + uid, response }],
          });
        }
      });
      if (apiLogs.length > 200) apiLogs.splice(0, apiLogs.length - 200);
      const cur = get();
      const finalRows = cur.rows.map((r, i) => {
        const hit = changedByRow.get(i);
        return hit ? { ...r, ...hit.cols } : r;
      });
      // Archived viewer: show liveness in the grid but never write back.
      if (cur.archivedMode) {
        set({
          rows: finalRows,
          apiLogs,
          checkRunning: false,
          ...recomputeMarks(finalRows, s.crossDups, s.columns),
        });
        showSummary();
        return;
      }
      const changeJournal = mergeJournal(get().changeJournal, changed);
      if (changeJournal.length > MAX_JOURNAL) {
        toast("Syncing changes…");
        void get().flushPersist();
      }
      set({
        rows: finalRows,
        apiLogs,
        changeJournal: changeJournal.slice(-MAX_JOURNAL),
        isDirty: true,
        checkRunning: false,
        ...recomputeMarks(finalRows, s.crossDups, s.columns),
      });
      get().persist();
      showSummary();
    } catch (e) {
      set({ checkRunning: false, pendingAutoCheck: false });
      pendingAutoTriggerRow = null;
      toast("Check failed. " + (e instanceof Error ? e.message : String(e)) + " Please try again.");
    }
  },

  maybeAutoCheck: (rowIdx: number | null | undefined, colKey: string) => {
    const s = get();
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (!behavior?.checkAccounts) return;
    if (colKey !== "cookies") return;
    const uidOn = localStorage.getItem("ss_autoCheck") !== "false";
    const simpleOn = isPageFile(s.file) && localStorage.getItem("ss_pageSimple") === "true";
    if (!uidOn && !simpleOn) return;
    const isBulk = rowIdx == null;
    const trigger = isBulk ? -1 : rowIdx;
    if (s.checkRunning) {
      if (!s.pendingAutoCheck) set({ pendingAutoCheck: true });
      pendingAutoTriggerRow = isBulk ? null : (rowIdx as number);
      return;
    }
    void get().runCheck(trigger as unknown as number);
  },

  _pageSweepCore: async (mode, filter, excludeIdx) => {
    const s = get();
    // Archived viewer: UID-check only, never simple/advanced sweeps.
    if (s.archivedMode) return;
    if (s.file?.type !== "fb_cookie") return;
    if (!isPageFile(s.file)) return;
    const sweepFileId = s.fileId;
    const rows = s.rows.map((r) => ({ ...r }));
    const rowsRef = s.rows;
    let ledger: Ledger | null = null;
    let ledgerDirty = false;
    if (mode === "auto-simple") {
      ledger = { ...loadLedger(sweepFileId) };
    }
    const advInFlight = new Set<string>();
    const checkRows: { row: Row; uid: string | null; idx: number; cuser: string | null }[] = [];
    rows.forEach((row, idx) => {
      if (filter && !filter(row, idx)) return;
      if (excludeIdx != null && idx === excludeIdx) return;
      const tf = (row.twofakey ?? "").trim();
      if (!tf || isNo2FAMark("twofakey", tf)) return;
      if (row.status !== "good") return;
      // dead (live overlay), held or approved rows are never simple-checked —
      // dead can't be eligible, sold/locked rows must keep their flags.
      const live = row as Row & { _dead?: boolean; _hold?: boolean; _approved?: boolean };
      if (live._dead || live._hold || live._approved) return;
      if (!row.cookies || !/c_user=\d+/.test(row.cookies)) return;
      if (checkStatusOf(row) === "eligible") return;
      const cuser = extractCUser(row.cookies);
      if (mode === "auto-simple" && cuser && ledger) {
        const ent = ledger[cuser];
        if (ent && (ent.s >= 3 || ent.a)) return;
      }
      let uid = row.uid ?? null;
      if (!uid && row.cookies) {
        const m = row.cookies.match(/c_user=(\d+)/);
        if (m) uid = m[1];
      }
      checkRows.push({ row, uid, idx, cuser });
    });
    if (!checkRows.length) return;
    // mergeSnap prefers the sweep result, then legacy wa_* keys, then the live
    // row — with !== undefined so an explicit null (checked, no ban) survives
    const mergeSnap = (base: Row, snap: Row): Row => {
      const b = base as Record<string, unknown>;
      const p = snap as Record<string, unknown>;
      const pick = (nk: string, lk: string): unknown =>
        p[nk] !== undefined ? p[nk] : p[lk] !== undefined ? p[lk] : b[nk] !== undefined ? b[nk] : b[lk];
      return applyCheckFields(
        { ...base },
        {
          status: (p.check_status ?? p.wa_status ?? b.check_status ?? b.wa_status) as unknown,
          banReason: pick("check_ban_reason", "wa_ban_reason"),
          pageName: pick("check_page_name", "wa_page_name"),
          linkedNumber: pick("check_linked_number", "wa_linked_number"),
        },
      );
    };
    const writeBack = () => {
      const cur = get();
      if (cur.rows === rowsRef) return rows.slice();
      const processed = new Set(checkRows.map((w) => w.idx));
      return cur.rows.map((r, i) => {
        if (!processed.has(i)) return r;
        const snap = rows[i];
        if (!snap) return r;
        return mergeSnap(r, snap);
      });
    };
    const pushInstant = (idx: number, newRow: Row) => {
      const cur = get();
      if (cur.fileId !== sweepFileId) return;
      const curRow = cur.rows[idx];
      if (!curRow) return;
      const out = cur.rows.slice();
      out[idx] = mergeSnap(curRow, newRow);
      set({ rows: out });
    };
    const isCleanMiss = (res: unknown): boolean => {
      if (!res || typeof res !== "object") return false;
      const o = res as Record<string, unknown>;
      return o.eligible === false && (o.error == null);
    };
    // cache-first for every mode, including manual-advanced
    {
      let cache: Record<string, CheckCacheEntry> = {};
      try {
        const uids = checkRows.map((w) => w.uid).filter((u): u is string => !!u);
        if (uids.length) {
          const res = await api.getCheckCache(uids);
          cache = (res?.cache as Record<string, CheckCacheEntry>) ?? {};
        }
      } catch {
        cache = {};
      }
      if (get().fileId !== sweepFileId) return;
      const remaining: typeof checkRows = [];
      for (const w of checkRows) {
        const hit = w.uid ? cache[w.uid] : null;
        if (hit && hit.status === "eligible") {
          applyCheckFields(w.row, { status: "eligible", banReason: hit.banReason ?? null, pageName: hit.pageName ?? null, linkedNumber: hit.linkedNumber ?? null });
          if (ledger && w.cuser && ledger[w.cuser]) {
            delete ledger[w.cuser];
            ledgerDirty = true;
          }
          pushInstant(w.idx, w.row);
          rows[w.idx] = { ...w.row };
          continue;
        }
        remaining.push(w);
      }
      if (remaining.length === 0) {
        if (ledgerDirty && sweepFileId && get().fileId === sweepFileId && ledger) {
          saveLedger(sweepFileId, ledger);
        }
        if (get().fileId !== sweepFileId) return;
        const finalRows = writeBack();
        const cur = get();
        const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
        finalRows.forEach((row, i) => {
          const prev = s.rows[i] ?? {};
          const cols: Record<string, string> = {};
          let diff = false;
          for (const k of CHECK_FIELDS) {
            const pv = (prev as Record<string, unknown>)[k];
            const nv = (row as Record<string, unknown>)[k];
            if (pv !== nv) {
              diff = true;
              cols[k] = nv == null ? "" : String(nv);
            }
          }
          if (diff) {
            changed.push({ rowIdx: i, cols });
          }
        });
        if (changed.length === 0) return;
        const changeJournal = mergeJournal(get().changeJournal, changed);
        if (changeJournal.length > MAX_JOURNAL) toast("Syncing changes…");
        set({ rows: finalRows, changeJournal: changeJournal.slice(-MAX_JOURNAL), isDirty: true, ...recomputeMarks(finalRows, cur.crossDups, cur.columns) });
        get().persist();
        return;
      }
      checkRows.length = 0;
      checkRows.push(...remaining);
    }
    const live = checkRows;
    const concurrency = 3;
    let pos = 0;
    const nextBatch = async (): Promise<void> => {
      if (pos >= live.length) return;
      const batch: number[] = [];
      for (let limit = concurrency; limit > 0 && pos < live.length; limit--) batch.push(pos++);
      await Promise.all(
        batch.map(async (i) => {
          const w = live[i];
          const apply = (check_status: string, check_ban_reason?: string | null, check_page_name?: string | null, check_linked_number?: string | null) => {
            const newRow: Row = applyCheckFields({ ...w.row }, { status: check_status, banReason: check_ban_reason, pageName: check_page_name, linkedNumber: check_linked_number });
            rows[w.idx] = newRow;
            live[i] = { ...w, row: newRow };
            pushInstant(w.idx, newRow);
          };
          if (mode === "manual-advanced") {
            try {
              const res = (await api.pageAdvanced(w.row.cookies ?? "")) as { eligible?: boolean; error?: string | null; banReason?: string | null; linkedNumber?: string | null } | null;
              if (res && res.eligible === true) apply("eligible", res.banReason ?? null, undefined, res.linkedNumber ?? null);
              else if (res && res.error) apply("error", res.banReason ?? null, undefined, res.linkedNumber ?? null);
              else if (isCleanMiss(res)) apply("ineligible", res ? (res as unknown as { banReason?: string | null }).banReason ?? null : null, undefined, res ? (res as unknown as { linkedNumber?: string | null }).linkedNumber ?? null : null);
              else apply("error", res ? (res as unknown as { banReason?: string | null }).banReason ?? null : null, undefined, res ? (res as unknown as { linkedNumber?: string | null }).linkedNumber ?? null : null);
            } catch {
              if (checkStatusOf(s.rows[w.idx]) === "eligible") return;
              apply("error");
            }
            return;
          }
          // simple modes (auto-simple | manual-simple)
          try {
            const res = (await api.pageSimple(w.row.cookies ?? "")) as { eligible?: boolean; error?: string | null; banReason?: string | null; pageName?: string | null; linkedNumber?: string | null } | null;
            if (res && res.eligible === true) {
              apply("eligible", null, res.pageName ?? null, res.linkedNumber ?? null);
              if (ledger && w.cuser && ledger[w.cuser]) {
                delete ledger[w.cuser];
                ledgerDirty = true;
              }
            } else if (isCleanMiss(res)) {
              apply("ineligible", (res as unknown as { banReason?: string | null }).banReason ?? null, (res as unknown as { pageName?: string | null }).pageName ?? null, (res as unknown as { linkedNumber?: string | null }).linkedNumber ?? null);
              if (ledger && w.cuser) {
                const ent = ledger[w.cuser] ?? { s: 0, a: false };
                // avoid double-count for same cuser in same sweep
                if (advInFlight.has(w.cuser)) {
                  ent.s = Math.max(ent.s, 1);
                } else {
                  ent.s += 1;
                }
                if (ent.s >= 3 && !ent.a && !advInFlight.has(w.cuser)) {
                  advInFlight.add(w.cuser);
                  try {
                    const wa2 = (await api.pageAdvanced(w.row.cookies ?? "")) as { eligible?: boolean; error?: string | null; banReason?: string | null; linkedNumber?: string | null } | null;
                    if (wa2 && wa2.eligible === true) {
                      const newRow: Row = applyCheckFields({ ...rows[w.idx] }, { status: "eligible", banReason: wa2.banReason ?? null, linkedNumber: wa2.linkedNumber ?? null });
                      rows[w.idx] = newRow;
                      live[i] = { ...w, row: newRow };
                      pushInstant(w.idx, newRow);
                      delete ledger[w.cuser];
                      ledgerDirty = true;
                    } else if (wa2 && wa2.error) {
                      ent.a = true;
                      ledger[w.cuser] = ent;
                      ledgerDirty = true;
                      apply("ineligible", wa2.banReason ?? null, undefined, wa2.linkedNumber ?? null);
                      // keep ineligible status from page miss, mark exhausted
                      rows[w.idx] = applyCheckFields({ ...rows[w.idx] }, { status: "ineligible", banReason: wa2.banReason ?? null, linkedNumber: wa2.linkedNumber ?? null });
                      pushInstant(w.idx, rows[w.idx]);
                    } else if (isCleanMiss(wa2)) {
                      ent.a = true;
                      ledger[w.cuser] = ent;
                      ledgerDirty = true;
                    } else {
                      ent.a = true;
                      ledger[w.cuser] = ent;
                      ledgerDirty = true;
                      if (wa2 && wa2.error) {
                        rows[w.idx] = applyCheckFields({ ...rows[w.idx] }, { status: "error" });
                        pushInstant(w.idx, rows[w.idx]);
                      }
                    }
                  } catch {
                    ent.a = true;
                    ledger[w.cuser] = ent;
                    ledgerDirty = true;
                  }
                } else {
                  ledger[w.cuser] = ent;
                  ledgerDirty = true;
                }
              }
            } else {
              // null/undefined or error response -> error, no ledger increment
              const ban = (res as unknown as { banReason?: string | null } | null)?.banReason ?? null;
              const pn = (res as unknown as { pageName?: string | null } | null)?.pageName ?? null;
              const ln = (res as unknown as { linkedNumber?: string | null } | null)?.linkedNumber ?? null;
              apply("error", ban, pn, ln);
            }
          } catch {
            apply("error");
          }
        }),
      );
      return nextBatch();
    };
    try {
      await nextBatch();
    } catch {
      // swallow
    }
    if (ledgerDirty && sweepFileId && get().fileId === sweepFileId && ledger) {
      saveLedger(sweepFileId, ledger);
    }
    if (get().fileId !== sweepFileId) return;
    const finalRows = writeBack();
    const cur = get();
    const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
    finalRows.forEach((row, i) => {
      const prev = s.rows[i] ?? {};
      const cols: Record<string, string> = {};
      let diff = false;
      for (const k of CHECK_FIELDS) {
        const pv = (prev as Record<string, unknown>)[k];
        const nv = (row as Record<string, unknown>)[k];
        if (pv !== nv) {
          diff = true;
          cols[k] = nv == null ? "" : String(nv);
        }
      }
      if (diff) {
        changed.push({ rowIdx: i, cols });
      }
    });
    if (changed.length === 0) return;
    const changeJournal = mergeJournal(get().changeJournal, changed);
    if (changeJournal.length > MAX_JOURNAL) toast("Syncing changes…");
    set({ rows: finalRows, changeJournal: changeJournal.slice(-MAX_JOURNAL), isDirty: true, ...recomputeMarks(finalRows, cur.crossDups, cur.columns) });
    get().persist();
  },

  runPageChecks: async () => {
    const s = get();
    // Archived viewer: UID-check only, no simple/advanced sweeps.
    if (s.archivedMode) return;
    if (s.file?.type !== "fb_cookie") return;
    await (get() as unknown as { _pageSweepCore: (m: string) => Promise<void> })._pageSweepCore("auto-simple");
  },

  runPageChecksFiltered: async (filter) => {
    // Archived viewer: UID-check only, no simple/advanced sweeps.
    if (get().archivedMode) return;
    await (get() as unknown as { _pageSweepCore: (m: string, f: unknown) => Promise<void> })._pageSweepCore("manual-simple", filter as unknown as (row: Row, idx: number) => boolean);
  },

  runPageChecksAdvanced: async (filter) => {
    // Archived viewer: UID-check only, no simple/advanced sweeps.
    if (get().archivedMode) return;
    await (get() as unknown as { _pageSweepCore: (m: string, f: unknown) => Promise<void> })._pageSweepCore("manual-advanced", filter as unknown as (row: Row, idx: number) => boolean);
  },

  restoreVersion: async () => {
    toast("No earlier version available.");
    return false;
  },

  applyRestore: (rows, seq, file) => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const cols = fileColumns(file ?? s.file);
    const padded = [...rows];
    while (padded.length < 100) padded.push(makeEmptyRow(cols));
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    set({
      file: file ?? s.file,
      rows: padded,
      undoStack,
      redoStack: [],
      isDirty: false,
      changeJournal: [],
      lastSeq: seq,
      dirtyStructural: false,
      ...recomputeMarks(padded, s.crossDups, s.columns),
    });
  },

  mergeRows: (incoming) => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const existing = new Set<string>();
    s.rows.forEach((row) => {
      const k = dedupKeyForRow(row);
      if (k) existing.add(k);
    });
    const added: Row[] = [];
    let skipped = 0;
    incoming.forEach((row) => {
      const k = dedupKeyForRow(row);
      if (k && existing.has(k)) {
        skipped++;
        return;
      }
      if (k) existing.add(k);
      added.push(row);
    });
    if (!added.length) {
      toast(`No rows merged. ${skipped} skipped.`);
      return;
    }
    // Insert right after the last data row (not concat at the end): the grid
    // is padded with empty rows and only renders the first GRID_PAGE, so
    // appending past the padding hides merged accounts until Compact.
    let lastDataIdx = -1;
    s.rows.forEach((row, idx) => {
      if (isDataRow(row, s.columns)) lastDataIdx = idx;
    });
    const room = MAX_GRID_ROWS - s.rows.length;
    if (room <= 0) {
      toast(`Row limit reached. Maximum ${MAX_GRID_ROWS} rows allowed.`);
      return;
    }
    const fitting = added.slice(0, room);
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    const rows = s.rows.slice();
    rows.splice(lastDataIdx + 1, 0, ...fitting);
    set({
      rows,
      undoStack,
      redoStack: [],
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      ...recomputeMarks(rows, s.crossDups, s.columns),
    });
    get().persist("merge");
    void refreshCrossDups(s.fileId);
    if (fitting.some((r) => r.cookies || r.uid)) {
      get().maybeAutoCheck(null, "cookies");
    }
    if (skipped || fitting.length < added.length) toast(`Merged ${fitting.length} rows. ${skipped} skipped.`);
  },

  // Live row-state pushes (socket/poll): patch overlay flags by pool key.
  // Cell values, order, undo and journals are never touched — a push can
  // land mid-edit without disturbing the user's work.
  applyLiveStates: (states) => {
    const s = get();
    if (!s.rows.length || !states) return;
    let changed = false;
    const rows = s.rows.map((row) => {
      const k = poolRowKey(row);
      if (!k || !(k in states)) return row;
      const st = states[k];
      const hold = !!st.hold;
      const approved = !!st.approved;
      const dead = !!st.dead;
      if ((row as Row & { _hold?: boolean })._hold === hold && (row as Row & { _approved?: boolean })._approved === approved && (row as Row & { _dead?: boolean })._dead === dead) return row;
      changed = true;
      return { ...row, _hold: hold, _approved: approved, _dead: dead };
    });
    if (changed) set({ rows });
  },

  applyUpload: (mode, incoming) => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    let lastDataIdx = -1;
    s.rows.forEach((row, idx) => {
      if (isDataRow(row, s.columns)) lastDataIdx = idx;
    });
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    if (mode === "replace") {
      const capped = incoming.slice(0, MAX_GRID_ROWS);
      const rows = [...capped];
      while (rows.length < 100) rows.push(makeEmptyRow(s.columns));
      set({
        rows,
        undoStack,
        redoStack: [],
        isDirty: true,
        dirtyStructural: true,
        structuralVersion: ++structuralCounter,
        selectedCell: null,
        qebOpen: false,
      inlineEdit: false,
        ...recomputeMarks(rows, s.crossDups, s.columns),
      });
      get().persist("replace");
      if (incoming.length > capped.length) toast(`Limited to ${capped.length} rows.`);
    } else {
      const rows = s.rows.slice();
      const room = MAX_GRID_ROWS - rows.length;
      const fitting = incoming.slice(0, Math.max(0, room));
      rows.splice(lastDataIdx + 1, 0, ...fitting);
      set({
        rows,
        undoStack,
        redoStack: [],
        isDirty: true,
        dirtyStructural: true,
        structuralVersion: ++structuralCounter,
        ...recomputeMarks(rows, s.crossDups, s.columns),
      });
      get().persist("append");
      if (fitting.length < incoming.length) toast(`Limited to ${fitting.length} rows.`);
    }
    void refreshCrossDups(s.fileId);
    if (incoming.some((r) => r.cookies || r.uid)) {
      get().maybeAutoCheck(null, "cookies");
    }
    // Cache-only check hydration for re-uploaded rows: the new-file path hydrates
    // before createFile, but in-sheet uploads land with blank check_status until a
    // live simple runs (green instead of blue). Fill cached eligibility
    // instantly — no live checks here, maybeAutoCheck above handles those.
    const hydrateFileId = s.fileId;
    const hydrateSnap = incoming.map((r) => ({ ...r }));
    void (async () => {
      await hydrateCheckCache(hydrateSnap);
      if (!hydrateFileId || get().fileId !== hydrateFileId) return;
      const hits = new Map<string, Row>();
      hydrateSnap.forEach((row) => {
        const st = checkStatusOf(row);
        if (st !== "eligible" && st !== "ineligible") return;
        let uid = row.uid ?? null;
        if (!uid && row.cookies) {
          const m = row.cookies.match(/c_user=(\d+)/);
          if (m) uid = m[1];
        }
        if (uid && !hits.has(uid)) hits.set(uid, row);
      });
      if (!hits.size) return;
      const cur = get();
      if (cur.fileId !== hydrateFileId) return;
      let touched = false;
      const finalRows = cur.rows.map((row) => {
        let uid = row.uid ?? null;
        if (!uid && row.cookies) {
          const m = row.cookies.match(/c_user=(\d+)/);
          if (m) uid = m[1];
        }
        const hit = uid ? hits.get(uid) : undefined;
        if (!hit) return row;
        const same = (nk: "check_ban_reason" | "check_page_name" | "check_linked_number", lk: "wa_ban_reason" | "wa_page_name" | "wa_linked_number") =>
          ((row as Record<string, unknown>)[nk] ?? (row as Record<string, unknown>)[lk] ?? null) ===
          ((hit as Record<string, unknown>)[nk] ?? (hit as Record<string, unknown>)[lk] ?? null);
        if (
          checkStatusOf(row) === checkStatusOf(hit) &&
          same("check_ban_reason", "wa_ban_reason") &&
          same("check_page_name", "wa_page_name") &&
          same("check_linked_number", "wa_linked_number")
        ) return row;
        touched = true;
        return applyCheckFields({ ...row }, { status: hit.check_status ?? hit.wa_status, banReason: hit.check_ban_reason ?? hit.wa_ban_reason, pageName: hit.check_page_name ?? hit.wa_page_name, linkedNumber: hit.check_linked_number ?? hit.wa_linked_number });
      });
      if (!touched) return;
      const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
      finalRows.forEach((row, i) => {
        if (row === cur.rows[i]) return;
        const cols: Record<string, string> = {};
        for (const k of CHECK_FIELDS) {
          const nv = (row as Record<string, unknown>)[k];
          cols[k] = nv == null ? "" : String(nv);
        }
        changed.push({ rowIdx: i, cols });
      });
      const changeJournal = mergeJournal(get().changeJournal, changed);
      set({ rows: finalRows, changeJournal: changeJournal.slice(-MAX_JOURNAL), isDirty: true, ...recomputeMarks(finalRows, get().crossDups, get().columns) });
      get().persist();
    })();
  },

  removeEmptyRows: () => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const columns = s.columns;
    let lastDataIdx = -1;
    s.rows.forEach((row, idx) => {
      if (isDataRow(row, columns)) lastDataIdx = idx;
    });
    if (lastDataIdx < 0) {
      toast("No empty rows to remove.");
      return;
    }
    const used = s.rows.slice(0, lastDataIdx + 1);
    const tail = s.rows.slice(lastDataIdx + 1);
    const cleaned = used.filter((row) => isDataRow(row, columns));
    const removed = used.length - cleaned.length;
    if (removed === 0) {
      toast("Sheet is already compact.");
      return;
    }    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    const rows = cleaned.concat(tail);
    set({
      rows,
      undoStack,
      redoStack: [],
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      ...recomputeMarks(rows, s.crossDups, s.columns),
      selectedCell: null,
      qebOpen: false,
      inlineEdit: false,
      selectionMode: false,
      selectedItems: new Set(),
      selRows: new Set(),
      selCols: new Set(),
    });
    get().persist("clean");

  },

  deleteDeadRows: () => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const deadIdx: number[] = [];
    s.rows.forEach((row, idx) => {
      if (row.status === "bad") deadIdx.push(idx);
    });
    if (!deadIdx.length) {
      toast("No inactive rows found.");
      return;
    }
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    const deadSet = new Set(deadIdx);
    const rows = s.rows.filter((_, idx) => !deadSet.has(idx));
    set({
      rows,
      undoStack,
      redoStack: [],
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      ...recomputeMarks(rows, s.crossDups, s.columns),
      selectedCell: null,
      qebOpen: false,
      inlineEdit: false,
      selectionMode: false,
      selectedItems: new Set(),
      selRows: new Set(),
      selCols: new Set(),
    });
    get().persist("clean");

  },

  bubbleGetActiveRow: () => {
    const s = get();
    const isCookieOnly = !fileColumns(s.file).some((c) => c.key === "twofakey");
    const complete = (r: Row) =>
      isCookieOnly ? !!r.cookies : !!(r.cookies && r.twofakey);
    // Keep the current in-progress row (missing cookie or missing key).
    if (
      s.bubbleActiveRow >= 0 &&
      s.bubbleActiveRow < s.rows.length &&
      !complete(s.rows[s.bubbleActiveRow])
    ) {
      return s.bubbleActiveRow;
    }
    // Scan forward from the current position: first row that still needs
    // something (cookie-only waiting for 2FA, key-only waiting for cookie,
    // or fully empty). Never jumps back to an already-advanced account.
    let start = Math.max(0, s.bubbleActiveRow);
    if (start >= s.rows.length) start = 0;
    for (let i = start; i < s.rows.length; i++) {
      if (!complete(s.rows[i])) {
        set({ bubbleActiveRow: i });
        return i;
      }
    }
    const rows = s.rows.length >= MAX_GRID_ROWS ? s.rows : s.rows.concat(makeEmptyRow(s.columns));
    const idx = rows.length - 1;
    set({ rows, bubbleActiveRow: idx });
    return idx;
  },

  bubbleAdvanceActiveRow: () => {
    const s = get();
    let idx = s.bubbleActiveRow + 1;
    let rows = s.rows;
    while (idx >= rows.length && rows.length < MAX_GRID_ROWS) {
      rows = rows.concat(makeEmptyRow(s.columns));
    }
    if (idx >= rows.length) {
      toast(`Row limit reached. Maximum ${MAX_GRID_ROWS} rows allowed.`);
      idx = rows.length - 1;
    }
    set({ bubbleActiveRow: idx, rows });
  },

  bubbleSaveCookie: (text) => {
    const s = get();
    const trimmed = (text || "").trim();
    const dupe = bubbleCookieIndex(s.rows).get(trimmed);
    if (dupe !== undefined) {
      toast("Duplicate found at row " + (dupe + 1) + ".");
      return;
    }
    const isCookieOnly = !fileColumns(s.file).some((c) => c.key === "twofakey");
    const idx = get().bubbleGetActiveRow();
    if (!isCookieOnly && s.rows[idx].cookies && !s.rows[idx].twofakey) {
      // Row already has a cookie and still needs its key — this second cookie
      // paste was NOT saved (it's a cookie, not a 2FA key). Keep it short:
      // the bubble popup has no room for a long toast.
      toast("Please enter the 2FA key first.");
      return;
    }
    if (!isCookieOnly && !s.rows[idx].twofakey) {
      // STRICT 2FA-first: a cookie never opens a row. The key anchors the
      // account first, the cookie completes it — otherwise cookies leak onto
      // keyless rows and accounts get mismatched. (Cookie-only files have no
      // key slot, so they keep the direct cookie flow above.)
      toast("Please enter the 2FA key first.");
      return;
    }
    const rows = s.rows.slice();
    rows[idx] = { ...rows[idx], cookies: text };
    const newInvalid = new Set(s.invalidCells);
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (behavior?.onCellChange) {
      behavior.onCellChange({
        rows,
        rowIdx: idx,
        colKey: "cookies",
        value: text,
        invalidCells: newInvalid,
        showToast: toast,
      });
    }
    vibrate(15);
    if (isCookieOnly) {
      toast("Row " + (idx + 1) + " completed.");
      set({
        rows,
        isDirty: true,
        dirtyStructural: true,
        structuralVersion: ++structuralCounter,
        invalidCells: newInvalid,
        ...recomputeMarksForRow(rows, s.crossDups, s.columns, idx),
      });
      get().persist("bubble");
      get().maybeAutoCheck(idx, "cookies");
      get().bubbleAdvanceActiveRow();
      return;
    }
    const complete = !!rows[idx].twofakey;
    if (!complete) toast("Please enter the 2FA key first.");
    set({
      rows,
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      invalidCells: newInvalid,
      ...recomputeMarksForRow(rows, s.crossDups, s.columns, idx),
    });
    get().persist("bubble");
    get().maybeAutoCheck(idx, "cookies");
    if (complete) get().bubbleAdvanceActiveRow();
  },

  bubbleSaveKey: async (text) => {
    const s = get();
    const isCookieOnly = !fileColumns(s.file).some((c) => c.key === "twofakey");
    if (isCookieOnly) return;
    const key = normalizeBubbleKey(text);
    // STRICT 2FA shape: base32, 10–32 chars (32 = max key length, spaces
    // optional — normalizeBubbleKey already stripped them). Anything else is
    // refused so non-key blobs can never leak into the key slot.
    if (!/^[A-Z2-7]{10,32}$/.test(key)) {
      toast("Invalid 2FA key. Please check and try again.");
      return;
    }
    if (bubbleKeyIndex(s.rows).has(key)) {
      toast("This 2FA key already exists.");
      return;
    }
    const idx = get().bubbleGetActiveRow();
    if (s.rows[idx].twofakey) {
      // Row already has a key — a different key paste belongs to another row,
      // which still needs its cookie first.
      toast("Please enter the cookie.");
      return;
    }
    const rows = s.rows.slice();
    rows[idx] = { ...rows[idx], twofakey: key };
    const newInvalid = new Set(s.invalidCells);
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (behavior?.onCellChange) {
      behavior.onCellChange({
        rows,
        rowIdx: idx,
        colKey: "twofakey",
        value: key,
        invalidCells: newInvalid,
        showToast: toast,
      });
    }
    vibrate(15);
    const complete = !!rows[idx].cookies;
    if (!complete) toast("Please enter the cookie.");
    set({
      rows,
      isDirty: true,
      dirtyStructural: true,
      structuralVersion: ++structuralCounter,
      invalidCells: newInvalid,
      ...recomputeMarksForRow(rows, s.crossDups, s.columns, idx),
    });
    get().persist("bubble");
    if (complete) get().bubbleAdvanceActiveRow();
    if (!s.isDesktop) {
      void getCachedTOTP(key)
        .then((r) => {
          if (!r) return;
          if (useSheetStore.getState().fileId !== s.fileId) return;
          navigator.clipboard.writeText(r.code).catch(() => {});
        })
        .catch(() => {});
    }
  },

  bubbleSkipNo2FA: () => {
    const s = get();
    const isCookieOnly = !fileColumns(s.file).some((c) => c.key === "twofakey");
    if (isCookieOnly) return;
    const idx = s.bubbleActiveRow >= 0 ? s.bubbleActiveRow : s.bubbleGetActiveRow();
    const row = s.rows[idx];
    // STRICT 2FA-first: skip marks the key slot even before the cookie lands,
    // so no-2FA accounts still anchor their row first. It never overwrites a
    // real key or marker.
    const canSkip = !!row && !row.twofakey;
    if (canSkip) {
      const rows = s.rows.slice();
      rows[idx] = { ...rows[idx], twofakey: NO_2FA_MARK };
      const newInvalid = new Set(s.invalidCells);
      newInvalid.delete(idx + ":twofakey");
      set({
        rows,
        isDirty: true,
        dirtyStructural: true,
        structuralVersion: ++structuralCounter,
        invalidCells: newInvalid,
        ...recomputeMarksForRow(rows, s.crossDups, s.columns, idx),
      });
      get().persist("bubble");
      vibrate(15);
      // Advance only when the row is complete (cookie + marker). A marked row
      // with no cookie yet stays active so the next cookie paste lands on it.
      if (row.cookies && row.cookies.trim()) {
        get().bubbleAdvanceActiveRow();
      }
    }
  },

  setCellStyle: (rowIdx, colKey, patch) => {
    const s = get();
    // Archived viewer is read-only (view + copy + UID-check only).
    if (s.archivedMode) return;
    const row = s.rows[rowIdx];
    if (!row) return;
    const map = parseStyles(row);
    const cur = map[colKey] ? { ...map[colKey] } : ({} as CellStyle);
    if (patch.bg !== undefined) {
      if (patch.bg == null || patch.bg === "transparent" || patch.bg === "") delete cur.bg;
      else cur.bg = patch.bg;
    }
    if (patch.color !== undefined) {
      if (patch.color == null || patch.color === "transparent" || patch.color === "") delete cur.color;
      else cur.color = patch.color;
    }
    if (patch.bold !== undefined) {
      if (patch.bold == null || patch.bold === false) delete cur.bold;
      else cur.bold = true;
    }
    if (Object.keys(cur).length === 0) delete map[colKey];
    else map[colKey] = cur;
    const json = Object.keys(map).length ? stringifyStyles(map) : "";
    const prevVal = (row._cellStyles as string) ?? "";
    const newRows = s.rows.slice();
    newRows[rowIdx] = json ? { ...row, _cellStyles: json } : { ...row, _cellStyles: "" } as Row;
    if (!json) delete (newRows[rowIdx] as Record<string, unknown>)._cellStyles;
    const undoStack = [...s.undoStack, { rowIdx, colKey: "_cellStyles", prevVal } as CellDelta];
    if (undoStack.length > 100) undoStack.shift();
    const changeJournal = mergeJournal(get().changeJournal, [{ rowIdx, cols: { _cellStyles: json } as Record<string, string> }]);
    if (changeJournal.length > MAX_JOURNAL) toast("Syncing changes…");
    set({ rows: newRows, isDirty: true, changeJournal: changeJournal.slice(-MAX_JOURNAL), undoStack, redoStack: [] });
    get().persist();
  },
}));

async function refreshCrossDups(fileId: string | null) {
  if (!fileId) return;
  try {
    const d = await api.getCrossDups(fileId);
    const cur = useSheetStore.getState();
    if (!d?.dups || cur.fileId !== fileId) return;
    useSheetStore.setState({
      crossDups: d.dups,
      ...recomputeMarks(cur.rows, d.dups, cur.columns),
    });
  } catch {
    // swallow
  }
}

// ── Durable outbox (IDB-first) helpers ──

// Reconcile the IDB mirror with live state after an ack: rewrite when edits
// remain, delete when clean. Decided from live state at ack time so an
// in-flight presist() mirror write (issued earlier) can never resurrect
// already-acked intent — IDB applies same-connection writes in order.
function syncMirror(fileId: string) {
  const st = useSheetStore.getState();
  if (st.fileId !== fileId) return;
  if (st.isDirty || st.changeJournal.length || st.dirtyStructural) {
    void mirrorPending(fileId, st.changeJournal, st.dirtyStructural, st.dirtyStructural ? st.rows : undefined, st.lastSeq).catch(() => {});
  } else {
    void idbDel(mirrorKey(fileId)).catch(() => {});
  }
}

// Replay a leftover mirror onto freshly loaded server rows (boot / reopen).
// Returns null when nothing pending.
async function resumeLocal(
  id: string,
  serverRows: Row[],
): Promise<{ rows: Row[]; journal: AppendOp[]; structural: boolean } | null> {
  try {
    const mirror = await idbGet<JournalMirror>(mirrorKey(id));
    if (!mirror || (!mirror.structural && !mirror.journal.length)) return null;
    const resumed = applyMirror(serverRows, mirror);
    if (!resumed.dirty) return null;
    return { rows: resumed.rows as Row[], journal: resumed.journal as AppendOp[], structural: mirror.structural };
  } catch {
    return null;
  }
}

// ── Bubble (Android mini-window) helpers ──

function trimMemoryRows() {
  const s = useSheetStore.getState();
  if (!s.fileId || !s.file) return;
  const columns = fileColumns(s.file);
  useSheetStore.setState((prev) => {
    if (prev.isDirty) return {};
    let lastData = -1;
    prev.rows.forEach((row, i) => {
      if (isDataRow(row, columns)) lastData = i;
    });
    const keep = Math.min(prev.rows.length, Math.max(lastData + 51, 100));
    if (prev.rows.length <= keep) return {};
    const tail = prev.rows.slice(keep);
    const tailEmpty = tail.every((r) => !isDataRow(r, columns));
    if (!tailEmpty) return {};
    return { rows: prev.rows.slice(0, keep) };
  });
}

/** Normalize a 2FA key: strip spaces/dashes, uppercase (old normalizeKey). */
function normalizeBubbleKey(t: string | null | undefined): string {
  return (t || "").replace(/[\s\-]/g, "").toUpperCase();
}

// Bubble paste duplicate lookups used to re-scan every row on every paste.
// Rows are only ever replaced (never mutated in place) elsewhere in this
// store, so an index keyed on the array's identity stays valid until the
// next edit — cache it and rebuild only when the reference changes.
let cookieIndexRows: Row[] | null = null;
let cookieIndex: Map<string, number> | null = null;
function bubbleCookieIndex(rows: Row[]): Map<string, number> {
  if (cookieIndexRows === rows && cookieIndex) return cookieIndex;
  const idx = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = (r.cookies ?? "").trim();
    if (v && !idx.has(v)) idx.set(v, i);
  });
  cookieIndexRows = rows;
  cookieIndex = idx;
  return idx;
}

let keyIndexRows: Row[] | null = null;
let keyIndex: Map<string, number> | null = null;
function bubbleKeyIndex(rows: Row[]): Map<string, number> {
  if (keyIndexRows === rows && keyIndex) return keyIndex;
  const idx = new Map<string, number>();
  rows.forEach((r, i) => {
    const v = r.twofakey ?? "";
    // "No 2FA" skip markers never count as a duplicate of a real key.
    if (!v || isNo2FAMark("twofakey", v)) return;
    const k = normalizeBubbleKey(v);
    if (!idx.has(k)) idx.set(k, i);
  });
  keyIndexRows = rows;
  keyIndex = idx;
  return idx;
}

function applyCells(
  cells: Array<{ rowIdx: number; colKey: string; value: string }>,
): void {
  if (!cells.length) return;
  const s = useSheetStore.getState();
  const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
  const rows = s.rows.slice();
  const newInvalid = new Set(s.invalidCells);
  const deltas: CellDelta[] = [];
  let changed = false;
  let skipped = 0;
  let lastKey: string | null = null;
  let pastedCookie = false;
  for (const cell of cells) {
    const row = rows[cell.rowIdx];
    if (!row) continue;
    // Same rules as single-cell commit: locked rows are never written and
    // same-file duplicates are blocked at entry (counted, not silent).
    if (row._hold || row._approved) {
      skipped++;
      continue;
    }
    const dupV = (cell.value ?? "").trim();
    if (dupV && !isNo2FAMark(cell.colKey, dupV) && rows.some((r, i) => i !== cell.rowIdx && ((r[cell.colKey] ?? "").trim() === dupV))) {
      skipped++;
      continue;
    }
    const prevVal = row[cell.colKey] ?? "";
    if (prevVal === cell.value) continue;
    rows[cell.rowIdx] = { ...row, [cell.colKey]: cell.value };
    deltas.push({
      rowIdx: cell.rowIdx,
      colKey: cell.colKey,
      prevVal,
    });
    changed = true;
    if (
      cell.colKey === "twofakey" &&
      cell.value &&
      /^[A-Z2-7]{10,32}$/.test(cell.value.replace(/[\s\-]/g, "").toUpperCase())
    ) {
      lastKey = cell.value;
    }
    if (behavior?.onCellChange) {
      behavior.onCellChange({
        rows,
        rowIdx: cell.rowIdx,
        colKey: cell.colKey,
        value: cell.value,
        invalidCells: newInvalid,
        showToast: toast,
      });
    }
    if (cell.colKey === "cookies" && cell.value) pastedCookie = true;
  }
  if (!changed) return;
  const undoStack: UndoEntry[] = [...s.undoStack];
  if (deltas.length > 1) undoStack.push({ type: "cells", deltas });
  else if (deltas.length === 1) undoStack.push(deltas[0]);
  if (undoStack.length > 100) undoStack.shift();
  useSheetStore.setState({
    rows,
    undoStack,
    redoStack: [],
    isDirty: true,
    dirtyStructural: true,
    structuralVersion: ++structuralCounter,
    invalidCells: newInvalid,
    ...recomputeMarks(rows, s.crossDups, s.columns),
  });
  useSheetStore.getState().persist();
  if (pastedCookie) {
    useSheetStore.getState().maybeAutoCheck(null, "cookies");
  }
  if (skipped) toast(`${skipped} locked cells were skipped.`);
  if (lastKey && !s.isDesktop) {
    void getCachedTOTP(lastKey)
      .then((r) => {
        if (!r) return;
        if (useSheetStore.getState().fileId !== s.fileId) return;
        navigator.clipboard.writeText(r.code).catch(() => {});
        toast("Verification code copied.");
      })
      .catch(() => {});
  }
}
