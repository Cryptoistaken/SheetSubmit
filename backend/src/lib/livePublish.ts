import { rpc } from "./do";
import { LIVE_KEY_CAP, groupLiveStates, poolRoom, type LiveRowState } from "./live";
import { publishLive, publishRoom, type LiveStates } from "./liveBus";

// DB → rooms bridge: after a mutation, resolve fresh per-file key states and
// fan them out. Fail-open by design — a live push must never break the
// mutation it follows.
function emitGrouped(map: Record<string, LiveStates> | null | undefined): number {
  let n = 0;
  for (const [fileId, states] of Object.entries(map || {})) {
    if (!fileId || !states || !Object.keys(states).length) continue;
    publishLive(fileId, states);
    n++;
  }
  return n;
}

/** Fresh states for one download's keys (hold / approve / reject / revert / fresh hold). */
export async function publishDownloadStates(password: string, downloadId: string): Promise<number> {
  if (!downloadId) return 0;
  try {
    const map = (await rpc("pools", password, "liveStatesByDownload", { id: downloadId })) as Record<string, LiveStates>;
    return emitGrouped(map);
  } catch {
    return 0;
  }
}

/** Fresh states for bare keys across passwords (markDead, worker relay). */
export async function publishKeyStates(keys: string[]): Promise<number> {
  const clean = [...new Set(keys.filter((k) => typeof k === "string" && !!k))].slice(0, LIVE_KEY_CAP);
  if (!clean.length) return 0;
  try {
    const rows = (await rpc("pools", "global", "liveStatesByKeys", { keys: clean })) as (LiveRowState & { password?: string })[];
    return emitGrouped(groupLiveStates(rows || []));
  } catch {
    return 0;
  }
}

export interface PoolCountRow { password: string; pool: string; available: number; claimed: number; users: number; invalid: number }
export interface PoolBadge { id: string; available: number }
export interface PoolCountsMessage extends PoolCountRow {
  type: "pool-counts";
  verified?: number;
  unverified?: number;
  totalAvailable?: number;
  pools: PoolBadge[];
}

async function buildPoolMessage(r: PoolCountRow, rows: PoolCountRow[]): Promise<PoolCountsMessage> {
  const msg: PoolCountsMessage = {
    type: "pool-counts", ...r,
    pools: rows.filter((x) => x.password === r.password).map((x) => ({ id: x.pool, available: x.available })),
  };
  if (r.pool === "page") {
    const vc = (await rpc("pools", r.password, "verifiedCounts", { pool: "page" }).catch(() => null)) as any;
    if (vc) {
      msg.verified = Number(vc.verified) || 0;
      msg.unverified = Number(vc.unverified) || 0;
      msg.totalAvailable = Number(vc.totalAvailable) || 0;
    }
  }
  return msg;
}

/** One pool's current counts snapshot — same shape the rooms receive, so the
 * 15s poll fallback heals worker-side drift (wa/page sweeps only touch
 * data.check_status, which moves the page verified split but no counters). */
export async function poolCountsSnapshot(password: string, pool: string): Promise<PoolCountsMessage | null> {
  try {
    const all = (await rpc("pools", "global", "summaryAll", {})) as any[];
    const rows: PoolCountRow[] = (Array.isArray(all) ? all : [])
      .map((r) => ({
        password: String(r.password), pool: String(r.pool),
        available: Number(r.available) || 0, claimed: Number(r.claimed) || 0,
        users: Number(r.users) || 0, invalid: Number(r.invalid) || 0,
      }));
    const r = rows.find((x) => x.password === password && x.pool === pool);
    if (!r) return null;
    return await buildPoolMessage(r, rows);
  } catch {
    return null;
  }
}

/** Fresh counts for pool rooms in scope (both filters optional): each
 * message carries its own counts plus same-password summaryAll rows so tab
 * badges update with zero extra fetch, plus the verified split for the page
 * pool. Counts only — no PII, row keys, or holdings. Fail-open. */
export async function publishPoolCounts(password?: string, pool?: string): Promise<number> {
  try {
    const all = (await rpc("pools", "global", "summaryAll", {})) as any[];
    const rows: PoolCountRow[] = (Array.isArray(all) ? all : [])
      .filter((r) => (!password || r.password === password) && (!pool || r.pool === pool))
      .map((r) => ({
        password: String(r.password), pool: String(r.pool),
        available: Number(r.available) || 0, claimed: Number(r.claimed) || 0,
        users: Number(r.users) || 0, invalid: Number(r.invalid) || 0,
      }));
    if (!rows.length) return 0;
    let n = 0;
    for (const r of rows) {
      publishRoom(poolRoom(r.password, r.pool), await buildPoolMessage(r, rows));
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}
