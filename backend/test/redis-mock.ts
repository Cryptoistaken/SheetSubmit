// In-memory fake of backend/src/services/redis.ts.
// Mirrors its exports (redis, key, getJSON, setJSON, setJSONex, delKey) plus a
// WATCH/MULTI/pipeline implementation with genuine optimistic-lock semantics so
// updateUserFilesAtomic's conflict-retry loop can be tested without a Redis.
//
// Version counters: every mutation bumps a per-key version. watch() records the
// version at call time; exec() aborts (returns null) if any watched key changed,
// exactly like Redis. setBeforeExec(hook) lets tests simulate a concurrent writer.
import { mock } from "bun:test";
import path from "node:path";

type StoreVal = string | string[] | Set<string> | Record<string, string>;

export const store: Record<string, StoreVal> = {};
const versions: Record<string, number> = {};
let watched: Record<string, number> = {};
let beforeExecHook: (() => void) | null = null;

function bump(k: string): void {
  versions[k] = (versions[k] || 0) + 1;
}

// Low-level store writers used by the hook to simulate a concurrent writer
// (they bump the key version so an in-flight WATCH conflict is detected).
export function fakeSet(k: string, val: StoreVal): void {
  store[k] = val;
  bump(k);
}

export function fakeDel(k: string): void {
  if (k in store) {
    delete store[k];
    bump(k);
  }
}

export function resetStore(): void {
  for (const k of Object.keys(store)) delete store[k];
  for (const k of Object.keys(versions)) delete versions[k];
  watched = {};
  beforeExecHook = null;
}

export function setBeforeExec(hook: (() => void) | null): void {
  beforeExecHook = hook;
}

type ValType = "string" | "list" | "set" | "none";

function valType(k: string): ValType {
  const v = store[k];
  if (v === undefined) return "none";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "list";
  if (v instanceof Set) return "set";
  return "string"; // hash treated as string type for valType
}

