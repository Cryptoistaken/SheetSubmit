import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { wsCall, wsConnect, wsOn } from "@/lib/ws";

const TURNSTILE_SITE_KEY = "0x4AAAAAAEmGwKWEZqnHmgYU";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id: string) => void };
    Telegram?: { Login?: { init?: (opts: Record<string, unknown>, cb: (data: unknown) => void) => void; open?: (cb?: (data: unknown) => void) => void; auth?: (opts: Record<string, unknown>, cb: (data: unknown) => void) => void } };
    Android?: { isTelegramLoginAvailable?: () => boolean; startTelegramLogin?: () => void };
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

  const [tgClientId, setTgClientId] = useState<string | null>(null);
  const [tgReady, setTgReady] = useState(false);
  const [tgLoading, setTgLoading] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);
  const [showLegacy, setShowLegacy] = useState(false);

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

  useEffect(() => {
    let stop = false;
    api.telegramConfig().then((r) => { if (!stop && r.clientId) setTgClientId(r.clientId); }).catch(() => {});
    return () => { stop = true; };
  }, []);

  useEffect(() => {
    if (!tgClientId) return;
    if (window.Telegram?.Login) { setTgReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://oauth.telegram.org/js/telegram-login.js";
    s.async = true;
    s.onload = () => setTgReady(true);
    s.onerror = () => setTgReady(false);
    document.head.appendChild(s);
    return () => { s.remove(); };
  }, [tgClientId]);

  async function handleTelegramLogin() {
    if (!tgClientId || claimedDoneRef.current) return;
    if (!turnstileTokenRef.current) { setTgError("Complete human verification first"); return; }
    setTgError(null);
    setTgLoading(true);
    if (window.Android?.isTelegramLoginAvailable?.()) {
      window.Android.startTelegramLogin?.();
      return;
    }
    try {
      const TG = window.Telegram?.Login;
      if (!TG) throw new Error("Telegram Login not ready");
      const finish = async (data: any) => {
        if (data?.error) throw new Error(String(data.error));
        const idToken = data?.id_token;
        if (typeof idToken !== "string" || !idToken) throw new Error("No id_token returned");
        const res = await api.verifyTelegramLogin(idToken, turnstileTokenRef.current);
        if (!res.ok) throw new Error("verification failed");
        claimedDoneRef.current = true;
        localStorage.setItem(HAD_SESSION, "1");
        setWaiting(true);
        window.location.href = safeNext(next);
      };
      const options = { client_id: Number(tgClientId), scope: ["openid", "profile"] };
      if (!Number.isSafeInteger(options.client_id) || options.client_id <= 0) throw new Error("Invalid Telegram client ID");
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Telegram login timed out")), 120000);
        const callback = (data: unknown) => { clearTimeout(timer); finish(data).then(resolve).catch(reject); };
        try {
          if (TG.auth) TG.auth(options, callback);
          else { TG.init?.(options, callback); TG.open?.(callback); }
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    } catch (e: unknown) {
      setTgError(e instanceof Error ? e.message : String(e));
      setTgLoading(false);
    }
  }

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

  const showOfficial = !!tgClientId && !showLegacy;

  return (
    <main id="loginScreen" aria-labelledby="login-title">
      <div className="login-wrap">
        <div className="login-card">
          <h1 id="login-title" className="sr-only">Login to Sheet Submit</h1>
          {notice && <p role="alert" aria-live="assertive" className="login-hint" style={{ color: "var(--red)", marginBottom: 12 }}>{notice}</p>}
          <div ref={turnstileBoxRef} role="group" aria-label="Human verification" style={{ marginBottom: 12, display: turnstileToken ? "none" : undefined }} />
          {showOfficial ? (
            <>
              <button
                className={`tg-auth-button${tgReady && turnstileToken && !tgLoading ? "" : " is-loading"}`}
                onClick={handleTelegramLogin}
                disabled={!tgReady || !turnstileToken || tgLoading}
                aria-busy={tgLoading ? "true" : undefined}
                type="button"
              >
                <span className="tg-auth-icon" aria-hidden="true" />
                <span>{tgLoading ? "Verifying…" : "Continue with Telegram"}</span>
              </button>
              {tgError && <p role="alert" className="login-hint" style={{ color: "var(--red)", marginTop: 8 }}>{tgError}</p>}
              <button className="login-legacy-link" onClick={() => setShowLegacy(true)} type="button">
                Try legacy
              </button>
            </>
          ) : (
            <>
              {showRecheck ? (
                <button className="tg-auth-button" onClick={recheck} type="button">
                  <span className="tg-auth-icon" aria-hidden="true" />
                  <span>Recheck login</span>
                </button>
              ) : (
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
                  <span>Sign In with Telegram (Bot)</span>
                </a>
              )}
              {tgClientId && (
                <button className="login-legacy-link" onClick={() => setShowLegacy(false)} type="button">
                  Back
                </button>
              )}
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
