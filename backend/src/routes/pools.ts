import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAuth, isAdmin } from "../lib/session";
import { rpc } from "../lib/do";
import { checkRate, ipKey } from "../lib/rateLimit";
export const pools = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
function admin(c: any) { return isAdmin(c.env, c.get("uid")); }
const PASSWORDS = ["dgddigital", "L0VE@12345"];
const POOL_IDS = ["cookies_only", "cookies_2fa", "page"] as const;
type PoolId = typeof POOL_IDS[number];
const META: Record<PoolId, { label: string; badge: string; cols: string[]; filename: string; rule: string }> = {
  cookies_only: { label: "Cookies", badge: "Cookies", cols: ["cookies"], filename: "cookies_pool.xlsx", rule: "cookies valid, 2FA empty" },
  cookies_2fa: { label: "2FA", badge: "2FA", cols: ["cookies", "twofakey"], filename: "2fa_pool.xlsx", rule: "cookies + 2FA key" },
  page: { label: "Page", badge: "Page", cols: ["cookies", "twofakey"], filename: "page_pool.xlsx", rule: 'cookies + 2FA + wa_status === "eligible"' },
};
const summarize = (rows: any[]) => {
  const available = rows.filter((r) => r._state === "available").length;
  const claimedRows = rows.filter((r) => r._state === "claimed");
  const claimed = claimedRows.length;
  const m = new Map<string, { available: number; claimed: number }>();
  for (const r of rows) {
    const uid = String(r._srcUid || "").trim();
    if (!uid) continue;
    const cur = m.get(uid) ?? { available: 0, claimed: 0 };
    if (r._state === "available") cur.available++;
    else if (r._state === "claimed") cur.claimed++;
    m.set(uid, cur);
  }
  const users = [...m.entries()].map(([userId, c]) => ({ userId, displayName: userId, username: null, photoUrl: null, firstName: null, lastName: null, isAdmin: false, available: c.available, claimed: c.claimed }));
  return { available, claimed, users };
};
const isPool = (v: string): v is PoolId => (POOL_IDS as readonly string[]).includes(v);
const detailRows = async (c: any, password: string, pool: string) => rpc(c.env.POOLS, password, "detail", { pool }) as Promise<any[]>;

pools.use("/*", requireAuth);
const DL_PASSWORDS = ["dgddigital", "L0VE@12345"];
const dlMeta = (m: any) => ({
  id: m.id,
  at: m.ts,
  claimedBy: m.claimedBy ?? m.claimed_by,
  password: m.password,
  poolId: m.poolId || m.pool_id,
  pool_id: m.pool_id || m.poolId,
  claimed: m.claimed,
  filename: m.filename,
  reverted: !!m.reverted,
  status: m.status || (m.reverted ? "REVERTED" : m.claimed ? "CLAIMED" : null),
  unitPrice: m.unitPrice ?? (m.unit_price != null ? Number(m.unit_price) : null),
  unit_price: m.unit_price,
  total: m.total != null ? Number(m.total) : null,
  mode: m.mode ?? null,
  srcUids: m.srcUids ?? (m.src_uids ? (typeof m.src_uids === "string" ? JSON.parse(m.src_uids) : m.src_uids) : null),
  srcFileIds: m.srcFileIds ?? (m.src_file_ids ? (typeof m.src_file_ids === "string" ? JSON.parse(m.src_file_ids) : m.src_file_ids) : null),
  selection: m.selection ?? (m.selection ? (typeof m.selection === "string" ? JSON.parse(m.selection) : m.selection) : null),
});
const findDownload = async (c: any, id: string) => {
  const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(c.env.POOLS, pwd, "download", { id }).catch(() => null) as any));
  for (let i = 0; i < results.length; i++) if (results[i]) return { ...results[i], password: DL_PASSWORDS[i] };
  return null;
};
const findHold = async (c: any, id: string) => {
  const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(c.env.POOLS, pwd, "download", { id }).catch(() => null) as any));
  for (let i = 0; i < results.length; i++) if (results[i]) return { ...results[i], password: DL_PASSWORDS[i] };
  return null;
};

