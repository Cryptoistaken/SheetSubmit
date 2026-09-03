// Pools API — admin only. Ponytail ultra: no new deps, WATCH+MULTI, reuse key/redis/getJSON.
import { Router } from "express";
import * as XLSX from "xlsx";
import { isAdmin, requireAuth, requireAdmin } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { getJSON, key, redis, setJSON } from "../services/redis";
import { BACKEND_PUBLIC_URL } from "../config/env";
import { DEFAULT_PASSWORD, POOL_IDS, POOL_META } from "../services/pools";
import type { Row } from "../lib/shared";

export const poolsRouter = Router();

const SHOW_PASSWORDS = [DEFAULT_PASSWORD, "L0VE@12345"] as const;

function isPoolId(v: string): boolean { return (POOL_IDS as string[]).includes(v); }
function isValidPassword(v: string): boolean { return v.length >= 1 && v.length <= 64 && /^[A-Za-z0-9@._-]+$/.test(v); }
function safeFilename(s: string): string { return s.replace(/["\r\n]/g, "_").slice(0, 120); }

// shared claim logic
async function doClaim(password: string, poolId: string, countRaw: unknown, filterUserId: string | undefined, adminId: string) {
  if (!isValidPassword(password)) throw Object.assign(new Error("invalid password"), { status: 400 });
  const availKey = key(`pool:${password}:${poolId}:available`);
  const claimedKey = key(`pool:${password}:${poolId}:claimed`);
  const dedupKey = key(`pool:${password}:${poolId}:dedup`);
  const takenGlobalKey = key(`taken:global:${password}`);
  const takenPoolKey = key(`taken:pool:${password}:${poolId}`);
  const usersKey = key(`pool:${password}:${poolId}:users`);
  const ledgerKey = key(`pool:${password}:${poolId}:ledger`);

  let target: number;
  if (countRaw === "all" || countRaw === undefined || countRaw === null) target = Infinity;
  else {
    const n = Number(countRaw);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error("invalid count"), { status: 400 });
    target = n;
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    await redis.watch(availKey);
    const rawList = await redis.lrange(availKey, 0, -1);
    let parsed: { raw: string; obj: Record<string, unknown> }[] = [];
    for (const s of rawList) {
      try { parsed.push({ raw: s, obj: JSON.parse(s) as Record<string, unknown> }); } catch { /* skip */ }
    }
    if (filterUserId) parsed = parsed.filter(p => String(p.obj.srcUserId) === filterUserId);
    if (!parsed.length) { await redis.unwatch(); return { claimed: 0, rows: [] as unknown[] }; }
    const slice = target === Infinity ? parsed : parsed.slice(0, target);
    const multi = redis.multi();
    for (const e of slice) {
      multi.lrem(availKey, 1, e.raw);
      const enriched = { ...e.obj, claimedBy: adminId, claimedAt: Date.now() };
      multi.rpush(claimedKey, JSON.stringify(enriched));
      const dk = String(e.obj.dedupKey || "");
      if (dk) {
        multi.sadd(takenGlobalKey, dk);
        multi.sadd(takenPoolKey, dk);
        multi.srem(dedupKey, dk);
      }
      multi.rpush(ledgerKey, JSON.stringify({ action: "claim", dedupKey: dk, poolId, password, claimedBy: adminId, srcUserId: e.obj.srcUserId, srcFileId: e.obj.srcFileId, at: Date.now() }));
      const su = String(e.obj.srcUserId || "");
      if (su) multi.hincrby(usersKey, su, -1);
    }
    const execRes = await multi.exec();
    if (execRes === null) continue; // retry

    // update rows:<fileId> — mark _taken
    const byFile = new Map<string, typeof slice>();
    for (const e of slice) {
      const fid = String(e.obj.srcFileId || "");
      if (!fid) continue;
      if (!byFile.has(fid)) byFile.set(fid, []);
      byFile.get(fid)!.push(e);
    }
    const claimedRows: unknown[] = [];
    for (const [fid, entries] of byFile) {
      let rows = await getJSON<Row[]>(`rows:${fid}`);
      if (!Array.isArray(rows)) rows = [];
      let changed = false;
      for (const en of entries) {
        const dk = String(en.obj.dedupKey || "");
        let idx = -1;
        const srcIdx = en.obj.srcRowIdx as number | undefined;
        if (typeof srcIdx === "number" && rows[srcIdx]) {
          const r = rows[srcIdx] as Record<string, unknown>;
          const cur = (r.uid as string) || ((r.cookies as string || "").match(/c_user=(\d+)/)?.[1]) || null;
          if (cur === dk) idx = srcIdx;
        }
        if (idx === -1) {
          idx = (rows as Record<string, unknown>[]).findIndex(rr => {
            const cur = (rr.uid as string) || ((rr.cookies as string || "").match(/c_user=(\d+)/)?.[1]) || null;
            return cur === dk;
          });
        }
        if (idx !== -1) {
          const rr = rows[idx] as Record<string, unknown>;
          rr._taken = true;
          rr._takenAt = Date.now();
          rr._pool = poolId;
          (rr as Record<string, unknown>)._takenBy = adminId;
          changed = true;
          claimedRows.push({ dedupKey: dk, srcFileId: fid, srcUserId: en.obj.srcUserId, cookies: rr.cookies, twofakey: rr.twofakey, uid: rr.uid, _takenAt: rr._takenAt });
        } else {
          claimedRows.push({ dedupKey: dk, srcFileId: fid, srcUserId: en.obj.srcUserId, cookies: en.obj.cookies, twofakey: en.obj.twofakey, uid: en.obj.uid });
        }
      }
      if (changed) await setJSON(`rows:${fid}`, rows);
    }
    // download record — store claimedRows + raw slice for revert
    const at = Date.now();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const label = String(POOL_META[poolId as keyof typeof POOL_META]?.label || poolId).toLowerCase().replace(/\s+/g, "_");
    const safePwd = password.replace(/[^A-Za-z0-9_-]/g, "_");
    const filename = safeFilename(`${label}_${safePwd}_${new Date(at).toISOString().slice(0, 10)}_${slice.length}_${id.slice(-4)}.xlsx`);
    const rawSlice = slice.map(e => e.raw);
    await redis.pipeline()
      .hmset(key(`pool:download:${id}`), { id, at: String(at), claimedBy: adminId, password, poolId, claimed: String(slice.length), filename, rows: JSON.stringify(claimedRows), raw: JSON.stringify(rawSlice), filterUserId: filterUserId || "", reverted: "0" })
      .zadd(key("pool:downloads"), String(at), id)
      .exec();
    return { claimed: slice.length, rows: claimedRows, downloadId: id, filename };
  }
  throw Object.assign(new Error("conflict, retry"), { status: 409 });
}

// GET /api/pools — list per-password pools
poolsRouter.get("/", requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  const p = redis.pipeline();
  for (const pwd of SHOW_PASSWORDS) for (const pid of POOL_IDS) {
    p.llen(key(`pool:${pwd}:${pid}:available`));
    p.llen(key(`pool:${pwd}:${pid}:claimed`));
    p.hlen(key(`pool:${pwd}:${pid}:users`));
  }
  const results = (await p.exec()) || [];
  let rIdx = 0;
  const pools: unknown[] = [];
  for (const pwd of SHOW_PASSWORDS) for (const pid of POOL_IDS) {
    const avail = Number((results[rIdx]?.[1] as number) ?? 0) || 0;
    const claimed = Number((results[rIdx + 1]?.[1] as number) ?? 0) || 0;
    const users = Number((results[rIdx + 2]?.[1] as number) ?? 0) || 0;
    rIdx += 3;
    const meta = POOL_META[pid as keyof typeof POOL_META];
    pools.push({ id: pid, label: meta.label, badge: meta.badge, cols: meta.cols, filename: meta.filename, password: pwd, available: avail, claimed, users });
  }
  res.json({ pools });
}));

