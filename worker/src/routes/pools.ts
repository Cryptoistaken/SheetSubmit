import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAuth, isAdmin } from "../lib/session";
import { rpc } from "../lib/do";
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
// ponytail: pool rows carry no srcUserId (raw row JSON), so per-user attribution is claimer-only;
// add src_user column in PoolDO if contributor stats matter
const summarize = (rows: any[]) => {
  const available = rows.filter((r) => r._state === "available").length;
  const claimedRows = rows.filter((r) => r._state === "claimed");
  const users = new Map<string, number>();
  for (const r of claimedRows) { const u = String(r._claimedBy || ""); if (u) users.set(u, (users.get(u) || 0) + 1); }
  return { available, claimed: claimedRows.length, users: [...users].map(([userId, claimed]) => ({ userId, displayName: userId, username: null, photoUrl: null, firstName: null, lastName: null, isAdmin: false, available: 0, claimed })) };
};
const isPool = (v: string): v is PoolId => (POOL_IDS as readonly string[]).includes(v);
const detailRows = async (c: any, password: string, pool: string) => rpc(c.env.POOLS, password, "detail", { pool }) as Promise<any[]>;

pools.use("/*", requireAuth);
const DL_PASSWORDS = ["dgddigital", "L0VE@12345"];
const dlMeta = (m: any) => ({ id: m.id, at: m.ts, claimedBy: m.claimedBy, password: m.password, poolId: m.poolId || m.pool_id, claimed: m.claimed, filename: m.filename, reverted: !!m.reverted });
const findDownload = async (c: any, id: string) => { for (const pwd of DL_PASSWORDS) { const d: any = await rpc(c.env.POOLS, pwd, "download", { id }).catch(() => null); if (d) return { ...d, password: pwd }; } return null; };
pools.get("/downloads", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const all: any[] = []; for (const pwd of DL_PASSWORDS) { const r = await rpc(c.env.POOLS, pwd, "downloads").catch(() => ({ downloads: [] })); for (const d of r.downloads || []) all.push(dlMeta({ ...d, password: pwd })); } all.sort((a, b) => b.at - a.at); return c.json(all.slice(0, 50)); });
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
pools.get("/downloads/:id", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const d = await findDownload(c, c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404); if (c.req.query("format") === "json") return c.json(dlMeta({ ...d, rows: d.rows })); const pid = d.poolId as PoolId; const cols = META[pid]?.cols || ["cookies"]; const XLSX = await import("xlsx"); const ws = XLSX.utils.aoa_to_sheet(d.rows.map((r: any) => cols.map((k) => String(r[k] ?? "")))); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "pool"); const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as unknown as Uint8Array; return new Response(buf, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${String(d.filename || "download.xlsx").replace(/["\r\n]/g, "_")}"` } }); });
pools.post("/downloads/:id/revert", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const d = await findDownload(c, c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404); return c.json(await rpc(c.env.POOLS, d.password, "revertDownload", { id: d.id, uid: c.get("uid") })); });
pools.get("/", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const out: any[] = [];
  for (const pwd of PASSWORDS) for (const pid of POOL_IDS) {
    const s = summarize(await detailRows(c, pwd, pid));
    out.push({ id: pid, ...META[pid], password: pwd, available: s.available, claimed: s.claimed, users: s.users.length });
  }
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
  const s = summarize(await detailRows(c, c.req.param("password"), pid));
  return c.json({ pool: { id: pid, ...META[pid] }, password: c.req.param("password"), totals: { available: s.available, claimed: s.claimed, users: s.users.length }, users: s.users });
});
pools.post("/:password/:pool/claim", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
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
  return c.json({ password: pwd, poolId: pid, claimed: out.claimed, rows: out.rows, downloadId: out.downloadId, filename: out.filename });
});
pools.get("/:password/:pool/user-files", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const pid = c.req.param("pool");
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const r = await rpc(c.env.POOLS, c.req.param("password"), "userFiles", { pool: pid });
  return c.json(r);
});
pools.post("/:password/:pool/revert", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  return c.json(await rpc(c.env.POOLS, c.req.param("password"), "revert", { id: body.id }));
});
