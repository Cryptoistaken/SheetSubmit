import type { Env } from "./shared";

/** Shared worker health probe (M8): one target builder + error mapping for the
 *  public route and the agent proxy. */
export async function fetchWorkerHealth(env: Env): Promise<{ ok: true; worker: unknown } | { ok: false; error: string; status: 502 | 503 }> {
  const base = env.WORKER_URL;
  if (!base) return { ok: false, error: "WORKER_URL not set", status: 503 };
  const target = /^https?:\/\//i.test(base) ? `${base.replace(/\/+$/, "")}/health` : `http://${base}${base.includes(":") ? "" : ":3000"}/health`;
  try {
    const r = await fetch(target, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, error: `worker responded ${r.status}`, status: 502 };
    return { ok: true, worker: await r.json() };
  } catch (e) { return { ok: false, error: String((e as Error)?.message || e), status: 502 }; }
}
