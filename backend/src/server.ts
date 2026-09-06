import { serve } from "bun";
import { app, startBackgroundTasks } from "./index";
import type { Env } from "./lib/shared";
import { closeDatabase } from "./lib/pg";

const env: Env = {
  INDEX: "index",
  FILES: "files",
  POOLS: "pools",
  DATABASE_URL: process.env.DATABASE_URL || "",
  SESSION_SECRET: process.env.SESSION_SECRET,
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
  ADMIN_IDS: process.env.ADMIN_IDS,
  TURNSTILE_SECRET: process.env.TURNSTILE_SECRET,
  TURNSTILE_SITE_KEY: process.env.TURNSTILE_SITE_KEY,
  TG_WEBHOOK_SECRET: process.env.TG_WEBHOOK_SECRET,
  WORKER_URL: process.env.WORKER_URL,
  FRONTEND_URL: process.env.FRONTEND_URL,
  HITOOLS_CHECK_URL: process.env.HITOOLS_CHECK_URL,
  TELEGRAM_LOGIN_CLIENT_ID: process.env.TELEGRAM_LOGIN_CLIENT_ID,
};

if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const port = Number(process.env.PORT || 3000);
const server = serve({ port, hostname: "0.0.0.0", fetch: (request) => { startBackgroundTasks(env); return app.fetch(request, env); } });
console.log(`SheetSubmit backend listening on 0.0.0.0:${port}`);

let stopping = false;
async function shutdown(signal: string) { if (stopping) return; stopping = true; console.log(`${signal}: shutting down`); server.stop(true); await closeDatabase(); process.exit(0); }
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
