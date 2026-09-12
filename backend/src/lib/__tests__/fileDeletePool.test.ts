import { afterAll, describe, expect, it } from "bun:test";

// delete-time pool ops: filePoolState (counts scoped to ONE file via
// src_file_id) + removeFileRows (wipes EVERYTHING sourced from one file,
// any state) + userFiles (hides rows whose file is gone from file_index).
// Runs against a REAL database — skipped without DATABASE_URL (CI provides
// Postgres).
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

const PWD = "filedelpool";
const run = Date.now().toString(36);
const F1 = `fdel-${run}-f1`, F2 = `fdel-${run}-f2`, GHOST = `fdel-${run}-gone`;
const A = `k-${run}-avail`, H = `k-${run}-held`, C = `k-${run}-sold`, X = `k-${run}-x`, G = `k-${run}-ghost`;

async function seed() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO users(user_id) VALUES(${"u1-" + run}) ON CONFLICT(user_id) DO NOTHING`;
    await sql`INSERT INTO file_index(file_id,owner_id,data) VALUES(${F1},${`u1-${run}`},${{} as any}) ON CONFLICT(file_id) DO NOTHING`;
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES
      (${PWD},'cookies_2fa',${A},${{} as any},'available',${`u1-${run}`},${F1},${now},NULL),
      (${PWD},'cookies_2fa',${H},${{} as any},'held',${`u1-${run}`},${F1},${now},${`hh-${run}`}),
      (${PWD},'cookies_2fa',${C},${{} as any},'claimed',${`u1-${run}`},${F1},${now},${`hh-${run}`}),
      (${PWD},'page',${X},${{} as any},'held','u2',${F2},${now},${`hh2-${run}`}),
      (${PWD},'page',${A},${{} as any},'held','u2',${F2},${now},${`hh2-${run}`}),
      (${PWD},'cookies_2fa',${G},${{} as any},'claimed',${`u1-${run}`},${GHOST},${now},${`hhg-${run}`})`;
  } finally {
    await sql.end();
  }
}

