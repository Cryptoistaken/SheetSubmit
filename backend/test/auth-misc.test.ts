// Tests for audit fixes in the auth/logging/redis slice:
// BE-15 (request-log URL redaction), BE-16 (ban-status cache +
// invalidateBanCache), BE-17 (getJSON parse-error logging).
//
// The real src/services/redis.ts and src/middleware/auth.ts are loaded from
// runtime-generated copies (written to a temp dir, imports re-pointed at the
// real config/env, a files stub, and the redis copy). This is necessary because
// bun v1.3's mock.module is process-global: the other test files register
// mocks for the exact src paths of services/redis and middleware/auth, so
// importing those paths here would hand us their fakes instead of the real
// code. Only `ioredis` is mocked (to an in-memory fake) — no other test file
// registers that mock, so this one can't collide.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

class FakeRedis {
  static instances: FakeRedis[] = [];
  store: Record<string, string | string[]> = {};
  getCalls = 0;
  throwOnGet = false;

  constructor(_url: string, _opts: unknown) {
    FakeRedis.instances.push(this);
  }
  on(_event: string, _cb: unknown): void {}
  async get(k: string): Promise<string | null> {
    this.getCalls++;
    if (this.throwOnGet) throw new Error("redis get failed");
    const v = this.store[k];
    return typeof v === "string" ? v : null;
  }
  async set(k: string, v: string): Promise<string> {
    this.store[k] = v;
    return "OK";
  }
  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) {
      if (k in this.store) {
        delete this.store[k];
        n++;
      }
    }
    return n;
  }
  async sadd(_k: string, ..._members: string[]): Promise<number> {
    return 0;
  }
  async srem(_k: string, ..._members: string[]): Promise<number> {
    return 0;
  }
  async smembers(_k: string): Promise<string[]> {
    return [];
  }
  async type(_k: string): Promise<string> {
    return "none";
  }
  pipeline(): { exec: () => Promise<unknown> } {
    return { exec: async () => null };
  }
  multi(): { exec: () => Promise<unknown> } {
    return { exec: async () => null };
  }
}

mock.module("ioredis", () => ({ default: FakeRedis }));

const srcDir = path.join(import.meta.dir, "..", "src");
// Temp copies live under test/ (not the OS temp dir) so bare-package imports
// like "ioredis" still resolve against backend/node_modules.
const tmpDir = mkdtempSync(path.join(import.meta.dir, "tmp-copy-"));
const realRedisPath = path.join(tmpDir, "redis.ts");
const realAuthPath = path.join(tmpDir, "auth.ts");
const filesStubPath = path.join(tmpDir, "files-stub.ts");

writeFileSync(
  realRedisPath,
  readFileSync(path.join(srcDir, "services", "redis.ts"), "utf8").replace(
    'from "../config/env"',
    'from "' + pathToFileURL(path.join(srcDir, "config", "env.ts")).href + '"',
  ),
);
writeFileSync(filesStubPath, "export async function findUserFile(): Promise<null> { return null; }");

// Re-point the copied auth.ts imports: files -> stub, redis -> the copied real
// redis module, config/env -> the real one (dotenv + constants only). The
// `import type` lines (shared, express) are erased at runtime and can stay.
const realAuthSrc = readFileSync(path.join(srcDir, "middleware", "auth.ts"), "utf8")
  .replace('from "../services/files"', 'from "' + pathToFileURL(filesStubPath).href + '"')
  .replace('from "../services/redis"', 'from "' + pathToFileURL(realRedisPath).href + '"')
  .replace('from "../config/env"', 'from "' + pathToFileURL(path.join(srcDir, "config", "env.ts")).href + '"');
writeFileSync(realAuthPath, realAuthSrc);

const { redactUrl } = await import("../src/middleware/logging");
const { getJSON, key } = await import(pathToFileURL(realRedisPath).href);
const { requireAuth, invalidateBanCache } = await import(pathToFileURL(realAuthPath).href);

const redisInst = FakeRedis.instances[0];

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows may keep the loaded module open — harmless if removal fails.
  }
});

