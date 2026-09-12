import { afterAll, beforeAll, describe, expect, it } from "bun:test";

// R3 seam: the HTTP surface of authed file reads. Browsers cache these responses
// and revalidate with If-None-Match; a bodyless 304 saves the payload on every
// repeat load. Real app -> routing + session middleware + DB included.
import { app } from "../../index";
import type { Env } from "../../lib/shared";

const UID = `etagu-${Date.now().toString(36)}`;
const FID = `etagf-${Date.now().toString(36)}`;
const SECRET = "test-secret";
const ORIGIN = "https://sheetsubmit.pages.dev";
const ENV = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET } as Env;
let cookie = "";
let file: Record<string, unknown>;

const get = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { Origin: ORIGIN, Cookie: cookie, ...headers } }, ENV);

describe.skipIf(!process.env.DATABASE_URL)("authed file reads revalidate (ETag/304)", () => {
  beforeAll(async () => {
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: UID, name: "t", username: "t" });
    const token = await signSession(UID, SECRET);
    await repository("index", "global", "session", { token, uid: UID, exp: Date.now() + 60_000 });
    cookie = `ss_session=${token}`;
    file = { id: FID, name: "etag", type: "fb_cookie", preset: "combo", poolKind: "combo", password: "dgddigital", poolEnabled: true, createdAt: Date.now(), updatedAt: Date.now() };
    await repository("index", "global", "register", { uid: UID, file });
    await repository("files", FID, "init", { file, rows: [{ uid: "1", cookies: "c_user=1;" }] });
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id=${UID}`;
      await sql`DELETE FROM file_rows WHERE file_id=${FID}`;
      await sql`DELETE FROM file_meta WHERE file_id=${FID}`;
      await sql`DELETE FROM file_logs WHERE file_id=${FID}`;
      await sql`DELETE FROM meta WHERE k=${`filesnap:${FID}`}`;
      await sql`DELETE FROM file_index WHERE file_id=${FID}`;
      await sql`DELETE FROM users WHERE user_id=${UID}`;
    } finally { await sql.end(); }
  });

  it("serves ETag + private no-cache and a bodyless 304 on match", async () => {
    const first = await get("/api/files");
    expect(first.status).toBe(200);
    const tag = first.headers.get("ETag");
    expect(tag).toBeTruthy();
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");

    const again = await get("/api/files", { "If-None-Match": tag! });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(tag);
    expect(again.headers.get("Cache-Control")).toBe("private, no-cache");
    expect(again.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await again.text()).toBe("");
  });

  it("revalidates a full file read the same way", async () => {
    const first = await get(`/api/files/${FID}/full`);
    expect(first.status).toBe(200);
    const tag = first.headers.get("ETag");
    expect(tag).toBeTruthy();
    const again = await get(`/api/files/${FID}/full`, { "If-None-Match": tag! });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
  });

  it("issues a new ETag once the content changes", async () => {
    const first = await get("/api/files");
    const tag = first.headers.get("ETag")!;
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "register", { uid: UID, file: { ...file, name: "etag renamed", updatedAt: Date.now() + 1000 } });
    const stale = await get("/api/files", { "If-None-Match": tag });
    expect(stale.status).toBe(200);
    expect(stale.headers.get("ETag")).not.toBe(tag);
  });

  it("leaves other authed reads and non-GET methods uncached", async () => {
    const me = await get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.headers.get("ETag")).toBeNull();
    expect(me.headers.get("Cache-Control")).toBeNull();

    const first = await get("/api/files");
    const del = await app.request(`/api/files/${FID}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: cookie, "If-None-Match": first.headers.get("ETag")! } }, ENV);
    expect(del.status).not.toBe(304);
  });
});
