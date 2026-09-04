import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { ComponentType } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

// Stale chunk after a fresh deploy (old tab imports a hashed asset the new
// deploy deleted) — reload once to fetch the fresh index.html instead of
// crashing to "Unexpected Application Error!".
// ponytail: ComponentType<any> — retry wrapper is prop-agnostic by design
function lazyRetry(fn: () => Promise<{ default: ComponentType<any> }>) {
  return lazy(async () => {
    try {
      return await fn();
    } catch {
      if (!sessionStorage.getItem("ss_chunk_reload")) {
        sessionStorage.setItem("ss_chunk_reload", "1");
        window.location.reload();
      }
      throw new Error("Chunk failed — reloaded");
    }
  });
}

const AdminView = lazyRetry(() => import("@/components/home/AdminView"));
const ArchiveView = lazyRetry(() => import("@/components/home/ArchiveView"));
const SplitterTool = lazyRetry(() => import("@/components/tools/SplitterTool"));
const PoolsView = lazyRetry(() => import("@/components/home/PoolsView"));
import Fab from "@/components/home/Fab";
import FileGrid from "@/components/home/FileGrid";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { COLUMN_PRESETS, fileTypeDef, FILE_PRESET_NAMES } from "@/lib/types";
import type { FilePreset, FileType, SheetFile } from "@/lib/types";
import { downloadXlsx, genId, hydrateWaCache, importXlsx, todayStr } from "@/lib/xlsx";
import { useBubbleStore } from "@/stores/bubbleStore";
import { CakephpIcon, ObsidianIcon, PasswordIcon, RabbitmqIcon, RedisIcon, ReplitPoolsIcon, WakuIcon } from "@/components/icons/FileTypeIcons";

type Tab = "files" | "archive" | "pools" | "admin" | "tools";

interface AndroidBridge {
  getBubbleFile?: () => string;
  disableBubble?: () => void;
  enableBubble?: (id: string) => void;
}

function getAndroid(): AndroidBridge | null {
  try {
    return (window as unknown as { Android?: AndroidBridge }).Android ?? null;
  } catch {
    return null;
  }
}

