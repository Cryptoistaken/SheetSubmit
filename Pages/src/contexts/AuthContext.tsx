import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api, normalizeUser } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CACHE_KEY = "ss_auth_user";
// Backend said login is required — never call /me again this page-load (no retry storms ever).
let loginRefused = false;
// Set when a session cookie has ever been issued to this browser; cleared on
// logout/expiry. Lets us skip the /auth/me round-trip entirely for first-time
// visitors (no cookie yet) instead of firing a doomed 401 call on every load.
const HAD_SESSION = "ss_had_session";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionExpired, setSessionExpired] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Refused before, or no cookie has ever been issued → skip the /me call entirely.
    // The Android floating-bubble mini window exposes only the clipboard bridge
    // (no startTelegramLogin) but shares the app's CookieManager session, so any
    // window.Android bridge — or a ?bubble=1 URL — must still attempt /me instead
    // of bouncing straight to /login.
    let isBubble = false;
    try {
      isBubble = new URLSearchParams(window.location.search).get("bubble") === "1";
    } catch {
      // ignore malformed query
    }
    const hasAndroidBridge =
      typeof window !== "undefined" &&
      !!(window as unknown as { Android?: unknown }).Android;
    if (loginRefused || (localStorage.getItem(HAD_SESSION) !== "1" && !window.Android?.startTelegramLogin && !hasAndroidBridge && !isBubble)) {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    const load = async () => {
      try {
        const { user: u, expired, loginRequired } = await api.me();
        if (!active) return;
        if (loginRequired || expired) {
          loginRefused = true;
          localStorage.removeItem(HAD_SESSION);
          localStorage.removeItem(CACHE_KEY);
          setSessionExpired(true);
          setUser(null);
          setLoading(false);
          return;
        }
        setUser(u);
        if (u) {
          localStorage.setItem(CACHE_KEY, JSON.stringify(u));
          try { const { useProfileCache } = await import("@/stores/profileCache"); useProfileCache.getState().setProfiles([u as unknown]); } catch {}
        } else {
          localStorage.removeItem(CACHE_KEY);
        }
        setLoading(false);
      } catch {
        // Transient failure (redeploy / network blip). Keep the app usable with the
        // last known user and retry a couple of times.
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) {
          try {
            const parsed = JSON.parse(cached) as User;
            const cid = (parsed as any)?.id ?? (parsed as any)?.user_id;
            if (active && cid) setUser(normalizeUser(parsed));
          } catch {
            localStorage.removeItem(CACHE_KEY);
          }
        }
        if (active && retryRef.current < 3) {
          retryRef.current++;
          timer = setTimeout(() => { if (active) void load(); }, 1500 * retryRef.current);
          return;
        }
        // outage: stay degraded with cached user instead of forcing a login bounce
        setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, sessionExpired }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
