import { Download, MessageCircle, Palette, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import SheetToolbar from "@/components/sheet/SheetToolbar";
import { useAuth } from "@/contexts/AuthContext";
import { useModalA11y } from "@/hooks/useModalA11y";
import { api } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { useToast } from "@/lib/toast";
import { useBubbleStore } from "@/stores/bubbleStore";
import { useSheetStore } from "@/stores/sheetStore";

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
  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [renameOpen, setRenameOpen] = useState(false);
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

  // Close gear panel when leaving the home screen.
  useEffect(() => {
    if (isFilePage) setPanelOpen(false);
  }, [isFilePage]);

  // Health polling — 30s interval, 1.5x backoff to 2min, paused while tab hidden.
  useEffect(() => {
    let cancelled = false;
    let interval = 30000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = () => {
      api
        .health()
        .then((h) => {
          interval = 30000;
          if (cancelled) return;
          const ok = h.status === "ok" || h.status === "ready";
          setConn(ok ? { cls: "ok", text: "Connected" } : { cls: "", text: "Reconnecting..." });
        })
        .catch(() => {
          if (cancelled) return;
          setConn({ cls: "err", text: "Disconnected" });
          interval = Math.min(interval * 1.5, 120000);
        });
    };
    const schedule = () => {
      timer = setTimeout(() => {
        if (document.visibilityState !== "hidden") check();
        schedule();
      }, interval);
    };
    check();
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Close gear panel on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        panelRef.current &&
        !panelRef.current.contains(t) &&
        btnRef.current &&
        !btnRef.current.contains(t)
      ) {
        setPanelOpen(false);
      }
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  if (!user) return null;

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
      showToast("Rename failed");
      return;
    }
    useSheetStore.setState((s) => (s.file ? { file: { ...s.file, name } } : {}));
    closeRename();
  };

  const logout = () => {
    api
      .logout()
      .then(() => window.location.reload())
      .catch(() => showToast("Logout failed"));
  };

  return (
    <div className="topbar">
      <div className="topbar-l">
        <img
          src={theme === "dark" ? "/logo-dark.svg" : "/logo-light.svg"}
          className="topbar-logo"
          alt="Logo"
          style={hideHome}
        />
        <span className="home-top-title" style={hideHome}>
          Sheet Submit
        </span>
        <button
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
          {fileName}
        </button>
      </div>
      <div className="topbar-r">
        {isFilePage && <SheetToolbar />}
        <span
          className={`conn-status${conn.cls ? " " + conn.cls : ""}`}
          style={hideHome}
        >
          <span className="conn-status-dot"></span>
          <span>{conn.text}</span>
        </span>
        <button
          ref={btnRef}
          className={`profile-btn${user.photoUrl ? " loaded" : ""}`}
          title="User menu"
          style={hideHome}
          onClick={(e) => {
            e.stopPropagation();
            setPanelOpen((o) => !o);
          }}
        >
          <img className="user-btn-avatar" src={user.photoUrl ?? ""} alt="" />
        </button>
        <div ref={panelRef} className={`gear-settings-panel${panelOpen ? " open" : ""}`}>
          <div className="gear-user-card">
            <img className="gear-user-avatar" src={user.photoUrl ?? ""} alt="" />
            <div className="gear-user-info">
              <div className="gear-user-name">{displayName}</div>
              <div className="gear-user-username">
                {user.username ? "@" + user.username : ""}
              </div>
            </div>
          </div>
          <div className="gear-divider"></div>
          <div className="gear-settings-title">Settings</div>
          <div className="gear-toggle-row">
            <div>
              <div className="gear-toggle-label">Night mode</div>
              <div className="gear-toggle-sub">Dark background theme</div>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                aria-label="Night mode"
                checked={theme === "dark"}
                onChange={toggle}
              />
              <span className="toggle-track"></span>
            </label>
          </div>
          {isAndroid ? (
            <>
              <div className="gear-divider"></div>
              <div className="gear-toggle-row">
                <div>
                  <div className="gear-toggle-label">Floating bubble</div>
                  <div className="gear-toggle-sub">Mini sheet over other apps</div>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    aria-label="Floating bubble"
                    checked={bubbleOn}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setPanelOpen(false);
                        useBubbleStore.setState({ pickMode: true });
                        navigate("/");
                      } else {
                        try {
                          getAndroid()?.disableBubble?.();
                        } catch {
                          // bridge missing
                        }
                        useBubbleStore.getState().setOn(false);
                        showToast("Floating bubble off");
                      }
                    }}
                  />
                  <span className="toggle-track"></span>
                </label>
              </div>
              <div
                className="gear-toggle-row"
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onClick={() => {
                  setPanelOpen(false);
                  navigate("/bubble-design");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPanelOpen(false);
                    navigate("/bubble-design");
                  }
                }}
              >
                <div>
                  <div className="gear-toggle-label">Bubble design</div>
                  <div className="gear-toggle-sub">Icon, color and size</div>
                </div>
                <Palette size={18} />
              </div>
              <div className="gear-divider"></div>
              <div
                className="gear-toggle-row"
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onClick={() => {
                  try {
                    getAndroid()?.checkForUpdates?.();
                  } catch {
                    // bridge missing
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    try {
                      getAndroid()?.checkForUpdates?.();
                    } catch {
                      // bridge missing
                    }
                  }
                }}
              >
                <div>
                  <div className="gear-toggle-label">Check for updates</div>
                  <div className="gear-toggle-sub">Download the latest version</div>
                </div>
                <RefreshCw size={18} />
              </div>
              <div
                className="gear-toggle-row"
                style={{ cursor: "pointer" }}
                role="button"
                tabIndex={0}
                onClick={() => {
                  try {
                    getAndroid()?.openSupport?.();
                  } catch {
                    // bridge missing
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    try {
                      getAndroid()?.openSupport?.();
                    } catch {
                      // bridge missing
                    }
                  }
                }}
              >
                <div>
                  <div className="gear-toggle-label">Report an issue</div>
                  <div className="gear-toggle-sub">Contact us on Telegram</div>
                </div>
                <MessageCircle size={18} />
              </div>
            </>
          ) : null}
          {!isAndroid && (
            <>
              <div className="gear-divider"></div>
              <a
                className="gear-toggle-row"
                style={{ cursor: "pointer", textDecoration: "none" }}
                href="https://github.com/Cryptoistaken/SheetSubmit-testmycode/releases/latest/download/SheetSubmit.apk"
                target="_blank"
                rel="noopener noreferrer"
              >
                <div>
                  <div className="gear-toggle-label">Download app</div>
                  <div className="gear-toggle-sub">Install the latest Android APK</div>
                </div>
                <Download size={18} />
              </a>
            </>
          )}
          <div className="gear-divider"></div>
          <button
            className="btn btn-ghost"
            style={{ width: "100%", justifyContent: "center" }}
            onClick={logout}
          >
            Logout
          </button>
        </div>
      </div>

      {isFilePage && renameOpen && file && (
        <div
          ref={renameRef}
          className="modal-overlay open"
          role="dialog"
          aria-modal="true"
          aria-label="Rename file"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRename();
          }}
        >
          <div className="modal-box">
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
