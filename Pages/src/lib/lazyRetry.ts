import { lazy } from "react";
import type { ComponentType } from "react";

// Stale chunk after a fresh deploy (old tab imports a hashed asset the new
// deploy deleted) — reload once to fetch the fresh index.html instead of
// crashing to "Unexpected Application Error!".
// ponytail: ComponentType<any> — retry wrapper is prop-agnostic by design
export function lazyRetry(fn: () => Promise<{ default: ComponentType<any> }>) {
  return lazy(async () => {
    try {
      return await fn();
    } catch {
      // 10s window = infinite-reload-loop guard; past it, self-heal again
      // (long-open tabs survive many deploys and need repeated recovery).
      const last = Number(sessionStorage.getItem("ss_chunk_reload") ?? 0);
      if (Date.now() - last > 10000) {
        sessionStorage.setItem("ss_chunk_reload", String(Date.now()));
        window.location.reload();
      }
      throw new Error("Chunk failed — reloaded");
    }
  });
}
