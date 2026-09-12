import { Suspense, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { lazyRetry } from "@/lib/lazyRetry";

const AdminView = lazyRetry(() => import("@/components/home/AdminView"));
const AnalysisView = lazyRetry(() => import("@/components/home/AnalysisView"));
const ApprovalsView = lazyRetry(() => import("@/components/home/ApprovalsView"));
const ArchiveView = lazyRetry(() => import("@/components/home/ArchiveView"));
const SplitterTool = lazyRetry(() => import("@/components/tools/SplitterTool"));
const PoolLookupTool = lazyRetry(() => import("@/components/tools/PoolLookupTool"));
const PoolsView = lazyRetry(() => import("@/components/home/PoolsView"));
const SettingsView = lazyRetry(() => import("@/components/home/SettingsView"));
const WalletView = lazyRetry(() => import("@/components/home/WalletView"));
const WithdrawalsView = lazyRetry(() => import("@/components/home/WithdrawalsView"));
import Fab from "@/components/home/Fab";
import FileGrid from "@/components/home/FileGrid";
import ViewSwitch from "@/components/home/ViewSwitch";
import { useViewStore } from "@/stores/viewStore";
import PageSkeleton from "@/components/ui/page-skeleton";
import { useModalA11y } from "@/hooks/useModalA11y";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { COLUMN_PRESETS, fileTypeDef, FILE_PRESET_NAMES } from "@/lib/types";
import type { FilePreset, FileType, SheetFile } from "@/lib/types";
import { downloadXlsx, genId, hydrateWaCache, importXlsx } from "@/lib/xlsx";
import { useBubbleStore } from "@/stores/bubbleStore";
import { AnalysisIcon, ApprovalsIcon, ArchiveIcon, CookieIcon, ObsidianIcon, PageIcon, PasswordIcon, RabbitmqIcon, RedisIcon, ReplitPoolsIcon, TwoFaIcon, WakuIcon, WalletIcon } from "@/components/icons/FileTypeIcons";

type Tab = "files" | "archive" | "wallet" | "withdrawals" | "pools" | "approvals" | "settings" | "admin" | "analysis" | "tools";

// Built-in passwords for new files — files under these are shared by
// default; the modal only offers these two.
export const LOVE_PASSWORD = "L0VE@12345";

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

function ToolsList({ onOpenSplitter, onOpenPoolLookup }: { onOpenSplitter: () => void; onOpenPoolLookup: () => void }) {
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
        <div
          className="file-card"
          role="button"
          tabIndex={0}
          onClick={onOpenPoolLookup}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenPoolLookup(); } }}
        >
          <div className="file-card-icon" style={{ background: "var(--green-bg)", color: "var(--green)" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" /></svg>
          </div>
          <div className="file-card-name">Pool lookup</div>
          <div className="file-card-meta">Trace an account across pools</div>
          <span className="file-type-badge" style={{ background: "var(--green-bg)", color: "var(--green)" }}>Pool</span>
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
  // /files, /archive, /admin, /analysis, /admin/user/:id (admin user detail). The active
  // tab is derived from the pathname so every section is deep-linkable.
  const path = location.pathname;
  const tab: Tab = path.startsWith("/pools")
    ? "pools"
    : path.startsWith("/approvals")
      ? "approvals"
      : path.startsWith("/settings")
        ? "settings"
    : path.startsWith("/tools")
      ? "tools"
      : path.startsWith("/analysis")
        ? "analysis"
      : path.startsWith("/admin")
        ? "admin"
        : path === "/archive"
          ? "archive"
          : path === "/wallet"
            ? "wallet"
            : path === "/withdrawals"
              ? "withdrawals"
            : "files";

  const [files, setFiles] = useState<SheetFile[] | null>(null);
  const [dupCounts, setDupCounts] = useState<Record<string, number>>({});
  // Shared with the sidebar footer toggle (admins) — the floating toggle below
  // is for regular users only.
  const view = useViewStore((s) => s.view);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [archSel, setArchSel] = useState<Set<string>>(new Set());
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");

  const selectionMode = selected.size > 0;

  // The desktop sidebar navigates directly (bypasses goTab): switching
  // sections must not leave an armed selection bar behind from the old tab.
  useEffect(() => {
    setSelected(new Set());
    setArchSel(new Set());
  }, [tab]);

  const loadFiles = useCallback(async () => {
    try {
      const [fs, cd] = await Promise.all([api.getFiles(), api.getCrossDups()]);
      setFiles(fs);
      setDupCounts(cd.counts ?? {});
    } catch {
      setFiles([]);
      showToast("Unable to load files. Please try again.");
    }
  }, [showToast]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await api.getFiles());
    } catch {
      showToast("Unable to load files. Please try again.");
    }
  }, [showToast]);

  useEffect(() => {
    if ((tab === "admin" || tab === "analysis" || tab === "tools" || tab === "pools" || tab === "approvals" || tab === "settings") && !user?.isAdmin) {
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
    setArchSel(new Set());
    navigate(to);
  };

  const bubblePickMode = useBubbleStore((s) => s.pickMode);

  const pickBubbleFile = (id: string) => {
    const f = files?.find((x) => x.id === id);
    if (!f) return;
    if (f.type !== "fb_cookie") {
      showToast("Bubble mode supports Facebook files only.");
      return;
    }
    try {
      getAndroid()?.enableBubble?.(f.id);
    } catch {
      // bridge may be gone
    }
    useBubbleStore.setState({ on: true, pickMode: false });
  };

  const downloadFile = async (f: SheetFile) => {
    let rows;
    try {
      rows = await api.getRows(f.id);
    } catch {
      showToast("Unable to load rows. Please try again.");
      return;
    }
    if (!rows || !rows.length) {
      showToast("Please add content first.");
      return;
    }
    try {
      await downloadXlsx(rows, f.columns ?? fileTypeDef(f.type).columns, f.name);
    } catch {
      showToast("Download failed. Please try again.");
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
          showToast("Bubble file moved to archive.");
        }
      } catch {
        // bridge may be gone
      }
    }
    try {
      await api.deleteFile(f.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg.includes(" - ") ? msg.split(" - ").slice(1).join(" - ").trim() : "Unable to archive file. Please check your connection and try again.");
      return;
    }
    loadFiles();
    showToast("File moved to archive.");
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
      showToast("Please enter a file name.");
      return;
    }
    if (!renameFileId) return;
    try {
      await api.updateFile(renameFileId, { name });
    } catch {
      showToast("Unable to rename. Please try again.");
      return;
    }
    closeRename();
    refreshFiles();
    showToast("File renamed.");
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(msg.includes(" - ") ? msg.split(" - ").slice(1).join(" - ").trim() : "Unable to archive files. Please check your connection and try again.");
      return;
    }
    setSelected(new Set());
    loadFiles();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " moved to archive.");
  };

  const [pwModal, setPwModal] = useState<null | { type: FileType; preset: FilePreset; choice: string; custom: string }>(null);
  const renameRef = useModalA11y(!!renameFileId, closeRename);

  const openCreatePw = (type: FileType, preset: FilePreset) => setPwModal({ type, preset, choice: "dgddigital", custom: "" });

  const createWithPassword = async (password: string) => {
    if (!pwModal) return;
    const type = pwModal.type;
    const columns = COLUMN_PRESETS[pwModal.preset];
    setPwModal(null);
    const base = FILE_PRESET_NAMES[pwModal.preset];
    const current = files ?? (await api.getFiles());
    const sameCount = current.filter((f) => {
      const p = (f.preset ?? f.poolKind) as string | undefined;
      if (p) return p === pwModal.preset;
      return f.name.toLowerCase().startsWith(base.toLowerCase());
    }).length;
    let finalName = sameCount === 0 ? base : base + " " + (sameCount + 1);
    if (current.some((f) => f.name === finalName)) {
      let n = Math.max(sameCount + 1, 2);
      finalName = base + " " + n;
      while (current.some((f) => f.name === finalName)) {
        n++;
        finalName = base + " " + n;
      }
    }
    const id = genId();
    try {
      await api.createFile({ id, name: finalName, type, preset: pwModal.preset, poolKind: pwModal.preset, password, poolEnabled: true, columns });
    } catch {
      showToast("Unable to create file. Please try again.");
      return;
    }
    showToast(fileTypeDef(type).label + " file created.");
    loadFiles();
  };

  const createFile = async (preset: FilePreset) => openCreatePw("fb_cookie", preset);

  const [uploadPending, setUploadPending] = useState<null | { id: string; name: string; type: FileType; rows: import("@/lib/types").Row[]; dataCount: number; cacheReady: Promise<void> }>(null);
  const [typePick, setTypePick] = useState<null | { has2fa: boolean; pageHint: boolean }>(null);
  const typePickRef = useModalA11y(!!typePick, () => { setTypePick(null); setUploadPending(null); });
  const pwRef = useModalA11y(!!pwModal, () => { setPwModal(null); setUploadPending(null); });

  const pickUploadType = (preset: FilePreset) => {
    if (!uploadPending) return;
    setTypePick(null);
    const isLoveName = uploadPending.name.toLowerCase().includes("love");
    setPwModal({ type: uploadPending.type, preset, choice: isLoveName ? LOVE_PASSWORD : "dgddigital", custom: "" });
  };

  const doUploadWithPassword = async (password: string) => {
    if (!uploadPending) return;
    const { id, name, type, rows, dataCount } = uploadPending;
    const preset = pwModal?.preset ?? "page";
    setUploadPending(null);
    setPwModal(null);
    await uploadPending.cacheReady;
    try {
      await api.createFile({ id, name, type, preset, poolKind: preset, password, poolEnabled: true, rows, dataCount, columns: COLUMN_PRESETS[preset] });
    } catch {
      showToast("Unable to import file. Please try again.");
      return;
    }
    showToast("Successfully imported " + dataCount + " rows.");
    loadFiles();
  };

  const uploadFile = async (file: File) => {
    try {
      const buf = await file.arrayBuffer();
      const current = files ?? (await api.getFiles());
      const result = await importXlsx(buf, file.name, current);
      // ask file type first, then password — L0VE preselect if name contains Love
      const cacheReady = hydrateWaCache(result.rows);
      setUploadPending({ id: result.id, name: result.name, type: result.type, rows: result.rows, dataCount: result.dataCount, cacheReady });
      setTypePick({
        has2fa: result.rows.some((r) => String(r.twofakey ?? "").trim() !== ""),
        pageHint: result.name.toLowerCase().includes("page"),
      });
    } catch {
      showToast("Unable to import file. Please try again.");
    }
  };

  return (
    <>
      <div id="homeTabBar" className={user?.isAdmin ? "admin-tabs" : undefined}>
        {tab === "files" && selectionMode ? (
          <div className="home-tabs" role="toolbar" aria-label="File selection actions">
              <button type="button" className="home-tab sel-danger" aria-label={`Move ${selected.size} files to archive`} onClick={() => void deleteSelected()}>Move to archive</button>
              {files && files.length > 0 && selected.size >= files.length ? (
                <button type="button" className="home-tab sel-primary" aria-label="Unselect all files" onClick={unselectAll}>Unselect all</button>
              ) : (
                <button type="button" className="home-tab sel-primary" aria-label="Select all files" onClick={selectAll}>Select all</button>
              )}
          </div>
        ) : tab === "archive" && archSel.size > 0 ? null : (
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
          className={`home-tab${tab === "wallet" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "wallet"}
          onClick={() => goTab("/wallet")}
        >
          <WalletIcon size={14} aria-hidden="true" />
          Wallet
        </button>
        <button
          className={`home-tab${tab === "withdrawals" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "withdrawals"}
          onClick={() => goTab("/withdrawals")}
        >
          <img src="/withdrawal-icon.svg" alt="" aria-hidden="true" width={15.4} height={15.4} />
          Withdrawals
        </button>
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
            className={`home-tab${tab === "approvals" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "approvals"}
            onClick={() => goTab("/approvals")}
          >
            <ApprovalsIcon size={14} aria-hidden="true" />
            Approvals
          </button>
        ) : null}
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "settings" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "settings"}
            onClick={() => goTab("/settings")}
          >
            <img src="/settings-icon.svg" alt="" aria-hidden="true" width={15.4} height={15.4} />
            Settings
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
        <button
          className={`home-tab${tab === "archive" ? " active" : ""}`}
          role="tab"
          aria-selected={tab === "archive"}
          onClick={() => goTab("/archive")}
        >
          <ArchiveIcon size={14} aria-hidden="true" />
          Archive
        </button>
        {user?.isAdmin ? (
          <button
            className={`home-tab${tab === "analysis" ? " active" : ""}`}
            role="tab"
            aria-selected={tab === "analysis"}
            onClick={() => goTab("/analysis")}
          >
            <AnalysisIcon size={14} aria-hidden="true" />
            Analysis
          </button>
        ) : null}
          </div>
        )}
      </div>

      {tab === "files" ? (
        <div className="home-pane" id="homePaneFiles">
          {selectionMode ? (
            <div className="sel-count-bar" role="status" aria-live="polite">
              <span>{selected.size} selected</span>
              <button type="button" className="btn btn-ghost" aria-label="Clear file selection" onClick={unselectAll}>Clear</button>
            </div>
          ) : null}
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
          {files === null ? <PageSkeleton variant="files" /> : (
            <FileGrid
              files={files}
              crossDupCounts={dupCounts}
              selectedIds={selected}
              selectionMode={selectionMode}
              view={view}
              onOpen={bubblePickMode ? pickBubbleFile : openFile}
              onDownload={downloadFile}
              onRename={openRename}
              onDelete={deleteFile}
              onToggleSelect={toggleSelect}
            />
            )}
        </div>
      ) : null}

      {tab === "archive" ? (
        <div className="home-pane" id="homePaneArchive">
          <Suspense fallback={<PageSkeleton variant="archive" />}>
            <ArchiveView selected={archSel} setSelected={setArchSel} view={view} />
          </Suspense>
        </div>
      ) : null}

      {tab === "wallet" ? (
        <div className="home-pane" id="homePaneWallet" style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={<PageSkeleton variant="files" />}><WalletView /></Suspense>
        </div>
      ) : null}

      {tab === "withdrawals" ? (
        <div className="home-pane" id="homePaneWithdrawals" style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={<PageSkeleton variant="files" />}><WithdrawalsView /></Suspense>
        </div>
      ) : null}

      {tab === "pools" && user?.isAdmin ? (
        <div className="home-pane" id="homePanePools" style={{ padding: "24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={<PageSkeleton variant="pools" />}>
            <PoolsView />
          </Suspense>
        </div>
      ) : null}

      {tab === "approvals" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneApprovals" style={{ padding: "24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={<PageSkeleton variant="pools" />}>
            <ApprovalsView />
          </Suspense>
        </div>
      ) : null}

      {tab === "settings" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneSettings" style={{ padding: "24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          <Suspense fallback={<PageSkeleton variant="pools" />}>
            <SettingsView />
          </Suspense>
        </div>
      ) : null}

      {tab === "admin" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneAdmin">
          <Suspense fallback={<PageSkeleton variant={userId ? "admin-detail" : "admin"} />}>
            <AdminView initialUserId={userId} view={view} />
          </Suspense>
        </div>
      ) : null}

      {tab === "analysis" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneAnalysis">
          <Suspense fallback={<PageSkeleton variant="admin" />}>
            <AnalysisView />
          </Suspense>
        </div>
      ) : null}

      {tab === "tools" && user?.isAdmin ? (
        <div className="home-pane" id="homePaneTools" style={{ padding: "32px 24px", maxWidth: 960, margin: "0 auto", width: "100%" }}>
          {path === "/tools/splitter" ? (
            <Suspense fallback={<PageSkeleton variant="splitter" />}>
              <SplitterTool />
            </Suspense>
          ) : path === "/tools/pool-lookup" ? (
            <Suspense fallback={<PageSkeleton variant="splitter" />}>
              <PoolLookupTool />
            </Suspense>
          ) : (
            <ToolsList onOpenSplitter={() => navigate("/tools/splitter")} onOpenPoolLookup={() => navigate("/tools/pool-lookup")} />
          )}
        </div>
      ) : null}

      {tab === "files" ? <Fab onCreate={createFile} onUpload={uploadFile} /> : null}
      {tab === "files" && !user?.isAdmin ? <ViewSwitch view={view} setViewMode={setViewMode} floating /> : null}

      <div
        className={`modal-overlay${renameFileId ? " open" : ""}`}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeRename();
        }}
      >
        <div ref={renameRef} className="modal-box" role="dialog" aria-modal="true" aria-labelledby="rename-title">
          <div id="rename-title" className="modal-title">Rename file</div>
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

      <div className={`modal-overlay${typePick ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) { setTypePick(null); setUploadPending(null); } }}>
        <div ref={typePickRef} className="modal-box" role="dialog" aria-modal="true" aria-labelledby="typepick-title" style={{ width: 300 }}>
          <div id="typepick-title" className="modal-title">Choose file type</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 10 }}>
            {([
              { preset: "cookie" as FilePreset, name: "Cookie", desc: "cookies and uid", Icon: CookieIcon },
              { preset: "combo" as FilePreset, name: "2fa", desc: "cookies and 2fa and uid", Icon: TwoFaIcon },
              { preset: "page" as FilePreset, name: "Page", desc: "full columns", Icon: PageIcon },
            ] as const).map((o) => {
              const detected = typePick && ((o.preset === "cookie" && !typePick.has2fa) || (o.preset === "combo" && typePick.has2fa) || (o.preset === "page" && typePick.pageHint));
              const disabled = !!typePick?.has2fa && o.preset === "cookie";
              return (
                <button
                  className="home-fab-item"
                  key={o.preset}
                  disabled={disabled}
                  title={disabled ? "File has 2FA data - pick 2fa or Page" : undefined}
                  style={disabled ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                  onClick={() => pickUploadType(o.preset)}
                >
                  <span className="home-fab-ic" aria-hidden="true" style={{ background: "var(--bg3)", color: "var(--text)" }}><o.Icon size={15} aria-hidden="true" /></span>
                  <span>
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span className="home-fab-name">{o.name}</span>
                      {detected ? <span style={{ fontSize: 10, fontWeight: 600, color: "var(--green)", background: "var(--green-bg)", padding: "1px 6px", borderRadius: 999 }}>Detected</span> : null}
                    </span>
                    <span className="home-fab-desc">{o.desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className={`modal-overlay${pwModal ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) { setPwModal(null); setUploadPending(null); } }}>
        <div ref={pwRef} className="modal-box" role="dialog" aria-modal="true" aria-labelledby="pw-title" style={{ width: 340 }}>
          <div id="pw-title" className="modal-title">Pick a password</div>
          <p style={{ fontSize: 12, color: "var(--text3)", marginTop: 4 }}>Files under these passwords are shared by default.</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10, marginTop: 12 }}>
            {[
              { id: "dgddigital" },
              { id: LOVE_PASSWORD },
            ].map((c) => (
              <button
                key={c.id}
                className="file-card"
                style={{ display: "flex", flexDirection: "row", gap: 12, textAlign: "left", padding: "14px 16px", minHeight: 56, justifyContent: "flex-start", alignItems: "center", borderColor: "var(--border2)" }}
                onClick={() => { if (uploadPending) doUploadWithPassword(c.id); else createWithPassword(c.id); }}
              >
                <span style={{ display: "inline-flex", flexShrink: 0 }} aria-hidden="true"><PasswordIcon password={c.id} size={18} aria-hidden="true" /></span>
                <span className="file-card-name" style={{ fontSize: 13, fontWeight: 600 }}>{c.id}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
