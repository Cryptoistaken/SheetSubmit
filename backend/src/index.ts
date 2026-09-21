import { Hono } from "hono";
import type { Context, Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { compress } from "hono/compress";
import { etag } from "hono/etag";
import type { Env } from "./lib/shared";
import { requireAuth, isAdmin, cookie, verifySession, evictSessions } from "./lib/session";
import { rpc } from "./lib/do";
import { rateLimit } from "./lib/redis";
import { fetchWorkerHealth } from "./lib/workerHealth";
import { startWorkerJobs } from "./worker/runner";
import { files, archive, crossDups } from "./routes/files";
import { live } from "./routes/live";
import { pools } from "./routes/pools";
import { admin } from "./routes/admin";
import { wa } from "./routes/wa";
import { bot, ensureWebhook } from "./routes/bot";
import { testAuth } from "./routes/testAuth";
import { agent } from "./routes/agent";
import { agentDoorOpen } from "./lib/agent";
import { verifyTelegramIdToken } from "./lib/telegramOidc";
import { signSession as signSessionFn } from "./lib/session";
import { logEvent, newReqId } from "./lib/log";

export const app = new Hono<{ Bindings: Env; Variables: { uid: string; logCtx?: Record<string, unknown> } }>();
// ponytail: manual bump on any backend route change — lets health checks confirm a deploy landed
export const API_VERSION = "2.0.37";
// ponytail: repository errors are plain Errors — map known client failures to typed
// 4xx JSON instead of masking everything as 500. Unknown (incl. SQL internals) stays masked.
const CLIENT_ERRORS: [RegExp, ContentfulStatusCode][] = [
  [/not found|file not found|withdrawal not found/i, 404],
  [/cannot be deleted|decision is final|version conflict|on hold|locked|already approved|already rejected|insufficient wallet balance/i, 409],
  [/upstream|service unavailable|jwks unavailable|timed? ?out|fetch failed/i, 502],
  [/could not |temporarily unavailable/i, 503],
  [/invalid|required|too many|too large|exclusive|pick mode|verified|already|not a hold|not revertable|expired|unsupported|conflict/i, 400],
];
app.onError((err, c) => {
  const message = String((err as Error)?.message || "").slice(0, 256);
  // ponytail: no separate error line — the wide-event middleware below merges
  // this into the single per-request event (logging-best-practices).
  try {
    c.set("logCtx", { ...(c.get("logCtx") ?? {}), error: message || String(err).slice(0, 256) });
  } catch { /* context must never break error mapping */ }
  for (const [re, status] of CLIENT_ERRORS) if (re.test(message)) return c.json({ error: message }, status);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "not found" }, 404));