// helper to resolve detail and validate
async function poolDetail(password: string, poolId: string, res: import("express").Response) {
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return null; }
  if (!password || !String(password).trim() || !isValidPassword(password)) { res.status(400).json({ error: "invalid password" }); return null; }
  const availKey = key(`pool:${password}:${poolId}:available`);
  const claimedKey = key(`pool:${password}:${poolId}:claimed`);
  const usersKey = key(`pool:${password}:${poolId}:users`);
  const pipe = redis.pipeline();
  pipe.lrange(availKey, 0, -1);
  pipe.lrange(claimedKey, 0, -1);
  pipe.hgetall(usersKey);
  const results = await pipe.exec();
  const availRaw = (results?.[0]?.[1] as string[]) || [];
  const claimedRaw = (results?.[1]?.[1] as string[]) || [];
  const usersHash = (results?.[2]?.[1] as Record<string, string>) || {};

  const availObjs: Record<string, unknown>[] = [];
  for (const s of availRaw) try { availObjs.push(JSON.parse(s)); } catch {}
  const claimedObjs: Record<string, unknown>[] = [];
  for (const s of claimedRaw) try { claimedObjs.push(JSON.parse(s)); } catch {}

  // per-user counts
  const availByUser = new Map<string, number>();
  for (const o of availObjs) { const u = String(o.srcUserId || ""); if (!u) continue; availByUser.set(u, (availByUser.get(u) || 0) + 1); }
  const claimedByUser = new Map<string, number>();
  for (const o of claimedObjs) { const u = String(o.srcUserId || ""); if (!u) continue; claimedByUser.set(u, (claimedByUser.get(u) || 0) + 1); }
  // also fallback to usersHash if claimed empty but hash has -? usersHash tracks available decrement, not claimed. Prefer claimedObjs.

  const allUserIds = new Set<string>([...availByUser.keys(), ...claimedByUser.keys(), ...Object.keys(usersHash)]);
  // fetch user display
  const userIds = [...allUserIds].filter(Boolean);
  const userMap = new Map<string, Record<string, unknown>>();
  if (userIds.length) {
    const up = redis.pipeline();
    userIds.forEach(id => up.get(key(`user:${id}`)));
    const ures = await up.exec();
    userIds.forEach((id, i) => {
      const raw = ures?.[i]?.[1] as string | null;
      if (!raw) return;
      try { userMap.set(id, JSON.parse(raw)); } catch {}
    });
  }
  const users: unknown[] = [];
  for (const uid of userIds) {
    const u = userMap.get(uid) as Record<string, unknown> | undefined;
    const displayName = u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || String(u.username || uid) : uid;
    const hasPhoto = !!(u && (u.fileId || (u as Record<string, unknown>).photoUrl));
    const computedPhotoUrl = hasPhoto ? ((u?.photoUrl as string) || (BACKEND_PUBLIC_URL ? BACKEND_PUBLIC_URL + "/api/auth/photo/" + uid : null)) : null;
    users.push({
      userId: uid,
      displayName,
      username: (u?.username as string) || null,
      photoUrl: computedPhotoUrl as string | null,
      firstName: (u?.firstName as string) || null,
      lastName: (u?.lastName as string) || null,
      isAdmin: isAdmin(uid),
      available: availByUser.get(uid) || 0,
      claimed: claimedByUser.get(uid) || Number(usersHash[uid] ?? 0) * 0 || claimedByUser.get(uid) || 0,
    });
  }
  // sort by available desc
  (users as { available: number }[]).sort((a, b) => b.available - a.available);

  const meta = POOL_META[poolId as keyof typeof POOL_META];
  return {
    pool: meta,
    password,
    totals: { available: availObjs.length, claimed: claimedObjs.length, users: allUserIds.size },
    users,
  };
}