function ToolsList({ onOpenSplitter }: { onOpenSplitter: () => void }) {
  return (
    <div>
      <h2 style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>Tools</h2>
      <p style={{ fontSize: 13, color: "var(--text3)", marginBottom: 16 }}>Admin utilities</p>
      <div className="files-grid">
        <div
          className="file-card"
          role="button"
          tabIndex={0}
          onClick={onOpenSplitter}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenSplitter(); } }}
        >
          <div className="file-card-icon" style={{ background: "var(--blue-light)", color: "var(--blue)" }}>
            {/* icon: allsvgicons.com/lucide/scissors.svg */}
            <ObsidianIcon size={16} />
          </div>
          <div className="file-card-name">Splitter</div>
          <div className="file-card-meta">Split xlsx into N parts</div>
          <span className="file-type-badge" style={{ background: "var(--blue-light)", color: "var(--blue)" }}>Xlsx</span>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { userId } = useParams();
  const showToast = useToast();
  const confirm = useConfirm();

  // Each home section has its own URL path (mobile + desktop): / = files,
  // /files, /archive, /admin, /admin/user/:id (admin user detail). The active
  // tab is derived from the pathname so every section is deep-linkable.
  const path = location.pathname;
  const tab: Tab = path.startsWith("/pools")
    ? "pools"
    : path.startsWith("/tools")
      ? "tools"
      : path.startsWith("/admin")
        ? "admin"
        : path === "/archive"
          ? "archive"
          : "files";

  const [files, setFiles] = useState<SheetFile[] | null>(null);
  const [dupCounts, setDupCounts] = useState<Record<string, number>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const selectionMode = selected.size > 0;

  const loadFiles = useCallback(async () => {
    try {
      const [fs, cd] = await Promise.all([api.getFiles(), api.getCrossDups()]);
      setFiles(fs);
      setDupCounts(cd.counts ?? {});
    } catch {
      setFiles([]);
      showToast("Could not load files. Check your connection.");
    }
  }, [showToast]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await api.getFiles());
    } catch {
      showToast("Could not load files. Check your connection.");
    }
  }, [showToast]);

  useEffect(() => {
    if ((tab === "admin" || tab === "tools" || tab === "pools") && !user?.isAdmin) {
      navigate("/", { replace: true });
    }
  }, [tab, user, navigate]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  const openFile = (id: string) => navigate("/file/" + id);

  // Multi-select belongs to one section: switching tabs must not leave an armed
  // selection bar behind (its Delete would act on files from the previous tab).
  const goTab = (to: string) => {
    setSelected(new Set());
    navigate(to);
  };

  const bubblePickMode = useBubbleStore((s) => s.pickMode);

  const pickBubbleFile = (id: string) => {
    const f = files?.find((x) => x.id === id);
    if (!f) return;
    if (f.type !== "fb_cookie") {
      showToast("Only Facebook files work in the bubble");
      return;
    }
    try {
      getAndroid()?.enableBubble?.(f.id);
    } catch {
      // bridge may be gone
    }
    useBubbleStore.setState({ on: true, pickMode: false });
    showToast("Floating bubble on - " + f.name);
  };

  const downloadFile = async (f: SheetFile) => {
    const rows = await api.getRows(f.id);
    if (!rows || !rows.length) {
      showToast("No data");
      return;
    }
    try {
      await downloadXlsx(rows, f.columns ?? fileTypeDef(f.type).columns, f.name);
      showToast("Downloaded");
    } catch {
      showToast("Could not download file. Check your connection.");
    }
  };

  const deleteFile = async (f: SheetFile) => {
    const ok = await confirm("Move this file to archive?", "Archive");
    if (!ok) return;
    const android = getAndroid();
    if (android) {
      try {
        if (android.getBubbleFile?.() === f.id) {
          android.disableBubble?.();
          useBubbleStore.getState().setOn(false);
          showToast("Floating bubble disabled - file archived");
        }
      } catch {
        // bridge may be gone
      }
    }
    try {
      await api.deleteFile(f.id);
    } catch {
      showToast("Could not archive file. Check your connection.");
      return;
    }
    loadFiles();
    showToast("File archived");
  };

  const openRename = (f: SheetFile) => {
    setRenameFileId(f.id);
    setRenameName(f.name);
  };

  const closeRename = () => {
    setRenameFileId(null);
    setRenameName("");
  };

  const commitRename = async () => {
    const name = renameName.trim();
    if (!name) {
      showToast("Name cannot be empty");
      return;
    }
    if (!renameFileId) return;
    try {
      await api.updateFile(renameFileId, { name });
    } catch {
      showToast("Could not rename file. Try again.");
      return;
    }
    closeRename();
    refreshFiles();
    showToast("Renamed");
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const holdSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.size === 0) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (files) setSelected(new Set(files.map((f) => f.id)));
  };

  const unselectAll = () => setSelected(new Set());

  const deleteSelected = async () => {
    if (!selectionMode) return;
    const ids = Array.from(selected);
    const ok = await confirm(
      "Move " + ids.length + " file" + (ids.length > 1 ? "s" : "") + " to archive?",
      "Archive",
    );
    if (!ok) return;
    try {
      await Promise.all(ids.map((id) => api.deleteFile(id)));
    } catch {
      showToast("Could not archive files. Check your connection.");
      return;
    }
    setSelected(new Set());
    loadFiles();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " archived");
  };

  const [pwModal, setPwModal] = useState<null | { type: FileType; preset: FilePreset; choice: string; custom: string }>(null);

  const openCreatePw = (type: FileType, preset: FilePreset) => setPwModal({ type, preset, choice: "dgddigital", custom: "" });

  const createWithPassword = async (password: string) => {
    if (!pwModal) return;
    const type = pwModal.type;
    const columns = COLUMN_PRESETS[pwModal.preset];
    const poolEnabled = password === "dgddigital";
    setPwModal(null);
    const name = FILE_PRESET_NAMES[pwModal.preset] + " " + todayStr();
    const current = files ?? (await api.getFiles());
    let finalName = name;
    if (current.some((f) => f.name === name)) {
      let suffix = 2;
      while (current.some((f) => f.name === name + " (" + suffix + ")")) suffix++;
      finalName = name + " (" + suffix + ")";
    }
    const id = genId();
    let created: import("@/lib/types").SheetFile;
    try {
      created = await api.createFile({ id, name: finalName, type, preset: pwModal.preset, poolKind: pwModal.preset, password, poolEnabled, columns });
    } catch {
      showToast("Could not create file. Check your connection.");
      return;
    }
    showToast(fileTypeDef(type).label + " file created");
    if (useBubbleStore.getState().pickMode) { loadFiles(); return; }
    navigate("/file/" + created.id);
  };

  const createFile = async (preset: FilePreset) => openCreatePw("fb_cookie", preset);

  const [uploadPending, setUploadPending] = useState<null | { id: string; name: string; type: FileType; rows: import("@/lib/types").Row[]; dataCount: number; cacheReady: Promise<void> }>(null);

  const doUploadWithPassword = async (password: string) => {
    if (!uploadPending) return;
    const { id, name, type, rows, dataCount } = uploadPending;
    const preset = pwModal?.preset ?? "page";
    setUploadPending(null);
    setPwModal(null);
    await uploadPending.cacheReady;
    let created: import("@/lib/types").SheetFile;
    try {
      created = await api.createFile({ id, name, type, preset, poolKind: preset, password, poolEnabled: password === "dgddigital", rows, dataCount });
    } catch {
      showToast("Could not import file. Check your file and try again.");
      return;
    }
    showToast("Imported " + dataCount + " rows");
    if (useBubbleStore.getState().pickMode) { loadFiles(); return; }
    navigate("/file/" + created.id);
  };

  const uploadFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const current = files ?? (await api.getFiles());
      const result = await importXlsx(buf, file.name, current);
      const isLoveName = result.name.toLowerCase().includes("love");
      // ask password before creating uploaded file — 2 cards, auto-pick L0VE if name contains Love
       const cacheReady = hydrateWaCache(result.rows);
       setUploadPending({ id: result.id, name: result.name, type: result.type, rows: result.rows, dataCount: result.dataCount, cacheReady });
      setPwModal({ type: result.type, preset: "page", choice: isLoveName ? "L0VE@12345" : "dgddigital", custom: "" });
    } catch {
      showToast("Could not import file. Check your file and try again.");
    }
  };

  return (
    <>
      <div className="home-tabs" role="tablist" aria-label="Home sections">
        <button
          className={`home-tab${tab === "files" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "files"}
          onClick={() => goTab("/")}
        >
          <RedisIcon size={14} aria-hidden="true" />
          My Files
        </button>
        <button
          className={`home-tab${tab === "archive" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "archive"}
          onClick={() => goTab("/archive")}
        >
          <CakephpIcon size={14} aria-hidden="true" />
          Archive
        </button>
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "pools" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "pools"}
            onClick={() => goTab("/pools/dgddigital/cookies_only")}
          >
            <ReplitPoolsIcon size={14} aria-hidden="true" />
            Pools
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "admin" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "admin"}
            onClick={() => goTab("/admin")}
          >
            <WakuIcon size={14} aria-hidden="true" />
            Admin
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "tools" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "tools"}
            onClick={() => goTab("/tools")}
          >
            <RabbitmqIcon size={14} aria-hidden="true" />
            Tools
          </button>
        ) : null}
      </div>

      {tab === "files" ? (
        <div className="home-pane" id="homePaneFiles">
          {bubblePickMode ? (
            <div className="bubble-pick-banner">
              <div>
                <div className="bubble-pick-title">Choose a bubble file</div>
                <div className="bubble-pick-sub">
                  Tap a Facebook file to show it in the mini window
                </div>
              </div>
              <button
                className="btn btn-ghost"
                onClick={() => useBubbleStore.getState().setPickMode(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}
          {files !== null ? (
            <FileGrid
              files={files}
              crossDupCounts={dupCounts}
              selectedIds={selected}
              selectionMode={selectionMode}
              onOpen={bubblePickMode ? pickBubbleFile : openFile}
              onDownload={downloadFile}
              onRename={openRename}
              onDelete={deleteFile}
              onToggleSelect={toggleSelect}
              onHoldSelect={holdSelect}
            />
          ) : null}
        </div>
      ) : null}

      {tab === "archive" ? (
        <div className="home-pane" id="homePaneArchive">
          <Suspense fallback={null}>
            <ArchiveView />
          </Suspense>
        </div>
      ) : null}

      {tab === "pools" && user?.isAdmin ? (
        <div className="home-pane" id="homePanePools" style={{ padding: "24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={null}>
            <PoolsView />
          </Suspense>
        </div>
      ) : null}

      {tab === "admin" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneAdmin">
          <Suspense fallback={null}>
            <AdminView initialUserId={userId} />
          </Suspense>
        </div>
      ) : null}

      {tab === "tools" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneTools" style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          {path === "/tools/splitter" ? (
            <Suspense fallback={null}>
              <SplitterTool />
            </Suspense>
          ) : (
            <ToolsList onOpenSplitter={() => navigate("/tools/splitter")} />
          )}
        </div>
      ) : null}

      {tab === "files" ? <Fab onCreate={createFile} onUpload={uploadFile} /> : null}

      <div className={`sel-bar${selectionMode ? " open" : ""}`}>
        <span className="sel-bar-count">{selected.size} selected</span>
        <div className="sel-bar-actions">
          <button className="sel-btn" onClick={selectAll}>
            Select All
          </button>
          <button className="sel-btn" onClick={unselectAll}>
            Unselect All
          </button>
          <button className="sel-btn danger" onClick={deleteSelected}>
            Delete
          </button>
        </div>
      </div>

      <div
        className={`modal-overlay${renameFileId ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeRename();
        }}
      >
        <div className="modal-box" role="dialog" aria-modal="true" aria-label="Rename file">
          <div className="modal-title">Rename file</div>
          <input
            className="modal-input"
            type="text"
            aria-label="File name"
            value={renameName}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                closeRename();
              }
            }}
          />
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={closeRename}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={commitRename}>
              Rename
            </button>
          </div>
        </div>
      </div>

      <div className={`modal-overlay${pwModal ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) { setPwModal(null); setUploadPending(null); } }}>
        <div className="modal-box" role="dialog" aria-modal="true" aria-label="Pick a password" style={{ width: 340 }}>
          <div className="modal-title">Pick a password</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 12 }}>
            {[
              { id: "dgddigital" },
              { id: "L0VE@12345" },
            ].map((c) => (
              <button
                key={c.id}
                className="file-card"
                style={{ display: "flex", gap: 10, textAlign: "center", padding: 14, minHeight: 56, justifyContent: "center", alignItems: "center", borderColor: "var(--border2)" }}
                onClick={() => { if (uploadPending) doUploadWithPassword(c.id); else createWithPassword(c.id); }}
              >
                <PasswordIcon password={c.id} size={18} />
                <span className="file-card-name" style={{ fontSize: 13, fontWeight: 600 }}>{c.id}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
