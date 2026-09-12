import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { requireAgent } from "../lib/agent";
import { rpc } from "../lib/do";
import { pingDatabase } from "../lib/pg";
import { fetchWorkerHealth } from "../lib/workerHealth";

// DEV-ONLY introspection for the debugging agent (see lib/agent.ts).
// Read-only: health, route map, global stats, worker proxy, config presence.
// Never returns secret values, user rows, or pool rows — only presence flags.
export const agent = new Hono<{ Bindings: Env; Variables: { uid: string; agent: boolean } }>();
agent.use("/*", requireAgent);

agent.get("/health", async (c) => {
  let db = false;
  try { await pingDatabase(); db = true; } catch { db = false; }
  return c.json({ ok: true, ts: Date.now(), door: true, db, redis: !!c.env.REDIS_URL });
});

agent.get("/routes", (c) => c.json([
  "GET /api/health", "GET /api/worker/health",
  "GET /api/wallet", "GET /api/wallet/balance", "POST /api/wallet/withdraw", "GET /api/wallet/requests", "POST /api/wallet/requests/:id/:action", "POST /api/wallet/credit",
  "GET|PUT /api/wallet/methods",
  "GET /api/auth/me", "POST /api/auth/logout", "POST /api/auth/device/claim",
  "GET /api/auth/telegram/config", "POST /api/auth/telegram/verify",
  "GET /api/bot/info", "POST /webhook/tg", "POST /api/test/login",
  "GET|POST /api/files", "PUT|DELETE /api/files/:id", "GET /api/files/:id/rows", "GET /api/files/:id/full",
  "PUT /api/files/:id/persist", "POST /api/files/:id/restore-snapshot", "PUT /api/files/:id/append",
  "POST /api/files/:id/live-ticket", "GET /api/files/:id/live", "GET /api/files/:id/live-state",
  "GET /api/archive", "GET /api/archive/:id/rows", "GET /api/archive/:id/full", "POST /api/archive/:id/restore", "POST /api/archive/batch-restore",
  "DELETE /api/archive/:id", "POST /api/archive/batch-delete",
  "GET /api/cross-dups",
  "GET /api/pools", "GET /api/pools/prices", "GET|PUT /api/pools/flags",
  "GET /api/pools/holds", "POST /api/pools/holds/:id/approve|reject|return",
  "GET /api/pools/downloads", "GET /api/pools/downloads/:id/detail", "GET /api/pools/downloads/:id",
  "POST /api/pools/downloads/:id/revert", "DELETE /api/pools/downloads/:id",
  "GET /api/pools/:password/:pool", "GET /api/pools/:password/:pool/view", "GET /api/pools/:password/:pool/rows",
  "GET /api/pools/:password/:pool/verified-counts", "GET /api/pools/:password/:pool/user-files",
  "GET|PUT /api/pools/:password/:pool/price", "GET /api/pools/:password/:pool/ledger (410)",
  "POST /api/pools/:password/:pool/claim|hold",
  "POST /api/pools/:password/:pool/live-ticket", "GET /api/pools/:password/:pool/live", "GET /api/pools/:password/:pool/live-state",
  "GET /api/admin/stats", "GET /api/admin/users", "GET /api/admin/users/search",
  "GET /api/admin/user/:id", "GET /api/admin/user/:id/archive",
  "POST /api/admin/user/:id/archive/:fileId/restore", "DELETE /api/admin/user/:id/archive/:fileId",
  "POST /api/admin/user/:id/:action", "DELETE /api/admin/user/:id",
  "GET|PUT|DELETE /api/admin/file/:id", "GET /api/admin/file/:id/rows", "GET /api/admin/file/:id/logs", "GET /api/admin/file/:id/undo",
  "PUT /api/admin/file/:id/persist", "POST /api/admin/file/:id/restore-snapshot", "GET /api/admin/pooldiag",
  "POST /api/fb/check", "POST /api/fb/page-simple", "POST /api/fb/page-advanced", "GET|POST /api/fb/cache",
  "GET /api/agent/health", "GET /api/agent/routes", "GET /api/agent/stats",
  "GET /api/agent/worker", "GET /api/agent/config",
]));

agent.get("/stats", async (c) => c.json(await rpc(c.env.INDEX, "global", "stats")));

agent.get("/worker", async (c) => {
  const r = await fetchWorkerHealth(c.env);
  return r.ok ? c.json({ ok: true, worker: r.worker }) : c.json({ ok: false, worker: null, error: r.error }, r.status);
});

// presence flags only — values never leave the server
agent.get("/config", (c) => c.json({
  databaseUrl: !!c.env.DATABASE_URL, redisUrl: !!c.env.REDIS_URL, sessionSecret: !!c.env.SESSION_SECRET,
  tgBotToken: !!c.env.TG_BOT_TOKEN, adminIds: !!c.env.ADMIN_IDS, tgWebhookSecret: !!c.env.TG_WEBHOOK_SECRET,
  backendUrl: !!c.env.BACKEND_URL, frontendUrl: !!c.env.FRONTEND_URL, workerUrl: !!c.env.WORKER_URL,
  checkUrl: !!c.env.CHECK_URL, telegramLogin: !!c.env.TELEGRAM_LOGIN_CLIENT_ID,
  allowTestAuth: c.env.ALLOW_TEST_AUTH === "1", agentDoor: true,
}));
