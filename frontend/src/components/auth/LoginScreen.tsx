import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import { getInitialTheme } from "@/lib/theme";

// Per-browser login id. Piggybacks on the app's device-login flow (the bot
// completes the session in-chat and stores device:<did> → sessionId), so the
// web page picks up the session by polling instead of copy-pasting a URL.
function getOrCreateDid(): string {
  const KEY = "ss_login_did";
  const existing = localStorage.getItem(KEY);
  if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
  const did = crypto.randomUUID().replace(/-/g, "");
  localStorage.setItem(KEY, did);
  return did;
}

const did = getOrCreateDid();

export default function LoginScreen() {
  const [label, setLabel] = useState("Connecting...");
  const [href, setHref] = useState<string | null>(null);
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [dark] = useState(() => getInitialTheme() === "dark");

  useEffect(() => {
    api
      .botInfo()
      .then((info) => {
        if (info.username) {
          const tme = "https://t.me/" + info.username + "?start=login_" + did;
          setHref("tg://resolve?domain=" + info.username + "&start=login_" + did);
          setFallbackHref(tme);
          setLabel("Open Telegram");
        } else {
          setLabel("Bot not available");
        }
      })
      .catch(() => setLabel("Connection failed"));
  }, []);

  // Poll the claim endpoint until the bot has completed the login in Telegram,
  // then reload — the /auth/me call on mount picks up the new session cookie.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      if (stop) return;
      try {
        const res = await api.claimDeviceSession(did);
        if (res.ok) {
          setWaiting(true);
          window.location.href = "/";
          return;
        }
      } catch {
        // transient network error — keep polling
      }
      timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div id="loginScreen">
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo">
            <img
              src={dark ? "/logo-light.svg" : "/logo-dark.svg"}
              alt="Sheet Submit"
              style={{ width: 48, height: 48 }}
            />
          </div>
          <h1>
            Login to <span className="login-brand">Sheet Submit</span>
          </h1>
          <a
            className={`login-btn${href ? " ready" : " loading"}`}
            href={href ?? "#"}
            onClick={(e) => {
              if (!href) {
                e.preventDefault();
              } else {
                setShowFallback(true);
              }
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.98 1.26-5.59 3.71-.53.37-1.01.55-1.44.54-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.75 3.99-1.74 6.65-2.89 7.98-3.44 3.8-1.57 4.59-1.85 5.1-1.86.11 0 .37.03.54.17.14.12.18.28.2.47-.01.06.01.24 0 .37z" />
            </svg>
            <span className="btn-label">{label}</span>
          </a>
          {showFallback && href && fallbackHref && !waiting && (
            <a className="login-fallback" href={fallbackHref} target="_blank" rel="noopener noreferrer">
              Can't open? Open in browser
            </a>
          )}
          {waiting && <p className="login-hint">Logged in — opening your workspace…</p>}
        </div>
      </div>
    </div>
  );
}