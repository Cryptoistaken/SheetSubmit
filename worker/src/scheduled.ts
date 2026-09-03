import { ensureWebhook } from "./routes/bot";

export async function scheduled(_event: ScheduledEvent, env: unknown, ctx: ExecutionContext) {
  const e = env as Parameters<typeof ensureWebhook>[0];
  if (e?.TG_BOT_TOKEN) ctx.waitUntil(ensureWebhook(e));
  /* DO alarms prune history independently. */
}
