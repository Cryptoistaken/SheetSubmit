import { afterAll, describe, expect, it } from "bun:test";
import { app } from "../../index";

// Wallet API additions: slim balance endpoint (H10), idempotent withdraw via
// client requestId (H5), and the chunked-body size cap (L3).
const hasDb = !!process.env.DATABASE_URL;
const SECRET = "test-secret";
const TAG = `wal${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const UID = `wal-u-${TAG}`;
const ENV = {
  INDEX: "index" as const,
  FILES: "files" as const,
  POOLS: "pools" as const,
  DATABASE_URL: process.env.DATABASE_URL as string,
  SESSION_SECRET: SECRET,
};

async function cookieFor(uid: string) {
  const { signSession } = await import("../../lib/session");
  const { repository } = await import("../../lib/pg");
  await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
  const token = await signSession(uid, SECRET);
  await repository("index", "global", "session", { token, uid, exp: Date.now() + 300_000 });
  return `ss_session=${token}`;
}

const post = (path: string, cookie: string | null, body: unknown) =>
  app.request(path, { method: "POST", headers: { Cookie: cookie ?? "", "Content-Type": "application/json" }, body: JSON.stringify(body) }, ENV);

describe.skipIf(!hasDb)("wallet API", () => {
  it("GET /api/wallet/balance returns just the balance", async () => {
    const uid = `${UID}-1`;
    const cookie = await cookieFor(uid);
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "walletCredit", { uid, amount: 25, title: "seed", direction: "credit", adminUid: "t" });
    const res = await app.request("/api/wallet/balance", { headers: { Cookie: cookie } }, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uid: string; balance: number };
    expect(body.uid).toBe(uid);
    expect(body.balance).toBe(25);
  });

  it("withdraw with the same requestId is applied once", async () => {
    const uid = `${UID}-2`;
    const cookie = await cookieFor(uid);
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "walletCredit", { uid, amount: 100, title: "seed", direction: "credit", adminUid: "t" });
    const rid = `wrid-${TAG}-a`;
    const a = await post("/api/wallet/withdraw", cookie, { amount: 10, method: "bKash", account: "01700000000", requestId: rid });
    const b = await post("/api/wallet/withdraw", cookie, { amount: 10, method: "bKash", account: "01700000000", requestId: rid });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(((await a.json()) as { id: string }).id).toBe(rid);
    expect(((await b.json()) as { id: string }).id).toBe(rid);
    const bal = (await (await app.request("/api/wallet/balance", { headers: { Cookie: cookie } }, ENV)).json()) as { balance: number };
    expect(bal.balance).toBe(90);
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      const r: any[] = await sql`SELECT COUNT(*) n FROM withdrawals WHERE user_id=${uid}`;
      expect(Number(r[0].n)).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it("rejects a chunked body over 4MB with 413", async () => {
    const big = new ReadableStream({ start(ctrl) { ctrl.enqueue(new Uint8Array(4_100_000)); ctrl.close(); } });
    const res = await app.request("/api/wallet/withdraw", { method: "POST", body: big as any, headers: { "Content-Type": "application/json" } } as any, ENV);
    expect(res.status).toBe(413);
  });

  it("still passes a small chunked body through to the handler", async () => {
    const uid = `${UID}-3`;
    const cookie = await cookieFor(uid);
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "walletCredit", { uid, amount: 50, title: "seed", direction: "credit", adminUid: "t" });
    const small = new ReadableStream({ start(ctrl) { ctrl.enqueue(new TextEncoder().encode(JSON.stringify({ amount: 5, method: "bKash", account: "01700000001" }))); ctrl.close(); } });
    const res = await app.request("/api/wallet/withdraw", { method: "POST", body: small as any, headers: { Cookie: cookie, "Content-Type": "application/json" } } as any, ENV);
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM wallet_transactions WHERE user_id LIKE ${`${UID}%`}`;
      await sql`DELETE FROM withdrawals WHERE user_id LIKE ${`${UID}%`}`;
      await sql`DELETE FROM wallets WHERE user_id LIKE ${`${UID}%`}`;
      await sql`DELETE FROM sessions WHERE user_id LIKE ${`${UID}%`}`;
      await sql`DELETE FROM users WHERE user_id LIKE ${`${UID}%`}`;
    } finally {
      await sql.end();
    }
  });
});
