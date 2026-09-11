import { useEffect, useRef } from "react";
import { api, apiBase } from "@/lib/api";
import { createPoolLiveClient, type PoolLivePatch } from "@/lib/poolLive";

// Live pool counts for the open pool, keyed on (password, pool). Ticket
// stream first, 15s polling fallback when the stream cannot connect.
// Pushes patch badges/totals/verified/users in place — never a full
// load(). Closes on unmount/pool-switch (same discipline as useLiveRows).
export function usePoolLive(password: string, pool: string, enabled: boolean, onPatch: (patch: PoolLivePatch) => void): void {
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  useEffect(() => {
    if (!enabled || !password || !pool) return;
    const pwd = password;
    const id = pool;
    const client = createPoolLiveClient({
      base: apiBase(),
      password: pwd,
      pool: id,
      getTicket: () => api.requestPoolLiveTicket(pwd, id).then((r) => r.ticket),
      onPatch: (patch) => patchRef.current(patch),
      pollState: async () => {
        try {
          return await api.getPoolLiveState(pwd, id);
        } catch {
          return null;
        }
      },
    });
    return () => client.close();
  }, [password, pool, enabled]);
}