async function cleanup() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PWD}`;
    await sql`DELETE FROM file_index WHERE file_id IN (${F1},${F2},${GHOST})`;
    await sql`DELETE FROM users WHERE user_id=${`u1-${run}`}`;
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

  it("removeFileRows wipes everything sourced from the file, keeps other files", async () => {
    await cleanup();
    await seed();
    const r = (await repository("pools", PWD, "removeFileRows", { srcFileId: F1 })) as { removed: number };
    expect(r.removed).toBe(3);
    const s1 = (await repository("pools", PWD, "filePoolState", { srcFileId: F1 })) as { held: number; claimed: number };
    expect(s1).toEqual({ held: 0, claimed: 0 });
    const s2 = (await repository("pools", PWD, "filePoolState", { srcFileId: F2 })) as { held: number; claimed: number };
    expect(s2).toEqual({ held: 2, claimed: 0 });
    const r0 = (await repository("pools", PWD, "removeFileRows", { srcFileId: "" })) as { removed: number };
    expect(r0.removed).toBe(0);
  }, 30_000);

  it("userFiles hides rows whose file is gone from the index", async () => {
    await cleanup();
    await seed();
    const out = (await repository("pools", PWD, "userFiles", { pool: "cookies_2fa" })) as {
      users: { userId: string; files: { fileId: string; available: number; claimed: number }[] }[];
    };
    const u1 = out.users.find((u) => u.userId === `u1-${run}`);
    expect(u1).toBeDefined();
    expect(u1!.files.map((f) => f.fileId).sort()).toEqual([F1]);
    expect(u1!.files[0]).toMatchObject({ available: 1, claimed: 1 });
  }, 30_000);
});

// archived files must never appear in pool reads, under any owner: every
// pool read filters out rows whose src_file_id belongs to an archived file
// (NULL src_file_id rows stay), the add op refuses feeds for archived files
// (mopping available husks — closes the feed/archive race), and re-uploaded
// rows recover page-eligibility from the check cache without ever overwriting an
// explicit value or blanking stored eligibility on touch.
const PX = "archpool";
const FARCH = `farch-${run}-a`, FLIVE = `farch-${run}-live`, UAX = `uax-${run}`;
const KA1 = `k-${run}-arch-avail`, KA2 = `k-${run}-live-avail`, KA3 = `k-${run}-nosrc-avail`;
const KA4 = `k-${run}-arch-claimed`, KL4 = `k-${run}-live-claimed`;
const PA1 = `k-${run}-arch-page`, PA2 = `k-${run}-live-page`;
const stamp = Date.now().toString().slice(-9);
const CU1 = `8${stamp}11`, CU2 = `8${stamp}22`, CU3 = `8${stamp}33`, CU4 = `8${stamp}44`, CU9 = `8${stamp}99`;
const feedRow = (u: string, extra: Record<string, unknown> = {}) => ({ uid: u, cookies: `c_user=${u}; xs=abc123`, twofakey: "JBSWY3DPEHPK3PXP", status: "good", ...extra });

async function seedArch() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO users(user_id) VALUES(${UAX}) ON CONFLICT(user_id) DO NOTHING`;
    await sql`INSERT INTO file_index(file_id,owner_id,archived,data) VALUES(${FARCH},${UAX},true,${{ name: "archived" } as any}),(${FLIVE},${UAX},false,${{ name: "live" } as any}) ON CONFLICT(file_id) DO UPDATE SET archived=EXCLUDED.archived`;
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES
      (${PX},'cookies_2fa',${KA1},${{} as any},'available',${UAX},${FARCH},${now},NULL),
      (${PX},'cookies_2fa',${KA2},${{} as any},'available',${UAX},${FLIVE},${now},NULL),
      (${PX},'cookies_2fa',${KA3},${{} as any},'available',NULL,NULL,${now},NULL),
      (${PX},'cookies_2fa',${KA4},${{} as any},'claimed',${UAX},${FARCH},${now},${`hh-${run}`}),
      (${PX},'cookies_2fa',${KL4},${{} as any},'claimed',${UAX},${FLIVE},${now},${`hh-${run}`}),
      (${PX},'page',${PA1},${{ check_status: "eligible" } as any},'available',${UAX},${FARCH},${now},NULL),
      (${PX},'page',${PA2},${{ check_status: "eligible" } as any},'available',${UAX},${FLIVE},${now},NULL)`;
  } finally {
    await sql.end();
  }
}

async function cleanupArch() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PX}`;
    await sql`DELETE FROM file_index WHERE file_id IN (${FARCH},${FLIVE})`;
    await sql`DELETE FROM meta WHERE k IN (${`check:${UAX}:${CU1}`},${`wa:${UAX}:${CU1}`},${`check:${UAX}:${CU2}`},${`wa:${UAX}:${CU2}`},${`check:${UAX}:${CU3}`},${`wa:${UAX}:${CU3}`},${`check:${UAX}:${CU4}`},${`wa:${UAX}:${CU4}`})`;
    await sql`DELETE FROM users WHERE user_id=${UAX}`;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!hasDb)("archived files never surface in pools", () => {
  afterAll(cleanupArch, 30_000);

  it("pool reads exclude archived files, keep NULL-src rows", async () => {
    await cleanupArch();
    await seedArch();
    const s = (await repository("pools", PX, "summary", { pool: "cookies_2fa" })) as { available: number; claimed: number; users: number };
    expect(s).toMatchObject({ available: 2, claimed: 1, users: 1 });
    const d = (await repository("pools", PX, "detail", { pool: "cookies_2fa" })) as { _key: string }[];
    expect(d.map((r) => r._key).sort()).toEqual([KA2, KA3, KL4].sort());
    const r = (await repository("pools", PX, "rows", { pool: "cookies_2fa", limit: 100 })) as { total: number };
    expect(r.total).toBe(2);
    const uf = (await repository("pools", PX, "userFiles", { pool: "cookies_2fa" })) as {
      users: { userId: string; files: { fileId: string; available: number; claimed: number }[] }[];
    };
    const ux = uf.users.find((u) => u.userId === UAX);
    expect(ux).toBeDefined();
    expect(ux!.files.map((f) => f.fileId)).toEqual([FLIVE]);
    expect(ux!.files[0]).toMatchObject({ available: 1, claimed: 1 });
    const pu = (await repository("pools", PX, "poolUsers", { pool: "cookies_2fa" })) as { userId: string; available: number; claimed: number }[];
    expect(pu.find((u) => u.userId === UAX)).toMatchObject({ available: 1, claimed: 1 });
    const vc = (await repository("pools", PX, "verifiedCounts", { pool: "page" })) as { totalAvailable: number; verified: number; unverified: number };
    expect(vc).toMatchObject({ totalAvailable: 1, verified: 1, unverified: 0 });
  }, 30_000);

  it("add refuses feeds for archived files and mops available husks", async () => {
    await cleanupArch();
    await seedArch();
    const out = (await repository("pools", PX, "add", { rows: [feedRow(CU9)], srcUid: UAX, srcFileId: FARCH, preset: "combo" })) as { added: number; blocked: number };
    expect(out).toEqual({ added: 0, blocked: 0 });
    const s = (await repository("pools", PX, "summary", { pool: "cookies_2fa" })) as { available: number; claimed: number };
    expect(s).toMatchObject({ available: 2, claimed: 1 }); // KA1 hidden by the read filter either way
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      const husks: any[] = await sql`SELECT COUNT(*) n FROM pool_rows WHERE password=${PX} AND src_file_id=${FARCH} AND state='available'`;
      expect(Number(husks[0].n)).toBe(0); // mop: no available husks left behind
      const kept: any[] = await sql`SELECT COUNT(*) n FROM pool_rows WHERE password=${PX} AND src_file_id=${FARCH} AND state='claimed'`;
      expect(Number(kept[0].n)).toBe(1); // claimed KA4 untouched
    } finally {
      await sql.end();
    }
    const vc = (await repository("pools", PX, "verifiedCounts", { pool: "page" })) as { totalAvailable: number; verified: number; unverified: number };
    expect(vc).toMatchObject({ totalAvailable: 1, verified: 1, unverified: 0 }); // PA1 husk gone, live PA2 stays
  }, 30_000);

  it("add stamps blank check_status from the check cache (incl. legacy wa: fallback), never overwrites explicit or stale", async () => {
    await cleanupArch();
    await seedArch();
    const fresh = Date.now();
    await repository("index", "global", "metaSet", { k: `check:${UAX}:${CU1}`, v: { status: "eligible", banReason: null, pageName: "TestPage", linkedNumber: "8801", ts: fresh } });
    await repository("index", "global", "metaSet", { k: `wa:${UAX}:${CU2}`, v: { status: "eligible", ts: fresh } });
    await repository("index", "global", "metaSet", { k: `wa:${UAX}:${CU3}`, v: { status: "eligible", ts: fresh } });
    await repository("index", "global", "metaSet", { k: `check:${UAX}:${CU4}`, v: { status: "eligible", ts: fresh - 2 * 86400000 } });
    const out = (await repository("pools", PX, "add", {
      rows: [feedRow(CU1), feedRow(CU2, { check_status: "ineligible" }), feedRow(CU3), feedRow(CU4)], srcUid: UAX, srcFileId: FLIVE, preset: "page",
    })) as { added: number };
    expect(out.added).toBe(4);
    const d = (await repository("pools", PX, "detail", { pool: "page" })) as { _key: string; check_status?: string; check_page_name?: string; check_linked_number?: string }[];
    const byKey = new Map(d.map((r) => [r._key, r]));
    expect(byKey.get(CU1)).toMatchObject({ check_status: "eligible", check_page_name: "TestPage", check_linked_number: "8801" });
    expect(byKey.get(CU2)?.check_status).toBe("ineligible"); // explicit value beats even a fresh cache hit
    expect(byKey.get(CU3)?.check_status).toBe("eligible"); // legacy wa: cache key still fills new fields
    expect(byKey.get(CU4)?.check_status ?? "").not.toBe("eligible");
  }, 30_000);

  it("touch keeps stored eligibility when a re-feed arrives blank", async () => {
    await cleanupArch();
    await seedArch();
    const first = (await repository("pools", PX, "add", { rows: [feedRow(CU3, { check_status: "eligible" })], srcUid: UAX, srcFileId: FLIVE, preset: "page" })) as { added: number };
    expect(first.added).toBe(1);
    const second = (await repository("pools", PX, "add", { rows: [feedRow(CU3)], srcUid: UAX, srcFileId: FLIVE, preset: "page" })) as { added: number };
    expect(second.added).toBe(0);
    const d = (await repository("pools", PX, "detail", { pool: "page" })) as { _key: string; check_status?: string }[];
    expect(d.find((r) => r._key === CU3)?.check_status).toBe("eligible");
  }, 30_000);
});
