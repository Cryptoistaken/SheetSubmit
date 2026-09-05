import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { getInitialTheme } from "@/lib/theme";
import { wsCall, wsConnect, wsOn } from "@/lib/ws";

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
  const claimedDoneRef = useRef(false);

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

  // WS fast-path — anonymous ticket, watch for claimed push
  useEffect(() => {
    if (!href) return;
    void wsConnect();
    const offClaimed = wsOn("claimed", () => {
      if (claimedDoneRef.current) return;
      api.claimDeviceSession(didRef.current ?? "", turnstileTokenRef.current).then((res) => {
        if (!res.ok) return;
        if (claimedDoneRef.current) return;
        claimedDoneRef.current = true;
        localStorage.setItem(HAD_SESSION, "1");
        setWaiting(true);
        window.location.href = "/";
      }).catch(() => {});
    });
    const offHealth = wsOn("health", () => {
      const did = didRef.current;
      if (did) wsCall("claim.watch", { did }).catch(() => {});
    });
    const t = setTimeout(() => {
      const did = didRef.current;
      if (did) wsCall("claim.watch", { did }).catch(() => {});
    }, 1000);
    return () => { offClaimed(); offHealth(); clearTimeout(t); };
  }, [href]);

  // Claim polling
  useEffect(() => {
    if (!href || !turnstileToken) return;
    let stop = false;
    let iv: ReturnType<typeof setInterval> | null = null;
    let attempts = 0;
    const tick = () => {
      if (stop || claimedDoneRef.current) return;
      if (!document.hasFocus()) return;
      setChecking(true);
      attempts++;
      api.claimDeviceSession(didRef.current ?? "", turnstileTokenRef.current).then((res) => {
        if (stop || claimedDoneRef.current) return;
        if (res.ok) { claimedDoneRef.current = true; stop = true; localStorage.setItem(HAD_SESSION, "1"); setWaiting(true); window.location.href = "/"; return; }
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
              <div ref={turnstileBoxRef} style={{ marginBottom: 12, display: turnstileToken ? "none" : undefined }} />
              <a
                className={`login-btn${href && turnstileToken ? " ready" : " loading"}${checking ? " checking" : ""}`}
                href={href && turnstileToken ? href : "#"}
                onClick={(e) => {
                  if (!href || !turnstileToken) { e.preventDefault(); return; }
                  setShowFallback(true);
                }}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 256 256" aria-hidden="true"><title>telegram</title><defs><linearGradient id="SVG6DaOZcwt" x1="50%" x2="50%" y1="0%" y2="100%"><stop offset="0%" stopColor="#2aabee"/><stop offset="100%" stopColor="#229ed9"/></linearGradient></defs><path fill="url(#SVG6DaOZcwt)" d="M128 0C94.06 0 61.48 13.494 37.5 37.49A128.04 128.04 0 0 0 0 128c0 33.934 13.5 66.514 37.5 90.51C61.48 242.506 94.06 256 128 256s66.52-13.494 90.5-37.49c24-23.996 37.5-56.576 37.5-90.51s-13.5-66.514-37.5-90.51C194.52 13.494 161.94 0 128 0"/><path fill="#fff" d="M57.94 126.648q55.98-24.385 74.64-32.152c35.56-14.786 42.94-17.354 47.76-17.441c1.06-.017 3.42.245 4.96 1.49c1.28 1.05 1.64 2.47 1.82 3.467c.16.996.38 3.266.2 5.038c-1.92 20.24-10.26 69.356-14.5 92.026c-1.78 9.592-5.32 12.808-8.74 13.122c-7.44.684-13.08-4.912-20.28-9.63c-11.26-7.386-17.62-11.982-28.56-19.188c-12.64-8.328-4.44-12.906 2.76-20.386c1.88-1.958 34.64-31.748 35.26-34.45c.08-.338.16-1.598-.6-2.262c-.74-.666-1.84-.438-2.64-.258c-1.14.256-19.12 12.152-54 35.686c-5.1 3.508-9.72 5.218-13.88 5.128c-4.56-.098-13.36-2.584-19.9-4.708c-8-2.606-14.38-3.984-13.82-8.41c.28-2.304 3.46-4.662 9.52-7.072"/></svg>
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
