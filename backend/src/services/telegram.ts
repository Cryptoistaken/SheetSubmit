// Telegram bot — ported from the old server (webhook on public URL, long-poll fallback).
import { BACKEND_PUBLIC_URL, LOGIN_BASE, TG_BOT_TOKEN, WEBHOOK_URL } from "../config/env";
import { generateToken } from "../lib/ids";
import { delKey, getJSON, key, redis, setJSON, setJSONex } from "./redis";

const TG_API = "https://api.telegram.org/bot" + TG_BOT_TOKEN;

export let botUsername = "";

interface TgJson {
  ok: boolean;
  result?: any;
  description?: string;
  error_code?: number;
}

export async function tg(method: string, body?: unknown): Promise<TgJson> {
  const bodyStr = body !== undefined ? JSON.stringify(body).slice(0, 200) : "(no body)";
  console.log("[Bot] tg." + method + " body=" + bodyStr);
  const opts: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  opts.signal = AbortSignal.timeout(method === "getUpdates" ? 60000 : 20000);
  const res = await fetch(TG_API + "/" + method, opts);
  const json = (await res.json()) as TgJson;
  if (json.ok) {
    console.log("[Bot] tg." + method + " → ok=" + json.ok);
  } else {
    console.log(
      "[Bot] tg." + method + " → ok=" + json.ok +
      " error_code=" + json.error_code + " description=\"" + json.description + "\"",
    );
  }
  return json;
}

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; text?: string; message_id?: number };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id?: number };
  };
}

export type TelegramLoginResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "banned" | "info" };

// Complete a Telegram login server-side: fetch chat info, upsert the user,
// create a session, and (for Android) bind it to the device key the app polls.
// Shared by the /api/auth/telegram web callback and the bot's direct device login.
export async function completeTelegramLogin(
  chatId: string | number,
  did?: string,
): Promise<TelegramLoginResult> {
  const userId = String(chatId);
  const banned = await getJSON("ban:" + userId);
  if (banned) return { ok: false, reason: "banned" };

  let userInfo: { id: string; firstName: string; lastName: string; username: string; fileId: string | null } | null = null;
  try {
    const chatRes = await tg("getChat", { chat_id: userId });
    if (chatRes.ok && chatRes.result) {
      userInfo = {
        id: userId,
        firstName: chatRes.result.first_name || "",
        lastName: chatRes.result.last_name || "",
        username: chatRes.result.username || "",
        fileId: null,
      };
      try {
        const photosRes = await tg("getUserProfilePhotos", { user_id: userId, limit: 1 });
        if (photosRes.ok && photosRes.result && photosRes.result.photos.length > 0) {
          userInfo.fileId = photosRes.result.photos[0][photosRes.result.photos[0].length - 1].file_id;
        }
      } catch {
        // ignore photo lookup failure
      }
    }
  } catch {
    // ignore getChat failure
  }

  if (!userInfo) return { ok: false, reason: "info" };

  console.log("[Auth] user=" + (userInfo.username || userInfo.firstName) + " id=" + userInfo.id);

  const existing = (await getJSON<Record<string, unknown>>("user:" + userInfo.id)) || {};
  const merged: Record<string, unknown> = {
    id: userInfo.id,
    firstName: userInfo.firstName,
    lastName: userInfo.lastName,
    username: userInfo.username,
    fileId: userInfo.fileId || existing.fileId || null,
    lastLogin: Date.now(),
  };
  await setJSON("user:" + userInfo.id, merged);
  await redis.sadd("ss:userIds", String(userInfo.id));

  const sessionId = generateToken();
  await setJSONex("session:" + sessionId, { userId: userInfo.id }, 2592000000);
  await redis.sadd(key("userSessions:" + userInfo.id), sessionId);

  if (did && /^[A-Za-z0-9-]{8,64}$/.test(did)) {
    await setJSONex("device:" + did, { sessionId }, 3600000);
    console.log("[Auth] session bound to device " + did.slice(0, 8) + "...");
  }

  void tg("sendMessage", {
    chat_id: chatId,
    text:
      "<b>Login Successful</b>\n\nHey @" + (userInfo.username || userInfo.firstName) +
      ", you are signed in to SheetSubmit.\n\nIf this was not you, contact the admin immediately.",
    parse_mode: "HTML",
  }).catch(console.error);

  return { ok: true, sessionId };
}

