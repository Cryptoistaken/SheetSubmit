// Pools — auto-classified row pools per password.
// Ponytail ultra: reuse getDedupKey, reuse pipeline, no deps.
import type { Row, StoredFile } from "../lib/shared";
import { getDedupKey } from "./files";
import { getJSON, key, redis } from "./redis";

export type PoolId = "cookies_only" | "cookies_2fa" | "page";
export const POOL_IDS: PoolId[] = ["cookies_only", "cookies_2fa", "page"];
export const DEFAULT_PASSWORD = "dgddigital";
export const L0VE_PASSWORD = "L0VE@12345";

export const POOL_META: Record<PoolId, { id: PoolId; label: string; badge: string; cols: string[]; filename: string; rule: string }> = {
  cookies_only: { id: "cookies_only", label: "Cookies", badge: "Cookies", cols: ["cookies"], filename: "cookies_pool.xlsx", rule: "cookies valid, 2FA empty" },
  cookies_2fa: { id: "cookies_2fa", label: "2FA", badge: "2FA", cols: ["cookies", "twofakey"], filename: "2fa_pool.xlsx", rule: "cookies + 2FA key" },
  page: { id: "page", label: "Page", badge: "Page", cols: ["cookies", "twofakey"], filename: "page_pool.xlsx", rule: 'cookies + 2FA + wa_status === "eligible"' },
};

export function getPoolMeta() {
  return POOL_META;
}

function pwdOf(file: StoredFile): string | null {
  if (!file.password || !String(file.password).trim()) return null;
  return String(file.password);
}
function dedupOf(file: StoredFile, row: Row): string | null {
  return getDedupKey((file.type as string) || "fb_cookie", row);
}
function poolKeys(password: string, poolId: PoolId) {
  return {
    available: key(`pool:${password}:${poolId}:available`),
    claimed: key(`pool:${password}:${poolId}:claimed`),
    dedup: key(`pool:${password}:${poolId}:dedup`),
    ledger: key(`pool:${password}:${poolId}:ledger`),
    users: key(`pool:${password}:${poolId}:users`),
    takenPool: key(`taken:pool:${password}:${poolId}`),
  };
}
function takenGlobalKey(password: string) { return key(`taken:global:${password}`); }
export function poolMetaKey() { return key("pool:meta"); }

function isInvalidRow(row: Row): boolean {
  if (!row || typeof row !== "object") return true;
  const cookies = String((row as Record<string, unknown>).cookies ?? "").trim();
  const uid = String((row as Record<string, unknown>).uid ?? "").trim();
  const status = String((row as Record<string, unknown>).status ?? "").trim().toLowerCase();
  if (!cookies) return true;
  if (!/c_user=\d+/.test(cookies)) return true;
  if (!uid) return true;
  if (status === "bad" || status === "dead") return true;
  // empty row (all values whitespace)
  if (!Object.values(row).some(v => String(v ?? "").trim())) return true;
  return false;
}

export function classifyRow(row: Row, wa_status?: string | null): PoolId | null {
  if (!row || typeof row !== "object") return null;
  const cookies = String((row as Record<string, unknown>).cookies ?? "").trim();
  const twoRaw = (row as Record<string, unknown>).twofakey ?? (row as Record<string, unknown>)["twofakey"] ?? (row as Record<string, unknown>)["2fa key"] ?? "";
  const twofakey = String(twoRaw).trim();
  const uid = String((row as Record<string, unknown>).uid ?? "").trim();
  const status = String((row as Record<string, unknown>).status ?? "").trim().toLowerCase();
  const wa = wa_status !== undefined ? wa_status : ((row as Record<string, unknown>).wa_status as string ?? (row as Record<string, unknown>).waStatus as string ?? null);
  if (!cookies) return null;
  if (!/c_user=\d+/.test(cookies)) return null;
  if (!uid) return null;
  if (status === "bad" || status === "dead") return null;
  const has2fa = !!twofakey;
  const eligible = wa === "eligible";
  if (!has2fa) {
    if (eligible) return null; // page without 2FA ineligible
    return "cookies_only";
  }
  if (eligible) return "page";
  return "cookies_2fa";
}

