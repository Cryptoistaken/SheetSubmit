import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  sessionExpired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CACHE_KEY = "ss_auth_user";
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

    // No cookie has ever been issued to this browser → skip the /me call.
    if (localStorage.getItem(HAD_SESSION) !== "1") {
      setLoading(false);
      return () => {
        active = false;
      };
    }

    const load = async () => {
      try {
        const { user: u, expired } = await api.me();
        if (!active) return;
        if (expired) {
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
            if (active && parsed?.id) setUser(parsed);
          } catch {
            localStorage.removeItem(CACHE_KEY);
          }
        }
        if (active && retryRef.current < 3) {
          retryRef.current++;
          timer = setTimeout(load, 1500 * retryRef.current);
          return;
        }
        if (active) setUser(null);
        setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Preload the avatar the instant its URL is known so the browser fires
  // that request before first paint instead of after the topbar mounts.
  useEffect(() => {
    if (!user?.photoUrl) return;
    if (document.querySelector(`link[rel="preload"][href="${user.photoUrl}"]`)) return;
    const link = document.createElement("link");
    link.rel = "preload";
    link.as = "image";
    link.href = user.photoUrl;
    link.setAttribute("fetchpriority", "high");
    document.head.appendChild(link);
  }, [user?.photoUrl]);

  return (
    <AuthContext.Provider value={{ user, loading, sessionExpired }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
