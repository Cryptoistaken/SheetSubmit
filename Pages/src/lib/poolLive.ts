import type { PoolUser } from "./api";
import { createLiveClient, type LiveClient, type LiveSource, type LiveTimer } from "./live";

// Pool live counts: the backend pushes counts-only payloads
// ({password, pool, available, claimed, users, invalid} + page
// {verified, unverified, totalAvailable} + compact pools[] for badges).
// This module validates a raw push into a patch — unknown fields are
// ignored forward-compatibly, corrupt counts are dropped (the caller
// keeps its previous value), and an explicit password/pool mismatch
// means the push is for another pool (stale after a pool switch).
export interface PoolLiveBadge {
  id: string;
  available: number;
}

export interface PoolLiveTotals {
  available?: number;
  claimed?: number;
  users?: number;
  invalid?: number;
}

export interface PoolLiveVerified {
  verified: number;
  unverified: number;
  totalAvailable: number;
}

export interface PoolLivePatch {
  totals: PoolLiveTotals | null;
  usersList: PoolUser[] | null;
  verified: PoolLiveVerified | null;
  badges: PoolLiveBadge[] | null;
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

function usersList(v: unknown): PoolUser[] | null {
  if (!Array.isArray(v)) return null;
  const out: PoolUser[] = [];
  for (const u of v) {
    if (!u || typeof u !== "object" || Array.isArray(u)) continue;
    const r = u as Record<string, unknown>;
    if (typeof r.userId !== "string" || !r.userId) continue;
    out.push({ ...(r as object), userId: r.userId, available: count(r.available) ?? 0, claimed: count(r.claimed) ?? 0 } as PoolUser);
  }
  return out;
}

function badges(v: unknown): PoolLiveBadge[] | null {
  if (!Array.isArray(v)) return null;
  const out: PoolLiveBadge[] = [];
  for (const b of v) {
    if (!b || typeof b !== "object" || Array.isArray(b)) continue;
    const r = b as Record<string, unknown>;
    const available = count(r.available);
    if (typeof r.id !== "string" || !r.id || available == null) continue;
    out.push({ id: r.id, available });
  }
  return out.length ? out : null;
}

export function parsePoolLiveEvent(curPwd: string, curPool: string, msg: unknown): PoolLivePatch | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (m.password !== undefined && m.password !== curPwd) return null;
  if (m.pool !== undefined && m.pool !== curPool) return null;

  const totals: PoolLiveTotals = {};
  const available = count(m.available);
  const claimed = count(m.claimed);
  const invalid = count(m.invalid);
  if (available != null) totals.available = available;
  if (claimed != null) totals.claimed = claimed;
  if (invalid != null) totals.invalid = invalid;
  const users = Array.isArray(m.users) ? null : count(m.users);
  if (users != null) totals.users = users;
  const hasTotals = Object.keys(totals).length > 0;

  const list = usersList(m.users ?? m.usersList);
  const verifiedCount = count(m.verified);
  const unverifiedCount = count(m.unverified);
  const verified =
    verifiedCount != null && unverifiedCount != null
      ? { verified: verifiedCount, unverified: unverifiedCount, totalAvailable: count(m.totalAvailable) ?? verifiedCount + unverifiedCount }
      : null;
  const badgeList = badges(m.pools);

  if (!hasTotals && !list && !verified && !badgeList) return null;
  return { totals: hasTotals ? totals : null, usersList: list, verified, badges: badgeList };
}

export interface PoolLiveClientOpts {
  base: string;
  password: string;
  pool: string;
  getTicket: () => Promise<string>;
  onPatch: (patch: PoolLivePatch) => void;
  pollState?: () => Promise<unknown | null>;
  createSource?: (url: string) => LiveSource;
  schedule?: (fn: () => void, ms: number) => LiveTimer;
  maxFailures?: number;
}

// Thin wrapper over createLiveClient: same ticket stream + ghost-fix +
// backoff + 15s poll fallback, but the stream URL is per password+pool
// and both stream and poll raw payloads flow through parsePoolLiveEvent.
export function createPoolLiveClient(opts: PoolLiveClientOpts): LiveClient {
  const { base, password, pool, getTicket, onPatch } = opts;
  return createLiveClient({
    base,
    fileId: `${password}/${pool}`,
    buildUrl: (ticket: string) =>
      `${base}/api/pools/${encodeURIComponent(password)}/${encodeURIComponent(pool)}/live?ticket=${encodeURIComponent(ticket)}`,
    getTicket,
    onEvent: (msg: unknown) => {
      const patch = parsePoolLiveEvent(password, pool, msg);
      if (patch) onPatch(patch);
    },
    pollEvent: opts.pollState,
    createSource: opts.createSource,
    schedule: opts.schedule,
    maxFailures: opts.maxFailures,
  });
}
