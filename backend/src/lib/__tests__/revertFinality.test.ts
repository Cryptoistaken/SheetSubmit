import { afterAll, describe, expect, it } from "bun:test";

// revertDownload finality seam: Delete on an approval must not claw back a
// decided hold after the 5-minute window (or once settled). Runs against a
// REAL database — set DATABASE_URL to run, skipped without it (CI runs Pages
// unit tests only). pg.ts builds its client at import time, so the import
// itself is conditional: the file must stay green with no DB configured.
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

const PWD = "revfinal";
const run = Date.now().toString(36);
const id = (tag: string) => `revt-${run}-${tag}`;

async function mkDownload(tag: string, over: Record<string, unknown> = {}) {
  const row = {
    id: id(tag),
    password: PWD,
    pool_id: "cookies_2fa",
    ts: Date.now(),
    status: "HOLD",
    unit_price: 0.05,
    total: 0.05,
    action_count: 0,
    first_action_at: null,
    settled: false,
    ...over,
  };
  // minimal insert via a throwaway client (repository has no raw-insert op)
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`INSERT INTO downloads(id,password,pool_id,ts,status,unit_price,total,action_count,first_action_at,settled)
      VALUES(${row.id},${row.password},${row.pool_id},${row.ts},${row.status as string},${row.unit_price as number},${row.total as number},${row.action_count as number},${row.first_action_at as number | null},${row.settled as boolean})`;
  } finally {
    await sql.end();
  }
  return row.id;
}

async function revert(id: string) {
  return repository("pools", PWD, "revertDownload", { id }) as Promise<{ ok: boolean; status: string }>;
}

describe.skipIf(!hasDb)("revertDownload finality", () => {
  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM downloads WHERE id LIKE ${`revt-${run}-%`}`;
    } finally {
      await sql.end();
    }
  }, 30_000);

  it("lets an undecided HOLD revert (pre-decision cleanup still works)", async () => {
    const hid = await mkDownload("hold");
    const r = await revert(hid);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("REVERTED");
  }, 30_000);

  it("lets an in-window APPROVED revert (Delete flow inside the window)", async () => {
    const hid = await mkDownload("inwin", { status: "APPROVED", action_count: 1, first_action_at: Date.now() });
    const r = await revert(hid);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("REVERTED");
  }, 30_000);

  it("refuses an APPROVED revert after the 5-minute window", async () => {
    const hid = await mkDownload("old", { status: "APPROVED", action_count: 1, first_action_at: Date.now() - 6 * 60 * 1000 });
    await expect(revert(hid)).rejects.toThrow("decision is final");
  }, 30_000);

  it("refuses a SETTLED approved revert even inside the window", async () => {
    const hid = await mkDownload("settled", { status: "APPROVED", action_count: 1, first_action_at: Date.now(), settled: true });
    await expect(revert(hid)).rejects.toThrow("decision is final");
  }, 30_000);

  it("refuses a twice-actioned revert", async () => {
    const hid = await mkDownload("twice", { status: "REJECTED", action_count: 2, first_action_at: Date.now() });
    await expect(revert(hid)).rejects.toThrow("decision is final");
  }, 30_000);

  it("keeps REJECTED unrevertable and REVERTED idempotent", async () => {
    const rej = await mkDownload("rej", { status: "REJECTED", action_count: 1, first_action_at: Date.now() });
    await expect(revert(rej)).rejects.toThrow("not revertable");
    const rev = await mkDownload("rev", { status: "REVERTED", action_count: 1, first_action_at: Date.now() });
    const r = await revert(rev);
    expect(r).toMatchObject({ ok: true, status: "REVERTED" });
  }, 30_000);
});
