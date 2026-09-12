import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// Admin fixes (B1/B2/B3/M15/M7): real app + real DB, harness mirrors
// poolLive.test.ts — app.request(path, init, ENV) with minted sessions.
import { app } from "../../index";

const TAG = Date.now().toString(36);
const TAIL = String(Date.now() % 100000000).padStart(8, "0");
const SECRET = "test-secret";
const ADMIN = `afx-adm-${TAG}`;
const PWD = "dgddigital";
const POOL = "cookies_only";
const K1 = `61${TAIL}`, K2 = `71${TAIL}`, K3 = `81${TAIL}`;
const O1 = `afx-o1-${TAG}`, O2 = `afx-o2-${TAG}`, O3 = `afx-o3-${TAG}`;
const U1 = `afx-u1-${TAG}`, U2 = `afx-u2-${TAG}`;
const F1 = `afxf1-${TAG}`, F2 = `afxf2-${TAG}`, F3 = `afxf3-${TAG}`;
const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET, ADMIN_IDS: ADMIN } as any;
let H: Record<string, string> = {};

const row = (uid: string) => ({ uid, cookies: `c_user=${uid};`, status: "good" });
const mkfile = (id: string) => ({ id, name: `afx-${TAG}`, type: "fb_cookie", preset: "cookie", poolKind: "cookie", password: PWD, poolEnabled: true, createdAt: Date.now(), updatedAt: Date.now() });
const db = async () => { const { default: postgres } = await import("postgres"); return postgres(process.env.DATABASE_URL as string, { max: 1 }); };

describe.skipIf(!process.env.DATABASE_URL)("admin fixes", () => {
  beforeAll(async () => {
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    for (const u of [ADMIN, O1, O2, O3, U1, U2]) await repository("index", "global", "ensureUser", { id: u, name: "t", username: "t" });
    const token = await signSession(ADMIN, SECRET);
    await repository("index", "global", "session", { token, uid: ADMIN, exp: Date.now() + 300_000 });
    H = { Cookie: `ss_session=${token}`, "Content-Type": "application/json" };
  }, 30_000);

  afterAll(async () => {
    const sql = await db();
    try {
      await sql`DELETE FROM pool_rows WHERE password=${PWD} AND (src_file_id IN (${F1},${F2},${F3}) OR row_key IN (${K1},${K2},${K3}))`;
      await sql`DELETE FROM pool_rejects WHERE row_key IN (${K1},${K2},${K3})`;
      await sql`DELETE FROM file_rows WHERE file_id IN (${F1},${F2},${F3})`;
      await sql`DELETE FROM file_logs WHERE file_id IN (${F1},${F2},${F3})`;
      await sql`DELETE FROM file_meta WHERE file_id IN (${F1},${F2},${F3})`;
      await sql`DELETE FROM meta WHERE k IN (${`filesnap:${F1}`},${`filesnap:${F2}`},${`filesnap:${F3}`},${`filetomb:${F1}`},${`filetomb:${F2}`},${`filetomb:${F3}`})`;
      await sql`DELETE FROM file_index WHERE file_id IN (${F1},${F2},${F3})`;
      await sql`DELETE FROM sessions WHERE user_id IN (${ADMIN},${O1},${O2},${O3},${U1},${U2})`;
      await sql`DELETE FROM users WHERE user_id IN (${ADMIN},${O1},${O2},${O3},${U1},${U2})`;
    } finally { await sql.end(); }
  }, 30_000);

  it("B1: admin restore-snapshot re-feeds pools", async () => {
    const { repository } = await import("../../lib/pg");
    const file = mkfile(F1);
    await repository("index", "global", "register", { uid: O1, file });
    await repository("files", F1, "init", { file, rows: [row(K1)] });
    const p = await app.request(`/api/admin/file/${F1}/persist`, { method: "PUT", headers: H, body: JSON.stringify({ rows: [row(K2)] }) }, ENV2);
    expect(p.status).toBe(200);
    const r = await app.request(`/api/admin/file/${F1}/restore-snapshot`, { method: "POST", headers: H, body: JSON.stringify({}) }, ENV2);
    expect(r.status).toBe(200);
    const detail = (await repository("pools", PWD, "detail", { pool: POOL })) as { _key: string }[];
    expect(detail.map((d) => d._key)).toContain(K1);
  }, 30_000);

  it("B2: admin file delete refuses held rows", async () => {
    const { repository } = await import("../../lib/pg");
    const file = mkfile(F2);
    await repository("index", "global", "register", { uid: O2, file });
    await repository("files", F2, "init", { file, rows: [row(K3)] });
    const sql = await db();
    try {
      await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES(${PWD},${POOL},${K3},${{} as any},'held',${O2},${F2},${Date.now()},${`hh-${TAG}`})`;
      const del1 = await app.request(`/api/admin/file/${F2}`, { method: "DELETE", headers: H }, ENV2);
      expect(del1.status).toBe(409);
      await sql`DELETE FROM pool_rows WHERE password=${PWD} AND src_file_id=${F2}`;
      const del2 = await app.request(`/api/admin/file/${F2}`, { method: "DELETE", headers: H }, ENV2);
      expect(del2.status).toBe(200);
      const left: any[] = await sql`SELECT COUNT(*) n FROM pool_rows WHERE password=${PWD} AND src_file_id=${F2}`;
      expect(Number(left[0].n)).toBe(0);
    } finally { await sql.end(); }
  }, 30_000);

  it("B3: admin file update rejects password change", async () => {
    const { repository } = await import("../../lib/pg");
    const file = mkfile(F3);
    await repository("index", "global", "register", { uid: O3, file });
    await repository("files", F3, "init", { file, rows: [row(K2)] });
    const bad = await app.request(`/api/admin/file/${F3}`, { method: "PUT", headers: H, body: JSON.stringify({ password: "other" }) }, ENV2);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error).toBe("password change not allowed - create a new file instead (pool rows are keyed by password)");
    const same = await app.request(`/api/admin/file/${F3}`, { method: "PUT", headers: H, body: JSON.stringify({ password: PWD }) }, ENV2);
    expect(same.status).toBe(200);
    const ok = await app.request(`/api/admin/file/${F3}`, { method: "PUT", headers: H, body: JSON.stringify({ name: "renamed" }) }, ENV2);
    expect(ok.status).toBe(200);
  }, 30_000);

  it("M7: GET /users filters by ?q=", async () => {
    const s = await app.request(`/api/admin/users?q=${encodeURIComponent(U1)}`, { headers: H }, ENV2);
    expect(s.status).toBe(200);
    const ids = ((await s.json()) as any[]).map((u) => u.id);
    expect(ids).toContain(U1);
    expect(ids).not.toContain(U2);
    const all = await app.request(`/api/admin/users`, { headers: H }, ENV2);
    expect(all.status).toBe(200);
    expect(Array.isArray(await all.json())).toBe(true);
  }, 30_000);
});
