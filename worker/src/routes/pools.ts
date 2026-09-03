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
const dlMeta = (m: any) => ({ id: m.id, at: m.ts, claimedBy: m.claimedBy, password: m.password, poolId: m.poolId, claimed: m.claimed, filename: m.filename, reverted: !!m.reverted });
const findDownload = async (c: any, id: string) => { for (const pwd of DL_PASSWORDS) { const d: any = await rpc(c.env.POOLS, pwd, "download", { id }).catch(() => null); if (d) return { ...d, password: pwd }; } return null; };
pools.get("/downloads", async (c) => { if (!admin(c)) return c.json({ error: "admin access required" }, 403); const all: any[] = []; for (const pwd of DL_PASSWORDS) { const r = await rpc(c.env.POOLS, pwd, "downloads").catch(() => ({ downloads: [] })); for (const d of r.downloads || []) all.push(dlMeta({ ...d, password: pwd })); } all.sort((a, b) => b.at - a.at); return c.json(all.slice(0, 50)); });
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
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const limit = Math.min(1000, Math.max(1, Number(c.req.query("limit")) || 100));
  const offset = Math.max(0, Number(c.req.query("offset")) || 0);
  let rows = (await detailRows(c, c.req.param("password"), pid)).filter((r) => r._state === "available");
  const userId = c.req.query("userId");
  if (userId) rows = rows.filter((r) => String(r._claimedBy || "") === userId); // ponytail: available rows lack owner, filter only matches claimed
  return c.json({ password: c.req.param("password"), poolId: pid, total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) });
});
pools.get("/:password/:pool/ledger", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  if (!isPool(c.req.param("pool"))) return c.json({ error: "invalid poolId" }, 400);
  return c.json(await rpc(c.env.POOLS, c.req.param("password"), "ledger", { pool: c.req.param("pool") }));
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
  if (!isPool(pid)) return c.json({ error: "invalid poolId" }, 400);
  const body = await c.req.json<{ count?: number | "all" }>().catch(() => ({}) as { count?: number | "all" });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const filename = `${META[pid].label.toLowerCase().replace(/\s+/g, "_")}_${c.req.param("password").replace(/[^A-Za-z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}_${id.slice(-4)}.xlsx`;
  const out = await rpc(c.env.POOLS, c.req.param("password"), "claim", { pool: pid, uid: c.get("uid"), count: body.count, downloadId: id, filename });
  return c.json({ password: c.req.param("password"), poolId: pid, claimed: out.claimed, rows: out.rows, downloadId: out.downloadId, filename: out.filename });
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
