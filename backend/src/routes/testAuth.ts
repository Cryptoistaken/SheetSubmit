import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { rpc } from "../lib/do";
import { cookie, signSession } from "../lib/session";

// TEST-ONLY auth backdoor for automated e2e (Playwright). Guarded by
// ALLOW_TEST_AUTH=1 — never set it on Railway prod or any public env.
// Lets tests mint a real ss_session cookie without Telegram OIDC/Turnstile.
export const testAuth = new Hono<{ Bindings: Env; Variables: { uid: string } }>();

testAuth.post("/login", async (c) => {
  if (c.env.ALLOW_TEST_AUTH !== "1") return c.json({ error: "not found" }, 404);
  if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500);
  let body: { uid?: unknown; name?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); }
  const uid = String(body.uid || "").trim();
  const name = String(body.name || "E2E User").slice(0, 128);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) return c.json({ error: "invalid uid" }, 400);
  await rpc(c.env.INDEX, "global", "ensureUser", { id: uid, name, username: "", photoUrl: null, phone: null });
  const token = await signSession(uid, c.env.SESSION_SECRET);
  await rpc(c.env.INDEX, "global", "session", { token, uid, exp: Date.now() + 2592000000 });
  return new Response(JSON.stringify({ ok: true, uid }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": cookie(token, 2592000, c.req.header("x-forwarded-proto") !== "http"),
    },
  });
});
