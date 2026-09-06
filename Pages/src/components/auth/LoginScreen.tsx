import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";

const TURNSTILE_SITE_KEY = "0x4AAAAAAEmGwKWEZqnHmgYU";

declare global {
  interface Window {
    turnstile?: { render: (el: HTMLElement, opts: Record<string, unknown>) => string; reset: (id: string) => void };
    Telegram?: { Login?: { init?: (opts: Record<string, unknown>, cb: (data: unknown) => void) => void; open?: (cb?: (data: unknown) => void) => void; auth?: (opts: Record<string, unknown>, cb: (data: unknown) => void) => void } };
    Android?: { isTelegramLoginAvailable?: () => boolean; startTelegramLogin?: () => void };
  }
}

const HAD_SESSION = "ss_had_session";

function safeNext(raw: unknown): string {
  return typeof raw === "string" && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
}

export default function LoginScreen({ notice, next }: { notice?: string; next?: string }) {
  const [waiting, setWaiting] = useState(false);
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

  const isAndroidApp = typeof window.Android?.startTelegramLogin === "function";

  // Web only: human verification widget
  useEffect(() => {
    if (isAndroidApp) return;
    if (window.turnstile) { setTurnstileReady(true); return; }
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => setTurnstileReady(true);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, [isAndroidApp]);

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

  // Web only: official Telegram Login widget library
  useEffect(() => {
    if (isAndroidApp || !tgClientId) return;
    if (window.Telegram?.Login) { setTgReady(true); return; }
    const s = document.createElement("script");
    s.src = "https://oauth.telegram.org/js/telegram-login.js";
    s.async = true;
    s.onload = () => setTgReady(true);
    s.onerror = () => setTgReady(false);
    document.head.appendChild(s);
    return () => { s.remove(); };
  }, [isAndroidApp, tgClientId]);

  // Shared landing for both legs (popup message + redirect hash):
  // verify id_token server-side, ping any opener, then land.
  async function completeLogin(idToken: string) {
    const res = await api.verifyTelegramLogin(idToken, turnstileTokenRef.current);
    if (!res.ok) throw new Error("verification failed");
    claimedDoneRef.current = true;
    localStorage.setItem(HAD_SESSION, "1");
    try { localStorage.setItem("ss_tg_done", String(Date.now())); } catch {}
    if (window.opener) { try { window.close(); } catch {} }
    setWaiting(true);
    window.location.href = safeNext(next);
  }

  // Redirect leg: approval finished in the Telegram app and bounced back to
  // /login#tgAuthResult=<base64url JSON {result: id_token}>. The library never
  // reads this hash — without this, mobile logins die as "popup_closed".
  useEffect(() => {
    if (isAndroidApp || claimedDoneRef.current) return;
    const m = window.location.hash.match(/tgAuthResult=([^&]+)/);
    if (!m) return;
    let idToken = "";
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
      idToken = typeof payload === "string" ? payload : String(payload?.result || "");
    } catch { return; }
    if (!idToken) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setTgLoading(true);
    completeLogin(idToken).catch((e: unknown) => {
      setTgError(e instanceof Error ? e.message : String(e));
      setTgLoading(false);
    });
  }, [isAndroidApp, next]);

  // If the popup window completes the login, it pings us — follow it home.
  useEffect(() => {
    if (isAndroidApp) return;
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ss_tg_done" && !claimedDoneRef.current) {
        claimedDoneRef.current = true;
        setWaiting(true);
        window.location.href = safeNext(next);
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [isAndroidApp, next]);

  async function handleTelegramLogin() {
    if (claimedDoneRef.current || waiting) return;
    // Native app: hand off to the Android Telegram SDK bridge
    if (window.Android?.isTelegramLoginAvailable?.()) {
      window.Android.startTelegramLogin?.();
      return;
    }
    if (!tgClientId) return;
    if (!turnstileTokenRef.current) { setTgError("Complete human verification first"); return; }
    setTgError(null);
    setTgLoading(true);
    try {
      const TG = window.Telegram?.Login;
      if (!TG) throw new Error("Telegram Login not ready");
      const finish = async (data: any) => {
        if (data?.error) throw new Error(String(data.error));
        const idToken = data?.id_token;
        if (typeof idToken !== "string" || !idToken) throw new Error("No id_token returned");
        await completeLogin(idToken);
      };
      // The JS SDK implicitly requests the required openid scope; its public
      // scope option only accepts profile, phone, and write.
      const options = { client_id: Number(tgClientId), scope: ["profile", "phone", "write"] };
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

  const officialReady = isAndroidApp
    ? !tgLoading && !waiting
    : tgReady && !!turnstileToken && !tgLoading && !waiting;

  return (
    <main id="loginScreen" aria-labelledby="login-title">
      <div className="login-wrap">
        <div className="login-card">
          <h1 id="login-title" className="sr-only">Login to Sheet Submit</h1>
          {notice && <p role="alert" aria-live="assertive" className="login-hint" style={{ color: "var(--red)", marginBottom: 12 }}>{notice}</p>}
          {!isAndroidApp && <div ref={turnstileBoxRef} role="group" aria-label="Human verification" style={{ marginBottom: 12, display: turnstileToken ? "none" : undefined }} />}
          <button
            className={`tg-login-button${officialReady ? "" : " is-loading"}`}
            onClick={handleTelegramLogin}
            disabled={!officialReady}
            aria-busy={tgLoading ? "true" : undefined}
            type="button"
          >
            <span className="tg-auth-icon" aria-hidden="true" />
            <span>{tgLoading ? "Verifying…" : "Continue with Telegram"}</span>
          </button>
          {tgError && <p role="alert" className="login-hint" style={{ color: "var(--red)", marginTop: 8 }}>{tgError}</p>}
          {waiting && <p role="status" aria-live="polite" className="login-hint">Logged in — opening your workspace…</p>}
        </div>
      </div>
    </main>
  );
}
