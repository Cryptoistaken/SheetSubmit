import { Hono } from "hono";
import type { Env } from "../lib/shared";
import { rpc } from "../lib/do";
import { signSession } from "../lib/session";
export const bot = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
const tg = async (env: Env, method: string, body: unknown) => fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export async function ensureWebhook(env: Env): Promise<void> {
  if (!env.TG_BOT_TOKEN || !env.TG_WEBHOOK_SECRET || !env.WORKER_URL) return;
  const url = `https://${env.WORKER_URL}/webhook/tg`;
  try {
    const info = await (await tg(env, "getWebhookInfo", {})).json() as { result?: { url?: string } };
    if (info.result?.url !== url) {
      await tg(env, "setWebhook", { url, secret_token: env.TG_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
    }
  } catch { /* ignore transient network failures */ }
}
bot.post("/webhook/tg", async (c) => {
  if (!c.env.TG_BOT_TOKEN || c.req.header("X-Telegram-Bot-Api-Secret-Token") !== c.env.TG_WEBHOOK_SECRET) return c.json({ error: "unauthorized" }, 401);
  const update = await c.req.json<any>(); const message = update.message; const callback = update.callback_query;
  if (message?.text?.startsWith("/start")) { const did = message.text.split(" ")[1]?.replace(/^login_/, ""); if (did && /^[A-Za-z0-9-]{8,64}$/.test(did)) await rpc(c.env.INDEX, "global", "deviceSet", { did, chatId: String(message.chat.id) }); await tg(c.env, "sendMessage", { chat_id: message.chat.id, text: "Welcome to Sheet Submit. Tap Login to continue.", reply_markup: { inline_keyboard: [[{ text: "Login", callback_data: "login" }]] } }); }
  if (message?.text === "/myid") await tg(c.env, "sendMessage", { chat_id: message.chat.id, text: `Your Telegram ID: ${message.chat.id}` });
  if (callback?.data === "login" && callback.message) { const chatId = String(callback.message.chat.id); const chat = await (await tg(c.env, "getChat", { chat_id: chatId })).json() as any; if (!chat.ok) return c.json({ ok: true }); const user = { id: chatId, name: [chat.result.first_name, chat.result.last_name].filter(Boolean).join(" "), username: chat.result.username || "" }; await rpc(c.env.INDEX, "global", "ensureUser", { id: chatId, name: user.name, username: user.username }); await rpc(c.env.INDEX, "global", "metaDel", { k: `photo:${chatId}` }).catch(() => {}); const token = await signSession(chatId, c.env.SESSION_SECRET); await rpc(c.env.INDEX, "global", "session", { token, uid: chatId, exp: Date.now() + 2592000000 }); const device = await rpc(c.env.INDEX, "global", "deviceByChat", { chatId }); if (device?.did) { await rpc(c.env.INDEX, "global", "deviceSet", { did: device.did, chatId: token }); } await tg(c.env, "answerCallbackQuery", { callback_query_id: callback.id }); await tg(c.env, "sendMessage", { chat_id: chatId, text: "Login successful. Return to Sheet Submit." }); }
  return c.json({ ok: true });
});
