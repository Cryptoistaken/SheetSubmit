import type { Env } from "./shared";
import { getWorkerStats } from "../worker/runner";

/** In-process worker health (merged): same shape the remote probe returned. */
export async function fetchWorkerHealth(
  _env: Env,
): Promise<{ ok: true; worker: unknown } | { ok: false; error: string; status: 502 | 503 }> {
  return { ok: true, worker: getWorkerStats() };
}
