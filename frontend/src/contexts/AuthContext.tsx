import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "@/lib/api";
import type { User } from "@/lib/types";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const CACHE_KEY = "ss_auth_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const retryRef = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const u = await api.me();
        if (!active) return;
        setUser(u);
        if (u) {
          localStorage.setItem(CACHE_KEY, JSON.stringify(u));
        } else {
          localStorage.removeItem(CACHE_KEY);
        }
        setLoading(false);
      } catch {
        // Transient failure (redeploy / network blip). Keep the app usable with the
        // last known user and retry a couple of times; a definitive /auth/me (200 +
        // null) still logs out correctly.
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

  return <AuthContext.Provider value={{ user, loading }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