// ponytail: one JSON wide event per API request (method/path/status/ms/uid) —
app.use("/api/*", async (c, next) => {
  const t = Date.now();
  const req_id = newReqId();
  try {
    await next();
  } finally {
    let uid: string | undefined;
    try {
      uid = c.get("uid") || undefined;
    } catch { /* unauthenticated */ }
    let ctx: Record<string, unknown> = {};
    try {
      ctx = c.get("logCtx") ?? {};
    } catch { /* never break the response path */ }
    logEvent(c.res.status >= 500 ? "error" : "info", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      duration_ms: Date.now() - t,
      req_id,
      version: API_VERSION,
      ...(uid ? { uid } : {}),
      ...ctx,
    });
  }
});
app.use("/api/*", async (c, next) => {
  const origin = c.req.header("Origin") || "";
  // ponytail: unconditional — an Origin-less first hit gets edge-cached; without
  // Vary: Origin every later browser gets the ACAO-less copy → CORS failures
  c.header("Vary", "Origin");
  const allowed = [c.env.FRONTEND_URL, "https://sheetsubmit.pages.dev", "http://localhost:5173", "http://127.0.0.1:5173"].filter(Boolean) as string[];
  if (origin && allowed.includes(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,HEAD,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization,Cache-Control,Pragma,Priority,If-None-Match");
    c.header("Access-Control-Expose-Headers", "ETag");
    c.header("Access-Control-Max-Age", "86400");
  }
  if (c.req.method === "OPTIONS") {
    const headers: Record<string, string> = {};
    if (origin && allowed.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Vary"] = "Origin";
      headers["Access-Control-Allow-Credentials"] = "true";
      headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,PATCH,HEAD,OPTIONS";
      headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization,Cache-Control,Pragma,Priority,If-None-Match";
      headers["Access-Control-Expose-Headers"] = "ETag";
      headers["Access-Control-Max-Age"] = "86400";
    }
    return new Response(null, { status: 204, headers });
  }
  return next();
});
// ponytail: chunked requests carry no Content-Length — clone-read with a cap
// instead of buffering the real body (clone keeps the original stream intact).
app.use("/api/*", async (c, next) => {
  const len = Number(c.req.header("Content-Length"));
  if (Number.isFinite(len) && len > 4_000_000) return c.json({ error: "payload too large" }, 413);
  if (!c.req.header("Content-Length")) {
    const body = c.req.raw.clone().body;
    if (body) {
      const reader = body.getReader();
      let total = 0;
      try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value?.byteLength ?? 0; if (total > 4_000_000) { await reader.cancel().catch(() => {}); return c.json({ error: "payload too large" }, 413); } } }
      catch { return c.json({ error: "invalid body" }, 400); }
      finally { try { reader.releaseLock(); } catch {} }
    }
  }
  return next();
});
// ponytail: Server-Timing separates backend ms from network ms when diagnosing slow APIs
app.use("/api/*", async (c, next) => { const t = Date.now(); await next(); c.header("Server-Timing", `app;dur=${Date.now() - t}`); });
// compress after CORS so Vary: Origin is kept (compress appends Accept-Encoding); xlsx blobs are skipped by hono's compressible-type filter
app.use("/api/*", compress());
// ETag/304 only for public, low-churn endpoints — never on authed/user-specific routes
app.use("/api/bot/info", etag());
app.use("/api/auth/telegram/config", etag());
// ponytail: hono's etag() rebuilds 304s with only ETag (CORS headers dropped),
// but authed file reads are cross-origin in prod. Roll the 20-line equivalent
// that keeps the headers on the 304; `private` + no-cache forces revalidation
// and lets the browser serve the stored 200 on a match.
const privateEtag = () => async (c: Context, next: Next) => {
  await next();
  if (c.req.method !== "GET" || c.res.status !== 200) return;
  // never buffer streams (SSE /api/files/*/live) or xlsx blobs — JSON only
  if (!(c.res.headers.get("content-type") || "").includes("application/json")) return;
  const body = await c.res.clone().arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", body));
  const tag = `"${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  c.header("Cache-Control", "private, no-cache");
  if (c.req.header("If-None-Match") === tag) {
    const headers = new Headers({ ETag: tag, "Cache-Control": "private, no-cache" });
    for (const k of ["Access-Control-Allow-Origin", "Access-Control-Allow-Credentials", "Vary"]) {
      const v = c.res.headers.get(k);
      if (v) headers.set(k, v);
    }
    c.res = new Response(null, { status: 304, headers });
  } else {
    c.res.headers.set("ETag", tag);
  }
};
app.use("/api/files", privateEtag());
app.use("/api/files/*", privateEtag());
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now(), version: API_VERSION }));
// Reports the in-process worker loop stats so scheduling is verifiable from the public backend URL
app.get("/api/worker/health", async (c) => {
  const r = await fetchWorkerHealth(c.env);
  return r.ok ? c.json({ ok: true, worker: r.worker }) : c.json({ ok: false, worker: null, error: r.error }, r.status);
});
app.get("/api/wallet", requireAuth, async (c) => { const uid = c.get("uid"); const [wallet, withdrawals, transactions] = await Promise.all([rpc(c.env.INDEX, "global", "walletGet", { uid }), rpc(c.env.INDEX, "global", "walletWithdrawals", { uid }), rpc(c.env.INDEX, "global", "walletTxList", { uid })]); return c.json({ ...(wallet as object), withdrawals, transactions }); });
app.get("/api/wallet/balance", requireAuth, async (c) => c.json(await rpc(c.env.INDEX, "global", "walletGet", { uid: c.get("uid") })));
app.post("/api/wallet/withdraw", requireAuth, async (c) => { let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); } const amount = Number(body?.amount); const method = String(body?.method || "").trim(); const account = String(body?.account || "").trim(); const rid = String(body?.requestId || "").trim(); if (rid && !/^[A-Za-z0-9-]{8,64}$/.test(rid)) return c.json({ error: "invalid requestId" }, 400); if (!Number.isFinite(amount) || amount <= 0 || amount > 100000 || !method || method.length > 64 || account.length < 3 || account.length > 256) return c.json({ error: "invalid withdrawal" }, 400); try { return c.json(await rpc(c.env.INDEX, "global", "walletWithdraw", { uid: c.get("uid"), id: rid || crypto.randomUUID(), amount: Math.round(amount * 100) / 100, method: method.slice(0, 64), account })); } catch (error) { const message = String((error as Error)?.message || ""); if (message.includes("insufficient")) return c.json({ error: "insufficient balance" }, 400); throw error; } });
app.get("/api/wallet/requests", requireAuth, async (c) => { if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); return c.json(await rpc(c.env.INDEX, "global", "walletRequests", { status: c.req.query("status") || "" })); });
app.post("/api/wallet/requests/:id/:action", requireAuth, async (c) => { if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); const action = c.req.param("action"); if (action !== "approve" && action !== "reject") return c.json({ error: "unsupported action" }, 400); try { return c.json(await rpc(c.env.INDEX, "global", "walletDecision", { id: c.req.param("id"), status: action === "approve" ? "APPROVED" : "REJECTED" })); } catch (error) { if (String((error as Error)?.message || "").includes("withdrawal not found")) return c.json({ error: "withdrawal not found" }, 404); throw error; } });
app.post("/api/wallet/credit", requireAuth, async (c) => { if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); } const uid = String(body?.uid || ""); const amount = Math.round(Number(body?.amount) * 100) / 100; const title = String(body?.title || "").trim().slice(0, 128) || "Manual credit"; if (!uid || uid.length > 64 || !Number.isFinite(amount) || amount <= 0 || amount > 100000) return c.json({ error: "invalid credit" }, 400); const direction = String(body?.direction || "credit").toLowerCase(); if (direction !== "credit" && direction !== "debit") return c.json({ error: "invalid direction" }, 400); const target: any = await rpc(c.env.INDEX, "global", "adminUser", { id: uid }); if (!target) return c.json({ error: "user not found" }, 404); try { return c.json(await rpc(c.env.INDEX, "global", "walletCredit", { uid, amount, title, direction, adminUid: c.get("uid") })); } catch (error) { if (String((error as Error)?.message || "").includes("insufficient")) return c.json({ error: "insufficient balance" }, 400); throw error; } });
app.get("/api/wallet/methods", requireAuth, async (c) => { return c.json(await rpc(c.env.INDEX, "global", "paymentMethodsGet", { uid: c.get("uid") })); });
app.put("/api/wallet/methods", requireAuth, async (c) => { let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid body" }, 400); } const methods = body?.methods ?? {}; if (typeof methods !== "object" || methods === null || Array.isArray(methods)) return c.json({ error: "invalid methods" }, 400); if (Object.keys(methods).length > 20 || JSON.stringify(methods).length > 10000) return c.json({ error: "invalid methods" }, 400); return c.json(await rpc(c.env.INDEX, "global", "paymentMethodsSet", { uid: c.get("uid"), methods })); });
// live row-state stream (ticket-authed, no session) mounts before the files
// router: its /* session middleware would otherwise reject ticketed streams
app.route("/api", live);
app.route("/api/files", files);
app.route("/api/archive", archive);
app.route("/api/cross-dups", crossDups);
app.route("/api/pools", pools);
app.route("/api/admin", admin);
app.route("/api", wa);
  app.route("/", bot);
  // TEST-ONLY: POST /api/test/login — 404s unless ALLOW_TEST_AUTH=1 (never prod)
  app.route("/api/test", testAuth);
  // DEV-ONLY agent door — 404s unless ALLOW_AGENT_ACCESS=1 + AGENT_TOKEN (never prod)
  app.route("/api/agent", agent);
app.get("/api/auth/me", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (!token) return c.json({ error: "not_authenticated", loginRequired: true }, 401); if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500); let session: { uid: string } | null = null; try { session = await verifySession(token, c.env.SESSION_SECRET); } catch { return c.json({ error: "session_expired", loginRequired: true }, 401); } if (!session) return c.json({ error: "session_expired", loginRequired: true }, 401); try { const dbSession: any = await rpc(c.env.INDEX, "global", "getSession", { token }); if (!dbSession) return c.json({ error: "session_expired", loginRequired: true }, 401); } catch { return c.json({ error: "session_expired", loginRequired: true }, 401); } const user: any = await rpc(c.env.INDEX, "global", "user", { id: session.uid }); if (!user) return c.json({ error: "session_expired", loginRequired: true }, 401); if (user.banned) return c.json({ error: "account_banned", loginRequired: true }, 403); return c.json({ id: String(user.user_id), name: user.name || "", username: user.username || "", photoUrl: user.photo_url || null, phone: user.phone || null, isAdmin: isAdmin(c.env, session.uid) }); });
app.post("/api/auth/logout", async (c) => { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (token) { evictSessions(undefined, token); await rpc(c.env.INDEX, "global", "deleteSession", { token }); } const secure = c.req.header("x-forwarded-proto") !== "http" ? " Secure;" : ""; return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json", "Set-Cookie": `ss_session=; Path=/; HttpOnly;${secure ? " Secure; SameSite=None" : " SameSite=Lax"}; Max-Age=0` } }); });
app.post("/api/auth/device/claim", async (c) => {
  let body: { token?: string }; try { body = await c.req.json(); } catch { return c.json({ ok: false }, 400); } const did = body.token || ""; if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) return c.json({ ok: false }); const info: any = await rpc(c.env.INDEX, "global", "deviceGet", { did }); if (!info?.chatId || !info.chatId.includes(".")) return c.json({ ok: false }); await rpc(c.env.INDEX, "global", "deviceDelete", { did }); return new Response(JSON.stringify({ ok: true, sessionId: info.chatId }), { headers: { "Content-Type": "application/json", "Set-Cookie": cookie(info.chatId, 2592000, c.req.header("x-forwarded-proto") !== "http") } }); });
// ponytail: getMe is env-static — module-memory cache keyed by token (success 10min, failure 60s)
let botCache: { token: string; username: string; exp: number } | null = null;
app.get("/api/bot/info", async (c) => { const token = c.env.TG_BOT_TOKEN || ""; if (botCache && botCache.token === token && Date.now() < botCache.exp) { c.header("Cache-Control", "public, max-age=600"); return c.json({ username: botCache.username }); } if (!token) return c.json({ username: "" }); try { const r = await fetch(`https://api.telegram.org/bot${token}/getMe`); if (!r.ok) { botCache = { token, username: "", exp: Date.now() + 60_000 }; return c.json({ username: "" }); } const j = await r.json() as any; const username = j.result?.username || ""; botCache = { token, username, exp: Date.now() + (username ? 600_000 : 60_000) }; c.header("Cache-Control", "public, max-age=600"); return c.json({ username }); } catch { botCache = { token, username: "", exp: Date.now() + 60_000 }; return c.json({ username: "" }); } });
app.get("/api/auth/telegram/config", (c) => { c.header("Cache-Control", "public, max-age=3600"); return c.json({ clientId: c.env.TELEGRAM_LOGIN_CLIENT_ID || "" }); });
app.post("/api/auth/telegram/verify", async (c) => {
   const ip = String(c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
   if (!(await rateLimit(`rl:auth:tg:${ip}`, 30, 60))) return c.json({ ok: false, error: "Rate limited", code: "rate_limited" }, 429);
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
let settleTimer: ReturnType<typeof setInterval> | null = null;
export function startBackgroundTasks(env: Env) {
  if (agentDoorOpen(env)) console.warn("[agent] DEV DOOR OPEN — unset ALLOW_AGENT_ACCESS before prod");
  if (!webhookChecked) { webhookChecked = true; void ensureWebhook(env).catch((error) => console.error("webhook check failed", error)); }
  // pay out holds whose 5-minute revert window closed (see settleHolds in pg.ts) + drop expired sessions (getSession already ignores them; uses sessions_exp_idx, max 1000/tick)
  // 10min cadence so Neon can suspend between runs (settle payouts may lag up to ~15min)
  if (!settleTimer) settleTimer = setInterval(() => { void rpc(env.INDEX, "global", "settleHolds", {}).catch((error) => console.error("hold settle failed", error)); void rpc(env.INDEX, "global", "sessionCleanup", {}).catch((error) => console.error("session cleanup failed", error)); }, 600_000);
  // merged worker loop (sweeps + backup sync) runs in-process, fire-and-forget
  void startWorkerJobs().catch((error) => console.error("worker loop failed", error));
}
