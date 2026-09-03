import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { useUndoRedo } from "@/hooks/useUndoRedo";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { parseSheetRows } from "@/lib/xlsx";
import { useSheetStore } from "@/stores/sheetStore";
import { useAuth } from "@/contexts/AuthContext";
import type { Row } from "@/lib/types";

const VersionHistory = lazy(() => import("./VersionHistory"));
const DownloadOverlay = lazy(() => import("./DownloadOverlay"));
const CustomDownloadOverlay = lazy(() => import("./CustomDownloadOverlay"));
const UploadOverlay = lazy(() => import("./UploadOverlay"));
const WaCheckOverlay = lazy(() => import("./WaCheckOverlay"));

interface MenuPos {
  top: number;
  right: number;
}

function UndoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"
        fill="currentColor"
      />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 15.7c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 15.5h9v-9l-3.6 3.1z"
        fill="currentColor"
      />
    </svg>
  );
}

export default function SheetToolbar() {
  const { canUndo, canRedo, undo, redo } = useUndoRedo();
  const showToast = useToast();
  const confirm = useConfirm();
  const columns = useSheetStore((s) => s.columns);
  const visibleCols = useSheetStore((s) => s.visibleCols);
  const checkRunning = useSheetStore((s) => s.checkRunning);
  const isDirty = useSheetStore((s) => s.isDirty);
  const offlineDirty = useSheetStore((s) => s.offlineDirty);
  const { user } = useAuth();

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos>({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [checkOpen, setCheckOpen] = useState(false);
  const [checkPos, setCheckPos] = useState<MenuPos>({ top: 0, right: 0 });
  const checkArrowRef = useRef<HTMLButtonElement>(null);
  const checkMenuRef = useRef<HTMLDivElement>(null);
  const [autoCheckOn, setAutoCheckOn] = useState(
    () => localStorage.getItem("ss_autoCheck") !== "false",
  );
  const [waCheckOn, setWaCheckOn] = useState(
    () => localStorage.getItem("ss_waCheck") === "true",
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [customDlOpen, setCustomDlOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [uploadRows, setUploadRows] = useState<Row[] | null>(null);
  const file = useSheetStore((s) => s.file);
  const pendingMerge = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const s = useSheetStore.getState();
    try {
      const buf = await file.arrayBuffer();
      const rows = await parseSheetRows(buf, s.columns);
      if (s.file?.type === "fb_cookie") {
        rows.forEach((r) => {
          if (r.cookies) {
            const m = r.cookies.match(/c_user=(\d+)/);
            if (m) r.uid = m[1];
          }
        });
      }
      if (pendingMerge.current) {
        pendingMerge.current = false;
        useSheetStore.getState().mergeRows(rows);
        return;
      }
      const empty = s.rows.every((r) => s.columns.every((c) => !r[c.key]));
      if (empty) {
        useSheetStore.getState().applyUpload("replace", rows);
        showToast("Replaced with " + rows.length + " rows");
        return;
      }
      setUploadRows(rows);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to read file");
    }
  };

  const close = () => setOpen(false);

  const toggle = () => {
    const next = !open;
    if (next && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setOpen(next);
  };

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const toggleCheck = () => {
    const next = !checkOpen;
    if (next && checkArrowRef.current) {
      const rect = checkArrowRef.current.getBoundingClientRect();
      setCheckPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
    }
    setCheckOpen(next);
  };

  useEffect(() => {
    if (!checkOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        checkArrowRef.current?.contains(t) ||
        checkMenuRef.current?.contains(t) ||
        btnRef.current?.contains(t)
      ) {
        return;
      }
      setCheckOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [checkOpen]);

  const copyAll = () => {
    close();
    const s = useSheetStore.getState();
    if (!s.rows.length) {
      showToast("No data");
      return;
    }
    const cols = s.columns;
    const lines = [cols.map((c) => c.label).join("\t")];
    let hasData = false;
    for (const row of s.rows) {
      const isEmpty = cols.every((c) => !row[c.key]);
      if (!isEmpty) {
        hasData = true;
        lines.push(cols.map((c) => row[c.key] ?? "").join("\t"));
      }
    }
    if (!hasData) {
      showToast("No data");
      return;
    }
    navigator.clipboard
      .writeText(lines.join("\n"))
      .then(() => showToast(`Copied ${lines.length - 1} rows`))
      .catch(() => showToast("Cannot copy"));
  };

  const startUpload = (merge: boolean) => {
    close();
    pendingMerge.current = merge;
    fileInputRef.current?.click();
  };

  const deleteDead = async () => {
    close();
    const s = useSheetStore.getState();
    const dead = s.rows.filter((r) => r.status === "bad").length;
    if (!dead) {
      showToast("No dead rows to delete");
      return;
    }
    const ok = await confirm(
      `Delete ${dead} dead row${dead === 1 ? "" : "s"}?`,
      "Delete",
    );
    if (ok) useSheetStore.getState().deleteDeadRows();
  };

  return (
    <>
      <span
        className={
          "save-status" +
          (offlineDirty ? " save-offline" : isDirty ? " save-pending" : " save-ok")
        }
        title={
          offlineDirty
            ? "Changes saved on this device — will sync when back online"
            : isDirty
              ? "Saving…"
              : "All changes saved"
        }
      >
        <span className="save-dot" />
        {offlineDirty ? "Saved offline" : isDirty ? "Saving…" : "Saved"}
      </span>
      <button
        className="undo-redo-btn"
        title="Undo"
        aria-label="Undo"
        disabled={!canUndo}
        onClick={undo}
      >
        <UndoIcon />
      </button>
      <button
        className="undo-redo-btn"
        title="Redo"
        aria-label="Redo"
        disabled={!canRedo}
        onClick={redo}
      >
        <RedoIcon />
      </button>
      <div className="check-split-wrap" data-check={checkRunning ? "checking" : ""}>
        <button
          className="check-split-main"
          onClick={() => void useSheetStore.getState().runCheck()}
        >
          {checkRunning ? "Checking..." : "Check"}
        </button>
        <button
          ref={checkArrowRef}
          className={"check-split-arrow" + (checkOpen ? " open" : "")}
          title="More check options"
          aria-label="More check options"
          onClick={toggleCheck}
        >
          <svg width="9" height="9" viewBox="0 0 10 6" fill="currentColor">
            <path d="M0 0l5 6 5-6z" />
          </svg>
        </button>
      </div>
      <div
        ref={checkMenuRef}
        className={"check-dropdown" + (checkOpen ? " open" : "")}
        style={{ top: checkPos.top, right: checkPos.right }}
      >
        <div className="check-dropdown-label">Auto-check</div>
        <button
          className={"autocheck-toggle" + (autoCheckOn ? " on" : "")}
          onClick={() => {
            const next = !autoCheckOn;
            setAutoCheckOn(next);
            localStorage.setItem("ss_autoCheck", String(next));
          }}
        >
          <span className="autocheck-track"></span>
          Auto-check
        </button>
        <div className="check-dropdown-label" style={{ marginTop: 8 }}>
          Page Check
        </div>
        <button
          className={"autocheck-toggle" + (waCheckOn ? " on" : "")}
          onClick={() => {
            const next = !waCheckOn;
            setWaCheckOn(next);
            localStorage.setItem("ss_waCheck", String(next));
          }}
        >
          <span className="autocheck-track"></span>
          Page Check
        </button>
      </div>
      <button
        ref={btnRef}
        className="sheet-more-btn"
        title="More actions"
        aria-label="More actions"
        onClick={toggle}
      >
        ⋮
      </button>
      <div
        ref={menuRef}
        className={"sheet-more-menu" + (open ? " open" : "")}
        style={{ top: pos.top, right: pos.right }}
      >
        <button className="sheet-more-item" onClick={copyAll}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy all data
        </button>
        <button
          className="sheet-more-item"
          onClick={() => {
            close();
            setDownloadOpen(true);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download xlsx
        </button>
        {user?.isAdmin ? (
          <button
            className="sheet-more-item"
            onClick={() => {
              close();
              setCustomDlOpen(true);
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download custom
          </button>
        ) : null}
        {user?.isAdmin && file?.type === "fb_cookie" ? (
          <button
            className="sheet-more-item"
            onClick={() => {
              close();
              setWaOpen(true);
            }}
          >
            {/* shield-check icon — lucide */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            WA Check
          </button>
        ) : null}
        <button className="sheet-more-item" onClick={() => startUpload(false)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload xlsx
        </button>
        <button className="sheet-more-item" onClick={() => startUpload(true)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 0 0 9 9" />
          </svg>
          Merge
        </button>
        <button
          className="sheet-more-item"
          onClick={() => {
            close();
            setVersionsOpen(true);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l4 2" />
          </svg>
          Versions
        </button>
        <button
          className="sheet-more-item"
          title="Compact - remove empty rows between used rows"
          aria-label="Compact rows"
          onClick={async () => {
            close();
            const ok = await confirm("Remove empty rows between used rows?", "Compact");
            if (!ok) return;
            useSheetStore.getState().removeEmptyRows();
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="8 3 4 3 4 7" />
            <polyline points="16 3 20 3 20 7" />
            <polyline points="8 21 4 21 4 17" />
            <polyline points="16 21 20 21 20 17" />
            <line x1="4" y1="12" x2="20" y2="12" />
          </svg>
          Compact
        </button>
        <button className="sheet-more-item" onClick={() => void deleteDead()}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
          Delete Dead
        </button>
        <div className="sheet-more-sep"></div>
        {columns.map((col) => (
          <div
            key={col.key}
            className="sheet-more-col-item"
            role="checkbox"
            aria-checked={visibleCols.has(col.key)}
            tabIndex={0}
            onClick={() => {
              close();
              useSheetStore.getState().toggleVisibleCol(col.key);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                close();
                useSheetStore.getState().toggleVisibleCol(col.key);
              }
            }}
          >
            <span
              className={"col-toggle" + (visibleCols.has(col.key) ? " on" : "")}
            ></span>
            {col.label}
          </div>
        ))}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,.xls"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
      {versionsOpen ? (
        <Suspense fallback={null}>
          <VersionHistory open={versionsOpen} onClose={() => setVersionsOpen(false)} />
        </Suspense>
      ) : null}
      {downloadOpen ? (
        <Suspense fallback={null}>
          <DownloadOverlay open={downloadOpen} onClose={() => setDownloadOpen(false)} />
        </Suspense>
      ) : null}
      {customDlOpen ? (
        <Suspense fallback={null}>
          <CustomDownloadOverlay
            open={customDlOpen}
            onClose={() => setCustomDlOpen(false)}
          />
        </Suspense>
      ) : null}
      {uploadRows ? (
        <Suspense fallback={null}>
          <UploadOverlay rows={uploadRows} onClose={() => setUploadRows(null)} />
        </Suspense>
      ) : null}
      {waOpen ? (
        <Suspense fallback={null}>
          <WaCheckOverlay open={waOpen} onClose={() => setWaOpen(false)} />
        </Suspense>
      ) : null}
    </>
  );
}
