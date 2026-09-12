import { afterAll, describe, expect, it } from "bun:test";
import { app } from "../../index";

// M17 session cache: requireAuth may skip its 2 DB lookups for a short window,
// but logout and admin ban must evict the cached entry immediately.
const hasDb = !!process.env.DATABASE_URL;
const SECRET = "test-secret";
const TAG = `sca${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const UID = `sca-u-${TAG}`;
const ADMIN = `sca-a-${TAG}`;
const ENV = {
  INDEX: "index" as const,
  FILES: "files" as const,
  POOLS: "pools" as const,
  DATABASE_URL: process.env.DATABASE_URL as string,
  SESSION_SECRET: SECRET,
  ADMIN_IDS: ADMIN,
};

async function cookieFor(uid: string) {
  const { signSession } = await import("../session");
  const { repository } = await import("../pg");
  await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
  const token = await signSession(uid, SECRET);
  await repository("index", "global", "session", { token, uid, exp: Date.now() + 300_000 });
  return { token, cookie: `ss_session=${token}` };
}

const wallet = (cookie: string) => app.request("/api/wallet", { headers: { Cookie: cookie } }, ENV);

describe.skipIf(!hasDb)("session cache + eviction", () => {
  it("a freshly authed request populates the cache (session row deletion alone does not 401 within the window)", async () => {
    const { token, cookie } = await cookieFor(`${UID}-1`);
    expect((await wallet(cookie)).status).toBe(200);
    const { repository } = await import("../pg");
    await repository("index", "global", "deleteSession", { token });
    expect((await wallet(cookie)).status).toBe(200);
  });

  it("logout evicts the cached entry immediately", async () => {
    const { cookie } = await cookieFor(`${UID}-2`);
    expect((await wallet(cookie)).status).toBe(200);
    const out = await app.request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } }, ENV);
    expect(out.status).toBe(200);
    expect((await wallet(cookie)).status).toBe(401);
  });

  it("admin ban evicts the cached entry immediately", async () => {
    const { cookie } = await cookieFor(`${UID}-3`);
    const adminCookie = (await cookieFor(ADMIN)).cookie;
    expect((await wallet(cookie)).status).toBe(200);
    const ban = await app.request(`/api/admin/user/${UID}-3/ban`, { method: "POST", headers: { Cookie: adminCookie } }, ENV);
    expect(ban.status).toBe(200);
    expect((await wallet(cookie)).status).toBe(403);
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id LIKE ${`${UID}%`} OR user_id=${ADMIN}`;
      await sql`DELETE FROM users WHERE user_id LIKE ${`${UID}%`} OR user_id=${ADMIN}`;
    } finally {
      await sql.end();
    }
  });
});
