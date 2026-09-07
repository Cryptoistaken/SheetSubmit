import { Hono } from "hono";
import type { Env } from "./lib/shared";
import { requireAuth, isAdmin, cookie, verifySession } from "./lib/session";
import { rpc } from "./lib/do";
import { files, archive, crossDups } from "./routes/files";
import { pools } from "./routes/pools";
import { admin } from "./routes/admin";
import { wa } from "./routes/wa";
import { bot, ensureWebhook } from "./routes/bot";
import { checkRate, ipKey } from "./lib/rateLimit";
import { verifyTelegramIdToken } from "./lib/telegramOidc";
import { signSession as signSessionFn } from "./lib/session";

export const app = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
// ponytail: manual bump on any backend route change — lets health checks confirm a deploy landed
export const API_VERSION = "1.5.6";
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
app.get("/api/wallet", requireAuth, async (c) => { const uid = c.get("uid"); const [wallet, withdrawals] = await Promise.all([rpc(c.env.INDEX, "global", "walletGet", { uid }), rpc(c.env.INDEX, "global", "walletWithdrawals", { uid })]); return c.json({ ...(wallet as object), withdrawals }); });
app.post("/api/wallet/withdraw", requireAuth, async (c) => { let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); } const amount = Number(body?.amount); const method = String(body?.method || "").trim(); const account = String(body?.account || "").trim(); if (!Number.isFinite(amount) || amount <= 0 || !method || account.length < 3 || account.length > 256) return c.json({ error: "invalid withdrawal" }, 400); try { return c.json(await rpc(c.env.INDEX, "global", "walletWithdraw", { uid: c.get("uid"), id: crypto.randomUUID(), amount, method, account })); } catch (error) { const message = String((error as Error)?.message || ""); if (message.includes("insufficient")) return c.json({ error: "insufficient balance" }, 400); throw error; } });
app.get("/api/wallet/requests", requireAuth, async (c) => { if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); return c.json(await rpc(c.env.INDEX, "global", "walletRequests", { status: c.req.query("status") || "" })); });
app.post("/api/wallet/requests/:id/:action", requireAuth, async (c) => { if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); const action = c.req.param("action"); if (action !== "approve" && action !== "reject") return c.json({ error: "unsupported action" }, 400); return c.json(await rpc(c.env.INDEX, "global", "walletDecision", { id: c.req.param("id"), status: action === "approve" ? "APPROVED" : "REJECTED" })); });
app.get("/api/wallet/methods", requireAuth, async (c) => { return c.json(await rpc(c.env.INDEX, "global", "paymentMethodsGet", { uid: c.get("uid") })); });
app.put("/api/wallet/methods", requireAuth, async (c) => { let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); } const methods = body?.methods ?? {}; if (typeof methods !== "object") return c.json({ error: "invalid methods" }, 400); return c.json(await rpc(c.env.INDEX, "global", "paymentMethodsSet", { uid: c.get("uid"), methods })); });
app.route("/api/files", files);
app.route("/api/archive", archive);
app.route("/api/cross-dups", crossDups);
app.route("/api/pools", pools);
app.route("/api/admin", admin);
app.route("/api", wa);
app.route("/", bot);
app.get("/api/auth/me", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (!token) return c.json({ error: "not_authenticated" }, 401); if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500); const session = await verifySession(token, c.env.SESSION_SECRET); if (!session) return c.json({ error: "session_expired" }, 401); const user: any = await rpc(c.env.INDEX, "global", "user", { id: session.uid }); if (!user) return c.json({ error: "session_expired" }, 401); return c.json({ id: String(user.user_id), name: user.name || "", username: user.username || "", photoUrl: user.photo_url || null, phone: user.phone || null, isAdmin: isAdmin(c.env, session.uid) }); });
app.post("/api/auth/logout", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (token) await rpc(c.env.INDEX, "global", "deleteSession", { token }); const secure = c.req.header("x-forwarded-proto") !== "http" ? " Secure;" : ""; return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `ss_session=; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=0` } }); });
app.post("/api/auth/device/claim", async (c) => {
  if (!checkRate(ipKey(c, "device.claim"), 10, 60000)) return c.json({ ok: false, error: "rate limited" }, 429);
  let body: { token?: string }; try { body = await c.req.json(); } catch { return c.json({ ok: false }, 400); } const did = body.token || ""; if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) return c.json({ ok: false }); const info: any = await rpc(c.env.INDEX, "global", "deviceGet", { did }); if (!info?.chatId || !info.chatId.includes(".")) return c.json({ ok: false }); await rpc(c.env.INDEX, "global", "deviceDelete", { did }); return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(info.chatId, 2592000, c.req.header("x-forwarded-proto") !== "http") } }); });
app.get("/api/bot/info", async (c) => { if (!c.env.TG_BOT_TOKEN) return c.json({ username: "" }); try { const r = await fetch(`https://api.telegram.org/bot${c.env.TG_BOT_TOKEN}/getMe`); if (!r.ok) return c.json({ username: "" }); const j = await r.json() as any; return c.json({ username: j.result?.username || "" }); } catch { return c.json({ username: "" }); } });
app.get("/api/auth/telegram/config", (c) => c.json({ clientId: c.env.TELEGRAM_LOGIN_CLIENT_ID || "" }));
app.post("/api/auth/telegram/verify", async (c) => {
  if (!checkRate(ipKey(c, "telegram.verify"), 20, 60000)) return c.json({ ok: false, error: "rate limited" }, 429);
   let body: { id_token?: string }; try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "invalid body" }, 400); }
   const idToken = String(body.id_token || "").trim();
   if (!idToken || idToken.length > 8192) return c.json({ ok: false, error: "missing id_token" }, 400);
   const clientId = c.env.TELEGRAM_LOGIN_CLIENT_ID;
  if (!clientId) return c.json({ ok: false, error: "telegram login not configured" }, 503);
  if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500);
  let claims: { uid: string; name: string; username: string; picture: string; phone: string };
  try { claims = await verifyTelegramIdToken(idToken, clientId); } catch (e: any) { return c.json({ ok: false, error: String(e?.message || "invalid token") }, 401); }
  await rpc(c.env.INDEX, "global", "ensureUser", { id: claims.uid, name: claims.name, username: claims.username, photoUrl: claims.picture || null, phone: claims.phone || null });
  const token = await signSessionFn(claims.uid, c.env.SESSION_SECRET);
  await rpc(c.env.INDEX, "global", "session", { token, uid: claims.uid, exp: Date.now() + 2592000000 });
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(token, 2592000, c.req.header("x-forwarded-proto") !== "http") } });
});

let webhookChecked = false;
export function startBackgroundTasks(env: Env) {
  if (!webhookChecked) { webhookChecked = true; void ensureWebhook(env).catch((error) => console.error("webhook check failed", error)); }
}