// detail routes
async function handleDetail(req: import("express").Request, res: import("express").Response) {
  // called from both single and double param routes — detect
  const pwd = (req.params.password as string) || DEFAULT_PASSWORD;
  const pid = (req.params.poolId as string) || (req.params as Record<string,string>).password && !isPoolId((req.params as Record<string,string>).password) ? "" : "";
  // actually for single-param route, req.params.poolId is the poolId; for double route, password+poolId
  const poolId = (req.params.poolId as string) || "";
  const password = (req.params as Record<string,string>).password && (req.params as Record<string,string>).poolId ? (req.params as Record<string,string>).password : DEFAULT_PASSWORD;
  const realPoolId = (req.params as Record<string,string>).poolId ? (req.params as Record<string,string>).poolId : (req.params as Record<string,string>).password || "";
  // simpler: if route was /:poolId (one segment), express sets req.params.poolId; if /:password/:poolId, sets both
  let finalPassword: string;
  let finalPoolId: string;
  if ((req.params as Record<string,string>).password && (req.params as Record<string,string>).poolId) {
    finalPassword = (req.params as Record<string,string>).password;
    finalPoolId = (req.params as Record<string,string>).poolId;
  } else {
    finalPassword = DEFAULT_PASSWORD;
    finalPoolId = (req.params as Record<string,string>).poolId || (req.params as Record<string,string>).password || "";
  }
  void pwd; void pid; void poolId; void password; void realPoolId;
  const detail = await poolDetail(finalPassword, finalPoolId, res);
  if (!detail) return;
  res.json(detail);
}

