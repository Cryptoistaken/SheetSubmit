import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { AnalysisIcon, ApprovalsIcon, ArchiveIcon, RabbitmqIcon, RedisIcon, ReplitPoolsIcon, WakuIcon, WalletIcon } from "@/components/icons/FileTypeIcons";
import ViewSwitch from "@/components/home/ViewSwitch";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/stores/viewStore";

const COLLAPSE_KEY = "ss_sidebar_collapsed";
const WIDTH_KEY = "ss_sidebar_width";
const MIN_W = 64;
const DEFAULT_W = 240;
const MAX_W = 320;
const SNAP_W = 120;
const LABEL_W = 180;

const clampWidth = (w: number) => Math.min(MAX_W, Math.max(MIN_W, Math.round(w)));

function loadWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN_W && raw <= MAX_W) return Math.round(raw);
  } catch {
    // ignore
  }
  return null;
}

function saveWidth(w: number | null) {
  try {
    if (w == null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // ignore
  }
}

interface NavItem {
  key: string;
  label: string;
  to: string;
  adminOnly?: boolean;
  icon: ReactNode;
}

const NAV_MAIN: NavItem[] = [
  { key: "files", label: "My Files", to: "/", icon: <RedisIcon size={16} aria-hidden="true" /> },
  { key: "wallet", label: "Wallet", to: "/wallet", icon: <WalletIcon size={16} aria-hidden="true" /> },
  { key: "withdrawals", label: "Withdrawals", to: "/withdrawals", icon: <img src="/withdrawal-icon.svg" alt="" aria-hidden="true" width={16} height={16} /> },
  { key: "archive", label: "Archive", to: "/archive", icon: <ArchiveIcon size={16} aria-hidden="true" /> },
];

const NAV_ADMIN: NavItem[] = [
  { key: "admin", label: "Admin", to: "/admin", adminOnly: true, icon: <WakuIcon size={16} aria-hidden="true" /> },
  { key: "pools", label: "Pools", to: "/pools/dgddigital/cookies_only", adminOnly: true, icon: <ReplitPoolsIcon size={16} aria-hidden="true" /> },
  { key: "approvals", label: "Approvals", to: "/approvals", adminOnly: true, icon: <ApprovalsIcon size={16} aria-hidden="true" /> },
  { key: "settings", label: "Settings", to: "/settings", adminOnly: true, icon: <img src="/settings-icon.svg" alt="" aria-hidden="true" width={16} height={16} /> },
  { key: "tools", label: "Tools", to: "/tools", adminOnly: true, icon: <RabbitmqIcon size={16} aria-hidden="true" /> },
  { key: "analysis", label: "Analysis", to: "/analysis", adminOnly: true, icon: <AnalysisIcon size={16} aria-hidden="true" /> },
];

function tabForPath(path: string): string {
  if (path.startsWith("/pools")) return "pools";
  if (path.startsWith("/approvals")) return "approvals";
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/tools")) return "tools";
  if (path.startsWith("/analysis")) return "analysis";
  if (path.startsWith("/admin")) return "admin";
  if (path === "/archive") return "archive";
  if (path === "/wallet") return "wallet";
  if (path === "/withdrawals") return "withdrawals";
  return "files";
}

function NavButton({ active, collapsed, label, onClick, children }: { active: boolean; collapsed: boolean; label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-[13px] font-semibold transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <span className="grid size-5 shrink-0 place-items-center" aria-hidden="true">{children}</span>
      {!collapsed && <span className="truncate">{label}</span>}
    </button>
  );
}

// Admin-only sidebar rail (regulars keep Topbar + tabs everywhere — the rail
// would be overkill for their 4 sections). Same persistent rail on desktop
// and phones; tap the footer trigger to collapse/expand (phones have no
// hover). Sheet pages never mount this.
export default function Sidebar() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const view = useViewStore((s) => s.view);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [customWidth, setCustomWidth] = useState<number | null>(loadWidth);
  // Hover-expand is desktop-only (touch has no hover); the footer trigger
  // tap collapses/expands everywhere.
  const [hoverOpen, setHoverOpen] = useState(false);
  // Live width while edge-dragging (null otherwise).
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStart = useRef<{ x: number; w: number } | null>(null);

  const effCollapsed = dragWidth != null ? dragWidth < LABEL_W : collapsed && !hoverOpen;
  const effWidth = dragWidth ?? (collapsed && !hoverOpen ? MIN_W : (customWidth ?? DEFAULT_W));

  if (!user) return null;

  const tab = tabForPath(location.pathname);
  const toggleCollapse = () => {
    setHoverOpen(false);
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };
  // Drag release (and arrow keys): narrow snaps to collapsed, wide persists
  // as the custom expanded width. Near-default rounds back to the default.
  const applyWidth = (w: number) => {
    const width = clampWidth(w);
    try {
      if (width < SNAP_W) {
        setCollapsed(true);
        localStorage.setItem(COLLAPSE_KEY, "1");
        setCustomWidth(null);
        saveWidth(null);
      } else {
        const custom = Math.abs(width - DEFAULT_W) < 4 ? null : width;
        setCollapsed(false);
        localStorage.setItem(COLLAPSE_KEY, "0");
        setCustomWidth(custom);
        saveWidth(custom);
      }
    } catch {
      // ignore
    }
  };
  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, w: effWidth };
    setDragWidth(effWidth);
  };
  const moveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = dragStart.current;
    if (s == null) return;
    setDragWidth(clampWidth(s.w + e.clientX - s.x));
  };
  const endDrag = () => {
    dragStart.current = null;
    if (dragWidth != null) {
      applyWidth(dragWidth);
      setDragWidth(null);
    }
  };
  const adminItems = NAV_ADMIN.filter((i) => !i.adminOnly || user.isAdmin);

  return (
    <aside
      onMouseLeave={() => setHoverOpen(false)}
      style={{ width: effWidth }}
      className={cn("relative flex shrink-0 flex-col overflow-hidden whitespace-nowrap border-r border-border bg-background ease-out motion-reduce:transition-none", dragWidth == null && "transition-[width] duration-200")}
    >
      {/* Hover auto-expand covers everything except the footer trigger block
          below it — the footer is hover-dead (click only), the rest expands. */}
      <div onMouseEnter={() => { if (collapsed) setHoverOpen(true); }} className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border px-3", effCollapsed && "justify-center px-0")}>
        <button type="button" onClick={() => navigate("/")} title="Sheet Submit — home" aria-label="Sheet Submit — home" className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-muted">
          <img src="/logo.svg" className="size-5" alt="" aria-hidden="true" />
        </button>
        {!effCollapsed && (
          <button type="button" onClick={() => navigate("/")} className="min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight">
            Sheet Submit
          </button>
        )}
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {NAV_MAIN.map((item) => (
          <NavButton key={item.key} active={tab === item.key} collapsed={effCollapsed} label={item.label} onClick={() => navigate(item.to)}>
            {item.icon}
          </NavButton>
        ))}
        {adminItems.length > 0 && (
          <>
            {!effCollapsed && (
              <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</p>
            )}
            {effCollapsed && <div className="mx-2 my-2 border-t border-border" aria-hidden="true" />}
            {adminItems.map((item) => (
              <NavButton key={item.key} active={tab === item.key} collapsed={effCollapsed} label={item.label} onClick={() => navigate(item.to)}>
                {item.icon}
              </NavButton>
            ))}
          </>
        )}
      </nav>
      </div>

      <div className={cn("flex flex-col gap-1 border-t border-border p-2", effCollapsed && "items-center")}>
        {tab === "files" && !effCollapsed ? (
          <div className="flex justify-center">
            <ViewSwitch view={view} setViewMode={setViewMode} />
          </div>
        ) : null}
        <div className={cn("flex items-center", effCollapsed ? "justify-center" : "justify-start")}>
        <button
          type="button"
          onClick={toggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
            <path d="M21.25 6.72v10.56a2.97 2.97 0 0 1-2.97 2.97H5.72a2.97 2.97 0 0 1-2.97-2.97V6.72a2.97 2.97 0 0 1 2.97-2.97h12.56a2.97 2.97 0 0 1 2.97 2.97" />
            <path d="M6.25 7.25v9.5" className={cn("transition-transform duration-200 ease-out motion-reduce:transition-none", effCollapsed && "translate-x-[10.5px]")} />
          </svg>
        </button>
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(effWidth)}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); applyWidth(effWidth + 16); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); applyWidth(effWidth - 16); }
        }}
        title="Drag to resize"
        className="absolute inset-y-0 right-0 z-10 w-3 cursor-ew-resize touch-none outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      />
    </aside>
  );
}
