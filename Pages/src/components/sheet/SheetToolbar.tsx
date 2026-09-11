import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";

import { useUndoRedo } from "@/hooks/useUndoRedo";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { parseSheetRows } from "@/lib/xlsx";
import { useSheetStore } from "@/stores/sheetStore";
import { MAX_GRID_ROWS } from "@/stores/sheetStore";
import { useAuth } from "@/contexts/AuthContext";
import type { Row } from "@/lib/types";
import { isDataRow, replaceCapMessage } from "@/lib/types";
import { isPageFile as isPageFileHelper } from "@/features/filetypes";

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
  const hasDups = useSheetStore((s) => s.dupRows.size > 0);
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
  const [checkWaOn, setCheckWaOn] = useState(
    () => localStorage.getItem("ss_checkWa") === "true",
  );
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [customDlOpen, setCustomDlOpen] = useState(false);
  const [waOpen, setWaOpen] = useState(false);
  const [uploadRows, setUploadRows] = useState<Row[] | null>(null);
  const file = useSheetStore((s) => s.file);
  const isPageFile = isPageFileHelper(file);
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
      const empty = !s.rows.some((r) => isDataRow(r, s.columns));
      if (empty) {
        // Strict per-file cap (server enforces it too): refuse, never truncate.
        const capMsg = replaceCapMessage(rows.length, MAX_GRID_ROWS);
        if (capMsg) {
          showToast(capMsg);
          return;
        }
        useSheetStore.getState().applyUpload("replace", rows);
        return;
      }
      setUploadRows(rows);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Couldn't read file");
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); btnRef.current?.focus(); }
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setCheckOpen(false); checkArrowRef.current?.focus(); }
    };
    document.addEventListener("click", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("click", onDoc); document.removeEventListener("keydown", onKey); };
  }, [checkOpen]);

  const copyAll = () => {
    close();
    const s = useSheetStore.getState();
    if (!s.rows.length) {
      showToast("Add content first");
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
      showToast("Add content first");
      return;
    }
    navigator.clipboard
      .writeText(lines.join("\n"))
      .catch(() => showToast("Could not copy. Try again."));
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
      showToast("No dead rows");
      return;
    }
    const ok = await confirm(
      `Delete ${dead} dead row${dead === 1 ? "" : "s"}?`,
      "Delete",
    );
    if (ok) useSheetStore.getState().deleteDeadRows();
  };

  const restoreSnapshot = async () => {
    close();
    const st = useSheetStore.getState();
    if (!st.fileId) return;
    const ok = await confirm(
      "Restore the last saved version? Rows added or changed since that save will be replaced (your current state stays in Undo).",
      "Restore",
    );
    if (!ok) return;
    try {
      const res = st.adminMode
        ? await api.adminRestoreSnapshot(st.fileId)
        : await api.restoreSnapshot(st.fileId);
      useSheetStore.getState().applyRestore(res.rows ?? [], res.seq ?? st.lastSeq, res.file ?? st.file);
      showToast("Restored (Undo kept)");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg.includes("no snapshot") ? "No earlier save to restore yet" : "Could not restore. Try again.");
    }
  };

  const poolOn = file?.poolEnabled !== false;

  const togglePool = async () => {
    close();
    const st = useSheetStore.getState();
    const fid = st.fileId;
    if (!fid || !st.file) return;
    const next = !poolOn;
    const ok = await confirm(
      next ? "Enable pooling for this file? Eligible rows will feed the shared pool." : "Disable pooling? Its available rows leave the shared pool.",
      next ? "Enable pool" : "Disable pool",
    );
    if (!ok) return;
    try {
      const cols = st.columns;
      let lastData = -1;
      st.rows.forEach((row, idx) => { if (cols.some((c) => row[c.key])) lastData = idx; });
      const trimmed = st.rows.slice(0, Math.min(st.rows.length, Math.max(lastData + 51, 100)));
      // Admins can flip pooling on anyone's file: owner routes 404 for them
      // (owned()), so use the admin routes in admin mode.
      const updated = st.adminMode
        ? await api.adminUpdateFile(fid, { poolEnabled: next })
        : await api.updateFile(fid, { poolEnabled: next });
      useSheetStore.setState({ file: updated });
      if (next) {
        // structural re-save re-fires the pool feed (persist() would no-op:
        // flipping the switch alone leaves no dirty cells behind)
        
        if (st.adminMode) await api.adminPersist(fid, { rows: trimmed, action: "pool-enable" });
        else await api.persist(fid, { rows: trimmed, action: "pool-enable" });
        showToast("Pooling on");
      } else {
        
      }
    } catch {
      showToast("Pooling failed");
    }
  };

  return (
    <>

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
          disabled={hasDups}
          title={hasDups ? "Remove duplicate rows first" : undefined}
          onClick={() => void useSheetStore.getState().runCheck()}
        >
          {checkRunning ? (
            <>
              Checking{" "}
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true">
                <title>loading-twotone-loop</title>
                <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
                  <path strokeDasharray="18" d="M12 3c4.97 0 9 4.03 9 9">
                    <animate fill="freeze" attributeName="stroke-dashoffset" dur="0.3s" values="18;0" />
                    <animateTransform attributeName="transform" dur="1.5s" repeatCount="indefinite" type="rotate" values="0 12 12;360 12 12" />
                  </path>
                  <path strokeDasharray="60" d="M12 3c4.97 0 9 4.03 9 9c0 4.97 -4.03 9 -9 9c-4.97 0 -9 -4.03 -9 -9c0 -4.97 4.03 -9 9 -9Z" opacity=".3">
                    <animate fill="freeze" attributeName="stroke-dashoffset" dur="1.2s" values="60;0" />
                  </path>
                </g>
              </svg>
            </>
          ) : (
            "Check"
          )}
        </button>
        <button
          ref={checkArrowRef}
          className={"check-split-arrow" + (checkOpen ? " open" : "")}
          title="More check options"
          aria-label="More check options"
           aria-expanded={checkOpen}
           aria-haspopup="menu"
           aria-controls="check-dropdown"
          onClick={toggleCheck}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24">
            <title>vercel-solid</title>
            <path fill="currentColor" d="M13 5h2v3h2v3h2v3h2v3h2v3H1v-3h2v-3h2v-3h2V8h2V5h2V3h2z" />
          </svg>
        </button>
      </div>
      <div
        ref={checkMenuRef}
        id="check-dropdown"
        className={"check-dropdown" + (checkOpen ? " open" : "")}
        style={{ top: checkPos.top, right: checkPos.right }}
        role="menu"
        aria-label="Check options"
        hidden={!checkOpen}
      >
        <div className="check-dropdown-label" id="check-uid-label">UID check</div>
        <button
          role="switch"
          aria-checked={autoCheckOn}
          aria-labelledby="check-uid-label"
          className={"autocheck-toggle" + (autoCheckOn ? " on" : "")}
          onClick={() => {
            const next = !autoCheckOn;
            setAutoCheckOn(next);
            localStorage.setItem("ss_autoCheck", String(next));
          }}
        >
          <span className="autocheck-track" aria-hidden="true"></span>
          UID check
        </button>
        {isPageFile ? (
          <>
            <div className="check-dropdown-label" style={{ marginTop: 8 }} id="check-page-label">
              Page Check
            </div>
            <button
              role="switch"
              aria-checked={waCheckOn}
              aria-labelledby="check-page-label"
              className={"autocheck-toggle" + (waCheckOn ? " on" : "")}
              onClick={() => {
                const next = !waCheckOn;
                setWaCheckOn(next);
                localStorage.setItem("ss_waCheck", String(next));
                if (next) {
                  setCheckWaOn(false);
                  localStorage.setItem("ss_checkWa", "false");
                }
              }}
            >
              <span className="autocheck-track" aria-hidden="true"></span>
              Page Check
            </button>
            <div className="check-dropdown-label" style={{ marginTop: 8 }} id="check-wa-label">
              WA Check
            </div>
            <button
              role="switch"
              aria-checked={checkWaOn}
              aria-labelledby="check-wa-label"
              className={"autocheck-toggle" + (checkWaOn ? " on" : "")}
              onClick={() => {
                const next = !checkWaOn;
                setCheckWaOn(next);
                localStorage.setItem("ss_checkWa", String(next));
                if (next) {
                  setWaCheckOn(false);
                  localStorage.setItem("ss_waCheck", "false");
                }
              }}
            >
              <span className="autocheck-track" aria-hidden="true"></span>
              WA Check
            </button>
          </>
        ) : null}
      </div>
      <button
        ref={btnRef}
        className="sheet-more-btn"
        title="More actions"
        aria-label="More actions"
         aria-expanded={open}
         aria-haspopup="menu"
         aria-controls="sheet-more-menu"
        onClick={toggle}
      >
        ⋮
      </button>
      <div
        ref={menuRef}
        id="sheet-more-menu"
        className={"sheet-more-menu" + (open ? " open" : "")}
        style={{ top: pos.top, right: pos.right }}
        role="menu"
        aria-label="Sheet actions"
        hidden={!open}
      >
        <button role="menuitem" className="sheet-more-item" onClick={copyAll}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          Copy all data
        </button>
        <button
          role="menuitem"
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
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download xlsx
        </button>
        {user?.isAdmin ? (
          <button
            role="menuitem"
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
              aria-hidden="true"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download custom
          </button>
        ) : null}
        {user?.isAdmin && isPageFile ? (
          <button
            role="menuitem"
            className="sheet-more-item"
            onClick={() => {
              close();
              setWaOpen(true);
            }}
          >
            {/* shield-check icon — lucide */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            WA Check
          </button>
        ) : null}
        <button role="menuitem" className="sheet-more-item" onClick={() => startUpload(false)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload xlsx
        </button>
        <button role="menuitem" className="sheet-more-item" onClick={() => startUpload(true)}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="18" cy="18" r="3" />
            <circle cx="6" cy="6" r="3" />
            <path d="M6 21V9a9 9 0 0 0 9 9" />
          </svg>
          Merge
        </button>
        <button
          role="menuitem"
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
            aria-hidden="true"
          >
            <polyline points="8 3 4 3 4 7" />
            <polyline points="16 3 20 3 20 7" />
            <polyline points="8 21 4 21 4 17" />
            <polyline points="16 21 20 21 20 17" />
            <line x1="4" y1="12" x2="20" y2="12" />
          </svg>
          Compact
        </button>
        <button role="menuitem" className="sheet-more-item" onClick={() => void deleteDead()}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
          Delete Dead
        </button>
        <button role="menuitem" className="sheet-more-item" onClick={() => void restoreSnapshot()}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Restore last save
        </button>
        <div className="sheet-more-sep" role="separator"></div>
        {user?.isAdmin ? (
          <>
            <div
              className="sheet-more-col-item"
              role="menuitemcheckbox"
              aria-checked={poolOn}
              tabIndex={0}
              onClick={() => void togglePool()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void togglePool();
                }
              }}
            >
              <span className={"col-toggle" + (poolOn ? " on" : "")}></span>
              Pooling {poolOn ? "on" : "off"}
            </div>
            <div className="sheet-more-sep" role="separator"></div>
          </>
        ) : null}
        {columns.map((col) => (
          <div
            key={col.key}
            className="sheet-more-col-item"
            role="menuitemcheckbox"
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