// rows — paginated (must be before generic detail routes to avoid shadowing)
async function handleRows(req: import("express").Request, res: import("express").Response) {
  let password: string, poolId: string;
  if ((req.params as Record<string,string>).password && (req.params as unknown as Record<string,string>).poolId && req.path.split("/").filter(Boolean).length >= 3) {
    // double segment: /:password/:poolId/rows -> params has both
    password = String((req.params as Record<string,string>).password);
    poolId = String((req.params as Record<string,string>).poolId);
  } else {
    password = DEFAULT_PASSWORD;
    poolId = String((req.params as Record<string,string>).poolId || (req.params as Record<string,string>).password || "");
  }
  // when route is /:poolId/rows single, express sets poolId; when /:password/:poolId/rows double, sets password+poolId. Above covers.
  // simpler fallback: check URL
  const segs = req.path.split("/").filter(Boolean);
  if (segs.length === 2 && segs[1] === "rows") { // /:poolId/rows
    password = DEFAULT_PASSWORD; poolId = segs[0];
  } else if (segs.length === 3 && segs[2] === "rows") { // /:password/:poolId/rows
    password = segs[0]; poolId = segs[1];
  }
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return; }
  const filterUserId = req.query.userId ? String(req.query.userId) : undefined;
  const limit = req.query.limit ? Math.min(1000, Math.max(1, parseInt(String(req.query.limit), 10) || 100)) : 100;
  const offset = req.query.offset ? Math.max(0, parseInt(String(req.query.offset), 10) || 0) : 0;
  const availKey = key(`pool:${password}:${poolId}:available`);
  const rawList = await redis.lrange(availKey, 0, -1);
  let objs: Record<string, unknown>[] = [];
  for (const s of rawList) try { objs.push(JSON.parse(s)); } catch {}
  if (filterUserId) objs = objs.filter(o => String(o.srcUserId) === filterUserId);
  const total = objs.length;
  const rows = objs.slice(offset, offset + limit);
  res.json({ password, poolId, total, offset, limit, rows });
}
poolsRouter.get("/:poolId/rows", requireAuth, requireAdmin, asyncRoute(handleRows));
poolsRouter.get("/:password/:poolId/rows", requireAuth, requireAdmin, asyncRoute(handleRows));

// ledger
async function handleLedger(req: import("express").Request, res: import("express").Response) {
  const segs = req.path.split("/").filter(Boolean);
  let password: string, poolId: string;
  if (segs.length === 2 && segs[1] === "ledger") { password = DEFAULT_PASSWORD; poolId = segs[0]; }
  else if (segs.length === 3 && segs[2] === "ledger") { password = segs[0]; poolId = segs[1]; }
  else { password = String((req.params as Record<string,string>).password || DEFAULT_PASSWORD); poolId = String((req.params as Record<string,string>).poolId || (req.params as Record<string,string>).password || ""); }
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return; }
  const ledgerKey = key(`pool:${password}:${poolId}:ledger`);
  const raw = await redis.lrange(ledgerKey, 0, -1);
  const ledger = raw.map(s => { try { return JSON.parse(s); } catch { return s; } });
  res.json({ password, poolId, ledger });
}
poolsRouter.get("/:poolId/ledger", requireAuth, requireAdmin, asyncRoute(handleLedger));
poolsRouter.get("/:password/:poolId/ledger", requireAuth, requireAdmin, asyncRoute(handleLedger));