// holds listing must be before /:password handlers
pools.get("/holds", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const status = c.req.query("status");
  if (status && status.length > 32) return c.json({ error: "invalid status" }, 400);
  const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(c.env.POOLS, pwd, "holds", { status: status || null }).catch(() => ({ holds: [] })) as any));
  const all = results.flatMap((r, i) => {
    const arr = r.holds || r.downloads || [];
    return arr.map((d: any) => ({ ...dlMeta({ ...d, password: DL_PASSWORDS[i] }), password: DL_PASSWORDS[i], held: d.claimed ?? d.held ?? 0 }));
  });
  all.sort((a: any, b: any) => (b.at ?? 0) - (a.at ?? 0));
  // if status filter provided, already filtered in DO; if no filter, keep only HOLDs (DO returns HOLDs)
  return c.json(all.slice(0, 50));
});
pools.post("/holds/:id/approve", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  // find password
  let lastErr: any = null;
  for (const pwd of DL_PASSWORDS) {
    const r: any = await rpc(c.env.POOLS, pwd, "holdApprove", { id, uid: c.get("uid") }).catch((e: any) => ({ _err: String(e?.message ?? e) }));
    if (r && r._err) { lastErr = r; continue; }
    if (r && r.error) {
      if (r.error === "not found") continue;
      return c.json({ error: r.error }, r.error === "not found" ? 404 : 400);
    }
    if (r && r.ok) return c.json(r);
    lastErr = r;
  }
  if (lastErr && lastErr.error === "not found") return c.json({ error: "not found" }, 404);
  return c.json({ error: "not found" }, 404);
});
const handleReject = async (c: any) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  for (const pwd of DL_PASSWORDS) {
    const r: any = await rpc(c.env.POOLS, pwd, "holdReject", { id, uid: c.get("uid") }).catch((e: any) => ({ _err: String(e?.message ?? e) }));
    if (r && r._err) continue;
    if (r && r.error) {
      if (r.error === "not found") continue;
      return c.json({ error: r.error }, r.error === "not found" ? 404 : 400);
    }
    if (r && r.ok) return c.json(r);
  }
  return c.json({ error: "not found" }, 404);
};
pools.post("/holds/:id/reject", handleReject);
pools.post("/holds/:id/return", handleReject);
pools.post("/holds/:id/revert", handleReject);

