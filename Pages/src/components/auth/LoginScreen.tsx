import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";

declare global {
  interface Window {
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
  const claimedDoneRef = useRef(false);

  const [tgClientId, setTgClientId] = useState<string | null>(null);
  const [tgReady, setTgReady] = useState(false);
  const [tgLoading, setTgLoading] = useState(false);
  const [tgError, setTgError] = useState<string | null>(null);

  const isAndroidApp = typeof window.Android?.startTelegramLogin === "function";

  // Bubble mini window (?bubble=1) shares the app's session cookie but may have
  // loaded while logged out — poll /me so logging in via the main app carries
  // this window in automatically instead of stranding it on the login widget.
  const isBubbleNext = (() => {
    try {
      return new URLSearchParams(String(next ?? "").split("?")[1] ?? "").get("bubble") === "1";
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (isAndroidApp || !isBubbleNext || claimedDoneRef.current) return;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api.me();
        if (!stop && r.user && !r.loginRequired && !r.expired) {
          claimedDoneRef.current = true;
          localStorage.setItem(HAD_SESSION, "1");
          try { localStorage.setItem("ss_tg_done", String(Date.now())); } catch {}
          setWaiting(true);
          window.location.href = safeNext(next);
        }
      } catch {
        // transient — the main-app login lands the shared cookie shortly
      }
    };
    void poll();
    const t = window.setInterval(() => { void poll(); }, 2500);
    return () => { stop = true; window.clearInterval(t); };
  }, [isAndroidApp, isBubbleNext, next]);

  useEffect(() => {
    let stop = false;
    api.telegramConfig().then((r) => { if (!stop && r.clientId) setTgClientId(r.clientId); }).catch(() => {});
    return () => { stop = true; };
  }, []);

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

  async function completeLogin(idToken: string) {
    const res = await api.verifyTelegramLogin(idToken);
    if (!res.ok) throw new Error("Verification failed. Please try again.");
    claimedDoneRef.current = true;
    localStorage.setItem(HAD_SESSION, "1");
    try { localStorage.setItem("ss_tg_done", String(Date.now())); } catch {}
    if (window.opener) { try { window.close(); } catch {} }
    setWaiting(true);
    window.location.href = safeNext(next);
  }

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
    if (window.Android?.isTelegramLoginAvailable?.()) {
      window.Android.startTelegramLogin?.();
      return;
    }
    if (!tgClientId) return;
    setTgError(null);
    setTgLoading(true);
    try {
      const TG = window.Telegram?.Login;
      if (!TG) throw new Error("Telegram login is not ready. Please try again.");
      const finish = async (data: any) => {
        if (data?.error) throw new Error(String(data.error));
        const idToken = data?.id_token;
        if (typeof idToken !== "string" || !idToken) throw new Error("Login is temporarily unavailable. Please try again later.");
        await completeLogin(idToken);
      };
      const options = { client_id: Number(tgClientId), scope: ["profile", "phone", "write"] };
      if (!Number.isSafeInteger(options.client_id) || options.client_id <= 0) throw new Error("Login is temporarily unavailable. Please try again later.");
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error("Telegram login timed out.")), 120000);
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
    : tgReady && !tgLoading && !waiting;

  return (
    <main id="loginScreen" aria-labelledby="login-title">
      <div className="login-wrap">
        <div className="login-card">
          <h1 id="login-title" className="sr-only">Log in to SheetSubmit</h1>
          {notice && <p role="alert" aria-live="assertive" className="login-hint" style={{ color: "var(--red)", marginBottom: 12 }}>{notice}</p>}
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
          {isBubbleNext && !waiting && <p role="status" aria-live="polite" className="login-hint">Already logged in the app? This window will continue automatically…</p>}
          {waiting && <p role="status" aria-live="polite" className="login-hint">Logged in. Opening your workspace…</p>}
        </div>
      </div>
    </main>
  );
}
