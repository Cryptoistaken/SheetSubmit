import { afterAll, describe, expect, it } from "bun:test";
import { app } from "../../index";
import { repository } from "../../lib/pg";

// Admin /analysis support: real app + real DB, harness mirrors poolLive.test.ts.
const hasDb = !!process.env.DATABASE_URL;
const TAG = Date.now().toString(36);
const ADMIN = `adm-an-${TAG}`;
const USER = `usr-an-${TAG}`;
const SECRET = "test-secret";
const ENV2: any = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET, ADMIN_IDS: ADMIN };

const cookieFor = async (uid: string) => {
  const { signSession } = await import("../../lib/session");
  await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
  const token = await signSession(uid, SECRET);
  await repository("index", "global", "session", { token, uid, exp: Date.now() + 60_000 });
  return `ss_session=${token}`;
};

describe.skipIf(!hasDb)("admin analysis", () => {
  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id IN (${ADMIN},${USER})`;
      await sql`DELETE FROM users WHERE user_id IN (${ADMIN},${USER})`;
    } finally { await sql.end(); }
  }, 30_000);

  it("non-admin → 403 on both routes", async () => {
    const ck = await cookieFor(USER);
    const h = await app.request("/api/admin/dbhealth", { headers: { Cookie: ck } }, ENV2);
    expect(h.status).toBe(403);
    const u = await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, ENV2);
    expect(u.status).toBe(403);
  }, 30_000);

  it("admin dbhealth → 200 with tables+seqScans+statements", async () => {
    const ck = await cookieFor(ADMIN);
    const r = await app.request("/api/admin/dbhealth", { headers: { Cookie: ck } }, ENV2);
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(Array.isArray(j.tables)).toBe(true);
    expect(j.tables.length).toBeGreaterThan(0);
    for (const t of j.tables) { expect(typeof t.table).toBe("string"); expect(typeof t.bytes).toBe("number"); expect(typeof t.rows).toBe("number"); }
    expect(Array.isArray(j.seqScans)).toBe(true);
    expect(typeof j.statements?.statsAvailable).toBe("boolean");
    if (j.statements.statsAvailable) {
      expect(Array.isArray(j.statements.byTime)).toBe(true);
      expect(Array.isArray(j.statements.byCalls)).toBe(true);
    }
  }, 30_000);

  it("admin neon-usage → 200 configured:false without env", async () => {
    const ck = await cookieFor(ADMIN);
    const r = await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, ENV2);
    expect(r.status).toBe(200);
    expect((await r.json()) as any).toEqual({ configured: false });
  }, 30_000);

  // guards the host + field mapping: api.neon.tech stopped resolving, which
  // silently turned the cost tracker into "not configured" forever.
  it("neon usage maps the live /api/v2 project shape", async () => {
    const key = process.env.NEON_API_KEY, projectId = process.env.NEON_PROJECT_ID;
    if (!key || !projectId) return;
    const r = await fetch(`https://console.neon.tech/api/v2/projects/${projectId}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return;
    const p: any = ((await r.json()) as any).project;
    expect(p).toBeDefined();
    const des = p.default_endpoint_settings ?? {};
    expect(typeof p.compute_time_seconds).toBe("number");
    expect(typeof p.synthetic_storage_size).toBe("number");
    expect(p.consumption_period_start).toBeString();
    expect(des.autoscaling_limit_min_cu).toBeNumber();
    expect(des.autoscaling_limit_max_cu).toBeNumber();
  }, 30_000);
});
