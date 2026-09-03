import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Old server loaded its repo-root `.env`; mirror that by loading the monorepo
// root `.env` (falls back to process env if absent).
// NOTE: this file is at <root>/backend/src/config/env.ts → THREE levels up
// to the monorepo root (config → src → backend → root).
const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
dotenv.config({ path: path.join(repoRoot, "backend", ".env") });

export const PORT = parseInt(process.env.PORT || "3000", 10);

export const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
export const REDIS_BACKUP_URL = process.env.REDIS_BACKUP_URL || "";

export const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const ADMIN_IDS_RAW = process.env.ADMIN_IDS;
export const ADMIN_IDS = (ADMIN_IDS_RAW || "8447133985,1772093705")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (!ADMIN_IDS_RAW) {
  console.warn("[Env] WARNING: ADMIN_IDS not set — granting admin to hardcoded fallback ids " + JSON.stringify(ADMIN_IDS) + ". Set ADMIN_IDS in production.");
}

export const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";

// Public URL of the backend API service itself (auto from Railway when the api
// service has a public domain). Used for the Telegram webhook registration.
export const BACKEND_PUBLIC_URL = RAILWAY_PUBLIC_DOMAIN
  ? "https://" + RAILWAY_PUBLIC_DOMAIN
  : "";

// Railway-style vars often come in without a scheme ("seal.up.railway.app").
// Normalize so login links / webhook URLs are always absolute.
function withScheme(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^localhost(:\d+)?$/i.test(url)) return "http://" + url;
  return "https://" + url;
}

// FRONTEND_URL = public URL of the web (frontend) service. The frontend serves the
// SPA; the api allows it via CORS and redirects login callbacks back to it.
export const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "")
  ? withScheme((process.env.FRONTEND_URL || "").replace(/\/+$/, ""))
  : `http://localhost:${PORT}`;

// Optional override for the Telegram webhook URL (base, without the path). If set,
// backend registers the webhook here directly (e.g. the api's own public URL)
// instead of the frontend/nginx path. Set it to the api's public URL only if you
// want Telegram to hit the backend directly.
export const WEBHOOK_URL = process.env.WEBHOOK_URL
  ? withScheme((process.env.WEBHOOK_URL || "").replace(/\/+$/, ""))
  : "";

// Base URL where the api's own routes live (login callback + webhook). When the
// frontend reverse-proxies /api, LOGIN_BASE must be the FRONTEND_URL so the session
// cookie is set first-party (browser 3rd-party cookie blocking drops cross-site
// cookie writes). Explicit LOGIN_BASE env wins, then WEBHOOK_URL, then the api's
// public URL, then (local dev) the frontend dev URL which proxies /api.
export const LOGIN_BASE = process.env.LOGIN_BASE
  ? withScheme((process.env.LOGIN_BASE || "").replace(/\/+$/, ""))
  : WEBHOOK_URL || BACKEND_PUBLIC_URL || FRONTEND_URL;

export const HISTORY_RETENTION_DAYS = parseInt(process.env.HISTORY_RETENTION_DAYS || "30", 10);
export const HISTORY_CHECKPOINT_EVERY = parseInt(process.env.HISTORY_CHECKPOINT_EVERY || "20", 10);
export const HISTORY_GC_INTERVAL_MS =
  parseInt(process.env.HISTORY_GC_INTERVAL_MS || String(6 * 60 * 60 * 1000), 10);

export const WA_CACHE_TTL_MS = (parseInt(process.env.WA_CACHE_TTL_HOURS || "0", 10) || 0) * 60 * 60 * 1000;

export const BACKUP_INTERVAL_MS = (parseInt(process.env.BACKUP_INTERVAL || "5", 10) || 5) * 60 * 1000;

// Directory served as static root (old server: old repo root; new default:
// the built web app). Set STATIC_ROOT to the old repo root for parity testing.
export const STATIC_ROOT =
  process.env.STATIC_ROOT || path.join(repoRoot, "frontend", "dist");
