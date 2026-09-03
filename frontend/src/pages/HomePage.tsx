import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

const AdminView = lazy(() => import("@/components/home/AdminView"));
const ArchiveView = lazy(() => import("@/components/home/ArchiveView"));
const SplitterTool = lazy(() => import("@/components/tools/SplitterTool"));
const PoolsView = lazy(() => import("@/components/home/PoolsView"));
import Fab from "@/components/home/Fab";
import FileGrid from "@/components/home/FileGrid";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { fileTypeDef } from "@/lib/types";
import type { FileType, SheetFile } from "@/lib/types";
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
      showToast("Could not load files");
    }
  }, [showToast]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await api.getFiles());
    } catch {
      showToast("Could not load files");
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
      await downloadXlsx(rows, fileTypeDef(f.type).columns, f.name);
      showToast("Downloaded");
    } catch {
      showToast("Download failed");
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
      showToast("Failed to archive file");
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
      showToast("Rename failed");
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
      showToast("Failed to archive files");
      return;
    }
    setSelected(new Set());
    loadFiles();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " archived");
  };

  const [pwModal, setPwModal] = useState<null | { type: FileType; choice: string; custom: string }>(null);

  const openCreatePw = (type: FileType) => setPwModal({ type, choice: "dgddigital", custom: "" });

  const createWithPassword = async (password: string) => {
    if (!pwModal) return;
    const type = pwModal.type;
    const poolEnabled = password === "dgddigital";
    setPwModal(null);
    const name = fileTypeDef(type).label + " " + todayStr();
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
      created = await api.createFile({ id, name: finalName, type, password, poolEnabled });
    } catch {
      showToast("Failed to create file");
      return;
    }
    showToast(fileTypeDef(type).label + " file created");
    if (useBubbleStore.getState().pickMode) { loadFiles(); return; }
    navigate("/file/" + created.id);
  };

  const createFile = async (type: FileType) => openCreatePw(type);

  const [uploadPending, setUploadPending] = useState<null | { id: string; name: string; type: FileType; rows: import("@/lib/types").Row[]; dataCount: number }>(null);

  const doUploadWithPassword = async (password: string) => {
    if (!uploadPending) return;
    const { id, name, type, rows, dataCount } = uploadPending;
    setUploadPending(null);
    setPwModal(null);
    await hydrateWaCache(rows);
    let created: import("@/lib/types").SheetFile;
    try {
      created = await api.createFile({ id, name, type, password, poolEnabled: password === "dgddigital" });
    } catch {
      showToast("Import failed");
      return;
    }
    try {
      await api.persist(created.id, { rows, dataCount, action: "import" });
    } catch {
      try { await api.deleteFile(created.id); } catch {}
      showToast("Import failed — rolled back");
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
      setUploadPending({ id: result.id, name: result.name, type: result.type, rows: result.rows, dataCount: result.dataCount });
      setPwModal({ type: result.type, choice: isLoveName ? "L0VE@12345" : "dgddigital", custom: "" });
    } catch {
      showToast("Import failed");
    }
  };

  return (
    <>
      <div className="home-tabs">
        <button
          className={`home-tab${tab === "files" ? " active" : ""}`}
          onClick={() => goTab("/")}
        >
          My Files
        </button>
        <button
          className={`home-tab${tab === "archive" ? " active" : ""}`}
          onClick={() => goTab("/archive")}
        >
          Archive
        </button>
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "pools" ? " active" : ""}`}
            onClick={() => goTab("/pools/dgddigital/cookies_only")}
          >
            Pools
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "admin" ? " active" : ""}`}
            onClick={() => goTab("/admin")}
          >
            Admin
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "tools" ? " active" : ""}`}
            onClick={() => goTab("/tools")}
          >
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