export async function handleBotUpdate(update: TgUpdate): Promise<void> {
  console.log(
    "[Bot] update id=" + update.update_id +
    " from=" + (update.message ? update.message.chat.id : update.callback_query ? update.callback_query.message?.chat.id : "?"),
  );
  if (update.message && update.message.text) {
    const msg = update.message;
    const text = msg.text!;
    if (text === "/start" || text.startsWith("/start ")) {
      const payload = (text.split(" ")[1] || "").trim();
      if (payload.indexOf("login_") === 0) {
        const did = payload.slice(6);
        if (/^[A-Za-z0-9-]{8,64}$/.test(did)) {
          await setJSONex("didchat:" + msg.chat.id, { did }, 900000);
          console.log("[Bot] device login requested chatId=" + msg.chat.id + " did=" + did.slice(0, 8) + "...");
        }
      }
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        text: "Welcome to Sheet Submit. Tap the button below to log in:",
        reply_markup: {
          inline_keyboard: [[{ text: "Login", callback_data: "login" }]],
        },
      });
    } else if (text === "/myid") {
      await tg("sendMessage", { chat_id: msg.chat.id, text: "Your Telegram ID: " + msg.chat.id });
    }
  }
  if (update.callback_query) {
    const cb = update.callback_query;
    if (cb.data === "login" && cb.message) {
      const chatId = cb.message.chat.id;
      // Device login (Android): complete the session right here — no "Open URL"
      // hop. The app polls /api/auth/device?token=<did> to pick up the session.
      const didChat = await getJSON<{ did: string }>("didchat:" + chatId);
      if (didChat && didChat.did) {
        await delKey("didchat:" + chatId);
        const result = await completeTelegramLogin(chatId, didChat.did);
        await tg("editMessageText", {
          chat_id: chatId,
          message_id: cb.message.message_id,
          text: result.ok
            ? "Login successful! You can close this chat and return to the app."
            : "Login failed. Please try again.",
        });
        await tg("answerCallbackQuery", { callback_query_id: cb.id });
        return;
      }
      const token = generateToken();
      let url = LOGIN_BASE + "/api/auth/telegram?token=" + token;
      const loginReq: Record<string, unknown> = { chatId: cb.message.chat.id };
      await setJSONex("login:" + token, loginReq, 900000);
      await tg("editMessageText", {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: "Login link ready:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Open URL", url }],
            [{ text: "Copy URL", copy_text: { text: url } }],
          ],
        },
      });
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
    }
  }
}

// Start the bot: set webhook when a public URL exists, else long-poll locally.
export async function startBot(): Promise<void> {
  try {
    const info = await tg("getMe");
    if (!info.ok) throw new Error("getMe failed");
    botUsername = info.result.username;
    console.log("[Bot] @" + botUsername + " id=" + info.result.id);
    await setJSON("bot:info", { username: botUsername });

    const hasPublicUrl = !!(WEBHOOK_URL || BACKEND_PUBLIC_URL);
    let usingWebhook = false;
    if (hasPublicUrl) {
      // Webhook target: explicit WEBHOOK_URL wins, else the api's own public URL.
      // (No nginx/frontend path anymore — Telegram hits the api directly.)
      const webhookUrl = (WEBHOOK_URL || BACKEND_PUBLIC_URL) + "/webhook/tg";
      const result = await tg("setWebhook", { url: webhookUrl, allowed_updates: ["message", "callback_query"] });
      if (result.ok) {
        usingWebhook = true;
        console.log("[Bot] Webhook set to " + webhookUrl);
      } else {
        console.log("[Bot] Webhook failed, falling back to polling: " + (result.description || ""));
      }
    }

    if (!usingWebhook) {
      await tg("deleteWebhook");
      console.log("[Bot] No public URL, using long-polling");
      let pollingOffset = 0;
      const poll = async (): Promise<void> => {
        try {
          const data = await tg("getUpdates", { offset: pollingOffset, timeout: 30, allowed_updates: ["message", "callback_query"] });
          if (data.ok && data.result) {
            if (data.result.length > 0) console.log("[Bot] received " + data.result.length + " update(s)");
            for (const update of data.result as TgUpdate[]) {
              pollingOffset = update.update_id + 1;
              await handleBotUpdate(update);
            }
          }
        } catch (e) {
          console.error("[Bot] Poll err:", (e as Error).message);
        }
        setTimeout(poll, 2000);
      };
      poll();
    }
  } catch (e) {
    console.error("[Bot] init error:", (e as Error).message);
    setTimeout(() => {
      void startBot();
    }, 10000);
  }
}

export function isBotEnabled(): boolean {
  return !!TG_BOT_TOKEN;
}
