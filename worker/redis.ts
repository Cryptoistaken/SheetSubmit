import { createClient } from "redis";

const rawUrl = Bun.env.REDIS_URL?.trim();
const url = rawUrl && /^(redis|rediss|redis\+tls):\/\//i.test(rawUrl) ? rawUrl : undefined;
const client = url ? createClient({ url, socket: { connectTimeout: 500, reconnectStrategy: (retries) => retries < 3 ? Math.min(250 * 2 ** retries, 2000) : false }, disableOfflineQueue: true }) : null;
let connecting: Promise<unknown> | null = null;
let unavailableUntil = 0;
client?.on("error", (error) => console.error("[redis]", error.message));

async function getClient() {
  if (!client) return null;
  if (Date.now() < unavailableUntil) return null;
  if (client.isReady) return client;
  if (!client.isOpen) {
    connecting ??= client.connect().finally(() => { connecting = null; });
    await Promise.race([connecting, Bun.sleep(100)]);
  }
  if (client.isReady) return client;
  unavailableUntil = Date.now() + 10_000;
  return null;
}
export async function redisDel(key: string) { try { const c = await getClient(); if (c) await c.del(key); } catch {} }
// live relay to the backend (best-effort — without REDIS_URL the backend
// simply never hears worker-side deaths until clients resync)
export async function publishLiveEvent(msg: unknown) { try { const c = await getClient(); if (c) await c.publish("ss:live", JSON.stringify(msg)); } catch {} }
export async function closeRedis() { if (client?.isOpen) await client.close(); }
