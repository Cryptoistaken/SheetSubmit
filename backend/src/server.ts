import { serve } from "bun";
import { app, startBackgroundTasks } from "./index";
import type { Env } from "./lib/shared";
import { bootstrapDatabase, closeDatabase } from "./lib/pg";
import { closeRedis, subscribeLiveEvents } from "./lib/redis";
import { isLiveStreamPathname, parseLiveEvent } from "./lib/live";
import { publishKeyStates } from "./lib/livePublish";

const env: Env = {
  INDEX: "index",
  FILES: "files",
  POOLS: "pools",
  DATABASE_URL: Bun.env.DATABASE_URL || "",
  SESSION_SECRET: Bun.env.SESSION_SECRET,
  TG_BOT_TOKEN: Bun.env.TG_BOT_TOKEN,
  ADMIN_IDS: Bun.env.ADMIN_IDS,
  TG_WEBHOOK_SECRET: Bun.env.TG_WEBHOOK_SECRET,
  BACKEND_URL: Bun.env.BACKEND_URL || Bun.env.RAILWAY_PUBLIC_DOMAIN,
  FRONTEND_URL: Bun.env.FRONTEND_URL,
  WORKER_URL: Bun.env.WORKER_URL,
  CHECK_URL: Bun.env.CHECK_URL,
  ALLOW_TEST_AUTH: Bun.env.ALLOW_TEST_AUTH,
  TELEGRAM_LOGIN_CLIENT_ID: Bun.env.TELEGRAM_LOGIN_CLIENT_ID,
  REDIS_URL: Bun.env.REDIS_URL,
  AGENT_TOKEN: Bun.env.AGENT_TOKEN,
  ALLOW_AGENT_ACCESS: Bun.env.ALLOW_AGENT_ACCESS,
};

if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const port = Number(Bun.env.PORT || 3000);
await bootstrapDatabase();
startBackgroundTasks(env);
// worker → rooms relay: held-uid-check deaths arrive on the live channel
// (fail-open — without REDIS_URL this simply never fires and clients resync
// on reconnect/poll instead)
void subscribeLiveEvents((message) => {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return;
  }
  const keys = parseLiveEvent(raw);
  if (keys && keys.length) void publishKeyStates(keys).catch(() => {});
});
const server = serve({
  port,
  hostname: "0.0.0.0",
  fetch: (request, srv) => {
    // SSE streams are quiet between pushes — Bun closes connections after
    // 10s idle by default, which killed every live stream (file + pool) and
    // left the client reconnecting forever. Disabled per-request for streams
    // only; the 15s :ping keeps intermediate proxies alive.
    try {
      if (isLiveStreamPathname(new URL(request.url).pathname)) srv.timeout(request, 0);
    } catch {}
    return app.fetch(request, env);
  },
});
console.log(`SheetSubmit backend listening on 0.0.0.0:${port}`);

let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`${signal}: shutting down`); server.stop(true); await closeDatabase(); await closeRedis(); process.exit(0); }
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
