import { describe, expect, it } from "bun:test";

// Live-row seam (slice 1): ticket-gated SSE through the REAL app — routing,
// session middleware and ticket checks included, no database touched. A ticket
// is minted straight from the store (the issue route adds the auth+ownership
// check in front of the same store in production).
import { app } from "../../index";
import { consumeLiveTicket, mintLiveTicket } from "../../lib/live";
import { publishLive } from "../../lib/liveBus";
import type { Env } from "../../lib/shared";

// app.request without bindings crashes the CORS middleware (c.env) — the
// runtime always provides them, so the suite does too. No DATABASE_URL:
// none of these paths may touch the database.
const ENV: Env = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: "", SESSION_SECRET: "test-secret" };
const req = (path: string, init?: RequestInit) => app.request(path, init, ENV);

const TID = "f1";
const OTHER = "f2";

async function readData(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number): Promise<any | null> {
  const dec = new TextDecoder();
  let buf = "";
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const left = end - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      Bun.sleep(left).then(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>),
    ]);
    if (chunk.done) return null;
    buf += dec.decode(chunk.value, { stream: true });
    const m = buf.match(/data: (.*)\n\n/);
    if (m) return JSON.parse(m[1]);
  }
  return null;
}

describe("GET /api/files/:id/live", () => {
  it("refuses a stream without a ticket", async () => {
    const res = await req(`/api/files/${TID}/live`);
    expect(res.status).toBe(401);
  });

  it("refuses a stream with an unknown ticket", async () => {
    const res = await req(`/api/files/${TID}/live?ticket=nope`);
    expect(res.status).toBe(401);
  });

  it("refuses a consumed ticket (single-use)", async () => {
    const t = mintLiveTicket(TID);
    expect(consumeLiveTicket(t)).toBe(TID);
    expect(consumeLiveTicket(t)).toBeNull();
  });

  it("refuses an expired ticket", async () => {
    const t = mintLiveTicket(TID, { now: 1_000 });
    expect(consumeLiveTicket(t, { now: 1_000 + 61_000 })).toBeNull();
  });

  it("refuses a ticket minted for a different file", async () => {
    const t = mintLiveTicket(OTHER);
    const res = await req(`/api/files/${TID}/live?ticket=${t}`);
    expect(res.status).toBe(401);
  });

  it("keeps the CORS headers on the stream (raw Response drops them)", async () => {
    const t = mintLiveTicket(TID);
    const res = await req(`/api/files/${TID}/live?ticket=${t}`, {
      headers: { Origin: "https://sheetsubmit.pages.dev" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://sheetsubmit.pages.dev");
    await res.body?.cancel();
  });
});

describe("POST /api/files/:id/live-ticket", () => {
  it("refuses ticket issue without a session", async () => {
    const res = await req(`/api/files/${TID}/live-ticket`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/files/:id/live-state", () => {
  it("refuses the overlay without a session", async () => {
    const res = await req(`/api/files/${TID}/live-state`);
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("live issue → stream → state round trip", () => {
  const UID = `lvu-${Date.now().toString(36)}`;
  const FID = `lvf-${Date.now().toString(36)}`;
  const SECRET = "test-secret";
  const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET };
  const cookieFor = async () => {
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: UID, name: "t", username: "t" });
    const token = await signSession(UID, SECRET);
    await repository("index", "global", "session", { token, uid: UID, exp: Date.now() + 60_000 });
    return `ss_session=${token}`;
  };

  it("issues a ticket, streams, and serves the overlay for the owner", async () => {
    const { repository } = await import("../../lib/pg");
    const cookie = await cookieFor();
    const file = { id: FID, name: "live", type: "fb_cookie", preset: "combo", poolKind: "combo", password: "dgddigital", poolEnabled: true, createdAt: Date.now(), updatedAt: Date.now() };
    await repository("index", "global", "register", { uid: UID, file });
    await repository("files", FID, "init", { file, rows: [{ cookies: "c_user=55;", uid: "55", twofakey: "K" }] });
    try {
      const issue = await app.request(`/api/files/${FID}/live-ticket`, { method: "POST", headers: { Cookie: cookie } }, ENV2);
      expect(issue.status).toBe(200);
      const { ticket } = (await issue.json()) as { ticket: string };
      expect(typeof ticket).toBe("string");
      const stream = await app.request(`/api/files/${FID}/live?ticket=${ticket}`, {}, ENV2);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      await stream.body?.cancel();
      const state = await app.request(`/api/files/${FID}/live-state`, { headers: { Cookie: cookie } }, ENV2);
      expect(state.status).toBe(200);
      expect(await state.json()).toEqual({ states: { "55": {} } });
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM sessions WHERE user_id=${UID}`;
        await sql`DELETE FROM users WHERE user_id=${UID}`;
        await sql`DELETE FROM file_rows WHERE file_id=${FID}`;
        await sql`DELETE FROM file_meta WHERE file_id=${FID}`;
        await sql`DELETE FROM file_logs WHERE file_id=${FID}`;
      } finally {
        await sql.end();
      }
      await repository("index", "global", "purge", { id: FID }).catch(() => {});
    }
  }, 30_000);
});

describe("live fan-out", () => {
  it("streams published states only to the ticket's own file", async () => {
    const t1 = mintLiveTicket(TID);
    const t2 = mintLiveTicket(OTHER);
    const r1 = await req(`/api/files/${TID}/live?ticket=${t1}`);
    const r2 = await req(`/api/files/${OTHER}/live?ticket=${t2}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/event-stream");
    expect(r2.status).toBe(200);
    const rd1 = r1.body!.getReader();
    const rd2 = r2.body!.getReader();
    publishLive(TID, { k1: { hold: true } });
    expect(await readData(rd1, 2000)).toEqual({ states: { k1: { hold: true } } });
    expect(await readData(rd2, 100)).toBeNull();
    rd1.cancel();
    rd2.cancel();
  });
});
