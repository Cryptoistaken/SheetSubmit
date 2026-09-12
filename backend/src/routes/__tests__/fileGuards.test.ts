import { describe, expect, it, afterAll } from "bun:test";

// File-route guards: M15 awaited pool feeds, H7 cross-dups cap removal, L5
// file meta validation, L6 persist guards, L7 append value caps, M10
// batch-delete cap 40.
import { app } from "../../index";

describe.skipIf(!process.env.DATABASE_URL)("file route guards", () => {
  const SECRET = "test-secret";
  const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET };
  const TAG = `fg${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const UID = `fgu-${TAG}`;
  const FIDS: string[] = [];
  let n = 0;
  const D = (s: string) => { let h = ""; for (const ch of `${s}:${TAG}:${++n}`) h += String(ch.charCodeAt(0) % 10); return (h + "1234567890").slice(0, 12); };
  const crow = (d: string) => ({ uid: d, cookies: `c_user=${d}; xs=abc`, status: "good" } as any);

  let cookie = "";
  const setup = async () => {
    if (cookie) return;
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: UID, name: "t", username: "t" });
    const token = await signSession(UID, SECRET);
    await repository("index", "global", "session", { token, uid: UID, exp: Date.now() + 300_000 });
    cookie = `ss_session=${token}`;
  };
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { Cookie: cookie, "Content-Type": "application/json", ...(init.headers || {}) } }, ENV2);
  const postFile = async (rows: any[]) => {
    const res = await req("/api/files", { method: "POST", body: JSON.stringify({ name: `fg-${TAG}`, preset: "cookie", rows }) });
    expect(res.status).toBe(200);
    const f = (await res.json()) as { id: string };
    FIDS.push(f.id);
    return f.id;
  };
  const poolKeys = async () => {
    const { repository } = await import("../../lib/pg");
    return (await repository("pools", "dgddigital", "detail", { pool: "cookies_only" })) as { _key: string }[];
  };

  it("M15: POST feed is awaited (row visible in pool detail immediately)", async () => {
    await setup();
    const d = D("m15a");
    await postFile([crow(d)]);
    const detail = await poolKeys();
    expect(detail.some((r) => r._key === d)).toBe(true);
  });

  it("M15: persist feed is awaited (new row visible immediately)", async () => {
    await setup();
    const d1 = D("m15b1"), d2 = D("m15b2");
    const fid = await postFile([crow(d1)]);
    const p = await req(`/api/files/${fid}/persist`, { method: "PUT", body: JSON.stringify({ rows: [crow(d1), crow(d2)] }) });
    expect(p.status).toBe(200);
    const detail = await poolKeys();
    expect(detail.some((r) => r._key === d2)).toBe(true);
  });

  it("H7: 41 same-type files do not 400; shared key reported", async () => {
    await setup();
    const { repository } = await import("../../lib/pg");
    const ids: string[] = [];
    const SHARED = D("shared");
    for (let i = 0; i < 41; i++) {
      const id = `fgh-${TAG}-${i}`;
      ids.push(id); FIDS.push(id);
      const file = { id, name: `fgh-${i}`, type: "fb_cookie", createdAt: Date.now(), updatedAt: Date.now() };
      const rows = i < 2 ? [crow(SHARED)] : [crow(D(`solo${i}`))];
      await repository("index", "global", "register", { uid: UID, file });
      await repository("files", id, "init", { file, rows });
    }
    const res = await req(`/api/cross-dups?fileId=${ids[0]}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { counts: Record<string, number>; dups: Record<string, { fileId: string }[]> };
    expect(Object.keys(body).sort()).toEqual(["counts", "dups"]);
    expect(SHARED in body.dups).toBe(true);
    expect(body.dups[SHARED].length).toBe(2);
  });

  it("L5: meta validation rejects bad type/columns/password, allows rename", async () => {
    await setup();
    const fid = await postFile([crow(D("l5"))]);
    const put = (b: unknown) => req(`/api/files/${fid}`, { method: "PUT", body: JSON.stringify(b) });
    const evil = await put({ type: "evil" });
    expect(evil.status).toBe(400);
    const cols = await put({ columns: [42] });
    expect(cols.status).toBe(400);
    const pw = await put({ password: "other" });
    expect(pw.status).toBe(400);
    expect((await pw.json()) as any).toEqual({ error: "password change not allowed - create a new file instead (pool rows are keyed by password)" });
    const ok = await put({ name: "ok rename" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).name).toBe("ok rename");
  });

  it("L6: persist ignores out-of-range dataCount, sanitizes action", async () => {
    await setup();
    const d = D("l6");
    const fid = await postFile([crow(d)]);
    const p = await req(`/api/files/${fid}/persist`, { method: "PUT", body: JSON.stringify({ rows: [crow(d)], dataCount: 99999 }) });
    expect(p.status).toBe(200);
    const full = await (await req(`/api/files/${fid}/full`)).json() as { file: any };
    expect(full.file.dataCount).not.toBe(99999);
    const p2 = await req(`/api/files/${fid}/persist`, { method: "PUT", body: JSON.stringify({ rows: [crow(d)], action: "Weird ACTION!!!" }) });
    expect(p2.status).toBe(200);
    const full2 = await (await req(`/api/files/${fid}/full`)).json() as { file: any };
    expect(full2.file.lastAction).toBe("WeirdACTION");
    expect(/^[A-Za-z-]{1,32}$/.test(full2.file.lastAction)).toBe(true);
  });

  it("L7: append rejects huge string values, accepts small appends", async () => {
    await setup();
    const fid = await postFile([crow(D("l7"))]);
    const seq = ((await (await req(`/api/files/${fid}/full`)).json()) as { seq: number }).seq;
    const big = await req(`/api/files/${fid}/append`, { method: "PUT", body: JSON.stringify({ base: seq, ops: [{ rowIdx: 0, cols: { uid: "x".repeat(60000) } }] }) });
    expect(big.status).toBe(400);
    const small = await req(`/api/files/${fid}/append`, { method: "PUT", body: JSON.stringify({ base: seq, ops: [{ rowIdx: 0, cols: { uid: D("l7n") } }] }) });
    expect(small.status).toBe(200);
  });

  it("M10: batch-delete caps at 40", async () => {
    await setup();
    const ids41 = Array.from({ length: 41 }, (_, i) => `fg-fake-${TAG}-${i}`);
    const r41 = await req("/api/archive/batch-delete", { method: "POST", body: JSON.stringify({ ids: ids41 }) });
    expect(r41.status).toBe(400);
    expect((await r41.json()) as any).toEqual({ error: "too many ids" });
    const ids40 = ids41.slice(0, 40);
    const r40 = await req("/api/archive/batch-delete", { method: "POST", body: JSON.stringify({ ids: ids40 }) });
    expect(r40.status).toBe(200);
    expect((await r40.json()) as any).toEqual({ deleted: 0 });
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id=${UID}`;
      if (FIDS.length) {
        await sql`DELETE FROM pool_rows WHERE src_file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM file_rows WHERE file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM file_meta WHERE file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM file_logs WHERE file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM meta WHERE k IN ${sql(FIDS.map((id) => `filesnap:${id}`))}`;
      }
      await sql`DELETE FROM users WHERE user_id=${UID}`;
    } finally {
      await sql.end();
    }
    const { repository } = await import("../../lib/pg");
    for (const id of FIDS) await repository("index", "global", "purge", { id }).catch(() => {});
  });
});
