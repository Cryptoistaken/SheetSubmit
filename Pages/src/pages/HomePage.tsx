import { Archive, Layers } from "lucide-react";
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

const ReplitIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>replit</title>
    <path fill="#f26207" d="M11 8c0-2.122.845-4.157 2.35-5.657A8.04 8.04 0 0 1 19.026 0h37.45a8.04 8.04 0 0 1 5.675 2.343A8 8 0 0 1 64.5 8v34.667H19.025a8.04 8.04 0 0 1-5.674-2.343A8 8 0 0 1 11 34.666zm53.5 34.667h45.475a8.04 8.04 0 0 1 5.675 2.343a8 8 0 0 1 2.35 5.657v26.666a8 8 0 0 1-2.35 5.657a8.04 8.04 0 0 1-5.675 2.343H64.5zM11 93.333c0-2.121.845-4.156 2.35-5.656a8.04 8.04 0 0 1 5.675-2.344H64.5V120a8 8 0 0 1-2.35 5.657A8.04 8.04 0 0 1 56.475 128h-37.45a8.04 8.04 0 0 1-5.674-2.343A8 8 0 0 1 11 120z" />
  </svg>
);

const WakuIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>waku</title>
    <path fill="#dd2e44" d="M10.666 16a7.114 7.114 0 0 0-7.111 7.111c0 3.926 2.61 6.166 7.111 7.112c0 0 2.003.607 7.111 1.316V48H7.111A7.114 7.114 0 0 0 0 55.111a7.114 7.114 0 0 0 7.111 7.112h10.666v53.332a7.114 7.114 0 0 0 7.112 7.111A7.114 7.114 0 0 0 32 115.555V62.223h64v53.332a7.114 7.114 0 0 0 7.111 7.111a7.114 7.114 0 0 0 7.112-7.111V62.223h10.666A7.114 7.114 0 0 0 128 55.11a7.114 7.114 0 0 0-7.111-7.11h-10.666V31.54c5.108-.71 7.111-1.317 7.111-1.317c4.334-1 7.111-3.186 7.111-7.112A7.114 7.114 0 0 0 117.334 16zM32 32.902c6.412.412 14.564.735 24.889.838V48H32zm64 0V48H71.111V33.74c10.325-.103 18.477-.426 24.889-.838" />
    <path fill="#292f33" d="M127.666 12.444c0 3.926-2.343 6.39-6.784 7.112c0 0-14.222 3.555-56.886 3.555c-42.66 0-56.878-3.555-56.878-3.555c-4.163-.669-6.73-3.15-6.73-7.076c0-3.929-.75-10.702 3.175-10.702c0 0 14.218 7.11 60.433 7.11s60.438-7.11 60.438-7.11c3.929 0 3.232 6.738 3.232 10.666M39.111 119.111A7.114 7.114 0 0 1 32 126.222H17.778a7.114 7.114 0 0 1-7.111-7.11a7.114 7.114 0 0 1 7.11-7.112H32a7.114 7.114 0 0 1 7.111 7.111m78.222 0a7.114 7.114 0 0 1-7.11 7.111H96a7.114 7.114 0 0 1-7.111-7.11A7.114 7.114 0 0 1 96 112h14.222a7.114 7.114 0 0 1 7.111 7.111" />
  </svg>
);

const RedisIcon = ({ size = 14, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 128 128" aria-hidden="true" {...props}>
    <title>redis</title>
    <path fill="#a41e11" d="M121.8 93.1c-6.7 3.5-41.4 17.7-48.8 21.6s-11.5 3.8-17.3 1S13 98.1 6.3 94.9c-3.3-1.6-5-2.9-5-4.2V78s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9v12.5c0 1.3-1.5 2.7-4.9 4.4" />
    <path fill="#d82c20" d="M121.8 80.5C115.1 84 80.4 98.2 73 102.1s-11.5 3.8-17.3 1S13 85.4 6.3 82.2C-.3 79-.5 76.8 6 74.3c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.9" />
    <path fill="#a41e11" d="M121.8 72.5C115.1 76 80.4 90.2 73 94.1c-7.4 3.8-11.5 3.8-17.3 1S13 77.4 6.3 74.2c-3.3-1.6-5-2.9-5-4.2V57.3s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9V68c0 1.3-1.5 2.7-4.9 4.5" />
    <path fill="#d82c20" d="M121.8 59.8c-6.7 3.5-41.4 17.7-48.8 21.6c-7.4 3.8-11.5 3.8-17.3 1S13 64.7 6.3 61.5s-6.8-5.4-.3-7.9c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.9" />
    <path fill="#a41e11" d="M121.8 51c-6.7 3.5-41.4 17.7-48.8 21.6c-7.4 3.8-11.5 3.8-17.3 1C49.9 70.9 13 56 6.3 52.8c-3.3-1.6-5.1-2.9-5.1-4.2V35.9s48-10.5 55.8-13.2c7.8-2.8 10.4-2.9 17-.5s46.1 9.5 52.6 11.9v12.5c.1 1.3-1.4 2.6-4.8 4.4" />
    <path fill="#d82c20" d="M121.8 38.3C115.1 41.8 80.4 56 73 59.9c-7.4 3.8-11.5 3.8-17.3 1S13 43.3 6.3 40.1s-6.8-5.4-.3-7.9c6.5-2.6 43.2-17 51-19.7c7.8-2.8 10.4-2.9 17-.5s41.1 16.1 47.6 18.5c6.7 2.4 6.9 4.4.2 7.8" />
    <path fill="#fff" d="m80.4 26.1l-10.8 1.2l-2.5 5.8l-3.9-6.5l-12.5-1.1l9.3-3.4l-2.8-5.2l8.8 3.4l8.2-2.7L72 23zM66.5 54.5l-20.3-8.4l29.1-4.4z" />
    <ellipse cx="38.4" cy="35.4" fill="#fff" rx="15.5" ry="6" />
    <path fill="#7a0c00" d="m93.3 27.7l17.2 6.8l-17.2 6.8z" />
    <path fill="#ad2115" d="m74.3 35.3l19-7.6v13.6l-1.9.8z" />
  </svg>
);

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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3" />
              <path d="M8.12 8.12L12 12m8-8L8.12 15.88" />
              <circle cx="6" cy="18" r="3" />
              <path d="M14.8 14.8L20 20" />
            </svg>
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
          <Archive size={14} aria-hidden="true" />
          Archive
        </button>
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "pools" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "pools"}
            onClick={() => goTab("/pools/dgddigital/cookies_only")}
          >
            <Layers size={14} aria-hidden="true" />
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
            <ReplitIcon size={14} aria-hidden="true" />
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
                style={{ textAlign: "center", padding: 14, minHeight: 56, justifyContent: "center", alignItems: "center", borderColor: "var(--border2)" }}
                onClick={() => { if (uploadPending) doUploadWithPassword(c.id); else createWithPassword(c.id); }}
              >
                <span className="file-card-name" style={{ fontSize: 13, fontWeight: 600 }}>{c.id}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
