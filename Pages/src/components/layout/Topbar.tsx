import { Download, LogOutIcon, MessageCircle, Palette, RefreshCw } from "lucide-react";
import { FileTypeIcon, VerifiedIcon } from "@/components/icons/FileTypeIcons";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import SheetToolbar from "@/components/sheet/SheetToolbar";
import { useAuth } from "@/contexts/AuthContext";
import { useModalA11y } from "@/hooks/useModalA11y";
import { api, useConnStore } from "@/lib/api";
import { loadBdtRate, useCurrency } from "@/lib/currency";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { useBubbleStore } from "@/stores/bubbleStore";
import { useSheetStore } from "@/stores/sheetStore";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ThemeTogglerButton } from "@/components/ui/theme-toggler";

interface AndroidBridge {
  isBubbleEnabled?: () => boolean;
  disableBubble?: () => void;
  checkForUpdates?: () => void;
  openSupport?: () => void;
}

function getAndroid(): AndroidBridge | null {
  try {
    return (window as unknown as { Android?: AndroidBridge }).Android ?? null;
  } catch {
    return null;
  }
}

export function BdtIcon() {
  return (
    <span className="currency-dot" aria-hidden="true">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>currency-bdt</title><path fill="currentColor" d="M18.09 10.5V9h-8.5V4.5A1.5 1.5 0 0 0 8.09 3a1.5 1.5 0 0 0-1.5 1.5A1.5 1.5 0 0 0 8.09 6v3h-3v1.5h3v6.2c0 2.36 1.91 4.27 4.25 4.3c2.34-.04 4.2-1.96 4.16-4.3c0-1.59-.75-3.09-2-4.08a4 4 0 0 0-.7-.47c-.22-.1-.46-.15-.7-.15c-.71 0-1.36.39-1.71 1c-.19.3-.29.65-.29 1c.01 1.1.9 2 2.01 2c.62 0 1.2-.31 1.58-.8c.21.47.31.98.31 1.5c.04 1.5-1.14 2.75-2.66 2.8c-1.53 0-2.76-1.27-2.75-2.8v-6.2z" /></svg>
    </span>
  );
}