export interface PoolCounts { added: number; skippedDuplicate: number; skippedInvalid: number; skippedIneligible: number; skippedTaken: number; skippedFiltered: number; }

async function isTaken(password: string, dedupKey: string): Promise<boolean> {
  try { return (await redis.sismember(takenGlobalKey(password), dedupKey)) === 1; } catch { // fallback via smembers
    try { const m = await redis.smembers(takenGlobalKey(password)); return m.includes(dedupKey); } catch { return false; }
  }
}
async function isDup(password: string, poolId: PoolId, dedupKey: string): Promise<boolean> {
  const k = poolKeys(password, poolId).dedup;
  try { return (await (redis as unknown as { sismember: (k:string,m:string)=>Promise<number> }).sismember(k, dedupKey)) === 1; } catch {
    try { const m = await redis.smembers(k); return m.includes(dedupKey); } catch { return false; }
  }
}

async function findCurrentPool(password: string, dedupKey: string): Promise<PoolId | null> {
  for (const pid of POOL_IDS) {
    if (await isDup(password, pid, dedupKey)) return pid;
  }
  return null;
}

async function removeFromPool(password: string, poolId: PoolId, dedupKey: string, fileId: string): Promise<void> {
  const ks = poolKeys(password, poolId);
  // remove from dedup set
  try { await redis.srem(ks.dedup, dedupKey); } catch {}
  try { await redis.srem(ks.takenPool, dedupKey); } catch {}
  // remove from available list — need exact entry string
  try {
    const list = await redis.lrange(ks.available, 0, -1);
    for (const entry of list) {
      try {
        const o = JSON.parse(entry);
        if (o.dedupKey === dedupKey && (!fileId || o.srcFileId === fileId)) {
          // try lrem if available
          const r = redis as unknown as { lrem: (k:string,c:number,v:string)=>Promise<number> };
          if (r.lrem) await r.lrem(ks.available, 0, entry);
          else {
            // fallback: rebuild list without this entry
            const filtered = list.filter(e => e !== entry);
            const p = redis.pipeline(); p.del(ks.available); filtered.forEach(e=>p.rpush(ks.available, e)); await p.exec();
          }
          break;
        }
      } catch {}
    }
  } catch {}
  // users hash decr — best-effort hincrby
  try {
    const h = redis as unknown as { hincrby: (k:string,f:string,v:number)=>Promise<number> };
    // find user for this entry to decr? We don't have userId here, skip precise. Use pipeline to scan users?
    // minimal: just decr generic if needed; caller handles userId via add path.
    void h;
  } catch {}
  // ledger
  try { await redis.rpush(ks.ledger, JSON.stringify({ action: "remove", dedupKey, poolId, fileId, at: Date.now() })); } catch {}
}

