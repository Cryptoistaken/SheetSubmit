// Redis value helpers — identical `ss:` key shapes to the old server.
import Redis, { type RedisOptions } from "ioredis";
import { REDIS_URL } from "../config/env";

const redisOpts: RedisOptions = {
  retryStrategy: (times: number) => Math.min(times * 500, 10000),
};
if (REDIS_URL.startsWith("rediss://") || REDIS_URL.includes("upstash.io")) {
  redisOpts.tls = {};
}

export const redis = new Redis(REDIS_URL, redisOpts);

redis.on("error", (err) => {
  console.error("Redis connection error:", err.message);
});

let redisReady = false;
redis.on("ready", () => {
  if (!redisReady) {
    redisReady = true;
    console.log("Connected to Redis");
  }
});

export function key(k: string): string {
  return "ss:" + k;
}

export async function getJSON<T>(k: string): Promise<T | null> {
  let raw: string | null = null;
  try {
    raw = await redis.get(key(k));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    console.error("[Redis] getJSON parse error key=" + key(k) + ":", (e as Error).message);
    return null;
  }
}

// Batch getJSON — single MGET round-trip instead of N sequential GETs.
export async function mgetJSON<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  let raws: (string | null)[] = [];
  try {
    raws = await redis.mget(keys.map(key));
  } catch {
    return keys.map(() => null);
  }
  return raws.map((raw, i) => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      console.error("[Redis] getJSON parse error key=" + key(keys[i]) + ":", (e as Error).message);
      return null;
    }
  });
}

export async function setJSON(k: string, val: unknown): Promise<boolean> {
  try {
    await redis.set(key(k), JSON.stringify(val));
    return true;
  } catch {
    return false;
  }
}

export async function setJSONex(k: string, val: unknown, ms: number): Promise<boolean> {
  try {
    await redis.set(key(k), JSON.stringify(val), "PX", ms);
    return true;
  } catch {
    return false;
  }
}

export async function delKey(k: string): Promise<boolean> {
  try {
    await redis.del(key(k));
    return true;
  } catch {
    return false;
  }
}
