import { Hono } from "hono";
import type { Env } from "./lib/shared";
import { requireAuth, isAdmin, cookie, verifySession } from "./lib/session";
import { rpc } from "./lib/do";
import { files, archive, crossDups } from "./routes/files";
import { pools } from "./routes/pools";
import { admin } from "./routes/admin";
import { wa } from "./routes/wa";
import { bot, ensureWebhook } from "./routes/bot";
import { scheduled } from "./scheduled";
import { IndexDO } from "./do/IndexDO";
import { FileDO } from "./do/FileDO";
import { PoolDO } from "./do/PoolDO";
import { checkRate, ipKey } from "./lib/rateLimit";
import { verifyTelegramIdToken } from "./lib/telegramOidc";
import { signSession as signSessionFn } from "./lib/session";

const app = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
// ponytail: manual bump on any worker route change — lets TestApi/health confirm a redeploy landed
export const API_VERSION = "1.4.0";
app.onError((err, c) => { console.error(err); return c.json({ error: "Internal server error" }, 500); });
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  const allowed = [c.env.FRONTEND_URL, "http://localhost:5173", "http://127.0.0.1:5173"].filter(Boolean) as string[];
  if (origin && allowed.includes(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  }
  if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: c.res.headers });
  return next();
});
app.use("/api/*", async (c, next) => { if (Number(c.req.header("Content-Length")) > 4_000_000) return c.json({ error: "payload too large" }, 413); if (c.req.raw.body) { try { const reader = c.req.raw.clone().body!.getReader(); let size = 0; while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4_000_000) { await reader.cancel(); return c.json({ error: "payload too large" }, 413); } } } catch { return c.json({ error: "invalid request body" }, 400); } } return next(); });
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now(), version: API_VERSION }));
app.route("/api/files", files);
app.route("/api/archive", archive);
app.route("/api/cross-dups", crossDups);
app.route("/api/pools", pools);
app.route("/api/admin", admin);
app.route("/api", wa);
app.route("/", bot);
app.get("/api/auth/me", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (!token) return c.json({ error: "not_authenticated" }, 401); if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500); const session = await verifySession(token, c.env.SESSION_SECRET); if (!session) return c.json({ error: "session_expired" }, 401); const user: any = await rpc(c.env.INDEX, "global", "user", { id: session.uid }); if (!user) return c.json(null); return c.json({ id: String(user.user_id), name: user.name || "", username: user.username || "", photoUrl: user.photo_url || null, phone: user.phone || null, isAdmin: isAdmin(c.env, session.uid) }); });
app.post("/api/auth/logout", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (token) await rpc(c.env.INDEX, "global", "deleteSession", { token }); return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": "ss_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } }); });
app.post("/api/auth/device/claim", async (c) => {
  if (!checkRate(ipKey(c, "device.claim"), 10, 60000)) return c.json({ ok: false, error: "rate limited" }, 429);
  let body: { token?: string; turnstile?: string }; try { body = await c.req.json(); } catch { return c.json({ ok: false }, 400); } const did = body.token || ""; if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) return c.json({ ok: false }); const tsToken = body.turnstile; if (c.env.TURNSTILE_SECRET) { if (!tsToken || tsToken.length > 2048) return c.json({ ok: false }, 403); try { const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000), body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: tsToken }) }); const result = await r.json() as { success: boolean }; if (!result.success) return c.json({ ok: false }, 403); } catch { return c.json({ ok: false }, 403); } } const info: any = await rpc(c.env.INDEX, "global", "deviceGet", { did }); if (!info?.chatId || !info.chatId.includes(".")) return c.json({ ok: false }); await rpc(c.env.INDEX, "global", "deviceDelete", { did }); return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(info.chatId) } }); });
app.get("/api/bot/info", async (c) => { if (!c.env.TG_BOT_TOKEN) return c.json({ username: "" }); try { const r = await fetch(`https://api.telegram.org/bot${c.env.TG_BOT_TOKEN}/getMe`); if (!r.ok) return c.json({ username: "" }); const j = await r.json() as any; return c.json({ username: j.result?.username || "" }); } catch { return c.json({ username: "" }); } });
app.get("/api/auth/telegram/config", (c) => c.json({ clientId: c.env.TELEGRAM_LOGIN_CLIENT_ID || "" }));
app.post("/api/auth/telegram/verify", async (c) => {
  if (!checkRate(ipKey(c, "telegram.verify"), 20, 60000)) return c.json({ ok: false, error: "rate limited" }, 429);
   let body: { id_token?: string; turnstile?: string }; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid body" }, 400); }
   const idToken = String(body.id_token || "").trim();
   if (!idToken || idToken.length > 8192) return c.json({ ok: false, error: "missing id_token" }, 400);
   const origin = c.req.header("Origin");
   if (c.env.TURNSTILE_SECRET && origin) {
     const tsToken = body.turnstile;
     if (!tsToken || tsToken.length > 2048) return c.json({ ok: false, error: "human verification required" }, 403);
     try {
       const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000), body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET, response: tsToken, remoteip: c.req.header("CF-Connecting-IP") || "" }) });
       const result = await r.json() as { success: boolean };
       if (!r.ok || !result.success) return c.json({ ok: false, error: "human verification failed" }, 403);
     } catch { return c.json({ ok: false, error: "human verification failed" }, 403); }
   }
   const clientId = c.env.TELEGRAM_LOGIN_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "telegram login not configured" }, 503);
  if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500);
  let claims: { uid: string; name: string; username: string; picture: string; phone: string };
  try { claims = await verifyTelegramIdToken(idToken, clientId); } catch (e: any) { return c.json({ ok: false, error: String(e?.message || "invalid token") }, 401); }
  await rpc(c.env.INDEX, "global", "ensureUser", { id: claims.uid, name: claims.name, username: claims.username, photoUrl: claims.picture || null, phone: claims.phone || null });
  const token = await signSessionFn(claims.uid, c.env.SESSION_SECRET);
  await rpc(c.env.INDEX, "global", "session", { token, uid: claims.uid, exp: Date.now() + 2592000000 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(token) } });
});
 app.post("/api/auth/turnstile-verify", async (c) => {
  if (!checkRate(ipKey(c, "turnstile.verify"), 20, 60000)) return c.json({ ok: false, error: "rate limited" }, 429);
  const secret = c.env.TURNSTILE_SECRET; if (!secret) return c.json({ ok: true }); let token: string | undefined; try { token = (await c.req.json<{ token?: string }>()).token; } catch { return c.json({ ok: false }, 403); } if (!token || token.length > 2048) return c.json({ ok: false }, 403); try { const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(10000), body: new URLSearchParams({ secret, response: token }) }); if (!r.ok) return c.json({ ok: false }, 403); const result = await r.json() as { success: boolean; "error-codes"?: string[] }; return result.success ? c.json({ ok: true }) : c.json({ ok: false }, 403); } catch { return c.json({ ok: false }, 403); } });

export { IndexDO, FileDO, PoolDO };
let webhookChecked = false;
export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => {
    if (!webhookChecked) {
      webhookChecked = true;
      ctx.waitUntil(ensureWebhook(env));
    }
    return app.fetch(req, env, ctx);
  },
  scheduled,
};
