import { afterAll, describe, expect, it } from "bun:test";

// pool_blocked: sold keys are recorded on claim/approve and refused at feed
// time, so deleted files' accounts can never be re-uploaded and resold.
// Runs against a REAL database — skipped without DATABASE_URL (CI provides
// Postgres for the e2e job schema; unit CI runs without DB).
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

const PWD = "poolblocked";
const run = Date.now().toString(36);
const stem = Date.now().toString().slice(-9);
const K1 = `7${stem}11`.slice(0, 18);
const K2 = `7${stem}22`.slice(0, 18);
const K3 = `7${stem}33`.slice(0, 18);
const H1 = `blk-${run}-h1`;

async function seed() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO downloads(id,password,pool_id,claimed_by,claimed,keys,rows,ts,status,unit_price,total,action_count,first_action_at,settled)
      VALUES(${H1},${PWD},'cookies_2fa','buyer1',1,${[K1] as any},${[{}] as any},${now},'HOLD',0.05,0.05,0,null,false)`;
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES
      (${PWD},'cookies_2fa',${K1},${{} as any},'held','owner1','file1',${now},${H1}),
      (${PWD},'cookies_2fa',${K2},${{} as any},'available','owner1','file1',${now},NULL)`;
  } finally {
    await sql.end();
  }
}

async function cleanup() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PWD}`;
    await sql`DELETE FROM downloads WHERE password=${PWD}`;
    await sql`DELETE FROM pool_blocked WHERE row_key IN (${K1},${K2},${K3})`;
  } finally {
    await sql.end();
  }
}

async function blockedReason(k: string): Promise<string | null> {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    const r: any[] = await sql`SELECT reason FROM pool_blocked WHERE row_key=${k}`;
    return r[0]?.reason ?? null;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!hasDb)("pool_blocked", () => {
  afterAll(cleanup, 30_000);

  it("holdApprove records the sold keys", async () => {
    await cleanup();
    await seed();
    const r = (await repository("pools", PWD, "holdApprove", { id: H1 })) as { approved: number };
    expect(r.approved).toBe(1);
    expect(await blockedReason(K1)).toBe("sold");
  }, 30_000);

  it("instant claim records the sold key", async () => {
    await cleanup();
    await seed();
    const r = (await repository("pools", PWD, "claim", { pool: "cookies_2fa", count: 5, uid: "buyer2" })) as { claimed: number };
    expect(r.claimed).toBe(1);
    expect(await blockedReason(K2)).toBe("sold");
  }, 30_000);

  it("add refuses blocklisted keys at feed time", async () => {
    await cleanup();
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`INSERT INTO pool_blocked(row_key,reason,ts) VALUES(${K3},'sold',${Date.now()}) ON CONFLICT(row_key) DO NOTHING`;
    } finally {
      await sql.end();
    }
    const row = { uid: K3, cookies: `c_user=${K3}; xs=1`, twofakey: "JBSWY3DPEHPK3PXP", status: "good" };
    const r = (await repository("pools", PWD, "add", { rows: [row], uid: "u9", srcUid: "u9", srcFileId: "f9", preset: "combo" })) as { added: number; blocked: number };
    expect(r.added).toBe(0);
    expect(r.blocked).toBe(1);
  }, 30_000);
});
