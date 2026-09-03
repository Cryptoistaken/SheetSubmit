// Auth routes — ported from the old server (API contract unchanged).
import { Router } from "express";
import { BACKEND_PUBLIC_URL, FRONTEND_URL, TG_BOT_TOKEN as BOT_TOKEN } from "../config/env";
import { asyncRoute } from "../middleware/asyncRoute";
import { delKey, getJSON, key, redis, setJSONex } from "../services/redis";
import { completeTelegramLogin, tg } from "../services/telegram";
import { getSessionId, invalidateSession, isAdmin } from "../middleware/auth";

export const authRouter = Router();

// Session cookie. Cross-origin (frontend ↔ api are different origins now that
// there is no nginx proxy), so production needs SameSite=None; Secure — browsers
// otherwise drop the cookie on cross-site fetches. Over plain HTTP (local dev)
// SameSite=None is rejected, so fall back to SameSite=Lax.
function sessionCookie(value: string, secure: boolean): string {
  const base = "session=" + value + "; Path=/; HttpOnly; Max-Age=" + (value ? 2592000 : 0);
  return secure ? base + "; SameSite=None; Secure" : base + "; SameSite=Lax";
}

// Telegram login callback (device/login link → session cookie)
authRouter.get("/telegram", asyncRoute(async (req, res) => {
  const token = String(req.query.token || "");
  if (!token) {
    res.status(400).send("Missing token");
    return;
  }
  console.log("[Auth] login callback with token=" + token.slice(0, 8) + "...");

  const loginData = await getJSON<{ chatId: string; did?: string }>("login:" + token);
  if (!loginData) {
    console.log("[Auth] invalid token");
    res.status(400).send("Invalid or expired token");
    return;
  }

  console.log("[Auth] login for chatId=" + loginData.chatId);
  const result = await completeTelegramLogin(loginData.chatId, loginData.did);
  await delKey("login:" + token);
  if (!result.ok) {
    if (result.reason === "banned") {
      console.log("[Auth] blocked login for banned user id=" + loginData.chatId);
      res.status(403).json({ error: "account banned" });
    } else {
      console.log("[Auth] failed to get user info");
      res.status(500).send("Failed to get user info");
    }
    return;
  }

  res.setHeader("Set-Cookie", sessionCookie(result.sessionId, req.secure));
  console.log("[Auth] session created, redirecting");

  // Login now happens on the api origin (link goes straight to the api's public
  // URL), so bounce the user back to the frontend.
  res.redirect(FRONTEND_URL + "/");
}));

// Serve the Telegram profile photo for a user (results cached to avoid
// hammering the Telegram API on every hit — /photo/:userId is unauthenticated).
authRouter.get("/photo/:userId", asyncRoute(async (req, res) => {
  const userId = req.params.userId;
  const photoUrl = (path: string) => "https://api.telegram.org/file/bot" + BOT_TOKEN + "/" + path;

  const cached = await getJSON<{ path?: string }>("photo:" + userId);
  if (cached && cached.path) {
    res.redirect(photoUrl(cached.path));
    return;
  }

  const user = await getJSON<{ fileId?: string }>("user:" + userId);
  if (!user || !user.fileId) {
    res.status(404).end();
    return;
  }

  let path: string | null = null;
  try {
    const fileRes = await tg("getFile", { file_id: user.fileId });
    if (fileRes.ok && fileRes.result && fileRes.result.file_path) {
      path = fileRes.result.file_path;
      await setJSONex("photo:" + userId, { path, ts: Date.now() }, 86400);
    }
  } catch {
    // fall through to cache fallback below
  }

  if (path) {
    res.redirect(photoUrl(path));
    return;
  }
  const fallback = await getJSON<{ path?: string }>("photo:" + userId);
  if (fallback && fallback.path) {
    res.redirect(photoUrl(fallback.path));
    return;
  }
  res.status(404).end();
}));

authRouter.get("/logout", asyncRoute(async (req, res) => {
  const sessionId = getSessionId(req);
  console.log("[Auth] logout session=" + (sessionId ? sessionId.slice(0, 8) + "..." : "none"));
  if (sessionId) {
    const session = await getJSON<{ userId: string | number }>("session:" + sessionId);
    await delKey("session:" + sessionId);
    if (session) await redis.srem(key("userSessions:" + String(session.userId)), sessionId);
    invalidateSession(sessionId);
  }
  res.setHeader("Set-Cookie", sessionCookie("", req.secure));
  res.json({ ok: true });
}));

authRouter.get("/me", asyncRoute(async (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    res.json(null);
    return;
  }
  const session = await getJSON<{ userId: string | number }>("session:" + sessionId);
  if (!session) {
    console.log("[Auth] me: session expired");
    res.json(null);
    return;
  }
  const user = await getJSON<Record<string, any>>("user:" + session.userId);
  const banned = await getJSON("ban:" + session.userId);
  if (banned) {
    console.log("[Auth] me: banned user, returning null");
    res.json(null);
    return;
  }
  if (user) {
    // Absolute URL so the cross-origin frontend <img> can load the photo.
    user.photoUrl = user.fileId ? (BACKEND_PUBLIC_URL || "") + "/api/auth/photo/" + user.id : null;
    user.isAdmin = isAdmin(user.id);
  }
  console.log(
    "[Auth] me: user=" + (user ? user.username || user.firstName || user.id : "null") +
    " admin=" + (user ? user.isAdmin : false),
  );
  res.json(user || null);
}));

// Device login poll (used by the Android WebView app)
authRouter.get("/device", asyncRoute(async (req, res) => {
  const did = String(req.query.token || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) {
    res.json({ ok: false });
    return;
  }
  const info = await getJSON<{ sessionId?: string }>("device:" + did);
  if (!info || !info.sessionId) {
    res.json({ ok: false });
    return;
  }
  await delKey("device:" + did);
  console.log("[Auth] device " + did.slice(0, 8) + "... picked up session");
  res.json({ ok: true, sessionId: info.sessionId });
}));

// Web login pickup. The SPA polls this while the user taps Login in Telegram.
// The bot completes the session in-chat (device:<did> → sessionId, exactly like
// the Android flow); here we set the HttpOnly cookie directly so the browser
// logs in without copy-pasting a login URL from the bot.
authRouter.get("/device/claim", asyncRoute(async (req, res) => {
  const did = String(req.query.token || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) {
    res.json({ ok: false });
    return;
  }
  const info = await getJSON<{ sessionId?: string }>("device:" + did);
  if (!info || !info.sessionId) {
    res.json({ ok: false });
    return;
  }
  await delKey("device:" + did);
  res.setHeader("Set-Cookie", sessionCookie(info.sessionId, req.secure));
  console.log("[Auth] device " + did.slice(0, 8) + "... claimed session for web");
  res.json({ ok: true });
}));
