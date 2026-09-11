import { afterAll, describe, expect, it } from "bun:test";

// delete-time pool ops: filePoolState (counts scoped to ONE file via
// src_file_id) + removeFileRows (wipes available+held of ONE file, keeps
// claimed rows and other files' rows). Runs against a REAL database —
// skipped without DATABASE_URL (CI provides Postgres).
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

const PWD = "filedelpool";
const run = Date.now().toString(36);
const F1 = `fdel-${run}-f1`, F2 = `fdel-${run}-f2`;
const A = `k-${run}-avail`, H = `k-${run}-held`, C = `k-${run}-sold`, X = `k-${run}-x`;

async function seed() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES
      (${PWD},'cookies_2fa',${A},${{} as any},'available','u1',${F1},${now},NULL),
      (${PWD},'cookies_2fa',${H},${{} as any},'held','u1',${F1},${now},${`hh-${run}`}),
      (${PWD},'cookies_2fa',${C},${{} as any},'claimed','u1',${F1},${now},${`hh-${run}`}),
      (${PWD},'page',${X},${{} as any},'held','u2',${F2},${now},${`hh2-${run}`}),
      (${PWD},'page',${A},${{} as any},'held','u2',${F2},${now},${`hh2-${run}`})`;
  } finally {
    await sql.end();
  }
}

async function cleanup() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PWD}`;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!hasDb)("file delete pool ops", () => {
  afterAll(cleanup, 30_000);

  it("filePoolState counts only the file's own rows", async () => {
    await cleanup();
    await seed();
    const s1 = (await repository("pools", PWD, "filePoolState", { srcFileId: F1 })) as { held: number; claimed: number };
    expect(s1).toEqual({ held: 1, claimed: 1 });
    const s2 = (await repository("pools", PWD, "filePoolState", { srcFileId: F2 })) as { held: number; claimed: number };
    expect(s2).toEqual({ held: 2, claimed: 0 });
    const s0 = (await repository("pools", PWD, "filePoolState", { srcFileId: "" })) as { held: number; claimed: number };
    expect(s0).toEqual({ held: 0, claimed: 0 });
  }, 30_000);

  it("removeFileRows wipes available+held, keeps claimed and other files", async () => {
    await cleanup();
    await seed();
    const r = (await repository("pools", PWD, "removeFileRows", { srcFileId: F1 })) as { removed: number };
    expect(r.removed).toBe(2);
    const s1 = (await repository("pools", PWD, "filePoolState", { srcFileId: F1 })) as { held: number; claimed: number };
    expect(s1).toEqual({ held: 0, claimed: 1 });
    const s2 = (await repository("pools", PWD, "filePoolState", { srcFileId: F2 })) as { held: number; claimed: number };
    expect(s2).toEqual({ held: 2, claimed: 0 });
    const r0 = (await repository("pools", PWD, "removeFileRows", { srcFileId: "" })) as { removed: number };
    expect(r0.removed).toBe(0);
  }, 30_000);
});
