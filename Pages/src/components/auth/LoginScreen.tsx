import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { getInitialTheme } from "@/lib/theme";

const TURNSTILE_SITE_KEY = "0x4AAAAAAEmGwKWEZqnHmgYU";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id: string) => void };
  }
}

function getOrCreateDid(): string {
  const KEY = "ss_login_did";
  const existing = localStorage.getItem(KEY);
  if (existing && /^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
  const did = crypto.randomUUID().replace(/-/g, "");
  localStorage.setItem(KEY, did);
  return did;
}

const HAD_SESSION = "ss_had_session";
const INITIAL_DELAY_MS = 10000;
const POLL_MS = 1000;
const MAX_ATTEMPTS = 60;

export default function LoginScreen({ notice }: { notice?: string }) {
  const [label, setLabel] = useState("Connecting...");
  const [href, setHref] = useState<string | null>(null);
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showRecheck, setShowRecheck] = useState(false);
  const [dark] = useState(() => getInitialTheme() === "dark");
  const didRef = useRef<string | null>(null);
  const [turnstileReady, setTurnstileReady] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const turnstileRef = useRef<string | null>(null);
  const turnstileBoxRef = useRef<HTMLDivElement>(null);

  // Load Turnstile script and render widget
  useEffect(() => {
    if (window.turnstile) { setTurnstileReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => setTurnstileReady(true);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  useEffect(() => {
    if (!turnstileReady || !turnstileBoxRef.current || turnstileRef.current) return;
    turnstileRef.current = window.turnstile!.render(turnstileBoxRef.current, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => { turnstileTokenRef.current = token; setTurnstileToken(token); },
      "error-callback": () => setTurnstileToken(null),
    });
  }, [turnstileReady]);

  // Fetch bot info
  useEffect(() => {
    let stop = false;
    api
      .botInfo()
      .then((info) => {
        if (stop) return;
        if (!info.username) { setLabel("Bot not available"); return; }
        const did = getOrCreateDid();
        didRef.current = did;
        setHref("tg://resolve?domain=" + info.username + "&start=login_" + did);
        setFallbackHref("https://t.me/" + info.username + "?start=login_" + did);
        setLabel("Open Telegram");
      })
      .catch(() => { if (!stop) setLabel("Connection failed"); });
    return () => { stop = true; };
  }, []);

  // Claim polling
  useEffect(() => {
    if (!href || !turnstileToken) return;
    let stop = false;
    let iv: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;
    const tick = () => {
      if (stop) return;
      if (!document.hasFocus()) return;
      setChecking(true);
      attempts++;
      api.claimDeviceSession(didRef.current ?? "", turnstileTokenRef.current).then((res) => {
        if (stop) return;
        if (res.ok) { stop = true; localStorage.setItem(HAD_SESSION, "1"); setWaiting(true); window.location.href = "/"; return; }
        if (attempts >= MAX_ATTEMPTS) { stop = true; if (iv) clearInterval(iv); setChecking(false); setShowRecheck(true); }
      }).catch(() => { if (stop) return; if (attempts >= MAX_ATTEMPTS) { stop = true; if (iv) clearInterval(iv); setChecking(false); setShowRecheck(true); } });
    };
    const first = setTimeout(() => { if (stop) return; iv = setInterval(tick, POLL_MS); tick(); }, INITIAL_DELAY_MS);
    return () => { stop = true; clearTimeout(first); if (iv) clearInterval(iv); };
  }, [href, turnstileToken]);

  const recheck = () => { localStorage.removeItem("ss_login_did"); window.location.href = "/"; };

  return (
    <div id="loginScreen">
      <div className="login-wrap">
        <div className="login-card">
          <div className="login-logo">
            <img src={dark ? "/logo-light.svg" : "/logo-dark.svg"} alt="Sheet Submit" style={{ width: 48, height: 48 }} />
          </div>
          <h1>Login to <span className="login-brand">Sheet Submit</span></h1>
          {notice && <p className="login-hint" style={{ color: "#ef4444", marginBottom: 12 }}>{notice}</p>}
          {showRecheck ? (
            <button className="login-btn ready" onClick={recheck} type="button">
              <span className="btn-label">Recheck login</span>
            </button>
          ) : (
            <>
              <div ref={turnstileBoxRef} style={{ marginBottom: 12 }} />
              <a
                className={`login-btn${href && turnstileToken ? " ready" : " loading"}${checking ? " checking" : ""}`}
                href={href && turnstileToken ? href : "#"}
                onClick={(e) => {
                  if (!href || !turnstileToken) { e.preventDefault(); return; }
                  setShowFallback(true);
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.12.03-1.98 1.26-5.59 3.71-.53.37-1.01.55-1.44.54-.47-.01-1.38-.27-2.06-.49-.83-.27-1.49-.42-1.43-.88.03-.24.37-.49 1.02-.75 3.99-1.74 6.65-2.89 7.98-3.44 3.8-1.57 4.59-1.85 5.1-1.86.11 0 .37.03.54.17.14.12.18.28.2.47-.01.06.01.24 0 .37z" />
                </svg>
                <span className="btn-label">{label}</span>
              </a>
            </>
          )}
          {showFallback && href && fallbackHref && !waiting && !showRecheck && (
            <a className="login-fallback" href={fallbackHref} target="_blank" rel="noopener noreferrer">
              Can't open? Open in browser
            </a>
          )}
          {waiting && <p className="login-hint">Logged in — opening your workspace…</p>}
          {showRecheck && <p className="login-hint">No login detected yet. Tap "Recheck login" when you've finished in Telegram.</p>}
        </div>
      </div>
    </div>
  );
}
