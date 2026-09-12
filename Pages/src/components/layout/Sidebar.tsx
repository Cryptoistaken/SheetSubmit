import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { AnalysisIcon, ApprovalsIcon, ArchiveIcon, RabbitmqIcon, RedisIcon, ReplitPoolsIcon, WakuIcon, WalletIcon } from "@/components/icons/FileTypeIcons";
import logoUrl from "@/assets/logo.svg";
import ViewSwitch from "@/components/home/ViewSwitch";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { useViewStore } from "@/stores/viewStore";

const COLLAPSE_KEY = "ss_sidebar_collapsed";
const MODE_KEY = "ss_sidebar_mode";
const WIDTH_KEY = "ss_sidebar_width";
const MIN_W = 64; // icons stop (also the trigger toggle target)
const TIGHT_W = 48; // drag-only stop inside the collapsed space
const MINI_W = 36; // drag-only stop inside the collapsed space
const DEFAULT_W = 240;
const MAX_W = 320;
// Release bands: <42 mini (36) · <56 tight (48) · <160 icons (64).
// Hidden is never a drag outcome — only the footer X button hides the rail.
const MINI_BELOW = 42;
const TIGHT_BELOW = 56;
const ICONS_BELOW = 160;
const LABEL_W = 180;

type RailMode = "expanded" | "icons" | "tight" | "mini" | "hidden";

function loadMode(): RailMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === "expanded" || m === "icons" || m === "tight" || m === "mini" || m === "hidden") return m;
    if (localStorage.getItem(COLLAPSE_KEY) === "1") return "icons";
  } catch {
    // ignore
  }
  // first run: start collapsed (icons), never expanded
  return "icons";
}

function saveMode(m: RailMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    // ignore
  }
}

const clampWidth = (w: number) => Math.min(MAX_W, Math.max(MINI_W, Math.round(w)));

function loadWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MINI_W && raw <= MAX_W) return Math.round(raw);
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

function NavButton({ active, collapsed, label, onClick, children, buttonRef }: { active: boolean; collapsed: boolean; label: string; onClick: () => void; children: ReactNode; buttonRef?: (el: HTMLButtonElement | null) => void }) {
  return (
    <button
      type="button"
      ref={buttonRef}
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
      <span className={cn("truncate transition-[max-width,opacity] duration-[var(--anim-med)] ease-[var(--ease-out)] motion-reduce:transition-none", collapsed ? "max-w-0 opacity-0" : "max-w-44 opacity-100")}>{label}</span>
    </button>
  );
}

function PanelTriggerIcon({ shifted }: { shifted?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="shrink-0">
      <path d="M21.25 6.72v10.56a2.97 2.97 0 0 1-2.97 2.97H5.72a2.97 2.97 0 0 1-2.97-2.97V6.72a2.97 2.97 0 0 1 2.97-2.97h12.56a2.97 2.97 0 0 1 2.97 2.97" />
      <path d="M6.25 7.25v9.5" className={cn("transition-transform duration-[var(--anim-med)] ease-[var(--ease-out)] motion-reduce:transition-none", shifted && "translate-x-[10.5px]")} />
    </svg>
  );
}

