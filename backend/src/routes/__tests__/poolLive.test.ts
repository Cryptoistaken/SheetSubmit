import { describe, expect, it } from "bun:test";

// Live pool-count seam: admin ticket-gated SSE through the REAL app —
// routing, session middleware and ticket checks included, no database
// touched. A ticket is minted straight from the store (the issue route adds
// the requireAuth + isAdmin check in front of the same store in production).
import { app } from "../../index";
import { consumePoolLiveTicket, mintPoolLiveTicket, poolRoom } from "../../lib/live";
import { publishRoom } from "../../lib/liveBus";
import { joinLive } from "../../lib/liveBus";
import type { Env } from "../../lib/shared";

// app.request without bindings crashes the CORS middleware (c.env) — the
// runtime always provides them, so the suite does too. No DATABASE_URL:
// none of these paths may touch the database.
const ENV: Env = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: "", SESSION_SECRET: "test-secret", ADMIN_IDS: "admin1" };
const req = (path: string, init?: RequestInit) => app.request(path, init, ENV);

const PWD = "dgddigital";
const POOL = "cookies_only";
const OTHER_POOL = "page";
const OTHER_PWD = "L0VE@12345";
const room = (pwd: string, pool: string) => `${pwd}:${pool}`;

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

describe("GET /api/pools/:password/:pool/live", () => {
  it("refuses a stream without a ticket", async () => {
    const res = await req(`/api/pools/${PWD}/${POOL}/live`);
    expect(res.status).toBe(401);
  });

  it("refuses a stream with an unknown ticket", async () => {
    const res = await req(`/api/pools/${PWD}/${POOL}/live?ticket=nope`);
    expect(res.status).toBe(401);
  });

  it("refuses a consumed ticket (single-use)", async () => {
    const t = mintPoolLiveTicket(room(PWD, POOL));
    expect(consumePoolLiveTicket(t)).toBe(room(PWD, POOL));
    expect(consumePoolLiveTicket(t)).toBeNull();
  });

  it("refuses an expired ticket", async () => {
    const t = mintPoolLiveTicket(room(PWD, POOL), { now: 1_000 });
    expect(consumePoolLiveTicket(t, { now: 1_000 + 61_000 })).toBeNull();
  });

  it("refuses a ticket minted for a different pool", async () => {
    const t = mintPoolLiveTicket(room(PWD, OTHER_POOL));
    const res = await req(`/api/pools/${PWD}/${POOL}/live?ticket=${t}`);
    expect(res.status).toBe(401);
  });

  it("refuses a ticket minted for a different password", async () => {
    const t = mintPoolLiveTicket(room(OTHER_PWD, POOL));
    const res = await req(`/api/pools/${PWD}/${POOL}/live?ticket=${t}`);
    expect(res.status).toBe(401);
  });

  it("scopes rooms per password+pool (no collision with file rooms)", async () => {
    expect(poolRoom(PWD, POOL)).toBe(`pool:${PWD}:${POOL}`);
    expect(poolRoom(PWD, POOL)).not.toBe(POOL);
  });

  it("keeps the CORS headers on the stream (raw Response drops them)", async () => {
    const t = mintPoolLiveTicket(room(PWD, POOL));
    const res = await req(`/api/pools/${PWD}/${POOL}/live?ticket=${t}`, {
      headers: { Origin: "https://sheetsubmit.pages.dev" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://sheetsubmit.pages.dev");
    await res.body?.cancel();
  });
});

describe("POST /api/pools/:password/:pool/live-ticket", () => {
  it("refuses ticket issue without a session", async () => {
    const res = await req(`/api/pools/${PWD}/${POOL}/live-ticket`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/pools/:password/:pool/live-state", () => {
  it("refuses the snapshot without a session", async () => {
    const res = await req(`/api/pools/${PWD}/${POOL}/live-state`);
    expect(res.status).toBe(401);
  });
});

describe("pool live fan-out", () => {
  it("streams published counts only to the ticket's own pool room", async () => {
    const t1 = mintPoolLiveTicket(room(PWD, POOL));
    const t2 = mintPoolLiveTicket(room(PWD, OTHER_POOL));
    const r1 = await req(`/api/pools/${PWD}/${POOL}/live?ticket=${t1}`);
    const r2 = await req(`/api/pools/${PWD}/${OTHER_POOL}/live?ticket=${t2}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toContain("text/event-stream");
    expect(r2.status).toBe(200);
    const rd1 = r1.body!.getReader();
    const rd2 = r2.body!.getReader();
    publishRoom(poolRoom(PWD, POOL), { counts: { available: 3 } });
    expect(await readData(rd1, 2000)).toEqual({ counts: { available: 3 } });
    expect(await readData(rd2, 100)).toBeNull();
    rd1.cancel();
    rd2.cancel();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("pool live issue → stream → counts round trip", () => {
  const ADMIN = `pladm-${Date.now().toString(36)}`;
  const USER = `plusr-${Date.now().toString(36)}`;
  const SECRET = "test-secret";
  const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET, ADMIN_IDS: ADMIN };
  const cookieFor = async (uid: string) => {
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
    const token = await signSession(uid, SECRET);
    await repository("index", "global", "session", { token, uid, exp: Date.now() + 60_000 });
    return `ss_session=${token}`;
  };

  it("rejects ticket issue for a non-admin session", async () => {
    const cookie = await cookieFor(USER);
    try {
      const res = await app.request(`/api/pools/${PWD}/${POOL}/live-ticket`, { method: "POST", headers: { Cookie: cookie } }, ENV2);
      expect(res.status).toBe(403);
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM sessions WHERE user_id=${USER}`;
        await sql`DELETE FROM users WHERE user_id=${USER}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);

  it("rejects the counts snapshot for a non-admin session", async () => {
    const cookie = await cookieFor(USER);
    try {
      const res = await app.request(`/api/pools/${PWD}/${POOL}/live-state`, { headers: { Cookie: cookie } }, ENV2);
      expect(res.status).toBe(403);
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM sessions WHERE user_id=${USER}`;
        await sql`DELETE FROM users WHERE user_id=${USER}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);

  it("rejects the counts snapshot for an unknown pool", async () => {
    const cookie = await cookieFor(ADMIN);
    try {
      const res = await app.request(`/api/pools/${PWD}/nope/live-state`, { headers: { Cookie: cookie } }, ENV2);
      expect(res.status).toBe(400);
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM sessions WHERE user_id=${ADMIN}`;
        await sql`DELETE FROM users WHERE user_id=${ADMIN}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);

  it("serves the counts snapshot for the poll fallback", async () => {
    const { repository } = await import("../../lib/pg");
    const adminCookie = await cookieFor(ADMIN);
    try {
      await repository("pools", PWD, "add", {
        rows: [{ cookies: "c_user=616161;", uid: "616161" }],
        uid: "seed", srcUid: "seed", srcFileId: "seedf", preset: "cookie",
      });
      const res = await app.request(`/api/pools/${PWD}/${POOL}/live-state`, { headers: { Cookie: adminCookie } }, ENV2);
      expect(res.status).toBe(200);
      const snap = (await res.json()) as any;
      expect(snap.type).toBe("pool-counts");
      expect(snap.password).toBe(PWD);
      expect(snap.pool).toBe(POOL);
      expect(typeof snap.available).toBe("number");
      expect(snap.pools).toEqual([{ id: POOL, available: snap.available }]);
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM pool_rows WHERE password=${PWD} AND row_key='616161'`;
        await sql`DELETE FROM pool_rejects WHERE password=${PWD}`;
        await sql`DELETE FROM sessions WHERE user_id=${ADMIN}`;
        await sql`DELETE FROM users WHERE user_id=${ADMIN}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);

  it("issues a ticket as admin, streams, and receives pool-counts", async () => {
    const { repository } = await import("../../lib/pg");
    const { publishPoolCounts } = await import("../../lib/livePublish");
    const adminCookie = await cookieFor(ADMIN);
    try {
      const issue = await app.request(`/api/pools/${PWD}/${POOL}/live-ticket`, { method: "POST", headers: { Cookie: adminCookie } }, ENV2);
      expect(issue.status).toBe(200);
      const { ticket } = (await issue.json()) as { ticket: string };
      expect(typeof ticket).toBe("string");
      const stream = await app.request(`/api/pools/${PWD}/${POOL}/live?ticket=${ticket}`, {}, ENV2);
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const reader = stream.body!.getReader();
      await repository("pools", PWD, "add", {
        rows: [{ cookies: "c_user=515151;", uid: "515151" }],
        uid: "seed", srcUid: "seed", srcFileId: "seedf", preset: "cookie",
      });
      const n = await publishPoolCounts(PWD, POOL);
      expect(n).toBeGreaterThanOrEqual(1);
      const msg = await readData(reader, 5000);
      expect(msg.type).toBe("pool-counts");
      expect(msg.password).toBe(PWD);
      expect(msg.pool).toBe(POOL);
      expect(typeof msg.available).toBe("number");
      expect(typeof msg.claimed).toBe("number");
      expect(typeof msg.users).toBe("number");
      expect(typeof msg.invalid).toBe("number");
      expect(Array.isArray(msg.pools)).toBe(true);
      expect(msg.pools).toContainEqual({ id: POOL, available: msg.available });
      reader.cancel();
    } finally {
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM pool_rows WHERE password=${PWD} AND row_key='515151'`;
        await sql`DELETE FROM pool_rejects WHERE password=${PWD}`;
        await sql`DELETE FROM sessions WHERE user_id=${ADMIN}`;
        await sql`DELETE FROM users WHERE user_id=${ADMIN}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);

    it("fans fresh counts out when a pool write commits", async () => {

    const { repository } = await import("../../lib/pg");
    const WPWD = `plw-${Date.now().toString(36)}`;
    const got: string[] = [];
    const leave = joinLive(poolRoom(WPWD, POOL), (msg) => got.push(msg));
    try {
      await repository("pools", WPWD, "add", {
        rows: [{ cookies: "c_user=424242;", uid: "424242" }],
        uid: "seed", srcUid: "seed", srcFileId: "seedf", preset: "cookie",
      });
      const deadline = Date.now() + 5000;
      while (!got.length && Date.now() < deadline) await Bun.sleep(50);
      expect(got.length).toBe(1);
      const msg = JSON.parse(got[0]);
      expect(msg.type).toBe("pool-counts");
      expect(msg.password).toBe(WPWD);
      expect(msg.pool).toBe(POOL);
      expect(msg.available).toBe(1);
    } finally {
      leave();
      const { default: postgres } = await import("postgres");
      const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
      try {
        await sql`DELETE FROM pool_rows WHERE password=${WPWD}`;
        await sql`DELETE FROM pool_rejects WHERE password=${WPWD}`;
      } finally {
        await sql.end();
      }
    }
  }, 30_000);
});
