import { repository } from "./pg";
import { redisJsonGet, redisJsonSet } from "./redis";
import { createHash } from "node:crypto";

const ttl = (namespace: string, op: string) => namespace === "index" && ["stats", "adminUsers", "adminUsersSearch", "files"].includes(op) ? 5 : namespace === "pools" && ["summary", "verifiedCounts", "userFiles", "rows"].includes(op) ? 3 : 0;
const key = (namespace: string, name: string, op: string, args: Record<string, unknown>) => `ss:rpc:${namespace}:${createHash("sha256").update(`${name}:${op}:${JSON.stringify(args)}`).digest("hex")}`;

export async function rpc(namespace: "index" | "files" | "pools", name: string, op: string, args: Record<string, unknown> = {}) {
  const seconds = ttl(namespace, op);
  if (!seconds) return repository(namespace, name, op, args);
  const cacheKey = key(namespace, name, op, args);
  const cached = await redisJsonGet(cacheKey);
  if (cached !== undefined) return cached;
  const result = await repository(namespace, name, op, args);
  void redisJsonSet(cacheKey, result, seconds);
  return result;
}