function norm(start: number, stop: number, len: number): [number, number] {
  const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
  let e = stop < 0 ? len + stop : Math.min(stop, len - 1);
  if (e < s) e = s - 1;
  return [s, e];
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

// ---- synchronous, version-bumping command implementations ----
function cmdGet(k: string): string | null {
  const v = store[k];
  return typeof v === "string" ? v : null;
}

function cmdSet(k: string, value: string): "OK" {
  store[k] = value;
  bump(k);
  return "OK";
}

function cmdDel(...keys: string[]): number {
  let n = 0;
  for (const k of keys) {
    if (k in store) {
      delete store[k];
      bump(k);
      n++;
    }
  }
  return n;
}

function cmdExists(k: string): number {
  return k in store ? 1 : 0;
}

function cmdType(k: string): ValType {
  return valType(k);
}

function cmdRpush(k: string, ...vals: string[]): number {
  const arr = Array.isArray(store[k]) ? (store[k] as string[]).slice() : [];
  arr.push(...vals);
  store[k] = arr;
  bump(k);
  return arr.length;
}

function cmdLrange(k: string, start: number, stop: number): string[] {
  if (!Array.isArray(store[k])) return [];
  const arr = store[k] as string[];
  const [s, e] = norm(start, stop, arr.length);
  return e < s ? [] : arr.slice(s, e + 1);
}

function cmdLlen(k: string): number {
  return Array.isArray(store[k]) ? (store[k] as string[]).length : 0;
}

function cmdLtrim(k: string, start: number, stop: number): "OK" {
  if (Array.isArray(store[k])) {
    const arr = store[k] as string[];
    const [s, e] = norm(start, stop, arr.length);
    store[k] = e < s ? [] : arr.slice(s, e + 1);
    bump(k);
  }
  return "OK";
}

function cmdSadd(k: string, ...members: string[]): number {
  const set = store[k] instanceof Set ? (store[k] as Set<string>) : new Set<string>();
  let added = 0;
  for (const m of members) {
    if (!set.has(m)) {
      set.add(m);
      added++;
    }
  }
  store[k] = set;
  bump(k);
  return added;
}

function cmdSrem(k: string, ...members: string[]): number {
  const set = store[k] instanceof Set ? (store[k] as Set<string>) : new Set<string>();
  let removed = 0;
  for (const m of members) {
    if (set.delete(m)) removed++;
  }
  if (removed > 0 || set.size > 0) store[k] = set;
  bump(k);
  return removed;
}

function cmdSmembers(k: string): string[] {
  return store[k] instanceof Set ? [...(store[k] as Set<string>)] : [];
}

function cmdScard(k: string): number {
  return store[k] instanceof Set ? (store[k] as Set<string>).size : 0;
}
function cmdSismember(k: string, member: string): number {
  return store[k] instanceof Set && (store[k] as Set<string>).has(member) ? 1 : 0;
}
function cmdLrem(k: string, count: number, val: string): number {
  if (!Array.isArray(store[k])) return 0;
  const arr = store[k] as string[];
  let removed = 0;
  if (count === 0) { const n = arr.filter(v=>v!==val).length; removed = arr.length - n; store[k]=arr.filter(v=>v!==val); if(removed) bump(k); return removed; }
  if (count > 0) { const idx = arr.indexOf(val); if(idx!==-1){arr.splice(idx,1); removed=1; bump(k);} return removed; }
  const idx = arr.lastIndexOf(val); if(idx!==-1){arr.splice(idx,1); removed=1; bump(k);} return removed;
}
function cmdHincrby(k: string, field: string, inc: number): number {
  const h = (store[k] && typeof store[k]==="object" && !(store[k] instanceof Set) && !Array.isArray(store[k])) ? store[k] as Record<string,string> : {} as Record<string,string>;
  const cur = parseInt(h[field]||"0",10)||0; const nxt = cur + inc; h[field]=String(nxt); store[k]=h; bump(k); return nxt;
}
function cmdHget(k: string, field: string): string | null { const h = store[k] as Record<string,string>; return h && typeof h==="object" && !(h instanceof Set) && !Array.isArray(h) ? (h[field]??null) : null; }
function cmdHset(k: string, field: string, val: string): number { const h = (store[k] && typeof store[k]==="object" && !(store[k] instanceof Set) && !Array.isArray(store[k])) ? store[k] as Record<string,string> : {} as Record<string,string>; const isNew = !(field in h); h[field]=val; store[k]=h; bump(k); return isNew?1:0; }

function cmdHgetall(k: string): Record<string, string> {
  const h = store[k] && typeof store[k] === "object" && !(store[k] instanceof Set) && !Array.isArray(store[k]) ? (store[k] as Record<string, string>) : {};
  return { ...h };
}
function cmdHlen(k: string): number {
  return Object.keys(cmdHgetall(k)).length;
}
function cmdHmset(k: string, obj: Record<string, string>): "OK" {
  const h = store[k] && typeof store[k] === "object" && !(store[k] instanceof Set) && !Array.isArray(store[k]) ? (store[k] as Record<string, string>) : {};
  for (const [f, v] of Object.entries(obj)) h[f] = String(v);
  store[k] = h;
  bump(k);
  return "OK";
}
function cmdZadd(k: string, score: string, member: string): number {
  const z = store[k] instanceof Map ? (store[k] as Map<string, number>) : new Map<string, number>();
  const added = z.has(member) ? 0 : 1;
  z.set(member, Number(score));
  store[k] = z;
  bump(k);
  return added;
}
function cmdZrevrange(k: string, start: number, stop: number): string[] {
  const z = store[k] instanceof Map ? (store[k] as Map<string, number>) : new Map<string, number>();
  const members = [...z.entries()].sort((a, b) => b[1] - a[1]).map((m) => m[0]);
  const [s, e] = norm(start, stop, members.length);
  return e < s ? [] : members.slice(s, e + 1);
}

function cmdScan(cursor: string, ...args: unknown[]): [string, string[]] {
  let pattern = "*";
  for (let i = 0; i + 1 < args.length; i += 2) {
    if (String(args[i]).toUpperCase() === "MATCH") pattern = String(args[i + 1]);
  }
  const re = globToRegex(pattern);
  const keys = Object.keys(store).filter((k) => re.test(k));
  return ["0", keys];
}

function applyCmd(cmd: string, args: unknown[]): unknown {
  switch (cmd) {
    case "get":
      return cmdGet(String(args[0]));
    case "set":
      return cmdSet(String(args[0]), String(args[1]));
    case "del":
      return cmdDel(...args.map(String));
    case "exists":
      return cmdExists(String(args[0]));
    case "type":
      return cmdType(String(args[0]));
    case "rpush":
      return cmdRpush(String(args[0]), ...args.slice(1).map(String));
    case "lrange":
      return cmdLrange(String(args[0]), Number(args[1]), Number(args[2]));
    case "llen":
      return cmdLlen(String(args[0]));
    case "ltrim":
      return cmdLtrim(String(args[0]), Number(args[1]), Number(args[2]));
    case "sadd":
      return cmdSadd(String(args[0]), ...args.slice(1).map(String));
    case "srem":
      return cmdSrem(String(args[0]), ...args.slice(1).map(String));
    case "smembers":
      return cmdSmembers(String(args[0]));
    case "scard":
      return cmdScard(String(args[0]));
    case "sismember":
      return cmdSismember(String(args[0]), String(args[1]));
    case "lrem":
      return cmdLrem(String(args[0]), Number(args[1]), String(args[2]));
    case "hincrby":
      return cmdHincrby(String(args[0]), String(args[1]), Number(args[2]));
    case "hget":
      return cmdHget(String(args[0]), String(args[1]));
    case "hset":
      return cmdHset(String(args[0]), String(args[1]), String(args[2]));
    case "hgetall":
      return cmdHgetall(String(args[0]));
    case "hlen":
      return cmdHlen(String(args[0]));
    case "hmset":
      return cmdHmset(String(args[0]), args[1] as Record<string, string>);
    case "zadd":
      return cmdZadd(String(args[0]), String(args[1]), String(args[2]));
    case "zrevrange":
      return cmdZrevrange(String(args[0]), Number(args[1]), Number(args[2]));
    case "scan":
      return cmdScan(String(args[0]), ...args);
    default:
      return null;
  }
}

const CHAINABLE_CMDS = [
  "get",
  "set",
  "del",
  "exists",
  "type",
  "rpush",
  "lrange",
  "llen",
  "ltrim",
  "sadd",
  "srem",
  "smembers",
  "scard",
  "sismember",
  "lrem",
  "hincrby",
  "hget",
  "hset",
  "hgetall",
  "hlen",
  "hmset",
  "zadd",
  "zrevrange",
  "scan",
];

type Op = { cmd: string; args: unknown[] };

// MULTI/pipeline: commands buffer until exec(). exec() first runs the
// concurrent-writer hook, then aborts (returns null) if any watched key changed,
// otherwise applies all queued commands and returns [null, result] pairs.
function makeChain() {
  const ops: Op[] = [];
  const chain: Record<string, unknown> = {
    exec: async () => {
      beforeExecHook?.();
      for (const k of Object.keys(watched)) {
        if ((versions[k] || 0) !== watched[k]) {
          watched = {};
          return null;
        }
      }
      const results: [null, unknown][] = [];
      for (const op of ops) {
        results.push([null, applyCmd(op.cmd, op.args)]);
      }
      watched = {};
      return results;
    },
  };
  for (const cmd of CHAINABLE_CMDS) {
    chain[cmd] = (...args: unknown[]) => {
      ops.push({ cmd, args });
      return chain;
    };
  }
  return chain;
}

export const redis = {
  get: async (k: string) => cmdGet(k),
  set: async (...args: unknown[]) => cmdSet(String(args[0]), String(args[1])),
  del: async (...keys: string[]) => cmdDel(...keys),
  exists: async (k: string) => cmdExists(k),
  type: async (k: string) => cmdType(k),
  rpush: async (k: string, ...vals: string[]) => cmdRpush(k, ...vals),
  lrange: async (k: string, s: number, e: number) => cmdLrange(k, s, e),
  llen: async (k: string) => cmdLlen(k),
  ltrim: async (k: string, s: number, e: number) => cmdLtrim(k, s, e),
  sadd: async (k: string, ...members: string[]) => cmdSadd(k, ...members),
  srem: async (k: string, ...members: string[]) => cmdSrem(k, ...members),
  smembers: async (k: string) => cmdSmembers(k),
  scard: async (k: string) => cmdScard(k),
  sismember: async (k: string, m: string) => cmdSismember(k, m),
  lrem: async (k: string, c: number, v: string) => cmdLrem(k, c, v),
  hincrby: async (k: string, f: string, v: number) => cmdHincrby(k, f, v),
  hget: async (k: string, f: string) => cmdHget(k, f),
  hset: async (k: string, f: string, v: string) => cmdHset(k, f, v),
  hgetall: async (k: string) => cmdHgetall(k),
  hlen: async (k: string) => cmdHlen(k),
  hmset: async (k: string, obj: Record<string, string>) => cmdHmset(k, obj),
  zadd: async (k: string, score: string, member: string) => cmdZadd(k, score, member),
  zrevrange: async (k: string, s: number, e: number) => cmdZrevrange(k, s, e),
  scan: async (cursor: string, ...args: unknown[]) => cmdScan(cursor, ...args),
  watch: async (...keys: string[]) => {
    for (const k of keys) {
      watched[k] = versions[k] || 0;
    }
    return "OK";
  },
  unwatch: async () => {
    watched = {};
    return "OK";
  },
  multi: () => makeChain(),
  pipeline: () => makeChain(),
};

export function key(k: string): string {
  return "ss:" + k;
}

export async function getJSON<T>(k: string): Promise<T | null> {
  try {
    const raw = await redis.get(key(k));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
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
    await redis.set(key(k), JSON.stringify(val), "PX", String(ms));
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

const fakeExports = { redis, key, getJSON, setJSON, setJSONex, delKey };

// Must be called BEFORE any dynamic import of ../services/history or
// ../services/files so the real module (which connects to Redis at import time)
// is never loaded.
export function installRedisMock(): void {
  mock.module(path.join(import.meta.dir, "..", "src", "services", "redis"), () => fakeExports);
  mock.module("../src/services/redis", () => fakeExports);
}

// Shared middleware/auth mock for route-level tests (append.test.ts, pools
// routes). bun keeps one mock per module path per process, so every test file
// must register an identical factory or the last registration wins and earlier
// files break with missing exports (e.g. isAdmin/requireAdmin).
export function installAuthMock(): void {
  const authMock = {
    isAdmin: (userId: string | number) => String(userId) === "admin1",
    requireAuth: async (req: import("express").Request, _res: import("express").Response, next: () => void) => {
      req.userId = String(req.headers["x-user-id"] || "user1");
      next();
    },
    requireAdmin: async (req: import("express").Request, res: import("express").Response, next: () => void) => {
      if (String(req.userId) !== "admin1") {
        res.status(403).json({ error: "admin access required" });
        return;
      }
      next();
    },
    requireFileAccess: async (req: import("express").Request, res: import("express").Response, next: () => void) => {
      const raw = store[key("files:" + req.userId)];
      let files: import("../src/lib/shared").StoredFile[] = [];
      if (typeof raw === "string") {
        try {
          files = JSON.parse(raw) as import("../src/lib/shared").StoredFile[];
        } catch {
          files = [];
        }
      }
      const file = files.find((f) => f.id === req.params.id);
      if (!file) {
        res.status(404).json({ error: "file not found" });
        return;
      }
      (req as import("express").Request & { file: import("../src/lib/shared").StoredFile }).file = file;
      next();
    },
    migrateListKey: migrateListKeyHelper,
    migrateLogKey: migrateListKeyHelper,
  };
  mock.module(path.join(import.meta.dir, "..", "src", "middleware", "auth"), () => authMock);
  mock.module("../src/middleware/auth", () => authMock);
}

// Real migration for the auth mock (mirrors backend/src/middleware/auth.ts):
// converts a legacy string-typed key (e.g. undo/redo JSON blob) to a list.
async function migrateListKeyHelper(listKey: string): Promise<void> {
  const type = await redis.type(listKey);
  if (type === "string") {
    const old = await redis.get(listKey);
    if (old) {
      try {
        const parsed = JSON.parse(old);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const p = redis.pipeline();
          p.del(listKey);
          parsed.forEach((l) => p.rpush(listKey, JSON.stringify(l)));
          await p.exec();
        } else {
          await redis.del(listKey);
        }
      } catch {
        await redis.del(listKey);
      }
    }
  }
}