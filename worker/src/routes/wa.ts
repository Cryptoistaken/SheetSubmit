import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAuth } from "../lib/session";
export const wa = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
wa.use("/fb/*", requireAuth);
wa.post("/fb/check", async (c) => { const body = await c.req.json<{ uids?: unknown[] }>(); if (!Array.isArray(body.uids) || !body.uids.length) return c.json({ error: "No UIDs provided" }, 400); const r = await fetch("https://check.fb.tools/api/check/facebook", { method: "POST", headers: { accept: "application/x-ndjson", "content-type": "application/json" }, body: JSON.stringify({ inputData: body.uids.slice(0, 500).map(String), userLang: "en", checkFriends: false }) }); const text = await r.text(); const valid: string[] = [], dead: string[] = []; for (const line of text.split("\n")) { try { const x = JSON.parse(line.slice(line.indexOf("{"))); const uid = String(x.data?.uid || x.data?.account || ""); (x.data?.status?.name === "valid" ? valid : dead).push(uid); } catch {} } return c.json({ valid, dead, uncertain: [] }); });
wa.post("/fb/page-check", async (c) => c.json({ eligible: false, error: "not implemented" }, 501));
wa.post("/fb/wa-check", async (c) => c.json({ eligible: false, error: "not implemented" }, 501));
wa.get("/wa/cache", async (c) => c.json({ enabled: false }));
