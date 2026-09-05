import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
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

function safeNext(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export default function LoginScreen({ notice, next }: { notice?: string; next?: string }) {
  const [label, setLabel] = useState("Connecting…");
  const [href, setHref] = useState<string | null>(null);
  const [fallbackHref, setFallbackHref] = useState<string | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [showRecheck, setShowRecheck] = useState(false);
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
        if (!info.username) { setLabel("Bot unavailable — try again later"); return; }
        const did = getOrCreateDid();
        didRef.current = did;
        setHref("tg://resolve?domain=" + info.username + "&start=login_" + did);
        setFallbackHref("https://t.me/" + info.username + "?start=login_" + did);
        setLabel("Open Telegram");
      })
      .catch(() => { if (!stop) setLabel("Connection failed — try again"); });
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
        window.location.href = safeNext(next);
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
  }, [href, next]);

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
        if (res.ok) { claimedDoneRef.current = true; stop = true; localStorage.setItem(HAD_SESSION, "1"); setWaiting(true); window.location.href = safeNext(next); return; }
        if (attempts >= MAX_ATTEMPTS) { stop = true; if (iv) clearInterval(iv); setChecking(false); setShowRecheck(true); }
      }).catch(() => { if (stop) return; if (attempts >= MAX_ATTEMPTS) { stop = true; if (iv) clearInterval(iv); setChecking(false); setShowRecheck(true); } });
    };
    const first = setTimeout(() => { if (stop) return; iv = setInterval(tick, POLL_MS); tick(); }, INITIAL_DELAY_MS);
    return () => { stop = true; clearTimeout(first); if (iv) clearInterval(iv); };
  }, [href, turnstileToken, next]);

  const recheck = () => { localStorage.removeItem("ss_login_did"); window.location.reload(); };

  return (
    <main id="loginScreen" aria-labelledby="login-title">
      <div className="login-wrap">
        <div className="login-card">
          <h1 id="login-title" className="sr-only">Login to Sheet Submit</h1>
          {notice && <p role="alert" aria-live="assertive" className="login-hint" style={{ color: "var(--red)", marginBottom: 12 }}>{notice}</p>}
          {showRecheck ? (
            <button className="tg-auth-button" onClick={recheck} type="button">
              <span className="tg-auth-icon" aria-hidden="true" />
              <span>Recheck login</span>
            </button>
          ) : (
            <>
              <div ref={turnstileBoxRef} role="group" aria-label="Human verification" style={{ marginBottom: 12, display: turnstileToken ? "none" : undefined }} />
              <a
                className={`tg-auth-button${href && turnstileToken ? "" : " is-loading"}`}
                href={href && turnstileToken ? href : undefined}
                aria-disabled={!href || !turnstileToken ? "true" : undefined}
                aria-busy={checking ? "true" : undefined}
                aria-label={label}
                tabIndex={!href || !turnstileToken ? 0 : undefined}
                onClick={(e) => {
                  if (!href || !turnstileToken) { e.preventDefault(); return; }
                  setShowFallback(true);
                }}
              >
                <span className="tg-auth-icon" aria-hidden="true" />
                <span>Sign In with Telegram</span>
              </a>
            </>
          )}
          {showFallback && href && fallbackHref && !waiting && !showRecheck && (
            <a className="login-fallback" href={fallbackHref} target="_blank" rel="noopener noreferrer">
              Can't open? Open in browser
            </a>
          )}
          {waiting && <p role="status" aria-live="polite" className="login-hint">Logged in — opening your workspace…</p>}
          {showRecheck && <p className="login-hint">No login detected yet. Tap "Recheck login" when you've finished in Telegram.</p>}
        </div>
      </div>
    </main>
  );
}
