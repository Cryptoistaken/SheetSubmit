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

export async function redisJsonGet<T>(key: string): Promise<T | undefined> {
  try { const c = await getClient(); const value = c ? await c.get(key) : null; return value == null ? undefined : JSON.parse(value) as T; } catch { return undefined; }
}
export async function redisJsonGetMany<T>(keys: string[]): Promise<(T | undefined)[] | undefined> {
  try { const c = await getClient(); if (!c) return undefined; return (await c.mGet(keys)).map((value) => value == null ? undefined : JSON.parse(value) as T); } catch { return undefined; }
}
export async function redisJsonSet(key: string, value: unknown, ttlSeconds: number) {
  try { const c = await getClient(); if (c) await c.set(key, JSON.stringify(value), { EX: ttlSeconds }); } catch {}
}
export async function redisDel(key: string) {
  try { const c = await getClient(); if (c) await c.del(key); } catch {}
}

/** Live fan-out channel (worker → backend rooms). Publish works on the shared
 * client; subscribing needs its own connection (subscriber mode is exclusive). */
export const LIVE_CHANNEL = "ss:live";

export async function publishLiveEvent(msg: unknown) {
  try {
    const c = await getClient();
    if (c) await c.publish(LIVE_CHANNEL, JSON.stringify(msg));
  } catch {}
}

// any: node-redis generic instantiations differ between createClient call
// sites — the relay only needs connect/subscribe/quit and stays fail-open
let sub: any = null;
export async function subscribeLiveEvents(onMsg: (msg: string) => void): Promise<void> {
  if (!url || sub) return;
  try {
    const s = createClient({ url, socket: { connectTimeout: 500, reconnectStrategy: (retries) => Math.min(1000 * 2 ** retries, 30_000) }, disableOfflineQueue: true });
    s.on("error", (error) => console.error("[redis:sub]", error.message));
    await s.connect();
    await s.subscribe(LIVE_CHANNEL, (message) => {
      try {
        onMsg(message);
      } catch (e) {
        console.error("[live-sub]", (e as Error)?.message ?? e);
      }
    });
    sub = s;
  } catch {
    try {
      await sub?.quit().catch(() => {});
    } catch {}
    sub = null;
  }
}
export async function closeRedis() { if (client?.isOpen) await client.close(); if (sub?.isOpen) await sub.quit().catch(() => {}); sub = null; }