// claim POST
async function handleClaim(req: import("express").Request, res: import("express").Response) {
  const segs = req.path.split("/").filter(Boolean);
  let password: string, poolId: string;
  if (segs.length === 2 && segs[1] === "claim") { password = DEFAULT_PASSWORD; poolId = segs[0]; }
  else if (segs.length === 3 && segs[2] === "claim") { password = segs[0]; poolId = segs[1]; }
  else { password = String((req.params as Record<string,string>).password || DEFAULT_PASSWORD); poolId = String((req.params as Record<string,string>).poolId || (req.params as Record<string,string>).password || ""); }
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return; }
  const body = (req.body || {}) as { count?: unknown; userId?: unknown };
  const count = body.count ?? (req.query.count as unknown);
  const filterUserId = body.userId ? String(body.userId) : (req.query.userId ? String(req.query.userId) : undefined);
  try {
    const out = await doClaim(password, poolId, count ?? "all", filterUserId, String(req.userId || ""));
    res.json({ password, poolId, claimed: out.claimed, rows: out.rows, downloadId: (out as unknown as { downloadId?: string }).downloadId, filename: (out as unknown as { filename?: string }).filename });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    if (err.status === 400) { res.status(400).json({ error: err.message }); return; }
    if (err.status === 409) { res.status(409).json({ error: err.message }); return; }
    throw e;
  }
}
poolsRouter.post("/:poolId/claim", requireAuth, requireAdmin, asyncRoute(handleClaim));
poolsRouter.post("/:password/:poolId/claim", requireAuth, requireAdmin, asyncRoute(handleClaim));

// download GET — alias for claim streaming. Minimal: reuse claim with query count/userId, then try xlsx else json.
async function handleDownload(req: import("express").Request, res: import("express").Response) {
  const segs = req.path.split("/").filter(Boolean);
  let password: string, poolId: string;
  if (segs.length === 2 && segs[1] === "download") { password = DEFAULT_PASSWORD; poolId = segs[0]; }
  else if (segs.length === 3 && segs[2] === "download") { password = segs[0]; poolId = segs[1]; }
  else { password = String((req.params as Record<string,string>).password || DEFAULT_PASSWORD); poolId = String((req.params as Record<string,string>).poolId || (req.params as Record<string,string>).password || ""); }
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return; }
  const count = (req.query.count as unknown) ?? "all";
  const filterUserId = req.query.userId ? String(req.query.userId) : undefined;
  try {
    const out = await doClaim(password, poolId, count, filterUserId, String(req.userId || ""));
    if (out.claimed === 0) { res.json({ password, poolId, claimed: 0, rows: [] }); return; }
    try {
      const meta = POOL_META[poolId as keyof typeof POOL_META];
      const cols = meta.cols;
      const data: unknown[][] = cols.length === 1
        ? (out.rows as Record<string, unknown>[]).map(r => [r.cookies])
        : (out.rows as Record<string, unknown>[]).map(r => [r.cookies, r.twofakey]);
      const ws = XLSX.utils.aoa_to_sheet(data as (string | number)[][]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "pool");
      const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(String((out as unknown as { filename?: string }).filename || meta.filename))}"`);
      res.send(buf);
      return;
    } catch { /* fallback to json */ }
    res.json({ password, poolId, claimed: out.claimed, rows: out.rows, downloadId: (out as unknown as { downloadId?: string }).downloadId, filename: (out as unknown as { filename?: string }).filename });
  } catch (e: unknown) {
    const err = e as Error & { status?: number };
    if (err.status === 400) { res.status(400).json({ error: err.message }); return; }
    if (err.status === 409) { res.status(409).json({ error: err.message }); return; }
    throw e;
  }
}
poolsRouter.get("/:poolId/download", requireAuth, requireAdmin, asyncRoute(handleDownload));
poolsRouter.get("/:password/:poolId/download", requireAuth, requireAdmin, asyncRoute(handleDownload));

