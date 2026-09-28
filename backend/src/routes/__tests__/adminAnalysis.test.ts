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

  it("admin neon-usage → 200 configured:false naming the absent vars", async () => {
    const ck = await cookieFor(ADMIN);
    const r = await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, ENV2);
    expect(r.status).toBe(200);
    // A bare {configured:false} is a dead end when the var is in fact set on
    // another service, so the route names what is missing (never its value).
    const j: any = await r.json();
    expect(j.configured).toBe(false);
    expect(j.missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
  }, 30_000);

  it("neon-usage reports only the half that is set", async () => {
    const ck = await cookieFor(ADMIN);
    const onlyProject: any = { ...ENV2, NEON_API_KEY: "   ", NEON_PROJECT_ID: "pid-123" };
    // A whitespace-only key is trimmed to empty and reported as missing, not
    // sent upstream as a blank bearer token.
    const blank = await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, onlyProject);
    expect(((await blank.json()) as any).missing).toEqual(["NEON_API_KEY"]);

    const onlyKey: any = { ...ENV2, NEON_API_KEY: "secret" };
    const j: any = await (await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, onlyKey)).json();
    expect(j.missing).toEqual(["NEON_PROJECT_ID"]);
  }, 30_000);

  it("neon-usage surfaces the upstream status instead of a bare error", async () => {
    const ck = await cookieFor(ADMIN);
    const env: any = { ...ENV2, NEON_API_KEY: "definitely-not-a-real-key", NEON_PROJECT_ID: "pid-does-not-exist" };
    const r = await app.request("/api/admin/neon-usage", { headers: { Cookie: ck } }, env);
    // 200 on purpose: these are soft outcomes the client renders. A 5xx would
    // be caught by the caller and collapse into a blank, uninformative tile —
    // exactly the dead end these diagnostics exist to remove.
    expect(r.status).toBe(200);
    const j: any = await r.json();
    // 401/403 (bad key) and an outage are different fixes; the UI needs to say
    // which one it hit.
    expect(j.error).toBe("neon api unavailable");
    expect(typeof j.status).toBe("number");
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
