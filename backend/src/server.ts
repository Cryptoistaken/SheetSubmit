import { serve } from "bun";
import { app, startBackgroundTasks } from "./index";
import type { Env } from "./lib/shared";
import { closeDatabase } from "./lib/pg";

const env: Env = {
  INDEX: "index",
  FILES: "files",
  POOLS: "pools",
  DATABASE_URL: Bun.env.DATABASE_URL || "",
  SESSION_SECRET: Bun.env.SESSION_SECRET,
  TG_BOT_TOKEN: Bun.env.TG_BOT_TOKEN,
  ADMIN_IDS: Bun.env.ADMIN_IDS,
  TURNSTILE_SECRET: Bun.env.TURNSTILE_SECRET,
  TURNSTILE_SITE_KEY: Bun.env.TURNSTILE_SITE_KEY,
  TG_WEBHOOK_SECRET: Bun.env.TG_WEBHOOK_SECRET,
  WORKER_URL: Bun.env.WORKER_URL || Bun.env.RAILWAY_PUBLIC_DOMAIN,
  FRONTEND_URL: Bun.env.FRONTEND_URL,
  HITOOLS_CHECK_URL: Bun.env.HITOOLS_CHECK_URL,
  TELEGRAM_LOGIN_CLIENT_ID: Bun.env.TELEGRAM_LOGIN_CLIENT_ID,
};

if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const port = Number(Bun.env.PORT || 3000);
startBackgroundTasks(env);
const server = serve({ port, hostname: "0.0.0.0", fetch: (request) => { startBackgroundTasks(env); return app.fetch(request, env); } });
console.log(`SheetSubmit backend listening on 0.0.0.0:${port}`);

let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`${signal}: shutting down`); server.stop(true); await closeDatabase(); process.exit(0); }
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