function makeReq(cookie: string): any {
  return { headers: { cookie } } as any;
}

function makeRes(): any {
  const res: any = {
    statusCode: 200,
    status(c: number) {
      res.statusCode = c;
      return res;
    },
    json: () => res,
    send: () => res,
    end: () => res,
    setHeader: () => res,
    redirect: () => res,
  };
  return res;
}

function captureError(): { spy: ReturnType<typeof mock>; restore: () => void } {
  const orig = console.error;
  const spy = mock((..._args: unknown[]) => {});
  (console as any).error = spy;
  return { spy, restore: () => ((console as any).error = orig) };
}

beforeEach(() => {
  redisInst.store = {};
  redisInst.getCalls = 0;
  redisInst.throwOnGet = false;
});

describe("redactUrl (BE-15)", () => {
  test("redacts sensitive query param values, keeps others", () => {
    expect(redactUrl("/api/auth/device?token=abc123")).toBe("/api/auth/device?token=[redacted]");
    expect(redactUrl("/api/auth/telegram?token=sec&did=dev-1")).toBe(
      "/api/auth/telegram?token=[redacted]&did=[redacted]",
    );
    expect(redactUrl("/api/files?session=xyz&name=sheet")).toBe("/api/files?session=[redacted]&name=sheet");
    expect(redactUrl("/api/files?code=1&key=2&secret=3&password=4&auth=5&session=6&did=7&token=8")).toBe(
      "/api/files?code=[redacted]&key=[redacted]&secret=[redacted]&password=[redacted]&auth=[redacted]&session=[redacted]&did=[redacted]&token=[redacted]",
    );
    expect(redactUrl("/api/health")).toBe("/api/health");
    expect(redactUrl("/api/files/123/rows?limit=50")).toBe("/api/files/123/rows?limit=50");
  });
});

describe("getJSON parse logging (BE-17)", () => {
  test("parses valid JSON", async () => {
    redisInst.store[key("good")] = JSON.stringify({ a: 1 });
    expect(await getJSON("good")).toEqual({ a: 1 });
  });

  test("logs a parse error with the key only and returns null", async () => {
    redisInst.store[key("bad")] = "{oops";
    const { spy, restore } = captureError();
    try {
      expect(await getJSON("bad")).toBeNull();
    } finally {
      restore();
    }
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0][0])).toContain("[Redis] getJSON parse error key=ss:bad");
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain("{oops");
  });

  test("returns null silently when redis.get rejects", async () => {
    redisInst.throwOnGet = true;
    const { spy, restore } = captureError();
    try {
      expect(await getJSON("gone")).toBeNull();
    } finally {
      restore();
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("requireAuth ban cache (BE-16)", () => {
  test("caches ban status: second request within TTL makes no redis.get calls", async () => {
    const sessionId = "sess-a";
    const userId = "uA";
    redisInst.store[key("session:" + sessionId)] = JSON.stringify({ userId });
    const next = mock(() => {});

    await requireAuth(makeReq("session=" + sessionId), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const afterFirst = redisInst.getCalls;
    expect(afterFirst).toBe(2); // session + ban

    await requireAuth(makeReq("session=" + sessionId), makeRes(), next);
    expect(redisInst.getCalls).toBe(afterFirst); // no extra redis.get
  });

  test("banned user is rejected with 403 until invalidateBanCache clears it", async () => {
    const sessionId = "sess-b";
    const userId = "uB";
    redisInst.store[key("session:" + sessionId)] = JSON.stringify({ userId });
    redisInst.store[key("ban:" + userId)] = "true";
    const next = mock(() => {});

    const bannedRes = makeRes();
    await requireAuth(makeReq("session=" + sessionId), bannedRes, next);
    expect(bannedRes.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();

    // User unbanned in admin; banCache must be invalidated before the next
    // request picks up the change.
    delete redisInst.store[key("ban:" + userId)];
    invalidateBanCache(userId);

    const okRes = makeRes();
    await requireAuth(makeReq("session=" + sessionId), okRes, next);
    expect(okRes.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(1);
  });
});