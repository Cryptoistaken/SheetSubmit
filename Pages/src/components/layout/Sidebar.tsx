import { ChevronsLeft, ChevronsRight, LogOutIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

import { AnalysisIcon, ApprovalsIcon, ArchiveIcon, RabbitmqIcon, RedisIcon, ReplitPoolsIcon, WakuIcon, WalletIcon } from "@/components/icons/FileTypeIcons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ThemeTogglerButton } from "@/components/ui/theme-toggler";
import { useAuth } from "@/contexts/AuthContext";
import { api } from "@/lib/api";
import { loadBdtRate, useCurrency } from "@/lib/currency";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "ss_sidebar_collapsed";

// 0 → "0.00", whole → grouped ("1,500"), fraction → 2 decimals (mirrors Topbar)
const fmtBalance = (v: number) => {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "0.00";
  if (Number.isInteger(r)) return r.toLocaleString("en-US");
  return r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

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

// Desktop-only app sidebar (lg:+). Hidden below lg — mobile keeps Topbar +
// the home tab bar. Sheet pages (/file/:id) keep Topbar on all sizes, so the
// Layout never mounts this there.
export default function Sidebar() {
  const { user } = useAuth();
  const { theme, toggle } = useTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const showToast = useToast();
  const [currency, setCurrency] = useCurrency();
  const [balance, setBalance] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  // Same 60s sessionStorage-cached wallet read as Topbar (only one of them is
  // mounted at a time on desktop home, so no double fetch in practice).
  useEffect(() => {
    let cancelled = false;
    const last = Number(sessionStorage.getItem("ss_wallet_ts") || 0);
    if (Date.now() - last < 60000) return;
    api.getWallet().then((w) => { if (!cancelled) { setBalance(w.balance); sessionStorage.setItem("ss_wallet_ts", String(Date.now())); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [location.pathname]);

  if (!user) return null;

  const tab = tabForPath(location.pathname);
  const toggleCollapse = () => {
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
  const logout = () => {
    api
      .logout()
      .then(() => { localStorage.removeItem("ss_had_session"); localStorage.removeItem("ss_auth_user"); sessionStorage.removeItem("ss_wallet_ts"); window.location.href = "/login"; })
      .catch(() => showToast("Could not log out. Try again."));
  };

  const displayName = ((user.firstName ?? "") + " " + (user.lastName ?? "")).trim() || "Account";
  const balanceUsd = balance ?? 0;
  const balanceText = currency === "USD" ? fmtBalance(balanceUsd) : fmtBalance(balanceUsd * loadBdtRate());
  const adminItems = NAV_ADMIN.filter((i) => !i.adminOnly || user.isAdmin);
  const CollapseIcon = collapsed ? ChevronsRight : ChevronsLeft;

  return (
    <aside className={cn("hidden shrink-0 flex-col border-r border-border bg-background lg:flex", collapsed ? "w-16" : "w-60")}>
      <div className={cn("flex items-center gap-2 border-b border-border px-3 py-3", collapsed && "flex-col px-0")}>
        <button type="button" onClick={() => navigate("/")} title="Sheet Submit — home" aria-label="Sheet Submit — home" className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-muted">
          <img src="/logo.svg" className="size-5" alt="" aria-hidden="true" />
        </button>
        {!collapsed && (
          <button type="button" onClick={() => navigate("/")} className="min-w-0 flex-1 truncate text-left text-sm font-semibold tracking-tight">
            Sheet Submit
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <CollapseIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      <nav aria-label="Primary" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {NAV_MAIN.map((item) => (
          <NavButton key={item.key} active={tab === item.key} collapsed={collapsed} label={item.label} onClick={() => navigate(item.to)}>
            {item.icon}
          </NavButton>
        ))}
        {adminItems.length > 0 && (
          <>
            {!collapsed && (
              <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Admin</p>
            )}
            {collapsed && <div className="mx-2 my-2 border-t border-border" aria-hidden="true" />}
            {adminItems.map((item) => (
              <NavButton key={item.key} active={tab === item.key} collapsed={collapsed} label={item.label} onClick={() => navigate(item.to)}>
                {item.icon}
              </NavButton>
            ))}
          </>
        )}
      </nav>

      <div className={cn("flex flex-col gap-1 border-t border-border p-2", collapsed && "items-center")}>
        {!collapsed && (
          <button
            type="button"
            onClick={() => setCurrency(currency === "USD" ? "BDT" : "USD")}
            title={currency === "USD" ? "Show BDT" : "Show USDC"}
            className="flex items-center justify-between rounded-md px-3 py-2 text-xs font-bold hover:bg-muted"
          >
            <span>{balanceText}</span>
            <span className="text-muted-foreground">{currency === "USD" ? "USDC" : "BDT"}</span>
          </button>
        )}
        <div className={cn("flex items-center gap-1", collapsed ? "flex-col" : "flex-row")}>
          <ThemeTogglerButton theme={theme} onToggle={toggle} />
          {!collapsed && (
            <span className="flex min-w-0 flex-1 items-center gap-2 px-1">
              <Avatar className="size-7 shrink-0">
                {user.photoUrl ? <AvatarImage src={user.photoUrl} alt="" /> : null}
                <AvatarFallback>{displayName.slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">{displayName}</span>
            </span>
          )}
          <button
            type="button"
            onClick={logout}
            aria-label="Log out"
            title="Log out"
            className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
          >
            <LogOutIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