// Admin-only sidebar rail (regulars keep Topbar + tabs everywhere — the rail
// would be overkill for their 4 sections). Same persistent rail on desktop
// and phones: expanded ↔ icons via the footer trigger, drag-only stops at
// tight (48) and mini (36) inside the collapsed space, hidden (rail gone,
// only a floating expand button stays) only via the footer X button.
// Tap works everywhere; hover-expand needs a real mouse.
// Sheet pages never mount this.
export default function Sidebar() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const view = useViewStore((s) => s.view);
  const setViewMode = useViewStore((s) => s.setViewMode);
  const [mode, setMode] = useState<RailMode>(loadMode);
  const [customWidth, setCustomWidth] = useState<number | null>(loadWidth);
  const [hoverOpen, setHoverOpen] = useState(false);
  // Sliding active-item bar (same motion dialect as the view-switch thumb).
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [ind, setInd] = useState<{ top: number; height: number; show: boolean }>({ top: 0, height: 0, show: false });
  useEffect(() => {
    if (!user) return;
    const btn = btnRefs.current[tabForPath(location.pathname)];
    const next = btn ? { top: btn.offsetTop, height: btn.offsetHeight, show: true } : null;
    setInd((p) => {
      const n = next ?? { top: p.top, height: p.height, show: false };
      return p.top === n.top && p.height === n.height && p.show === n.show ? p : n;
    });
  });
  // Live width while edge-dragging (null otherwise).
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragStart = useRef<{ x: number; w: number } | null>(null);

  // Hover (real mice only) always opens to the full width, whatever the mode.
  const expandedNow = dragWidth != null ? dragWidth >= LABEL_W : mode === "expanded" || hoverOpen;
  const effCollapsed = !expandedNow;
  const restWidth = mode === "expanded" ? (customWidth ?? DEFAULT_W)
    : mode === "icons" ? MIN_W
    : mode === "tight" ? TIGHT_W
    : MINI_W; // mini — hidden unmounts, so it never gets here
  const effWidth = dragWidth ?? (expandedNow ? (customWidth ?? DEFAULT_W) : restWidth);
  const tab = tabForPath(location.pathname);
  const adminItems = NAV_ADMIN.filter((i) => !i.adminOnly || user?.isAdmin);

  if (!user) return null;

  // Footer trigger toggles expanded ↔ icons only. Drag/arrow stops below
  // that: tight (48), mini (36). Hidden comes only from the X button.
  const toggleRail = () => {
    setHoverOpen(false);
    const next: RailMode = mode === "expanded" ? "icons" : "expanded";
    setMode(next);
    saveMode(next);
  };
  const expandRail = () => {
    setHoverOpen(false);
    setMode("expanded");
    saveMode("expanded");
  };
  const hideRail = () => {
    setHoverOpen(false);
    setMode("hidden");
    saveMode("hidden");
  };
  // Drag release (and arrow keys) snaps to mini (36) · tight (48) ·
  // icons (64) · expanded. Wide persists as the custom expanded width;
  // near-default rounds back to the default. Never hides — only X does that.
  const applyWidth = (w: number) => {
    const width = clampWidth(w);
    if (width < MINI_BELOW) {
      setMode("mini");
      saveMode("mini");
    } else if (width < TIGHT_BELOW) {
      setMode("tight");
      saveMode("tight");
    } else if (width < ICONS_BELOW) {
      setMode("icons");
      saveMode("icons");
    } else {
      const custom = Math.abs(width - DEFAULT_W) < 4 ? null : width;
      setMode("expanded");
      saveMode("expanded");
      setCustomWidth(custom);
      saveWidth(custom);
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
    const s = dragStart.current;
    dragStart.current = null;
    // A press without a real move is a tap, not a resize — ignore it so a
    // stray touch on the edge can't flip the rail state.
    if (dragWidth != null && s != null && Math.abs(dragWidth - s.w) >= 6) {
      applyWidth(dragWidth);
    }
    setDragWidth(null);
  };
  // Mini stop (36px): footer compacts so the trigger still fits with padding.
  const miniFooter = effWidth < 44;

  // Hidden state: the whole rail (icons included) is gone — only a floating
  // expand button stays at the bottom-left.
  if (mode === "hidden") {
    return (
      <button
        type="button"
        onClick={expandRail}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className="fixed bottom-7 left-6 z-[200] grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-border bg-background text-muted-foreground shadow-lg transition-colors hover:text-foreground"
      >
        <PanelTriggerIcon />
      </button>
    );
  }

  const triggerLabel = mode === "expanded" ? "Collapse sidebar" : "Expand sidebar";

  return (
    <aside
      onMouseLeave={() => setHoverOpen(false)}
      style={{ width: effWidth }}
      className={cn("group relative flex shrink-0 flex-col overflow-hidden whitespace-nowrap border-r border-border bg-background ease-[var(--ease-out)] motion-reduce:transition-none", dragWidth == null && "transition-[width] duration-[var(--anim-med)]")}
    >
      {/* Hover auto-expand covers everything except the footer trigger block
          below it — the footer is hover-dead (click only), the rest expands. */}
      <div onMouseEnter={() => { if (mode !== "expanded" && window.matchMedia("(hover: hover)").matches) setHoverOpen(true); }} className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex h-12 shrink-0 items-center gap-2 border-b border-border px-3", effCollapsed && "justify-center px-0")}>
        <button type="button" onClick={() => navigate("/")} title="Sheet Submit — home" aria-label="Sheet Submit — home" className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-muted">
          <img src={logoUrl} className="size-5" alt="" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => navigate("/")} tabIndex={effCollapsed ? -1 : 0} className={cn("min-w-0 truncate text-left text-sm font-semibold tracking-tight transition-[max-width,opacity] duration-[var(--anim-med)] ease-[var(--ease-out)] motion-reduce:transition-none", effCollapsed ? "max-w-0 flex-none opacity-0" : "max-w-44 flex-1 opacity-100")}>
          Sheet Submit
        </button>
      </div>

      <nav aria-label="Primary" className="relative flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <span aria-hidden="true" className="pointer-events-none absolute left-[3px] w-1 rounded-full bg-foreground transition-[top,height,opacity] duration-[var(--anim-med)] ease-[var(--ease-out)] motion-reduce:transition-none" style={{ top: ind.top, height: ind.height, opacity: ind.show ? 1 : 0 }} />
        {NAV_MAIN.map((item) => (
          <NavButton key={item.key} active={tab === item.key} collapsed={effCollapsed} label={item.label} onClick={() => navigate(item.to)} buttonRef={(el) => { btnRefs.current[item.key] = el; }}>
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
              <NavButton key={item.key} active={tab === item.key} collapsed={effCollapsed} label={item.label} onClick={() => navigate(item.to)} buttonRef={(el) => { btnRefs.current[item.key] = el; }}>
                {item.icon}
              </NavButton>
            ))}
          </>
        )}
      </nav>
      </div>

      <div className={cn("flex flex-col gap-1 border-t border-border", miniFooter ? "p-1" : "p-2", effCollapsed && "items-center")}>
        {tab === "files" && !effCollapsed ? (
          <div className="flex justify-center">
            <ViewSwitch view={view} setViewMode={setViewMode} />
          </div>
        ) : null}
        <div className={cn("flex items-center", effCollapsed ? "justify-center" : "justify-between")}>
        <button
          type="button"
          onClick={toggleRail}
          aria-expanded={mode === "expanded"}
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cn("flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", miniFooter ? "size-6" : "size-8")}
        >
          <PanelTriggerIcon shifted={effCollapsed} />
        </button>
        {!effCollapsed ? (
          <button
            type="button"
            onClick={hideRail}
            aria-label="Hide sidebar"
            title="Hide sidebar"
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2m-3.4 14L12 13.4L8.4 17L7 15.6l3.6-3.6L7 8.4L8.4 7l3.6 3.6L15.6 7L17 8.4L13.4 12l3.6 3.6z" /></svg>
          </button>
        ) : null}
        </div>
      </div>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuenow={Math.round(effWidth)}
        aria-valuemin={MINI_W}
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
        className={cn("absolute inset-y-0 right-0 z-10 cursor-ew-resize touch-none outline-none", miniFooter ? "w-3" : "w-6")}
      >
        <div
          aria-hidden="true"
          className={cn(
            "absolute right-[5px] top-1/2 h-10 w-1 -translate-y-1/2 rounded-full bg-border transition-opacity",
            dragWidth != null ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        />
      </div>
    </aside>
  );
}
