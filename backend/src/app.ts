// Express app assembly — mirrors the old server's route order (API routes,
// then static, then SPA fallback last).
import compression from "compression";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { FRONTEND_URL, STATIC_ROOT } from "./config/env";
import { errorHandler } from "./middleware/error";
import { requestLogger } from "./middleware/logging";
import { adminRouter } from "./routes/admin";
import { authRouter } from "./routes/auth";
import { createBotRouter, createWebhookRouter } from "./routes/bot";
import { deployRouter } from "./routes/deploy";
import { archiveRouter, crossDupsRouter, filesRouter } from "./routes/files";
import { historyRouter } from "./routes/history";
import { poolsRouter } from "./routes/pools";
import { waRouter } from "./routes/wa";
import { isBotEnabled } from "./services/telegram";
import { redis } from "./services/redis";

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(compression());

  // Trust Railway's TLS-terminating proxy so req.secure reflects HTTPS (drives the
  // SameSite=None cookie decision in auth.ts).
  app.set("trust proxy", 1);

  // CORS — the frontend now calls the api directly (no nginx proxy), so allow only
  // the configured frontend origin with credentials. Preflight for application/json.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === FRONTEND_URL) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Request logger
  app.use(requestLogger);

  // Self-redeploy hook (redeploy.bat → POST /__redeploy). Before API routes.
  app.use(deployRouter);

  // API routes
  app.use("/api/auth", authRouter);
  app.use("/api/files", filesRouter);
  // /api/files/:id/history... — after filesRouter so /:id doesn't shadow it
  app.use("/api/files", historyRouter);
  app.use("/api/pools", poolsRouter);
  app.use("/api/archive", archiveRouter);
  app.use("/api/cross-dups", crossDupsRouter);
  app.use("/api", waRouter); // /api/fb/check, /api/fb/wa-check, /api/wa/cache
  app.use("/api/admin", adminRouter);

  // Health check (no auth)
  app.get("/api/health", (_req, res) => {
    res.json({ status: redis.status === "ready" ? "ok" : redis.status });
  });

  // Bot routes (only when a bot token is configured)
  if (isBotEnabled()) {
    app.use("/api", createBotRouter());
    // Webhook must live at the ROOT path — Telegram is registered with the api's
    // public URL + "/webhook/tg" (direct hit, no nginx proxy).
    app.use(createWebhookRouter());
  }

  // Serve static files (after API routes)
  if (fs.existsSync(STATIC_ROOT)) {
    app.use(express.static(STATIC_ROOT));
  }

  // SPA fallback (last) — serve index.html for unmatched routes, like the old server
  app.get("*", (req, res) => {
    const indexPath = path.join(STATIC_ROOT, "index.html");
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send("index.html not found — build the web app or set STATIC_ROOT");
    }
  });

  // Central error handler (safe addition; old server had none)
  app.use(errorHandler);

  return app;
}
