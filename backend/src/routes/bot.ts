// Bot routes — registered only when a bot token is configured (mirrors old server).
import { Router } from "express";
import { asyncRoute } from "../middleware/asyncRoute";
import { botUsername, handleBotUpdate } from "../services/telegram";

// /api/bot/info (old: app.get('/api/bot/info'))
export function createBotRouter(): Router {
  const botRouter = Router();

  botRouter.get("/bot/info", asyncRoute(async (_req, res) => {
    res.json({ username: botUsername });
  }));

  return botRouter;
}

// /webhook/tg at ROOT, not under /api — Telegram's registered webhook URL is
// api public URL + "/webhook/tg" (direct hit, no nginx proxy).
export function createWebhookRouter(): Router {
  const webhookRouter = Router();

  webhookRouter.post("/webhook/tg", asyncRoute(async (req, res) => {
    res.sendStatus(200);
    void handleBotUpdate(req.body as Parameters<typeof handleBotUpdate>[0]).catch((e) =>
      console.error("[Bot] webhook update error:", (e as Error).message),
    );
  }));

  return webhookRouter;
}
