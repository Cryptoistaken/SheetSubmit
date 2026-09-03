import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAuth, isAdmin } from "../lib/session";
import { rpc } from "../lib/do";
export const pools = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
function admin(c: any) { return isAdmin(c.env, c.get("uid")); }
pools.use("/*", requireAuth);
pools.get("/", async (c) => admin(c) ? c.json({ pools: await rpc(c.env.POOLS, "dgddigital", "counts") }) : c.json({ error: "admin access required" }, 403));
pools.get("/:password/:pool/rows", async (c) => admin(c) ? c.json({ password: c.req.param("password"), poolId: c.req.param("pool"), rows: await rpc(c.env.POOLS, c.req.param("password"), "detail", { pool: c.req.param("pool") }) }) : c.json({ error: "admin access required" }, 403));
pools.get("/:password/:pool", async (c) => admin(c) ? c.json({ password: c.req.param("password"), pool: c.req.param("pool"), rows: await rpc(c.env.POOLS, c.req.param("password"), "detail", { pool: c.req.param("pool") }) }) : c.json({ error: "admin access required" }, 403));
pools.get("/:password/:pool/ledger", async (c) => admin(c) ? c.json(await rpc(c.env.POOLS, c.req.param("password"), "ledger", { pool: c.req.param("pool") })) : c.json({ error: "admin access required" }, 403));
pools.post("/:password/:pool/claim", async (c) => admin(c) ? c.json(await rpc(c.env.POOLS, c.req.param("password"), "claim", { pool: c.req.param("pool"), uid: c.get("uid"), count: (await c.req.json<any>()).count })) : c.json({ error: "admin access required" }, 403));
pools.post("/:password/:pool/revert", async (c) => admin(c) ? c.json(await rpc(c.env.POOLS, c.req.param("password"), "revert", { id: (await c.req.json<any>()).id })) : c.json({ error: "admin access required" }, 403));