export async function addRowsToPools(file: StoredFile, rows: Row[], userId: string): Promise<PoolCounts> {
  const c: PoolCounts = { added: 0, skippedDuplicate: 0, skippedInvalid: 0, skippedIneligible: 0, skippedTaken: 0, skippedFiltered: 0 };
  const password = pwdOf(file);
  if (!password) { c.skippedFiltered = rows.length; return c; }
  const enabled = file.poolEnabled !== false;
  if (!enabled) { c.skippedFiltered = rows.length; return c; }
  const toAdd: { poolId: PoolId; entry: string; dedupKey: string }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const dk = dedupOf(file, row);
    if (isInvalidRow(row) || !dk) { c.skippedInvalid++; continue; }
    if (await isTaken(password, dk)) { c.skippedTaken++; continue; }
    const wa = (row as Record<string, unknown>).wa_status as string ?? (row as Record<string, unknown>).waStatus as string ?? null;
    const pid = classifyRow(row, wa);
    if (!pid) { c.skippedIneligible++; continue; }
    if (await isDup(password, pid, dk)) { c.skippedDuplicate++; continue; }
    const entry = JSON.stringify({ dedupKey: dk, uid: (row as Record<string, unknown>).uid, cookies: (row as Record<string, unknown>).cookies, twofakey: (row as Record<string, unknown>).twofakey ?? (row as Record<string, unknown>)["twofakey"] ?? "", wa_status: wa, password, srcUserId: userId, srcFileId: file.id, srcRowIdx: i, addedAt: Date.now() });
    toAdd.push({ poolId: pid, entry, dedupKey: dk });
    c.added++;
  }
  if (!toAdd.length) return c;
  const p2 = redis.pipeline();
  for (const a of toAdd) {
    const ks = poolKeys(password, a.poolId);
    p2.rpush(ks.available, a.entry);
    p2.sadd(ks.dedup, a.dedupKey);
    p2.rpush(ks.ledger, JSON.stringify({ action: "add", dedupKey: a.dedupKey, poolId: a.poolId, fileId: file.id, userId, at: Date.now() }));
  }
  // users hash per pool+user
  for (const a of toAdd) {
    const ks = poolKeys(password, a.poolId);
    // hincrby if available else hset
    try { (p2 as unknown as { hincrby: (k:string,f:string,v:number)=>unknown }).hincrby(ks.users, userId, 1); } catch { p2.sadd(ks.users, userId); }
  }
  try { await p2.exec(); } catch {}
  // if hincrby not supported, fallback to simple set
  return c;
}

export async function removeRowFromPools(file: StoredFile, row: Row, _userId: string): Promise<boolean> {
  const dk = dedupOf(file, row);
  if (!dk) return false;
  const password = pwdOf(file);
  if (!password) return false;
  const cur = await findCurrentPool(password, dk);
  if (!cur) return false;
  await removeFromPool(password, cur, dk, file.id);
  return true;
}

export async function promoteRow(file: StoredFile, row: Row, userId: string, rowIdx: number): Promise<PoolId | null> {
  const dk = dedupOf(file, row);
  const password = pwdOf(file);
  if (!dk || !password) return null;
  if (await isTaken(password, dk)) {
    // ensure removed from available
    const cur = await findCurrentPool(password, dk);
    if (cur) await removeFromPool(password, cur, dk, file.id);
    return null;
  }
  if (isInvalidRow(row)) {
    const cur = await findCurrentPool(password, dk);
    if (cur) await removeFromPool(password, cur, dk, file.id);
    return null;
  }
  const wa = (row as Record<string, unknown>).wa_status as string ?? null;
  const next = classifyRow(row, wa);
  const cur = await findCurrentPool(password, dk);
  if (cur === next) return cur;
  if (next && await isDup(password, next, dk)) return cur;
  if (cur) await removeFromPool(password, cur, dk, file.id);
  if (!next) return null;
  const entry = JSON.stringify({ dedupKey: dk, uid: (row as Record<string, unknown>).uid, cookies: (row as Record<string, unknown>).cookies, twofakey: (row as Record<string, unknown>).twofakey ?? "", wa_status: wa, password, srcUserId: userId, srcFileId: file.id, srcRowIdx: rowIdx, addedAt: Date.now() });
  const ks = poolKeys(password, next);
  const p = redis.pipeline();
  p.rpush(ks.available, entry);
  p.sadd(ks.dedup, dk);
  p.rpush(ks.ledger, JSON.stringify({ action: "promote", dedupKey: dk, from: cur, to: next, fileId: file.id, userId, at: Date.now() }));
  try { (p as unknown as { hincrby: (k:string,f:string,v:number)=>unknown }).hincrby(ks.users, userId, 1); } catch {}
  try { await p.exec(); } catch {}
  return next;
}

