import { create } from "zustand";
import { api, type AppendOp, type AppendPayload } from "@/lib/api";
import {
  fileTypeDef,
  isNo2FAMark,
  NO_2FA_MARK,
  type ColumnDef,
  type CrossDupEntry,
  type Row,
  type SheetFile,
  type WaCacheEntry,
} from "@/lib/types";
import { getFileBehavior } from "@/features/filetypes";
import { toast } from "@/lib/toast";
import { vibrate } from "@/lib/utils";
import { IS_DESKTOP } from "@/lib/device";
import { getCachedTOTP } from "@/features/filetypes/totp";
import { offlineSync } from "@/offline/sync";

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
  offlineDirty: boolean;
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

  openFile: (id: string) => Promise<void>;
  openFileAdmin: (id: string, ownerId: string) => Promise<void>;
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
    wa: { status: string; banReason?: string | null } | null;
  } | null;
  toggleVisibleCol: (colKey: string) => void;
  runCheck: () => Promise<void>;
  runWaChecks: () => Promise<void>;
  runWaChecksFiltered: (filter: (row: Row, idx: number) => boolean) => Promise<void>;
  runWaChecksWaFiltered: (filter: (row: Row, idx: number) => boolean) => Promise<void>;
  maybeAutoCheck: (rowIdx: number, colKey: string) => void;
  restoreVersion: (v: number) => Promise<boolean>;
  mergeRows: (incoming: Row[]) => void;
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
let openSeq = 0;
let structuralCounter = 0;
let saveChain: Promise<void> = Promise.resolve();
const MAX_JOURNAL = 200;