// 0 → "0.00" (matches empty state), whole → grouped ("1,500"), fraction → 2 decimals ("1,500.50")
const fmtBalance = (v: number) => {
  const r = Math.round(v * 100) / 100;
  if (r === 0) return "0.00";
  if (Number.isInteger(r)) return r.toLocaleString("en-US");
  return r.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

interface ConnState {
  cls: "ok" | "err" | "";
  text: string;
}

export default function Topbar() {
  const { user } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const file = useSheetStore((s) => s.file);
  const unsynced = useSheetStore((s) => (s.isDirty || s.dirtyStructural ? s.changeJournal.length + (s.dirtyStructural ? 1 : 0) : 0));

  const [conn, setConn] = useState<ConnState>({ cls: "", text: "Connecting..." });
  const [renameOpen, setRenameOpen] = useState(false);
  const [photoBusted, setPhotoBusted] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [currency, setCurrency] = useCurrency();
  const renameRef = useModalA11y(renameOpen && !!file, () => setRenameOpen(false));
  const [isAndroid, setIsAndroid] = useState(() => !!getAndroid());
  const bubbleOn = useBubbleStore((s) => s.on);
  const showToast = useToast();

  // The Android bridge can register after first paint (old bubble.js re-checked
  // on window load) — re-sync so Android-only gear rows appear if it arrives late.
  useEffect(() => {
    const sync = () => {
      if (getAndroid()) {
        setIsAndroid(true);
        useBubbleStore.getState().setOn(!!getAndroid()?.isBubbleEnabled?.());
      }
    };
    sync();
    window.addEventListener("load", sync);
    return () => window.removeEventListener("load", sync);
  }, []);

  const isFilePage =
    location.pathname.startsWith("/file/") ||
    /\/admin\/user\/[^/]+\/file\/[^/]+/.test(location.pathname);
  const hideHome = isFilePage ? { display: "none" as const } : undefined;

  const connStatus = useConnStore((s) => s.status);
  useEffect(() => {
    if (connStatus === "ok") setConn({ cls: "ok", text: "Connected" });
    else if (connStatus === "err") setConn({ cls: "err", text: "Disconnected" });
    else setConn({ cls: "", text: "Connecting..." });
  }, [connStatus]);

  // Reset the broken-photo flag when the photo changes.
  useEffect(() => {
    setPhotoBusted(false);
    setPhotoLoaded(false);
  }, [user?.photoUrl]);

  useEffect(() => {
    let cancelled = false;
    const last = Number(sessionStorage.getItem("ss_wallet_ts") || 0);
    if (Date.now() - last < 60000) return;
    api.getWallet().then((w) => { if (!cancelled) { setBalance(w.balance); sessionStorage.setItem("ss_wallet_ts", String(Date.now())); } }).catch(() => {});
    return () => { cancelled = true; };
  }, [location.pathname]);

  if (!user) return null;

  const ringColor = conn.cls === "ok" ? "var(--green)" : conn.cls === "err" ? "var(--red)" : "var(--text3)";
  const balanceUsd = balance ?? 0;
  const balanceText = currency === "USD" ? fmtBalance(balanceUsd) : fmtBalance(balanceUsd * loadBdtRate());
  const toggleCurrency = () => setCurrency(currency === "USD" ? "BDT" : "USD");
  const displayName = ((user.firstName ?? "") + " " + (user.lastName ?? "")).trim();
  const fileName = file
    ? file.name.length > 10
      ? file.name.substring(0, 10) + "..."
      : file.name
    : "";

  const openRename = () => {
    if (!file) return;
    setRenameName(file.name);
    setRenameOpen(true);
  };

  const closeRename = () => setRenameOpen(false);

  const commitRename = async () => {
    const name = renameName.trim();
    if (!name || !file) return;
    const st = useSheetStore.getState();
    try {
      if (st.adminMode) await api.adminUpdateFile(file.id, { name });
      else await api.updateFile(file.id, { name });
    } catch {
      showToast("Couldn't rename");
      return;
    }
    useSheetStore.setState((s) => (s.file ? { file: { ...s.file, name } } : {}));
    closeRename();
  };

  const logout = () => {
    api
      .logout()
      .then(() => { localStorage.removeItem("ss_had_session"); localStorage.removeItem("ss_auth_user"); sessionStorage.removeItem("ss_wallet_ts"); window.location.href = "/login"; })
      .catch(() => showToast("Could not log out. Try again."));
  };

  return (
    <div className="topbar">
      <div className="topbar-l">
        <img
          src="/logo.svg"
          className="topbar-logo"
          alt="Logo"
          style={hideHome}
        />
        <span className="home-top-title" style={hideHome}>
          Sheet Submit
        </span>
        <button
          title="Back"
          aria-label="Back"
          className={`back-btn${isFilePage ? " visible" : ""}`}
          onClick={() => {
            const st = useSheetStore.getState();
            navigate(
              st.adminMode && st.adminOwnerId
                ? `/admin/user/${st.adminOwnerId}`
                : "/",
            );
          }}
        >
          <span className="back-btn-chevron">{"\u2039"}</span>
        </button>
        <button
          className={"sheet-title-btn" + (isFilePage ? " visible" : "")}
          title={file ? file.name : "Rename file"}
          onClick={openRename}
        >
          {file ? <FileTypeIcon file={file} size={14} /> : null}
          {fileName}
        </button>
      </div>
      <div className="topbar-r">
        {isFilePage && <SheetToolbar />}
        {!isFilePage && <ThemeTogglerButton theme={theme} onToggle={toggle} />}
        {isFilePage && unsynced > 0 ? (
          <span className="sync-dot" title={`${unsynced} unsynced change${unsynced === 1 ? "" : "s"} - syncs automatically`} aria-label={`${unsynced} unsynced changes`}>●{unsynced}</span>
        ) : null}
        <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, ...hideHome }}>
        <DropdownMenu>
        <div className={`profile-btn split${photoLoaded ? " loaded" : ""}`} role="group" aria-label="Account">
        <button type="button" className="pill-balance" onClick={toggleCurrency} title={currency === "USD" ? "Show BDT" : "Show USDC"} aria-label={currency === "USD" ? `Balance ${balanceText} USDC - show BDT` : `Balance ${balanceText} BDT - show USDC`}>
          <span className="profile-currency" aria-hidden="true">
            <span>{balanceText}</span>
            {currency === "USD" ? <img src="/usdc.svg" alt="" width={14} height={14} /> : <BdtIcon />}
          </span>
        </button>
          <span className="profile-pill-divider" aria-hidden="true"></span>
        <DropdownMenuTrigger asChild>
        <button type="button" className="pill-avatar" title="User menu" aria-label={displayName ? `User menu for ${displayName}` : "User menu"}>
          <span className={`avatar-ring${photoLoaded ? " show" : ""}${conn.cls === "ok" && photoLoaded ? " pulse" : ""}`} style={{ background: ringColor, color: ringColor }}>
              <Avatar className="size-full border-0 after:hidden">
                 {!photoBusted && user.photoUrl ? <AvatarImage src={user.photoUrl} alt="" fetchPriority="high" loading="eager" decoding="async" onLoad={() => setPhotoLoaded(true)} onError={() => setPhotoBusted(true)} /> : null}
                 <AvatarFallback className="bg-transparent text-inherit">{(displayName || "?").slice(0, 1).toUpperCase()}</AvatarFallback>
               </Avatar>
          </span>
        </button>
        </DropdownMenuTrigger>
        </div>
        {user.isAdmin ? (
          <span title="Verified" style={{ position: "absolute", right: 0, bottom: 0, width: 14, height: 14, display: "grid", placeItems: "center", color: "#1d9bf0", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))", pointerEvents: "none" }}>
            <VerifiedIcon size={14} />
          </span>
        ) : null}
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="flex items-center gap-3 py-2">
            <Avatar className="size-9"><AvatarImage src={user.photoUrl ?? undefined} alt="" /><AvatarFallback>{(displayName || "?").slice(0, 1).toUpperCase()}</AvatarFallback></Avatar>
            <span className="min-w-0"><span className="block truncate font-semibold">{displayName || "Account"}</span><span className="block truncate text-xs text-muted-foreground">{user.username ? `@${user.username}` : user.phone || ""}</span></span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {isAndroid ? (
            <>
              <DropdownMenuItem onSelect={() => {
                if (!bubbleOn) {
                  useBubbleStore.setState({ pickMode: true });
                  navigate("/");
                } else {
                  try { getAndroid()?.disableBubble?.(); } catch {}
                  useBubbleStore.getState().setOn(false);
                }
              }}>
                <span>{bubbleOn ? "Turn floating bubble off" : "Turn floating bubble on"}</span>
              </DropdownMenuItem>
              <DropdownMenuGroup>
                <DropdownMenuItem onSelect={() => navigate("/bubble-design")}><Palette /> Bubble design</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { try { getAndroid()?.checkForUpdates?.(); } catch {} }}><RefreshCw /> Check for updates</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => { try { getAndroid()?.openSupport?.(); } catch {} }}><MessageCircle /> Report an issue</DropdownMenuItem>
              </DropdownMenuGroup>
            </>
          ) : (
            <DropdownMenuItem onSelect={() => window.open("https://github.com/Cryptoistaken/SheetSubmit/releases/latest/download/SheetSubmit.apk", "_blank", "noopener,noreferrer")}><Download /> Download app</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={logout}><LogOutIcon /> Log out</DropdownMenuItem>
        </DropdownMenuContent>
        </DropdownMenu>
        </span>
      </div>

      {isFilePage && renameOpen && file && (
        <div
          className="modal-overlay open"
          role="dialog"
          aria-modal="true"
          aria-label="Rename file"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRename();
          }}
        >
          <div ref={renameRef} className="modal-box">
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
                  void commitRename();
                } else if (e.key === "Escape") {
                  closeRename();
                }
              }}
            />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={closeRename}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={() => void commitRename()}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
