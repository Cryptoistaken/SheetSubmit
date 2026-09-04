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
          setConn(h.ok ? { cls: "ok", text: "Connected" } : { cls: "", text: "Reconnecting..." });
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
          <svg className="profile-ring" xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" aria-hidden="true" style={{ color: ringColor }}>
            <title>circle-outline</title>
            <path fill="currentColor" d="M12.003 21q-1.866 0-3.51-.708q-1.643-.709-2.859-1.924t-1.925-2.856T3 12.003t.709-3.51Q4.417 6.85 5.63 5.634t2.857-1.925T11.997 3t3.51.709q1.643.708 2.859 1.922t1.925 2.857t.709 3.509t-.708 3.51t-1.924 2.859t-2.856 1.925t-3.509.709M12 20q3.35 0 5.675-2.325T20 12t-2.325-5.675T12 4T6.325 6.325T4 12t2.325 5.675T12 20m0-8"/>
          </svg>
          <span className="profile-currency" aria-label="Balance 0">
            <span>0</span>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 192 192" aria-hidden="true"><path fill="#4285f4" d="M73.5 16.4q2.7 0 5.4 0q5.7 0 11.4.1c4.8 0 9.7 0 14.5 0c3.7 0 7.5 0 11.2 0q2.7 0 5.4 0c2.5 0 5 0 7.5.1l2.2 0c5.4.1 9.4 1.3 13.5 4.9c4.4 5.2 7.6 11 10.8 17q1.8 3.4 3.7 6.7l1.9 3.4c3 5.5 6.2 10.9 9.3 16.2l3.3 5.6l1.6 2.7q1.8 3 3.6 6.1l1.9 3.3l1.8 3c2.8 5.1 3.1 9.8 2.4 15.5c-3.3 8.1-8 15.6-12.4 23.1l-3.7 6.3l-1.9 3.3c-2 3.5-4 6.9-6 10.4l-2 3.5l-3.8 6.7C144.8 172.4 144.8 172.4 137 175c-2.6.1-5.2.2-7.8.2l-2.4 0q-3.9 0-7.8 0l-2.7 0q-7.1 0-14.2 0c-4.9 0-9.8 0-14.6.1c-3.8 0-7.5 0-11.3 0q-2.7 0-5.4 0c-2.5 0-5 0-7.6 0c-.7 0-1.5 0-2.2 0c-5.5-.1-8.6-1.5-13-4.5c-2-2.2-2-2.2-3.5-4.5c-.6-.9-1.2-1.8-1.8-2.7c-2.9-4.7-5.6-9.6-8.3-14.4l-16.7-29.3L13 112l-1.5-2.5l-1.4-2.4l-1.2-2.1c-2.2-4.6-2.7-9.4-1.3-14.4c2.7-6.6 6-12.6 9.7-18.7l3.7-6.3l2-3.3c2-3.4 4-6.9 6-10.3l1-1.7q2.4-4.2 4.8-8.3L40 33l1.7-3l1.7-2.9l1.5-2.6c7.7-9.2 17.4-8.2 28.6-8.1"/><path fill="#1967d2" d="M24 130c7.6-.2 15.2-.4 22.7-.5q3.9-.1 7.7-.2a598 598 0 0 1 11.1-.2l3.5-.1c7.8 0 7.8 0 10.9 2.8c1.6 2.3 2.8 4.7 4.1 7.2l2.4 3.9q1.1 1.9 2.3 3.8l1.2 2.1q1.3 2.2 2.5 4.3q1.9 3.3 3.9 6.6q1.2 2.1 2.5 4.2l1.2 2c1.8 3 3.4 6 5 9.1c-7 .1-14 .2-21 .2q-3.6 0-7.1.1c-3.4 0-6.8.1-10.3.1l-3.2.1c-6.4 0-10.3-.6-15.4-4.5c-2-2.1-2-2.1-3.5-4.5l-1.7-2.7c-3.1-5.1-6.1-10.4-9-15.6l-1.9-3.3c-2.7-4.9-5.4-9.9-7.9-14.9z"/></svg>
          </span>
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
                href="https://github.com/Cryptoistaken/SheetSubmit/releases/latest/download/SheetSubmit.apk"
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
