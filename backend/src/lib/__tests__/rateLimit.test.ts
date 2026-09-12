import { describe, expect, it } from "bun:test";

// H6 limiter contract. Without a usable REDIS_URL it must fail open (true);
// with a reachable Redis it must start blocking after `limit` hits.
const usable = /^(redis|rediss|redis\+tls):\/\//i.test(process.env.REDIS_URL || "");

describe.skipIf(usable)("rateLimit (no redis -> fail-open)", () => {
  it("always allows when Redis is absent", async () => {
    const { rateLimit } = await import("../redis");
    const key = `rl:test:${Date.now().toString(36)}`;
    expect(await rateLimit(key, 1, 60)).toBe(true);
    expect(await rateLimit(key, 1, 60)).toBe(true);
    expect(await rateLimit(key, 1, 60)).toBe(true);
  });
});

describe.skipIf(!usable)("rateLimit (redis)", () => {
  it("blocks the request after `limit` hits in the window", async () => {
    const { rateLimit } = await import("../redis");
    // warm the lazy client; a cold client fail-opens the first call and gates
    // retries for 10s (by design), so wait past that gate before asserting
    await rateLimit(`rl:test:warm:${Date.now().toString(36)}`, 1, 60);
    await Bun.sleep(10_500);
    const key = `rl:test:${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    expect(await rateLimit(key, 2, 60)).toBe(true);
    expect(await rateLimit(key, 2, 60)).toBe(true);
    expect(await rateLimit(key, 2, 60)).toBe(false);
  }, 20_000);
});
