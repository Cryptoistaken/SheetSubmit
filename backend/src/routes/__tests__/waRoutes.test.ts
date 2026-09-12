import { describe, expect, it, afterAll } from "bun:test";
import { app } from "../../index";

describe.skipIf(!process.env.DATABASE_URL)("wa routes (H8/M12/H6)", () => {
  const SECRET = "test-secret";
  const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET };
  const TAG = `wa${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const UID = `wau-${TAG}`;
  let cookie = "";
  let ready = false;
  const setup = async () => {
    if (ready) return;
    ready = true;
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: UID, name: "t", username: "t" });
    const token = await signSession(UID, SECRET);
    await repository("index", "global", "session", { token, uid: UID, exp: Date.now() + 300_000 });
    cookie = `ss_session=${token}`;
  };
  const req = (path: string, init?: RequestInit) => app.request(path, { ...init, headers: { Cookie: cookie, "content-type": "application/json", ...(init?.headers || {}) } }, ENV2);

  it("GET /api/fb/cache?uids=12345 -> 200 {cache:{}}", async () => {
    await setup();
    const res = await req(`/api/fb/cache?uids=12345`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cache: {} });
  });

  it("POST /api/fb/cache {uids:[\"12345\"]} -> 200 {cache:{}}", async () => {
    await setup();
    const res = await req(`/api/fb/cache`, { method: "POST", body: JSON.stringify({ uids: ["12345"] }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cache: {} });
  });

  it("POST /api/fb/cache {uids:\"nope\"} -> 400 invalid_uids", async () => {
    await setup();
    const res = await req(`/api/fb/cache`, { method: "POST", body: JSON.stringify({ uids: "nope" }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid uids", code: "invalid_uids" });
  });

  it("POST /api/fb/cache non-string entry -> 400 invalid_uids", async () => {
    await setup();
    const res = await req(`/api/fb/cache`, { method: "POST", body: JSON.stringify({ uids: ["12345", 42] }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid uids", code: "invalid_uids" });
  });

  it("POST /api/fb/page-simple no cookie -> 400 invalid_cookie", async () => {
    await setup();
    const res = await req(`/api/fb/page-simple`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cookie required", code: "invalid_cookie" });
  });

  it("POST /api/fb/page-simple 60000-char cookie -> 400 invalid_cookie", async () => {
    await setup();
    const res = await req(`/api/fb/page-simple`, { method: "POST", body: JSON.stringify({ cookie: "x".repeat(60000) }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cookie too large", code: "invalid_cookie" });
  });

  it("POST /api/fb/page-advanced no cookie -> 400 invalid_cookie", async () => {
    await setup();
    const res = await req(`/api/fb/page-advanced`, { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cookie required", code: "invalid_cookie" });
  });

  it("POST /api/fb/page-advanced 60000-char cookie -> 400 invalid_cookie", async () => {
    await setup();
    const res = await req(`/api/fb/page-advanced`, { method: "POST", body: JSON.stringify({ cookie: "x".repeat(60000) }) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Cookie too large", code: "invalid_cookie" });
  });

  it("POST /api/fb/check {uids:[]} -> 400 invalid_uids with no network call", async () => {
    await setup();
    const orig = globalThis.fetch;
    let called = false;
    (globalThis as any).fetch = (...a: any[]) => { called = true; return orig(...(a as [any])); };
    try {
      const res = await req(`/api/fb/check`, { method: "POST", body: JSON.stringify({ uids: [] }) });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid UIDs", code: "invalid_uids" });
      expect(called).toBe(false);
    } finally {
      (globalThis as any).fetch = orig;
    }
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id IN (${UID})`;
      await sql`DELETE FROM users WHERE user_id IN (${UID})`;
    } finally {
      await sql.end();
    }
  });
});
