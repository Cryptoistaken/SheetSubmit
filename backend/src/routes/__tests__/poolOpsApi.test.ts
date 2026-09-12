import { afterAll, describe, expect, it } from "bun:test";
import { app } from "../../index";
import { repository } from "../../lib/pg";

const hasDb = !!process.env.DATABASE_URL;
const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const PASSWORD = `pwft-${TAG}`.slice(0, 32);
const ADMIN = `poa-${TAG}`;
const SECRET = "test-secret";
const POOL = "cookies_only";
const FILETAG = `poaf-${TAG}`;
const ENV2: any = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET, ADMIN_IDS: ADMIN };

const cookieFor = async (uid: string) => {
  const { signSession } = await import("../../lib/session");
  await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
  const token = await signSession(uid, SECRET);
  await repository("index", "global", "session", { token, uid, exp: Date.now() + 60_000 });
  return `ss_session=${token}`;
};
let adminCookie = "";
const adminCk = async () => { if (!adminCookie) adminCookie = await cookieFor(ADMIN); return adminCookie; };

const sqlMod = () => import("postgres");
async function seedAvail(keys: string[]) {
  await adminCk();
  const { default: postgres } = await sqlMod();
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO file_index(file_id,owner_id,data) VALUES(${FILETAG},${ADMIN},${{} as any}) ON CONFLICT(file_id) DO NOTHING`;
    for (const k of keys) await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES(${PASSWORD},${POOL},${k},${{} as any},'available',${ADMIN},${FILETAG},${now},NULL) ON CONFLICT DO NOTHING`;
  } finally { await sql.end(); }
}
async function cleanup() {
  const { default: postgres } = await sqlMod();
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PASSWORD}`;
    await sql`DELETE FROM downloads WHERE password=${PASSWORD}`;
    await sql`DELETE FROM pool_rejects WHERE password=${PASSWORD}`;
    await sql`DELETE FROM pool_blocked WHERE password=${PASSWORD}`;
    await sql`DELETE FROM pool_settings WHERE password=${PASSWORD}`;
    await sql`DELETE FROM file_index WHERE file_id=${FILETAG}`;
    await sql`DELETE FROM sessions WHERE user_id=${ADMIN}`;
    await sql`DELETE FROM users WHERE user_id=${ADMIN}`;
  } finally { await sql.end(); }
}

describe.skipIf(!hasDb)("poolOpsApi H9/L8/L15/H5/M6/M5", () => {
  afterAll(cleanup, 30_000);

  it("H9: holdsAll paginates server-side", async () => {
    await seedAvail([`h9-${TAG}-1`, `h9-${TAG}-2`, `h9-${TAG}-3`, `h9-${TAG}-4`, `h9-${TAG}-5`, `h9-${TAG}-6`]);
    for (let i = 0; i < 3; i++) await repository("pools", PASSWORD, "hold", { pool: POOL, uid: ADMIN, count: 1 });
    const r: any = await repository("pools", "global", "holdsAll", { status: "HOLD", limit: 2, offset: 1 });
    expect(r.holds.length).toBe(2);
    const ck = await adminCk();
    const res = await app.request(`/api/pools/holds?limit=2&offset=1`, { headers: { Cookie: ck } }, ENV2);
    expect(res.status).toBe(200);
    const arr: any = await res.json();
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(2);
  }, 30_000);

  it("L8: claim rejects >1000 srcUids", async () => {
    const ck = await adminCk();
    const res = await app.request(`/api/pools/${PASSWORD}/${POOL}/claim`, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcUids: Array(1001).fill("x") }) }, ENV2);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/too many srcUids/);
  }, 30_000);

  it("L15: third hold decision maps to 409 final", async () => {
    await seedAvail([`l15-${TAG}-1`, `l15-${TAG}-2`]);
    const h: any = await repository("pools", PASSWORD, "hold", { pool: POOL, uid: ADMIN, count: 2 });
    const id = String(h.holdId || h.downloadId);
    expect(id.length).toBeGreaterThan(0);
    const ck = await adminCk();
    const a1 = await app.request(`/api/pools/holds/${id}/approve`, { method: "POST", headers: { Cookie: ck } }, ENV2);
    expect(a1.status).toBe(200);
    const r1 = await app.request(`/api/pools/holds/${id}/reject`, { method: "POST", headers: { Cookie: ck } }, ENV2);
    expect(r1.status).toBe(200);
    const a2 = await app.request(`/api/pools/holds/${id}/approve`, { method: "POST", headers: { Cookie: ck } }, ENV2);
    expect(a2.status).toBe(409);
    expect(String(((await a2.json()) as any).error)).toMatch(/final/);
  }, 30_000);

  it("H5: claim requestId is idempotent", async () => {
    await seedAvail([`h5c-${TAG}-1`, `h5c-${TAG}-2`, `h5c-${TAG}-3`, `h5c-${TAG}-4`, `h5c-${TAG}-5`]);
    const ck = await adminCk();
    const rid = `rid-${TAG}-c1`;
    const b = JSON.stringify({ count: 2, requestId: rid });
    const r1 = await app.request(`/api/pools/${PASSWORD}/${POOL}/claim`, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: b }, ENV2);
    expect(r1.status).toBe(200);
    const j1: any = await r1.json();
    const r2 = await app.request(`/api/pools/${PASSWORD}/${POOL}/claim`, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: b }, ENV2);
    expect(r2.status).toBe(200);
    const j2: any = await r2.json();
    expect(j2.downloadId).toBe(j1.downloadId);
    expect(j2.claimed).toBe(j1.claimed);
    const d: any = await repository("pools", "global", "downloadAny", { id: rid });
    expect(d).not.toBeNull();
    expect(String(d.id)).toBe(rid);
  }, 30_000);

  it("H5: hold requestId is idempotent", async () => {
    await seedAvail([`h5h-${TAG}-1`, `h5h-${TAG}-2`, `h5h-${TAG}-3`, `h5h-${TAG}-4`, `h5h-${TAG}-5`]);
    const ck = await adminCk();
    const rid = `rid-${TAG}-h1`;
    const b = JSON.stringify({ count: 2, requestId: rid });
    const r1 = await app.request(`/api/pools/${PASSWORD}/${POOL}/hold`, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: b }, ENV2);
    expect(r1.status).toBe(200);
    const j1: any = await r1.json();
    const r2 = await app.request(`/api/pools/${PASSWORD}/${POOL}/hold`, { method: "POST", headers: { Cookie: ck, "Content-Type": "application/json" }, body: b }, ENV2);
    expect(r2.status).toBe(200);
    const j2: any = await r2.json();
    expect(j2.downloadId).toBe(j1.downloadId);
    expect((j2.claimed ?? j2.held)).toBe((j1.claimed ?? j1.held));
    const d: any = await repository("pools", "global", "downloadAny", { id: rid });
    expect(d).not.toBeNull();
  }, 30_000);

  it("M6: GET /api/pools/prices returns 6 combos", async () => {
    const ck = await adminCk();
    const res = await app.request(`/api/pools/prices`, { headers: { Cookie: ck } }, ENV2);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    expect(j.prices.length).toBe(6);
    for (const e of j.prices) { expect(typeof e.password).toBe("string"); expect(typeof e.poolId).toBe("string"); expect(typeof e.price).toBe("number"); }
  }, 30_000);

  it("M5: GET view returns summary+extras", async () => {
    const ck = await adminCk();
    const res = await app.request(`/api/pools/${PASSWORD}/${POOL}/view`, { headers: { Cookie: ck } }, ENV2);
    expect(res.status).toBe(200);
    const j: any = await res.json();
    for (const k of ["pool", "password", "totals", "users", "userFiles", "verifiedCounts", "price"]) expect(j).toHaveProperty(k);
  }, 30_000);
});