export async function removeFileRowsFromPools(file: StoredFile, userId: string): Promise<number> {
  const rows = (await getJSON<Row[]>(`rows:${file.id}`)) || [];
  let removed = 0;
  const password = pwdOf(file);
  if (!password) return 0;
  for (let i = 0; i < rows.length; i++) {
    const dk = dedupOf(file, rows[i] as Row);
    if (!dk) continue;
    // if already taken globally, keep blocked (do not resurrect)
    if (await isTaken(password, dk)) continue;
    const cur = await findCurrentPool(password, dk);
    if (cur) { await removeFromPool(password, cur, dk, file.id); removed++; }
  }
  // also handle passed userId for users hash decr fallback not needed
  void userId;
  return removed;
}

export async function handleFileSave(file: StoredFile, rows: Row[], userId: string): Promise<PoolCounts | null> {
  const password = pwdOf(file);
  if (!password) {
    return { added: 0, skippedDuplicate: 0, skippedInvalid: 0, skippedIneligible: 0, skippedTaken: 0, skippedFiltered: rows.length };
  }
  const enabled = file.poolEnabled !== false;
  const c: PoolCounts = { added: 0, skippedDuplicate: 0, skippedInvalid: 0, skippedIneligible: 0, skippedTaken: 0, skippedFiltered: 0 };
  if (!enabled) {
    // remove all available rows of this file
    await removeFileRowsFromPools(file, userId);
    c.skippedFiltered = rows.length;
    return c;
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Row;
    const dk = dedupOf(file, row);
    if (!dk || isInvalidRow(row)) {
      if (dk) {
        const cur = await findCurrentPool(password, dk);
        if (cur) await removeFromPool(password, cur, dk, file.id);
      }
      c.skippedInvalid++;
      continue;
    }
    if (await isTaken(password, dk)) {
      const cur = await findCurrentPool(password, dk);
      if (cur) await removeFromPool(password, cur, dk, file.id);
      c.skippedTaken++;
      continue;
    }
    const wa = (row as Record<string, unknown>).wa_status as string ?? null;
    const next = classifyRow(row, wa);
    if (!next) {
      const cur = await findCurrentPool(password, dk);
      if (cur) await removeFromPool(password, cur, dk, file.id);
      c.skippedIneligible++;
      continue;
    }
    const cur = await findCurrentPool(password, dk);
    if (cur === next) continue; // already correct
    if (cur) await removeFromPool(password, cur, dk, file.id);
    if (await isDup(password, next, dk)) { c.skippedDuplicate++; continue; }
    const entry = JSON.stringify({ dedupKey: dk, uid: (row as Record<string, unknown>).uid, cookies: (row as Record<string, unknown>).cookies, twofakey: (row as Record<string, unknown>).twofakey ?? "", wa_status: wa, password, srcUserId: userId, srcFileId: file.id, srcRowIdx: i, addedAt: Date.now() });
    const ks = poolKeys(password, next);
    const p = redis.pipeline();
    p.rpush(ks.available, entry);
    p.sadd(ks.dedup, dk);
    p.rpush(ks.ledger, JSON.stringify({ action: "add", dedupKey: dk, poolId: next, fileId: file.id, userId, at: Date.now() }));
    try { (p as unknown as { hincrby: (k:string,f:string,v:number)=>unknown }).hincrby(ks.users, userId, 1); } catch {}
    try { await p.exec(); } catch {}
    c.added++;
  }
  return c;
}

export async function backfillExistingFiles(): Promise<{ filesScanned: number; filesUpdated: number; pooled: PoolCounts }> {
  // disabled per spec: old files without password are never pooled (no auto-assign by name)
  // kept as manual utility only if explicitly called; currently returns no-op
  const total: PoolCounts = { added: 0, skippedDuplicate: 0, skippedInvalid: 0, skippedIneligible: 0, skippedTaken: 0, skippedFiltered: 0 };
  return { filesScanned: 0, filesUpdated: 0, pooled: total };
}