pools.get("/downloads", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(c.env.POOLS, pwd, "downloads").catch(() => ({ downloads: [] })))); const all = results.flatMap((r, i) => (r.downloads || []).map((d: any) => dlMeta({ ...d, password: DL_PASSWORDS[i] }))); all.sort((a, b) => b.at - a.at); return c.json(all.slice(0, 50)); });
pools.get("/downloads/:id/detail", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  const d = await findDownload(c, id);
  if (!d) return c.json({ error: "not found" }, 404);
  const detail: any = await rpc(c.env.POOLS, d.password, "downloadDetail", { id: d.id }).catch(() => null);
  if (!detail) return c.json({ error: "not found" }, 404);
  return c.json({ ...dlMeta({ ...detail, password: d.password }), rows: detail.rows, keys: detail.keys, groups: detail.groups ?? [] });
});
  pools.get("/downloads/:id", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const d = await findDownload(c, c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404); if (c.req.query("format") === "json") return c.json(dlMeta({ ...d, rows: d.rows })); const srcUid = c.req.query("srcUid") || "", srcFileId = c.req.query("srcFileId") || ""; let rows: any[] = d.rows || [], filename = String(d.filename || "download.xlsx"); if (srcUid || srcFileId) { const f: any = await rpc(c.env.POOLS, d.password, "downloadRows", { id: d.id, srcUid: srcUid || null, srcFileId: srcFileId || null }).catch(() => null); if (!f) return c.json({ error: "not found" }, 404); rows = f.rows; filename = String(c.req.query("name") || filename).replace(/["\r\n]/g, "_"); } const pid = d.poolId as PoolId; const cols = META[pid]?.cols || ["cookies"]; const XLSX = await import("xlsx"); const ws = XLSX.utils.aoa_to_sheet(rows.map((r: any) => cols.map((k) => String(r[k] ?? "")))); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "pool"); const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array; return new Response(buf as any, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${filename}"` } }); });
pools.post("/downloads/:id/revert", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const d = await findDownload(c, c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404); return c.json(await rpc(c.env.POOLS, d.password, "revertDownload", { id: d.id, uid: c.get("uid") })); });
pools.delete("/downloads/:id", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  const d = await findDownload(c, id);
  if (!d) return c.json({ error: "not found" }, 404);
  let r: any;
  try { r = await rpc(c.env.POOLS, d.password, "downloadDelete", { id: d.id }); }
  catch (error) {
    if (String((error as Error)?.message || "").includes("active record cannot be deleted")) return c.json({ error: "active record cannot be deleted" }, 400);
    throw error;
  }
  if (r?.error) return c.json({ error: r.error }, r.error === "not found" ? 404 : 400);
  return c.json(r);
});
pools.get("/", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const out = await Promise.all(PASSWORDS.flatMap((pwd) => POOL_IDS.map(async (pid) => {
    const st: any = await rpc(c.env.POOLS, pwd, "summary", { pool: pid }).catch(() => ({ available: 0, claimed: 0, users: 0, invalid: 0 }));
    return { id: pid, ...META[pid], password: pwd, available: st.available, claimed: st.claimed, users: st.users, invalid: st.invalid ?? 0 };
  })));
  return c.json({ pools: out });
});
pools.get("/:password/:pool/rows", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  const rawUser = c.req.query("userId") || c.req.query("srcUid") || "";
  const rawFile = c.req.query("fileId") || c.req.query("srcFileId") || "";
  const vOnly = c.req.query("verifiedOnly");
  const uvOnly = c.req.query("unverifiedOnly");
  if ((vOnly === "true" || vOnly === "1") && (uvOnly === "true" || uvOnly === "1")) return c.json({ error: "verifiedOnly and unverifiedOnly are mutually exclusive" }, 400);
  if ((vOnly === "true" || vOnly === "1" || uvOnly === "true" || uvOnly === "1") && pid !== "page") return c.json({ error: "verified filters only for page pool" }, 400);
  let rows = (await detailRows(c, pwd, pid)).filter((r) => r._state === "available");
  if (rawUser) rows = rows.filter((r) => String(r._srcUid || "") === rawUser);
  if (rawFile) rows = rows.filter((r) => String(r._srcFileId || "") === rawFile);
  // ponytail: bounded scan without SQL JSON parsing — JS filter, avoids json_extract in SQLite
  if (vOnly === "true" || vOnly === "1") rows = rows.filter((r) => String(r.wa_status || r.waStatus || "").toLowerCase() === "eligible");
  else if (uvOnly === "true" || uvOnly === "1") rows = rows.filter((r) => String(r.wa_status || r.waStatus || "").toLowerCase() !== "eligible");
  return c.json({ password: pwd, poolId: pid, total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) });
});
pools.get("/:password/:pool/ledger", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  if (!isPool(c.req.param("pool"))) return c.json({ error: "invalid poolId" }, 400);
  return c.json(await rpc(c.env.POOLS, c.req.param("password"), "ledger", { pool: c.req.param("pool") }));
});
pools.get("/:password/:pool/verified-counts", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  // for pid==="page": {verified: page available, unverified: cookies_2fa candidates (c_user+real 2FA+alive+wa not eligible)}, bounded scan
  const r: any = await rpc(c.env.POOLS, pwd, "verifiedCounts", { pool: pid });
  return c.json(r);
});
pools.get("/:password/:pool/page-counts", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const r: any = await rpc(c.env.POOLS, pwd, "verifiedCounts", { pool: pid });
  return c.json(r);
});
pools.get("/:password/:pool", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const st: any = await rpc(c.env.POOLS, c.req.param("password"), "summary", { pool: pid }).catch(() => ({ available: 0, claimed: 0, users: 0, invalid: 0 }));
  const rows: any[] = await detailRows(c, c.req.param("password"), pid).catch(() => []) as any; const summ = summarize(rows);
  return c.json({ pool: { id: pid, ...META[pid] }, password: c.req.param("password"), totals: { available: st.available, claimed: st.claimed, users: summ.users.length, invalid: st.invalid ?? 0 }, users: summ.users });
});
pools.post("/:password/:pool/claim", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  if (!checkRate(ipKey(c, "pool.claim"), 10, 60000)) return c.json({ error: "rate limited" }, 429);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  const body = await c.req.json().catch(() => ({}) as any);
  let count: number | "all" = body.count;
  if (count === undefined || count === null) count = 1;
  if (count !== "all" && (typeof count !== "number" || !Number.isFinite(count) || count < 1)) return c.json({ error: "invalid count" }, 400);
  if (typeof count === "number") count = Math.min(10000, Math.max(1, Math.floor(count)));
  const srcUidRaw = body.srcUid ?? body.claimForUser ?? body.userId ?? body.claimForUserId ?? null;
  const srcFileIdRaw = body.srcFileId ?? body.fileId ?? null;
  if (srcUidRaw != null && (typeof srcUidRaw !== "string" || !srcUidRaw.trim() || srcUidRaw.length > 64)) return c.json({ error: "invalid srcUid" }, 400);
  if (srcFileIdRaw != null && (typeof srcFileIdRaw !== "string" || !srcFileIdRaw.trim() || srcFileIdRaw.length > 64)) return c.json({ error: "invalid srcFileId" }, 400);
  // page is verified-only; verifiedOnly => claims from page (all eligible), unverifiedOnly => 0 (unverified live in cookies_2fa, use verified-counts to inspect)
  const verifiedOnly = !!body.verifiedOnly;
  const unverifiedOnly = !!body.unverifiedOnly;
  if (verifiedOnly && unverifiedOnly) return c.json({ error: "verifiedOnly and unverifiedOnly are mutually exclusive" }, 400);
  if ((verifiedOnly || unverifiedOnly) && pid !== "page") return c.json({ error: "verified filters only for page pool" }, 400);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const filename = `${META[pid].label.toLowerCase().replace(/\s+/g, "_")}_${pwd.replace(/[^A-Za-z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}_${id.slice(-4)}.xlsx`;
  const out = await rpc(c.env.POOLS, pwd, "claim", { pool: pid, uid: c.get("uid"), count, srcUid: srcUidRaw ? String(srcUidRaw) : null, srcFileId: srcFileIdRaw ? String(srcFileIdRaw) : null, claimForUser: srcUidRaw ? String(srcUidRaw) : null, verifiedOnly, unverifiedOnly, downloadId: id, filename });
  if (out?.error) return c.json({ error: out.error }, 400);
  return c.json({ password: pwd, poolId: pid, claimed: out.claimed, rows: out.rows, downloadId: out.downloadId, filename: out.filename, status: out.status, unitPrice: out.unitPrice, total: out.total, mode: out.mode });
});
pools.post("/:password/:pool/hold", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  if (!checkRate(ipKey(c, "pool.hold"), 20, 60000)) return c.json({ error: "rate limited" }, 429);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  const body = await c.req.json().catch(() => ({}) as any);
  let count: number | "all" = body.count;
  if (count === undefined || count === null) count = 1;
  if (count !== "all" && (typeof count !== "number" || !Number.isFinite(count) || count < 1)) return c.json({ error: "invalid count" }, 400);
  if (typeof count === "number") count = Math.min(10000, Math.max(1, Math.floor(count)));
  const modeRaw = body.mode ? String(body.mode).toLowerCase() : "fifo";
  if (modeRaw !== "fifo" && modeRaw !== "pick") return c.json({ error: "invalid mode" }, 400);
  if (modeRaw === "pick") {
    const hasUids = Array.isArray(body.srcUids) && body.srcUids.length > 0;
    const hasFileIds = Array.isArray(body.srcFileIds) && body.srcFileIds.length > 0;
    if (!hasUids && !hasFileIds) return c.json({ error: "pick mode requires srcUids or srcFileIds" }, 400);
  }
  // validate srcUids/srcFileIds arrays if provided
  if (body.srcUids != null && !Array.isArray(body.srcUids)) return c.json({ error: "invalid srcUids" }, 400);
  if (body.srcFileIds != null && !Array.isArray(body.srcFileIds)) return c.json({ error: "invalid srcFileIds" }, 400);
  if (Array.isArray(body.srcUids) && body.srcUids.some((v: any) => typeof v !== "string" || !v.trim() || v.length > 64)) return c.json({ error: "invalid srcUids" }, 400);
  if (Array.isArray(body.srcFileIds) && body.srcFileIds.some((v: any) => typeof v !== "string" || !v.trim() || v.length > 64)) return c.json({ error: "invalid srcFileIds" }, 400);
  const srcUidRaw = body.srcUid ?? body.claimForUser ?? body.userId ?? null;
  const srcFileIdRaw = body.srcFileId ?? body.fileId ?? null;
  if (srcUidRaw != null && (typeof srcUidRaw !== "string" || !srcUidRaw.trim() || srcUidRaw.length > 64)) return c.json({ error: "invalid srcUid" }, 400);
  if (srcFileIdRaw != null && (typeof srcFileIdRaw !== "string" || !srcFileIdRaw.trim() || srcFileIdRaw.length > 64)) return c.json({ error: "invalid srcFileId" }, 400);
  const verifiedOnly = !!body.verifiedOnly;
  const unverifiedOnly = !!body.unverifiedOnly;
  if (verifiedOnly && unverifiedOnly) return c.json({ error: "verifiedOnly and unverifiedOnly are mutually exclusive" }, 400);
  if ((verifiedOnly || unverifiedOnly) && pid !== "page") return c.json({ error: "verified filters only for page pool" }, 400);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const filename = `${META[pid].label.toLowerCase().replace(/\s+/g, "_")}_${pwd.replace(/[^A-Za-z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}_${id.slice(-4)}.xlsx`;
  const out: any = await rpc(c.env.POOLS, pwd, "hold", { pool: pid, uid: c.get("uid"), count, mode: modeRaw, srcUid: srcUidRaw ? String(srcUidRaw) : null, srcFileId: srcFileIdRaw ? String(srcFileIdRaw) : null, srcUids: Array.isArray(body.srcUids) ? body.srcUids : null, srcFileIds: Array.isArray(body.srcFileIds) ? body.srcFileIds : null, verifiedOnly, unverifiedOnly, downloadId: id, filename });
  if (out?.error) return c.json({ error: out.error }, 400);
  return c.json({ password: pwd, poolId: pid, claimed: out.claimed ?? out.held ?? 0, held: out.held ?? out.claimed ?? 0, count: out.count ?? out.claimed ?? 0, rows: out.rows, holdId: out.holdId ?? out.downloadId, downloadId: out.downloadId ?? out.holdId, filename: out.filename, status: out.status, unitPrice: out.unitPrice, total: out.total, mode: out.mode, srcUids: out.srcUids, srcFileIds: out.srcFileIds });
});
pools.get("/:password/:pool/user-files", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const r = await rpc(c.env.POOLS, c.req.param("password"), "userFiles", { pool: pid });
  return c.json(r);
});
pools.get("/:password/:pool/price", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  const r: any = await rpc(c.env.POOLS, pwd, "priceGet", { pool: pid, password: pwd });
  if (r?.error) return c.json({ error: r.error }, 400);
  return c.json(r);
});
pools.put("/:password/:pool/price", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  const pwd = c.req.param("password");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  if (!pwd || pwd.length > 64) return c.json({ error: "invalid password" }, 400);
  const body = await c.req.json().catch(() => ({}) as any);
  const price = Number(body?.price);
  if (!Number.isFinite(price) || price < 0 || price > 1000) return c.json({ error: "invalid price" }, 400);
  const r: any = await rpc(c.env.POOLS, pwd, "priceSet", { pool: pid, password: pwd, price });
  if (r?.error) return c.json({ error: r.error }, 400);
  return c.json(r);
});
pools.post("/:password/:pool/revert", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  return c.json(await rpc(c.env.POOLS, c.req.param("password"), "revert", { id: body.id }));
});