const isNetworkError = (e: unknown) =>
  e instanceof TypeError ||
  (typeof navigator !== "undefined" &&
    typeof navigator.onLine === "boolean" &&
    !navigator.onLine);

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
  offlineDirty: false,
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

  openFile: async (id) => {
    const seq = ++openSeq;
    set({ status: "loading", adminMode: false, adminOwnerId: null });
    try {
      const [full, crossDups] = await Promise.all([
        api.getFileFull(id),
        api.getCrossDups(id).then((d) => d?.dups ?? {}).catch(() => ({})),
      ]);
      const f = full.file;
      if (!f?.id) throw new Error("File not found");
      if (seq !== openSeq) return;
      const columns = fileTypeDef(f.type).columns;
      let visibleCols = new Set<string>(columns.map((c) => c.key));
      try {
        const saved = localStorage.getItem(`ss_cols_${id}`);
        if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
      } catch {
        // ignore malformed saved columns
      }
      const rows: Row[] = [...(full.rows ?? [])];
      while (rows.length < 100) rows.push(makeEmptyRow(columns));
      const undoStack = (full.undo ?? []) as UndoEntry[];
      const redoStack = (full.redo ?? []) as UndoEntry[];
      const apiLogs = full.logs ?? [];
      set({
        status: "ready",
        fileId: id,
        file: f,
        rows,
        columns,
        visibleCols,
        undoStack,
        redoStack,
        apiLogs,
        logBase: apiLogs.length,
        undoBase: undoStack.length,
        redoBase: redoStack.length,
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
        crossDups,
        checkRunning: false,
        pendingAutoCheck: false,
        bubbleActiveRow: -1,
        ...recomputeMarks(rows, crossDups, columns),
      });
    } catch {
      set({ status: "error" });
    }
  },

  closeFile: async () => {
    openSeq++;
    const st = get();
    if (st.selectedCell && (st.qebOpen || st.inlineEdit)) {
      const rows = st.rows.slice();
      rows[st.selectedCell.rowIdx] = { ...rows[st.selectedCell.rowIdx], [st.selectedCell.colIdx]: st.draft };
      set({ rows, isDirty: true, dirtyStructural: true, structuralVersion: ++structuralCounter });
    }
    if (get().isDirty) await get().flushPersist();
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
    });
  },

  openFileAdmin: async (id, ownerId) => {
    const seq = ++openSeq;
    set({ status: "loading", adminMode: true, adminOwnerId: ownerId });
    try {
      const [f, rowsRes, logsRes, undoData] = await Promise.all([
        api.adminFile(id),
        api.adminFileRows(id),
        api.adminFileLogs(id),
        api.adminUndo(id),
      ]);
      if (!f?.id) throw new Error("File not found");
      if (seq !== openSeq) return;
      const columns = fileTypeDef(f.type).columns;
      let visibleCols = new Set<string>(columns.map((c) => c.key));
      try {
        const saved = localStorage.getItem(`ss_cols_${id}`);
        if (saved) visibleCols = new Set<string>(JSON.parse(saved) as string[]);
      } catch {
        // ignore malformed saved columns
      }
      const rows: Row[] = [...(rowsRes ?? [])];
      while (rows.length < 100) rows.push(makeEmptyRow(columns));
      const undoStack = (undoData?.undo ?? []) as UndoEntry[];
      const redoStack = (undoData?.redo ?? []) as UndoEntry[];
      const apiLogs = logsRes ?? [];
      set({
        status: "ready",
        fileId: id,
        file: f,
        rows,
        columns,
        visibleCols,
        undoStack,
        redoStack,
        apiLogs,
        logBase: apiLogs.length,
        undoBase: undoStack.length,
        redoBase: redoStack.length,
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
        invalidCells: new Set(),
        crossDups: {},
        checkRunning: false,
        pendingAutoCheck: false,
        bubbleActiveRow: -1,
        ...recomputeMarks(rows, {}, columns),
      });
    } catch {
      set({ status: "error" });
    }
  },

  refreshSheet: async () => {
    const fileId = get().fileId;
    if (!fileId) return;
    if (get().isDirty) return;
    try {
      const rowsRes = get().adminMode
        ? await api.adminFileRows(fileId)
        : await api.getRows(fileId);
      if (fileId !== get().fileId) return;
      // A local edit (bubble save / commitCell) landed while the fetch was in
      // flight — applying the stale snapshot would wipe it. Keep the local rows
      // and let the next clean cycle refresh instead.
      if (get().isDirty) return;
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
    const row = s.rows[rowIdx];
    if (!row) return;
    if (row._taken) return;
    const prevVal = row[colKey] ?? "";
    if (value === prevVal) return;
    const prevRow = { ...row };
    const newRows = s.rows.slice();
    newRows[rowIdx] = { ...row, [colKey]: value };
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
    const changeJournal: AppendOp[] = [
      ...s.changeJournal.filter((op) => op.rowIdx !== rowIdx),
      { rowIdx, cols: journalCols },
    ];
    if (changeJournal.length > MAX_JOURNAL) {
      changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
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
          toast("TOTP copied");
        })
        .catch(() => {});
    }
  },

  persist: (action) => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void get().flushPersist(action);
    }, 300);
  },

  flushPersist: async (action, viaUnload) => {
    const run = async () => {
      const s = get();
      if (!s.fileId || !s.file) return;
      const columns = fileTypeDef(s.file.type).columns;
      let dataCount = 0;
      let lastData = -1;
      s.rows.forEach((row, idx) => {
        const hasData = columns.some((c) => row[c.key]);
        if (hasData) {
          dataCount++;
          lastData = idx;
        }
      });
      if (action || s.dirtyStructural || s.adminMode) {
        if (!s.isDirty) return;
        const keepCount = Math.min(s.rows.length, Math.max(lastData + 51, 100));
        const trimmed = s.rows.slice(0, keepCount);
        const payload: {
          rows: Row[];
          logs: unknown[];
          undo: UndoEntry[];
          redo: UndoEntry[];
          dataCount: number;
          action?: string;
          userId?: string;
        } = {
          rows: trimmed,
          logs: s.apiLogs,
          undo: s.undoStack,
          redo: s.redoStack,
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
          if (isNetworkError(e)) {
            await offlineSync.queueSave({ fileId: s.fileId, kind: "persist", payload });
            set({ offlineDirty: true });
          }
          // swallow — old app is fire-and-forget
        }
        const cur = get();
        if (cur.fileId === s.fileId && cur.rows === s.rows) {
          set({
            isDirty: false,
            changeJournal: [],
            lastSeq: resp?.seq ?? s.lastSeq,
            dirtyStructural: false,
            offlineDirty: false,
            logBase: cur.apiLogs.length,
            undoBase: cur.undoStack.length,
            redoBase: cur.redoStack.length,
          });
          trimMemoryRows();
        } else if (cur.fileId === s.fileId && resp) {
          // Newer edits landed while the structural persist was in flight. The
          // structural change was already sent; keep dirtyStructural only if a
          // NEW structural change arrived (cell edits belong in the journal and
          // can go out as a small append instead of another full upload).
          set({ dirtyStructural: cur.structuralVersion !== startStruct });
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
              offlineDirty: false,
              logBase: cur.apiLogs.length,
              undoBase: cur.undoStack.length,
              redoBase: cur.redoStack.length,
            });
            trimMemoryRows();
          }
        } catch (e) {
          if (isNetworkError(e)) {
            await offlineSync.queueSave({ fileId: s.fileId, kind: "append", payload });
            set({ offlineDirty: true });
            return;
          }
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
              const freshCols = fileTypeDef(f.type).columns;
              const rows: Row[] = [...(fresh.rows ?? [])];
              while (rows.length < 100) rows.push(makeEmptyRow(freshCols));
              s.changeJournal.forEach((op) => {
                const row = rows[op.rowIdx];
                if (!row) return;
                rows[op.rowIdx] = { ...row, ...op.cols };
              });
              set({
                rows,
                changeJournal: s.changeJournal,
                lastSeq: fresh.seq ?? s.lastSeq,
                undoStack: (fresh.undo ?? []) as UndoEntry[],
                redoStack: (fresh.redo ?? []) as UndoEntry[],
                apiLogs: fresh.logs ?? [],
                logBase: fresh.logs?.length ?? 0,
                undoBase: fresh.undo?.length ?? 0,
                redoBase: fresh.redo?.length ?? 0,
                isDirty: true,
                ...recomputeMarks(rows, cur.crossDups, cur.columns),
              });
            } catch {
              // swallow — keep journal for the next flush attempt
            }
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
    toast("Undo");
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
    toast("Redo");
  },

  openQuickEdit: (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    if (row._taken) return;
    set({
      selectedCell: { rowIdx, colIdx: colKey, originalVal: row[colKey] ?? "" },
      draft: row[colKey] ?? "",
      qebOpen: true,
      inlineEdit: false,
    });
  },

  openInlineEdit: (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    if (row._taken) return;
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
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toast("Cannot read clipboard");
      return;
    }
    if (!text) return;
    const sc = get().selectedCell;
    if (!sc) return;
    set({ draft: text });
    get().commitCell(sc.rowIdx, sc.colIdx, text);
  },

  quickEditClear: () => {
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
      toast("Copied");
    } catch {
      toast("Cannot copy");
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
    if (!s.selectionMode) return;
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    const rows = s.rows.slice();
    const newInvalid = new Set(s.invalidCells);
    const deltas: CellDelta[] = [];
    s.selectedItems.forEach((key) => {
      const parts = key.split(":");
      const rowIdx = Number(parts[0]);
      const colKey = parts[1];
      const row = rows[rowIdx];
      if (!row) return;
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
    toast("Deleted");
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
      toast("Nothing to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`Copied ${s.selectedItems.size} cells`);
      get().exitSelectionMode();
    } catch {
      toast("Cannot copy");
    }
  },

  addRow: () => {
    const s = get();
    const rows = s.rows.concat(
      Array.from({ length: 100 }, () => makeEmptyRow(s.columns)),
    );
    set({ rows, isDirty: true, dirtyStructural: true, structuralVersion: ++structuralCounter });
    get().persist();
    toast("100 rows added");
  },

  doubleTap: async (rowIdx, colKey) => {
    const row = get().rows[rowIdx];
    if (!row) return;
    const val = row[colKey] ?? "";
    if (!val) {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast("Cannot read clipboard");
        return;
      }
      if (!text) return;
      vibrate();
      get().commitCell(rowIdx, colKey, text);
      toast("Pasted");
    } else {
      try {
        await navigator.clipboard.writeText(val);
        vibrate();
        toast("Copied");
      } catch {
        toast("Cannot copy");
      }
    }
    // The first tap of the double-tap already opened the QEB with a stale
    // draft; leaving it open means the next commit wipes the value the
    // double-tap just pasted/copied. Close it but keep the cell selected.
    set({ qebOpen: false, inlineEdit: false, draft: "" });
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
          toast("Row copied");
        })
        .catch(() => {
          toast("Cannot copy");
        });
    } else {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
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
      applyCells(cells, "Row pasted");
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
          toast(`Copied ${vals.length} cells`);
        })
        .catch(() => {
          toast("Cannot copy");
        });
    } else {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        return;
      }
      if (!text) return;
      const parts = text.split("\n").filter((p) => p);
      const cells: Array<{ rowIdx: number; colKey: string; value: string }> = [];
      parts.forEach((val, i) => {
        if (s.rows[i]) cells.push({ rowIdx: i, colKey, value: val });
      });
      applyCells(cells, `Pasted ${parts.length} cells`);
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
        toast("TOTP copied");
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
    const wa = row.wa_status
      ? {
          status: row.wa_status,
          banReason: row.wa_ban_reason ?? undefined,
          pageName: row.wa_page_name ?? undefined,
          linkedNumber: row.wa_linked_number ?? undefined,
        }
      : null;
    return { logs: result.logs, label: result.label, crossInfo, wa };
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

  runCheck: async () => {
    const s = get();
    if (s.checkRunning) return;
    if (s.hasDuplicates) {
      toast("Resolve duplicate values first");
      return;
    }
    if (s.invalidCells.size > 0) {
      toast("Fix invalid cell values first");
      return;
    }
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (!behavior?.checkAccounts) return;
    const rows = s.rows.map((r) => ({ ...r }));
    rows.forEach((row) => {
      const isEmpty = s.columns.every((c) => !row[c.key]);
      if (isEmpty) row.status = "";
    });
    set({ checkRunning: true });
    try {
      const result = await behavior.checkAccounts(rows);
      const showSummary = () => {
        if (get().pendingAutoCheck) {
          set({ pendingAutoCheck: false });
          void get().runCheck();
          return;
        }
        if (
          typeof document !== "undefined" &&
          document.body.classList.contains("bubble-mode")
        ) {
          const parts: string[] = [];
          if (result.valid > 0) parts.push(result.valid + " alive");
          if (result.dead > 0) parts.push(result.dead + " dead");
          if (result.uncertain > 0) parts.push(result.uncertain + " uncertain");
          toast("Check: " + (parts.join(" · ") || "0 checked"));
        } else {
          const parts: string[] = [];
          if (result.valid > 0) parts.push(result.valid + " valid");
          if (result.dead > 0) parts.push(result.dead + " dead");
          if (result.uncertain > 0) parts.push(result.uncertain + " uncertain");
          toast("Check done " + (parts.join(", ") || "0 checked"));
        }
        if (
          s.file?.type === "fb_cookie" &&
          localStorage.getItem("ss_waCheck") === "true"
        ) {
          void get().runWaChecks();
        }
      };
      // Figure out which rows actually changed vs the pre-check snapshot.
      // Identity always differs (rows were copied), so compare values per key.
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
        // Same results as before — nothing new to save, don't persist and don't
        // grow the check history with redundant entries.
        set({ checkRunning: false });
        showSummary();
        return;
      }
      const apiLogs = s.apiLogs.slice();
      const changedSet = new Set(changed.map((c) => c.rowIdx));
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
      const changeJournal = [
        ...s.changeJournal.filter((op) => !changedSet.has(op.rowIdx)),
        ...changed.map((c) => ({ rowIdx: c.rowIdx, cols: c.cols })),
      ];
      if (changeJournal.length > MAX_JOURNAL) {
        changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
      }
      set({
        rows: finalRows,
        apiLogs,
        changeJournal,
        isDirty: true,
        checkRunning: false,
        ...recomputeMarks(finalRows, s.crossDups, s.columns),
      });
      get().persist();
      showSummary();
    } catch (e) {
      set({ checkRunning: false, pendingAutoCheck: false });
      toast("Check failed: " + (e instanceof Error ? e.message : String(e)));
    }
  },

  maybeAutoCheck: (_rowIdx, colKey) => {
    const s = get();
    if (localStorage.getItem("ss_autoCheck") === "false") return;
    const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
    if (!behavior?.checkAccounts) return;
    if (colKey !== "cookies") return;
    if (s.checkRunning) {
      if (!s.pendingAutoCheck) set({ pendingAutoCheck: true });
      return;
    }
    void get().runCheck();
  },

  runWaChecks: async () => {
    const s = get();
    if (s.file?.type !== "fb_cookie") return;
    const rows = s.rows.map((r) => ({ ...r }));
    const rowsRef = s.rows;
    const waRows: { row: Row; uid: string | null; idx: number }[] = [];
    rows.forEach((row, idx) => {
      const match =
        row.status === "good" &&
        row.wa_status !== "eligible" &&
        !!row.cookies &&
        /c_user=\d+/.test(row.cookies);
      if (match) {
        let uid = row.uid ?? null;
        if (!uid && row.cookies) {
          const m = row.cookies.match(/c_user=(\d+)/);
          if (m) uid = m[1];
        }
        waRows.push({ row, uid, idx });
      }
    });
    if (!waRows.length) return;
    const writeBack = () => {
      const cur = get();
      if (cur.rows === rowsRef) return rows.slice();
      const processed = new Set(waRows.map((w) => w.idx));
      return cur.rows.map((r, i) => {
        if (!processed.has(i)) return r;
        const snap = rows[i];
        if (!snap) return r;
        return {
          ...r,
          wa_status: snap.wa_status ?? r.wa_status,
          wa_ban_reason:
            snap.wa_ban_reason !== undefined ? snap.wa_ban_reason : r.wa_ban_reason,
          wa_page_name:
            snap.wa_page_name !== undefined ? snap.wa_page_name : r.wa_page_name,
          wa_linked_number:
            snap.wa_linked_number !== undefined
              ? snap.wa_linked_number
              : r.wa_linked_number,
        };
      });
    };
    let cache: Record<string, WaCacheEntry> = {};
    try {
      const uids = waRows
        .map((w) => w.uid)
        .filter((u): u is string => !!u);
      if (uids.length) {
        const res = await api.getWaCache(uids);
        cache = (res?.cache as Record<string, WaCacheEntry>) ?? {};
      }
    } catch {
      cache = {};
    }
    if (get().fileId !== s.fileId) return;
    const live = waRows.filter((w) => {
      const hit = w.uid ? cache[w.uid] : null;
      if (!hit || !hit.status) return true;
      if (hit.status === "eligible" || hit.status === "ineligible") {
        w.row.wa_status = hit.status;
        w.row.wa_ban_reason = hit.banReason ?? null;
        w.row.wa_page_name = hit.pageName ?? null;
        w.row.wa_linked_number = hit.linkedNumber ?? null;
        return false;
      }
      return true;
    });
    const pushInstant = (idx: number, newRow: Row) => {
      const cur = get();
      if (cur.fileId !== s.fileId) return;
      const curRow = cur.rows[idx];
      if (!curRow) return;
      const out = cur.rows.slice();
      out[idx] = { ...curRow, wa_status: newRow.wa_status, wa_ban_reason: newRow.wa_ban_reason, wa_page_name: newRow.wa_page_name, wa_linked_number: newRow.wa_linked_number };
      set({ rows: out });
    };
    const concurrency = 3;
    let pos = 0;
    const nextBatch = async (): Promise<void> => {
      if (pos >= live.length) return;
      const batch: number[] = [];
      for (let limit = concurrency; limit > 0 && pos < live.length; limit--) {
        batch.push(pos++);
      }
      await Promise.all(
        batch.map(async (i) => {
          const w = live[i];
          const apply = (wa_status: string, wa_ban_reason?: string | null, wa_page_name?: string | null, wa_linked_number?: string | null) => {
            const newRow: Row = { ...w.row, wa_status };
            if (wa_ban_reason !== undefined) newRow.wa_ban_reason = wa_ban_reason;
            if (wa_page_name !== undefined) newRow.wa_page_name = wa_page_name;
            if (wa_linked_number !== undefined) newRow.wa_linked_number = wa_linked_number;
            rows[w.idx] = newRow;
            live[i] = { ...w, row: newRow };
            pushInstant(w.idx, newRow);
          };
          try {
            const wa = (await api.pageCheck(w.row.cookies ?? "")) as {
              eligible?: boolean;
              error?: string | null;
              banReason?: string | null;
              pageName?: string | null;
              linkedNumber?: string | null;
            } | null;
            if (wa && wa.eligible === true) {
              apply("eligible", null, wa.pageName ?? null, wa.linkedNumber ?? null);
            } else {
              apply(wa?.error ? "error" : "ineligible", wa ? wa.banReason ?? null : null, wa ? wa.pageName ?? null : null, wa ? wa.linkedNumber ?? null : null);
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
    if (get().fileId !== s.fileId) return;
    const finalRows = writeBack();
    const cur = get();
    const WA_FIELDS = ["wa_status", "wa_ban_reason", "wa_page_name", "wa_linked_number"] as const;
    const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
    const changedSet = new Set<number>();
    finalRows.forEach((row, i) => {
      const prev = s.rows[i] ?? {};
      const cols: Record<string, string> = {};
      let diff = false;
      for (const k of WA_FIELDS) {
        const pv = (prev as Record<string, unknown>)[k];
        const nv = (row as Record<string, unknown>)[k];
        if (pv !== nv) {
          diff = true;
          cols[k] = nv == null ? "" : String(nv);
        }
      }
      if (diff) {
        changed.push({ rowIdx: i, cols });
        changedSet.add(i);
      }
    });
    // Same WA results as before — nothing new to save, skip persist entirely.
    if (changed.length === 0) return;
    const changeJournal = [
      ...s.changeJournal.filter((op) => !changedSet.has(op.rowIdx)),
      ...changed,
    ];
    if (changeJournal.length > MAX_JOURNAL) {
      changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
    }
    set({
      rows: finalRows,
      changeJournal,
      isDirty: true,
      ...recomputeMarks(finalRows, cur.crossDups, cur.columns),
    });
    get().persist();
  },

  runWaChecksFiltered: async (filter) => {
    const s = get();
    if (s.file?.type !== "fb_cookie") return;
    const rows = s.rows.map((r) => ({ ...r }));
    const rowsRef = s.rows;
    const waRows: { row: Row; uid: string | null; idx: number }[] = [];
    rows.forEach((row, idx) => {
      if (!filter(row, idx)) return;
      if (!row.cookies || !/c_user=\d+/.test(row.cookies)) return;
      let uid = row.uid ?? null;
      if (!uid && row.cookies) {
        const m = row.cookies.match(/c_user=(\d+)/);
        if (m) uid = m[1];
      }
      waRows.push({ row, uid, idx });
    });
    if (!waRows.length) return;
    const writeBack = () => {
      const cur = get();
      if (cur.rows === rowsRef) return rows.slice();
      const processed = new Set(waRows.map((w) => w.idx));
      return cur.rows.map((r, i) => {
        if (!processed.has(i)) return r;
        const snap = rows[i];
        if (!snap) return r;
        return {
          ...r,
          wa_status: snap.wa_status ?? r.wa_status,
          wa_ban_reason: snap.wa_ban_reason !== undefined ? snap.wa_ban_reason : r.wa_ban_reason,
          wa_page_name: snap.wa_page_name !== undefined ? snap.wa_page_name : r.wa_page_name,
          wa_linked_number: snap.wa_linked_number !== undefined ? snap.wa_linked_number : r.wa_linked_number,
        };
      });
    };
    let cache: Record<string, WaCacheEntry> = {};
    try {
      const uids = waRows.map((w) => w.uid).filter((u): u is string => !!u);
      if (uids.length) {
        const res = await api.getWaCache(uids);
        cache = (res?.cache as Record<string, WaCacheEntry>) ?? {};
      }
    } catch {
      cache = {};
    }
    if (get().fileId !== s.fileId) return;
    const live = waRows.filter((w) => {
      const hit = w.uid ? cache[w.uid] : null;
      if (!hit || !hit.status) return true;
      if (hit.status === "eligible" || hit.status === "ineligible") {
        w.row.wa_status = hit.status;
        w.row.wa_ban_reason = hit.banReason ?? null;
        w.row.wa_page_name = hit.pageName ?? null;
        w.row.wa_linked_number = hit.linkedNumber ?? null;
        return false;
      }
      return true;
    });
    const pushInstant = (idx: number, newRow: Row) => {
      const cur = get();
      if (cur.fileId !== s.fileId) return;
      const curRow = cur.rows[idx];
      if (!curRow) return;
      const out = cur.rows.slice();
      out[idx] = { ...curRow, wa_status: newRow.wa_status, wa_ban_reason: newRow.wa_ban_reason, wa_page_name: newRow.wa_page_name, wa_linked_number: newRow.wa_linked_number };
      set({ rows: out });
    };
    const concurrency = 3;
    let pos = 0;
    const nextBatch = async (): Promise<void> => {
      if (pos >= live.length) return;
      const batch: number[] = [];
      for (let limit = concurrency; limit > 0 && pos < live.length; limit--) batch.push(pos++);
      await Promise.all(batch.map(async (i) => {
        const w = live[i];
        const apply = (wa_status: string, wa_ban_reason?: string | null, wa_page_name?: string | null, wa_linked_number?: string | null) => {
          const newRow: Row = { ...w.row, wa_status };
          if (wa_ban_reason !== undefined) newRow.wa_ban_reason = wa_ban_reason;
          if (wa_page_name !== undefined) newRow.wa_page_name = wa_page_name;
          if (wa_linked_number !== undefined) newRow.wa_linked_number = wa_linked_number;
          rows[w.idx] = newRow;
          live[i] = { ...w, row: newRow };
          pushInstant(w.idx, newRow);
        };
        try {
          const wa = (await api.pageCheck(w.row.cookies ?? "")) as { eligible?: boolean; error?: string | null; banReason?: string | null; pageName?: string | null; linkedNumber?: string | null } | null;
          if (wa && wa.eligible === true) apply("eligible", null, wa.pageName ?? null, wa.linkedNumber ?? null);
          else apply(wa?.error ? "error" : "ineligible", wa ? wa.banReason ?? null : null, wa ? wa.pageName ?? null : null, wa ? wa.linkedNumber ?? null : null);
        } catch {
          apply("error");
        }
      }));
      return nextBatch();
    };
    try { await nextBatch(); } catch { /* swallow */ }
    if (get().fileId !== s.fileId) return;
    const finalRows = writeBack();
    const cur = get();
    const WA_FIELDS = ["wa_status", "wa_ban_reason", "wa_page_name", "wa_linked_number"] as const;
    const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
    const changedSet = new Set<number>();
    finalRows.forEach((row, i) => {
      const prev = s.rows[i] ?? {};
      const cols: Record<string, string> = {};
      let diff = false;
      for (const k of WA_FIELDS) {
        const pv = (prev as Record<string, unknown>)[k];
        const nv = (row as Record<string, unknown>)[k];
        if (pv !== nv) { diff = true; cols[k] = nv == null ? "" : String(nv); }
      }
      if (diff) { changed.push({ rowIdx: i, cols }); changedSet.add(i); }
    });
    if (changed.length === 0) return;
    const changeJournal = [...s.changeJournal.filter((op) => !changedSet.has(op.rowIdx)), ...changed];
    if (changeJournal.length > MAX_JOURNAL) changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
    set({ rows: finalRows, changeJournal, isDirty: true, ...recomputeMarks(finalRows, cur.crossDups, cur.columns) });
    get().persist();
  },

  runWaChecksWaFiltered: async (filter) => {
    const s = get();
    if (s.file?.type !== "fb_cookie") return;
    const rows = s.rows.map((r) => ({ ...r }));
    const rowsRef = s.rows;
    const waRows: { row: Row; uid: string | null; idx: number }[] = [];
    rows.forEach((row, idx) => {
      if (!filter(row, idx)) return;
      if (!row.cookies || !/c_user=\d+/.test(row.cookies)) return;
      let uid = row.uid ?? null;
      if (!uid && row.cookies) {
        const m = row.cookies.match(/c_user=(\d+)/);
        if (m) uid = m[1];
      }
      waRows.push({ row, uid, idx });
    });
    if (!waRows.length) return;
    const writeBack = () => {
      const cur = get();
      if (cur.rows === rowsRef) return rows.slice();
      const processed = new Set(waRows.map((w) => w.idx));
      return cur.rows.map((r, i) => {
        if (!processed.has(i)) return r;
        const snap = rows[i];
        if (!snap) return r;
        return {
          ...r,
          wa_status: snap.wa_status ?? r.wa_status,
          wa_ban_reason: snap.wa_ban_reason !== undefined ? snap.wa_ban_reason : r.wa_ban_reason,
          wa_page_name: snap.wa_page_name !== undefined ? snap.wa_page_name : r.wa_page_name,
          wa_linked_number: snap.wa_linked_number !== undefined ? snap.wa_linked_number : r.wa_linked_number,
        };
      });
    };
    const pushInstant = (idx: number, newRow: Row) => {
      const cur = get();
      if (cur.fileId !== s.fileId) return;
      const curRow = cur.rows[idx];
      if (!curRow) return;
      const out = cur.rows.slice();
      out[idx] = { ...curRow, wa_status: newRow.wa_status, wa_ban_reason: newRow.wa_ban_reason, wa_page_name: newRow.wa_page_name, wa_linked_number: newRow.wa_linked_number };
      set({ rows: out });
    };
    const concurrency = 3;
    let pos = 0;
    const nextBatch = async (): Promise<void> => {
      if (pos >= waRows.length) return;
      const batch: number[] = [];
      for (let limit = concurrency; limit > 0 && pos < waRows.length; limit--) batch.push(pos++);
      await Promise.all(batch.map(async (i) => {
        const w = waRows[i];
        const apply = (wa_status: string, wa_ban_reason?: string | null, wa_page_name?: string | null, wa_linked_number?: string | null) => {
          const newRow: Row = { ...w.row, wa_status };
          if (wa_ban_reason !== undefined) newRow.wa_ban_reason = wa_ban_reason;
          if (wa_page_name !== undefined) newRow.wa_page_name = wa_page_name;
          if (wa_linked_number !== undefined) newRow.wa_linked_number = wa_linked_number;
          rows[w.idx] = newRow;
          waRows[i] = { ...w, row: newRow };
          pushInstant(w.idx, newRow);
        };
        try {
          const wa = (await api.waCheck(w.row.cookies ?? "")) as { eligible?: boolean; error?: string | null; banReason?: string | null; linkedNumber?: string | null } | null;
          if (wa && wa.eligible === true) apply("eligible", wa.banReason ?? null, undefined, wa.linkedNumber ?? null);
          else {
            // WA check must only turn green, never downgrade an already-green dot
            if (s.rows[w.idx]?.wa_status === "eligible") return;
            apply(wa?.error ? "error" : "ineligible", wa ? wa.banReason ?? null : null, undefined, wa ? wa.linkedNumber ?? null : null);
          }
        } catch {
          if (s.rows[w.idx]?.wa_status === "eligible") return;
          apply("error");
        }
      }));
      return nextBatch();
    };
    try { await nextBatch(); } catch { /* swallow */ }
    if (get().fileId !== s.fileId) return;
    const finalRows = writeBack();
    const cur = get();
    const WA_FIELDS = ["wa_status", "wa_ban_reason", "wa_page_name", "wa_linked_number"] as const;
    const changed: { rowIdx: number; cols: Record<string, string> }[] = [];
    const changedSet = new Set<number>();
    finalRows.forEach((row, i) => {
      const prev = s.rows[i] ?? {};
      const cols: Record<string, string> = {};
      let diff = false;
      for (const k of WA_FIELDS) {
        const pv = (prev as Record<string, unknown>)[k];
        const nv = (row as Record<string, unknown>)[k];
        if (pv !== nv) { diff = true; cols[k] = nv == null ? "" : String(nv); }
      }
      if (diff) { changed.push({ rowIdx: i, cols }); changedSet.add(i); }
    });
    if (changed.length === 0) return;
    const changeJournal = [...s.changeJournal.filter((op) => !changedSet.has(op.rowIdx)), ...changed];
    if (changeJournal.length > MAX_JOURNAL) changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
    set({ rows: finalRows, changeJournal, isDirty: true, ...recomputeMarks(finalRows, cur.crossDups, cur.columns) });
    get().persist();
  },

  restoreVersion: async (v) => {
    const s = get();
    if (!s.fileId) return false;
    try {
      const res = s.adminMode
        ? await api.adminRestoreVersion(s.fileId, v)
        : await api.restoreVersion(s.fileId, v);
      if (!res?.ok) {
        toast("Restore failed");
        return false;
      }
      const rows = [...(res.rows ?? [])];
      while (rows.length < 100) rows.push(makeEmptyRow(s.columns));
      const undoStack: UndoEntry[] = [
        ...s.undoStack,
        { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
      ];
      if (undoStack.length > 100) undoStack.shift();
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
      toast(`Restored version v${v} (${res.rows?.length ?? 0} rows)`);
      return true;
    } catch {
      toast("Restore failed");
      return false;
    }
  },

  mergeRows: (incoming) => {
    const s = get();
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
      toast(`Merged 0 (skipped ${skipped})`);
      return;
    }
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    const rows = s.rows.concat(added);
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
    if (added.some((r) => r.cookies || r.uid)) {
      get().maybeAutoCheck(0, "cookies");
    }
    toast(`Merged ${added.length} (skipped ${skipped})`);
  },

  applyUpload: (mode, incoming) => {
    const s = get();
    let lastDataIdx = -1;
    s.rows.forEach((row, idx) => {
      if (s.columns.some((c) => row[c.key])) lastDataIdx = idx;
    });
    const undoStack: UndoEntry[] = [
      ...s.undoStack,
      { type: "rows", prevRows: s.rows.map((r) => ({ ...r })) },
    ];
    if (undoStack.length > 100) undoStack.shift();
    if (mode === "replace") {
      const rows = [...incoming];
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
      toast(`Replaced with ${incoming.length} rows`);
    } else {
      const rows = s.rows.slice();
      rows.splice(lastDataIdx + 1, 0, ...incoming);
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
      toast(`Appended ${incoming.length} rows`);
    }
    void refreshCrossDups(s.fileId);
    if (incoming.some((r) => r.cookies || r.uid)) {
      get().maybeAutoCheck(0, "cookies");
    }
  },

  removeEmptyRows: () => {
    const s = get();
    const columns = s.columns;
    let lastDataIdx = -1;
    s.rows.forEach((row, idx) => {
      if (columns.some((c) => row[c.key])) lastDataIdx = idx;
    });
    if (lastDataIdx < 0) {
      toast("Nothing to compact");
      return;
    }
    const used = s.rows.slice(0, lastDataIdx + 1);
    const tail = s.rows.slice(lastDataIdx + 1);
    const cleaned = used.filter((row) => columns.some((c) => row[c.key]));
    const removed = used.length - cleaned.length;
    if (removed === 0) {
      toast("Sheet already compact");
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
    toast(`Compacted - ${removed} row${removed === 1 ? "" : "s"} removed`);
  },

  deleteDeadRows: () => {
    const s = get();
    const deadIdx: number[] = [];
    s.rows.forEach((row, idx) => {
      if (row.status === "bad") deadIdx.push(idx);
    });
    if (!deadIdx.length) {
      toast("No dead rows to delete");
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
    toast(`Deleted ${deadIdx.length} dead row${deadIdx.length === 1 ? "" : "s"}`);
  },

  bubbleGetActiveRow: () => {
    const s = get();
    const complete = (r: Row) => !!(r.cookies && r.twofakey);
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
    const rows = s.rows.concat(makeEmptyRow(s.columns));
    const idx = rows.length - 1;
    set({ rows, bubbleActiveRow: idx });
    return idx;
  },

  bubbleAdvanceActiveRow: () => {
    const s = get();
    let idx = s.bubbleActiveRow + 1;
    let rows = s.rows;
    while (idx >= rows.length) {
      rows = rows.concat(makeEmptyRow(s.columns));
    }
    set({ bubbleActiveRow: idx, rows });
  },

  bubbleSaveCookie: (text) => {
    const s = get();
    const trimmed = (text || "").trim();
    const dupe = bubbleCookieIndex(s.rows).get(trimmed);
    if (dupe !== undefined) {
      toast("Duplicate @ " + (dupe + 1));
      return;
    }
    const idx = get().bubbleGetActiveRow();
    if (s.rows[idx].cookies) {
      // Row already has a cookie — this paste was NOT saved (it's a cookie,
      // not a 2FA key). Keep it short: the bubble popup has no room for a
      // long toast.
      toast("Need 2FA");
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
    const complete = !!rows[idx].twofakey;
    toast(complete ? "Row " + (idx + 1) + " done" : "Paste 2FA key");
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
    const key = normalizeBubbleKey(text);
    const s = get();
    if (bubbleKeyIndex(s.rows).has(key)) {
      toast("Duplicate 2FA");
      return;
    }
    const idx = get().bubbleGetActiveRow();
    if (s.rows[idx].twofakey) {
      // Row already has a 2FA key — this paste was NOT saved (it's a key,
      // not a cookie). Keep it short: the bubble popup has no room for a
      // long toast.
      toast("Need cookie");
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
    toast(complete ? "Row " + (idx + 1) + " done" : "Paste cookie");
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
          toast("Code copied");
        })
        .catch(() => {});
    }
  },

  bubbleSkipNo2FA: () => {
    const s = get();
    const idx = s.bubbleActiveRow >= 0 ? s.bubbleActiveRow : s.bubbleGetActiveRow();
    const row = s.rows[idx];
    const canSkip = !!(row?.cookies && row.cookies.trim()) && !row.twofakey;
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
      toast("2FA skipped");
      // The marked row is complete — move to the next one that needs a cookie.
      get().bubbleAdvanceActiveRow();
    }
  },

  setCellStyle: (rowIdx, colKey, patch) => {
    const s = get();
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
    const changeJournal = [...s.changeJournal.filter((op) => op.rowIdx !== rowIdx), { rowIdx, cols: { _cellStyles: json } as Record<string, string> }];
    if (changeJournal.length > MAX_JOURNAL) changeJournal.splice(0, changeJournal.length - MAX_JOURNAL);
    set({ rows: newRows, isDirty: true, changeJournal, undoStack, redoStack: [] });
    get().persist();
  },
}));

offlineSync.subscribe(() => {
  const st = useSheetStore.getState();
  if (offlineSync.isOnline()) {
    if (st.offlineDirty && st.fileId) {
      void useSheetStore.getState().flushPersist();
    }
    void offlineSync.flush();
  }
});

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

// ── Bubble (Android mini-window) helpers ──

function trimMemoryRows() {
  const s = useSheetStore.getState();
  if (!s.fileId || !s.file) return;
  const columns = fileTypeDef(s.file.type).columns;
  useSheetStore.setState((prev) => {
    if (prev.isDirty) return {};
    let lastData = -1;
    prev.rows.forEach((row, i) => {
      if (columns.some((c) => row[c.key])) lastData = i;
    });
    const keep = Math.min(prev.rows.length, Math.max(lastData + 51, 100));
    if (prev.rows.length <= keep) return {};
    const tail = prev.rows.slice(keep);
    const tailEmpty = tail.every((r) => columns.every((c) => !r[c.key]));
    if (!tailEmpty) return {};
    return { rows: prev.rows.slice(0, keep) };
  });
}

/** Normalize a 2FA key: strip spaces/dashes, uppercase (old normalizeKey). */
export function normalizeBubbleKey(t: string | null | undefined): string {
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
  toastMsg: string,
): void {
  if (!cells.length) return;
  const s = useSheetStore.getState();
  const behavior = getFileBehavior(s.file?.type ?? "fb_cookie");
  const rows = s.rows.slice();
  const newInvalid = new Set(s.invalidCells);
  const deltas: CellDelta[] = [];
  let changed = false;
  let lastKey: string | null = null;
  let pastedCookie = false;
  for (const cell of cells) {
    const row = rows[cell.rowIdx];
    if (!row) continue;
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
      /^[A-Z2-7]{10,}$/.test(cell.value.replace(/[\s\-]/g, "").toUpperCase())
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
    useSheetStore.getState().maybeAutoCheck(0, "cookies");
  }
  toast(toastMsg);
  if (lastKey && !s.isDesktop) {
    void getCachedTOTP(lastKey)
      .then((r) => {
        if (!r) return;
        if (useSheetStore.getState().fileId !== s.fileId) return;
        navigator.clipboard.writeText(r.code).catch(() => {});
        toast("TOTP copied");
      })
      .catch(() => {});
  }
}
