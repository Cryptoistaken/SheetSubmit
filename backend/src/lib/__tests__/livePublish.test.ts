import { afterAll, describe, expect, it } from "bun:test";

// Publish seam (slice 2a): mutations resolve affected (file, key) states and
// fan them out to live rooms. Pure grouping runs everywhere; the pg op and
// the download→rooms bridge need a REAL database (same guard as
// revertFinality.test.ts).
import { groupLiveStates, parseLiveEvent } from "../live";
import { joinLive } from "../liveBus";
import { publishDownloadStates, publishKeyStates } from "../livePublish";
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

describe("groupLiveStates", () => {
  it("splits key states per file and drops keyless rows", () => {
    expect(
      groupLiveStates([
        { src_file_id: "fA", row_key: "k1", hold: true, approved: false, dead: false },
        { src_file_id: "fA", row_key: "k2", hold: false, approved: true, dead: false },
        { src_file_id: "fB", row_key: "k3", hold: false, approved: false, dead: true },
        { src_file_id: "", row_key: "k4", hold: true, approved: false, dead: false },
      ]),
    ).toEqual({
      fA: { k1: { hold: true }, k2: { approved: true } },
      fB: { k3: { dead: true } },
    });
  });

  it("clears flags explicitly (all-false carries an empty state)", () => {
    expect(groupLiveStates([{ src_file_id: "fA", row_key: "k1", hold: false, approved: false, dead: false }])).toEqual({
      fA: { k1: {} },
    });
  });
});

describe("parseLiveEvent (worker → backend relay)", () => {
  it("accepts dead-keys with string keys", () => {
    expect(parseLiveEvent({ type: "dead-keys", keys: ["12345", "678"] })).toEqual(["12345", "678"]);
  });

  it("drops non-string and overlong keys", () => {
    expect(parseLiveEvent({ type: "dead-keys", keys: ["12345", 42, "", "x".repeat(65), null] })).toEqual(["12345"]);
  });

  it("caps at 500 keys", () => {
    expect(parseLiveEvent({ type: "dead-keys", keys: Array.from({ length: 501 }, (_, i) => String(10000 + i)) }).length).toBe(500);
  });

  it("rejects anything else", () => {
    expect(parseLiveEvent(null)).toBeNull();
    expect(parseLiveEvent({ type: "nope", keys: ["1"] })).toBeNull();
    expect(parseLiveEvent({ type: "dead-keys" })).toBeNull();
    expect(parseLiveEvent("dead-keys")).toBeNull();
  });
});

const PWD = "livpub";
const run = Date.now().toString(36);
const dl = (tag: string) => `lvp-${run}-${tag}`;

async function seed() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`INSERT INTO downloads(id,password,pool_id,claimed_by,claimed,filename,keys,rows,reverted,ts,status,unit_price,total,mode,src_uids,src_file_ids,selection)
      VALUES(${dl("h")},${PWD},${"cookies_2fa"},${"admin"},${2},${"h.xlsx"},${["k1", "k2"] as any},${[] as any},${false},${Date.now()},${"HOLD"},${0.05},${0.1},${"fifo"},${null as any},${null as any},${null as any})`;
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,src_uid,src_file_id,inserted_at,state,hold_id)
      VALUES(${PWD},${"cookies_2fa"},${"k1"},${{ cookies: "c_user=11" } as any},${"11"},${"fA"},${Date.now()},${"held"},${dl("h")}),
            (${PWD},${"cookies_2fa"},${"k2"},${{ cookies: "c_user=22" } as any},${"22"},${"fA"},${Date.now()},${"held"},${dl("h")}),
            (${PWD},${"cookies_2fa"},${"k9"},${{ cookies: "c_user=99" } as any},${"99"},${"fB"},${Date.now()},${"available"},${null as any})`;
  } finally {
    await sql.end();
  }
}

describe.skipIf(!hasDb)("liveStatesByDownload op", () => {
  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM pool_rows WHERE password=${PWD} AND row_key IN ('k1','k2','k9')`;
      await sql`DELETE FROM downloads WHERE id LIKE ${`lvp-${run}-%`}`;
    } finally {
      await sql.end();
    }
  }, 30_000);

  it("resolves fresh per-file states for a download's keys", async () => {
    await seed();
    const map = (await repository("pools", PWD, "liveStatesByDownload", { id: dl("h") })) as Record<string, Record<string, unknown>>;
    expect(map).toEqual({ fA: { k1: { hold: true }, k2: { hold: true } } });
  }, 30_000);

  it("fans a download's states out to joined rooms", async () => {
    const got: string[] = [];
    const leave = joinLive("fA", (msg) => got.push(msg));
    try {
      const n = await publishDownloadStates(PWD, dl("h"));
      expect(n).toBe(1);
      expect(got.length).toBe(1);
      expect(JSON.parse(got[0])).toEqual({ states: { k1: { hold: true }, k2: { hold: true } } });
    } finally {
      leave();
    }
  }, 30_000);

  it("resolves fresh states for bare keys across passwords", async () => {
    const got: string[] = [];
    const leave = joinLive("fA", (msg) => got.push(msg));
    try {
      const n = await publishKeyStates(["k1", "k2", "k9", "missing"]);
      expect(n).toBe(1);
      expect(JSON.parse(got[0])).toEqual({ states: { k1: { hold: true }, k2: { hold: true }, k9: {} } });
    } finally {
      leave();
    }
  }, 30_000);
});

describe.skipIf(!hasDb)("approve fans out through the route", () => {
  const ADMIN = `lvadm-${run}`;
  let token = "";

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM pool_rows WHERE password=${PWD} AND row_key IN ('k1','k2','k9')`;
      await sql`DELETE FROM downloads WHERE id LIKE ${`lvp-${run}-%`}`;
      await sql`DELETE FROM sessions WHERE user_id=${ADMIN}`;
      await sql`DELETE FROM users WHERE user_id=${ADMIN}`;
    } finally {
      await sql.end();
    }
  }, 30_000);

  it("POST approve publishes approved states to the owner's room", async () => {
    await seed();
    const { signSession } = await import("../session");
    await repository("index", "global", "ensureUser", { id: ADMIN, name: "t", username: "t" });
    token = await signSession(ADMIN, "test-secret");
    await repository("index", "global", "session", { token, uid: ADMIN, exp: Date.now() + 60_000 });
    const got: string[] = [];
    const leave = joinLive("fA", (msg) => got.push(msg));
    try {
      const { app } = await import("../../index");
      const res = await app.request(`/api/pools/holds/${dl("h")}/approve`, {
        method: "POST",
        headers: { Cookie: `ss_session=${token}` },
      }, { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: "test-secret", ADMIN_IDS: ADMIN });
      expect(res.status).toBe(200);
      expect(got.length).toBe(1);
      expect(JSON.parse(got[0])).toEqual({ states: { k1: { approved: true }, k2: { approved: true } } });
    } finally {
      leave();
    }
  }, 30_000);
});
