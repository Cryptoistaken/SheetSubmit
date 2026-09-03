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
  const out = await rpc(c.env.POOLS, c.req.param("password"), "claim", { pool: pid, uid: c.get("uid"), count: body.count });
  // no downloadId: frontend falls back to client-side xlsx generation from rows
  return c.json({ password: c.req.param("password"), poolId: pid, claimed: out.claimed, rows: out.rows });
});
pools.post("/:password/:pool/revert", async (c) => {
  if (!admin(c)) return c.json({ error: "admin access required" }, 403);
  const body = await c.req.json<{ id?: string }>().catch(() => ({}) as { id?: string });
  return c.json(await rpc(c.env.POOLS, c.req.param("password"), "revert", { id: body.id }));
});