// downloads history
poolsRouter.get("/downloads", requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  const ids = await redis.zrevrange(key("pool:downloads"), 0, 49);
  if (!ids.length) { res.json([]); return; }
  const p = redis.pipeline();
  ids.forEach((id: string) => p.hgetall(key(`pool:download:${id}`)));
  const results = await p.exec();
  const out = (results || []).map((r: unknown) => {
    const h = (r as [Error | null, Record<string, string>])?.[1] || {};
    if (!h.id) return null;
    let rows: unknown = null;
    try { rows = h.rows ? JSON.parse(h.rows) : []; } catch { rows = h.rows; }
    return { id: h.id, at: Number(h.at), claimedBy: h.claimedBy, password: h.password, poolId: h.poolId, claimed: Number(h.claimed), filename: h.filename, filterUserId: h.filterUserId || undefined, rowsCount: Array.isArray(rows) ? (rows as unknown[]).length : undefined, reverted: h.reverted === "1", revertedAt: h.revertedAt ? Number(h.revertedAt) : undefined, revertedBy: h.revertedBy || undefined };
  }).filter(Boolean);
  res.json(out);
}));
poolsRouter.get("/downloads/:id", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const h = await redis.hgetall(key(`pool:download:${id}`)) as unknown as Record<string, string>;
  if (!h || !h.id) { res.status(404).json({ error: "not found" }); return; }
  if (String(req.query.format) === "json") {
    let rows: unknown;
    try { rows = h.rows ? JSON.parse(h.rows) : []; } catch { res.status(500).json({ error: "rows parse failed" }); return; }
    res.json({ id: h.id, at: Number(h.at), claimedBy: h.claimedBy, password: h.password, poolId: h.poolId, claimed: Number(h.claimed), filename: h.filename, filterUserId: h.filterUserId || undefined, rows, reverted: h.reverted === "1", revertedAt: h.revertedAt ? Number(h.revertedAt) : undefined });
    return;
  }
  let rows: Record<string, unknown>[];
  try { rows = h.rows ? JSON.parse(h.rows) : []; } catch { res.status(500).json({ error: "rows parse failed" }); return; }
  if (!Array.isArray(rows)) { res.status(500).json({ error: "rows parse failed" }); return; }
  const pid = String(h.poolId);
  const meta = isPoolId(pid) ? POOL_META[pid as keyof typeof POOL_META] : null;
  const cols = meta ? meta.cols : ["cookies"];
  const data: unknown[][] = cols.length === 1 ? rows.map(r => [r.cookies]) : rows.map(r => [r.cookies, r.twofakey]);
  const ws = XLSX.utils.aoa_to_sheet(data as (string | number)[][]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "pool");
  const buf: Buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Buffer;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(String(h.filename || meta?.filename || "download.xlsx"))}"`);
  res.send(buf);
}));
poolsRouter.post("/downloads/:id/revert", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const id = String(req.params.id);
  const dlKey = key(`pool:download:${id}`);
  // atomic guard against double revert
  await redis.watch(dlKey);
  const h = await redis.hgetall(dlKey) as unknown as Record<string, string>;
  if (!h || !h.id) { await redis.unwatch(); res.status(404).json({ error: "not found" }); return; }
  if (h.reverted === "1") { await redis.unwatch(); res.status(400).json({ error: "already reverted" }); return; }
  const password = String(h.password);
  const poolId = String(h.poolId);
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId in record" }); return; }
  let claimedRows: Record<string, unknown>[] = [];
  let rawSlice: string[] = [];
  try { claimedRows = h.rows ? JSON.parse(h.rows) : []; } catch { res.status(500).json({ error: "rows parse failed" }); return; }
  try { rawSlice = h.raw ? JSON.parse(h.raw) : []; } catch { rawSlice = []; }
  // fallback: if raw missing (old records), reconstruct minimal raw from claimedRows
  if (!rawSlice.length && Array.isArray(claimedRows) && claimedRows.length) {
    rawSlice = claimedRows.map(r => JSON.stringify({ dedupKey: (r as Record<string,unknown>).dedupKey, srcUserId: (r as Record<string,unknown>).srcUserId, srcFileId: (r as Record<string,unknown>).srcFileId, srcRowIdx: -1, cookies: (r as Record<string,unknown>).cookies, twofakey: (r as Record<string,unknown>).twofakey, uid: (r as Record<string,unknown>).uid }));
  }
  const availKey = key(`pool:${password}:${poolId}:available`);
  const claimedKey = key(`pool:${password}:${poolId}:claimed`);
  const dedupKey = key(`pool:${password}:${poolId}:dedup`);
  const takenGlobalKey = key(`taken:global:${password}`);
  const takenPoolKey = key(`taken:pool:${password}:${poolId}`);
  const usersKey = key(`pool:${password}:${poolId}:users`);
  const ledgerKey = key(`pool:${password}:${poolId}:ledger`);
  const dedupKeys = claimedRows.map(r => String((r as Record<string,unknown>).dedupKey || "")).filter(Boolean);
  // revert pool lists
  const claimedRawList = await redis.lrange(claimedKey, 0, -1);
  const dedupSet = new Set(dedupKeys);
  const toKeep: string[] = [];
  for (const s of claimedRawList) {
    try { const o = JSON.parse(s) as Record<string,unknown>; if (dedupSet.has(String(o.dedupKey || ""))) continue; } catch {}
    toKeep.push(s);
  }
  const p = redis.pipeline();
  p.del(claimedKey);
  for (const s of toKeep) p.rpush(claimedKey, s);
  for (const raw of rawSlice) p.rpush(availKey, raw);
  for (const dk of dedupKeys) { p.srem(takenGlobalKey, dk); p.srem(takenPoolKey, dk); p.sadd(dedupKey, dk); }
  // users: increment back per srcUserId
  const byUser = new Map<string, number>();
  for (const r of claimedRows) { const u = String((r as Record<string,unknown>).srcUserId || ""); if (!u) continue; byUser.set(u, (byUser.get(u) || 0) + 1); }
  for (const [u, cnt] of byUser) p.hincrby(usersKey, u, cnt);
  p.rpush(ledgerKey, JSON.stringify({ action: "revert", downloadId: id, poolId, password, revertedBy: String(req.userId || ""), at: Date.now(), dedupKeys }));
  p.hmset(dlKey, { reverted: "1", revertedAt: String(Date.now()), revertedBy: String(req.userId || "") });
  const execRes = await p.exec();
  if (execRes === null) { res.status(409).json({ error: "conflict, retry" }); return; }
  // revert _taken flags in rows:<fileId>
  const byFile = new Map<string, string[]>();
  for (const r of claimedRows) {
    const fid = String((r as Record<string,unknown>).srcFileId || "");
    const dk = String((r as Record<string,unknown>).dedupKey || "");
    if (!fid || !dk) continue;
    if (!byFile.has(fid)) byFile.set(fid, []);
    byFile.get(fid)!.push(dk);
  }
  for (const [fid, dks] of byFile) {
    const dkSet = new Set(dks);
    let rows = await getJSON<Row[]>(`rows:${fid}`);
    if (!Array.isArray(rows)) continue;
    let changed = false;
    for (const row of rows as unknown as Record<string, unknown>[]) {
      const cur = String((row.uid as string) || ((row.cookies as string || "").match(/c_user=(\d+)/)?.[1]) || "");
      if (dkSet.has(cur) && (row as Record<string,unknown>)._taken) {
        delete (row as Record<string,unknown>)._taken;
        delete (row as Record<string,unknown>)._takenAt;
        delete (row as Record<string,unknown>)._pool;
        delete (row as Record<string,unknown>)._takenBy;
        changed = true;
      }
    }
    if (changed) await setJSON(`rows:${fid}`, rows);
  }
  res.json({ ok: true, reverted: dedupKeys.length });
}));

// detail routes — must be last (generic 1- and 2-segment GETs would shadow specific suffix routes)
poolsRouter.get("/:poolId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const poolId = String(req.params.poolId || "");
  if (!isPoolId(poolId)) { res.status(400).json({ error: "invalid poolId" }); return; }
  const d = await poolDetail(DEFAULT_PASSWORD, poolId, res);
  if (d) res.json(d);
}));
poolsRouter.get("/:password/:poolId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const password = String(req.params.password || "");
  const poolId = String(req.params.poolId || "");
  const d = await poolDetail(password, poolId, res);
  if (d) res.json(d);
}));

// keep unused helper for future
void handleDetail;
