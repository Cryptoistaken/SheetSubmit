import { Download, LogOutIcon, MessageCircle, Palette, RefreshCw } from "lucide-react";
import { WorkspaceIcon, FileTypeIcon, VerifiedIcon } from "@/components/icons/FileTypeIcons";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import SheetToolbar from "@/components/sheet/SheetToolbar";
import { useAuth } from "@/contexts/AuthContext";
import { useModalA11y } from "@/hooks/useModalA11y";
import { api, useConnStore } from "@/lib/api";
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

  const [conn, setConn] = useState<ConnState>({ cls: "", text: "Connecting..." });
  const [renameOpen, setRenameOpen] = useState(false);
  const [photoBusted, setPhotoBusted] = useState(false);
  const [photoLoaded, setPhotoLoaded] = useState(false);
  const [renameName, setRenameName] = useState("");
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

  if (!user) return null;

  const ringColor = conn.cls === "ok" ? "var(--green)" : conn.cls === "err" ? "var(--red)" : "var(--text3)";
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
      showToast("Could not rename file. Try again.");
      return;
    }
    useSheetStore.setState((s) => (s.file ? { file: { ...s.file, name } } : {}));
    closeRename();
  };

  const logout = () => {
    api
      .logout()
      .then(() => { window.location.href = "/login"; })
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
        <span style={{ position: "relative", display: "inline-flex", flexShrink: 0, ...hideHome }}>
        <DropdownMenu>
        <DropdownMenuTrigger asChild>
        <button className={`profile-btn${photoLoaded ? " loaded" : ""}`} title="User menu" aria-label={displayName ? `User menu for ${displayName}` : "User menu"}>
          <span className="profile-currency" aria-label="Balance 0">
            <span>0</span>
            <WorkspaceIcon size={14} />
          </span>
          <span className="profile-pill-divider"></span>
          <span className={`avatar-ring${photoLoaded ? " show" : ""}${conn.cls === "ok" && photoLoaded ? " pulse" : ""}`} style={{ background: ringColor, color: ringColor }}>
             <Avatar className="size-full border-0 after:hidden">
                {!photoBusted && user.photoUrl ? <AvatarImage src={user.photoUrl} alt="" fetchPriority="high" loading="eager" decoding="async" onLoad={() => setPhotoLoaded(true)} onError={() => setPhotoBusted(true)} /> : null}
                <AvatarFallback className="bg-transparent text-inherit">{(displayName || "?").slice(0, 1).toUpperCase()}</AvatarFallback>
              </Avatar>
          </span>
        </button>
        </DropdownMenuTrigger>
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
                  showToast("Floating bubble off");
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
