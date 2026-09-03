// Tests for backend/src/services/pools.ts — the auto-pooling layer that runs on
// every file save (POST /api/files, PUT persist/append). The real redis module is
// replaced by the in-memory fake, so classification, promotion between pool
// tiers, the taken-blocklist, and poolEnabled/password namespacing are all
// exercised without a server. These semantics gate what admins can later claim.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Row, StoredFile } from "../src/lib/shared";
import { fakeSet, installRedisMock, key, resetStore } from "./redis-mock";

installRedisMock();

const { classifyRow, handleFileSave, removeFileRowsFromPools } = await import("../src/services/pools");
const { redis } = await import("../src/services/redis");

const DGD = "dgddigital";
const L0VE = "L0VE@12345";

function file(over: Partial<StoredFile> = {}): StoredFile {
  return {
    id: "f1",
    name: "F",
    type: "fb_cookie",
    userId: "u1",
    createdAt: 1,
    updatedAt: 1,
    rowCount: 0,
    columns: null,
    password: DGD,
    poolEnabled: true,
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return { uid: "1000", cookies: "c_user=1000; useragent=x", twofakey: "", wa_status: "", ...over };
}

function cookieRow(n: number): Row {
  return { uid: String(n), cookies: `c_user=${n}; useragent=x` };
}

const availList = async (password: string, poolId: string): Promise<Record<string, unknown>[]> =>
  (await redis.lrange(key(`pool:${password}:${poolId}:available`), 0, -1)).map((s) => JSON.parse(s));
const dedupFor = async (password: string, poolId: string, dk: string): Promise<number> =>
  redis.sismember(key(`pool:${password}:${poolId}:dedup`), dk);

describe("classifyRow", () => {
  test("cookies without 2FA -> cookies_only", () => {
    expect(classifyRow(row())).toBe("cookies_only");
  });

  test("cookies + 2FA -> cookies_2fa", () => {
    expect(classifyRow(row({ twofakey: "secret" }))).toBe("cookies_2fa");
  });

  test("cookies + 2FA + wa_status eligible -> page", () => {
    expect(classifyRow(row({ twofakey: "secret", wa_status: "eligible" }))).toBe("page");
    expect(classifyRow(row({ twofakey: "secret" }), "eligible")).toBe("page");
  });

  test("wa_status eligible without 2FA is invalid (page requires 2FA)", () => {
    expect(classifyRow(row({ wa_status: "eligible" }))).toBeNull();
  });

  test("ineligibility: no cookies, missing c_user, missing uid, bad/dead status", () => {
    expect(classifyRow(row({ cookies: "" }))).toBeNull();
    expect(classifyRow(row({ cookies: "xs=abc" }))).toBeNull();
    expect(classifyRow(row({ uid: "" }))).toBeNull();
    expect(classifyRow(row({ status: "bad" }))).toBeNull();
    expect(classifyRow(row({ status: "dead" }))).toBeNull();
    expect(classifyRow(null as unknown as Row)).toBeNull();
    expect(classifyRow({} as Row)).toBeNull();
  });

  test("whitespace-only twofakey counts as no 2FA", () => {
    expect(classifyRow(row({ twofakey: "   " }))).toBe("cookies_only");
  });

  test("wa_status from row is honored when no override passed", () => {
    expect(classifyRow(row({ twofakey: "x", wa_status: "eligible" }))).toBe("page");
    // legacy waStatus alias is used only when wa_status is absent
    expect(classifyRow({ ...row({ twofakey: "x" }), wa_status: undefined, waStatus: "eligible" })).toBe("page");
    // explicit override beats the row value
    expect(classifyRow(row({ twofakey: "x", wa_status: "eligible" }), "dead")).toBe("cookies_2fa");
  });
});

describe("handleFileSave", () => {
  beforeEach(() => {
    resetStore();
  });

  test("pools valid rows into the file password's tier and writes ledger + users", async () => {
    const c = await handleFileSave(file(), [cookieRow(1)], "u1");
    expect(c).toMatchObject({ added: 1, skippedDuplicate: 0, skippedInvalid: 0, skippedIneligible: 0, skippedTaken: 0, skippedFiltered: 0 });

    const list = await availList(DGD, "cookies_only");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ dedupKey: "1", srcFileId: "f1", srcUserId: "u1", password: DGD });
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(1);
    expect(await redis.hget(key(`pool:${DGD}:cookies_only:users`), "u1")).toBe("1");
    expect((await redis.llen(key(`pool:${DGD}:cookies_only:ledger`)))).toBe(1);
  });

  test("2FA rows go to cookies_2fa and eligible ones to page, under the same password", async () => {
    await handleFileSave(file(), [cookieRow(1), { ...cookieRow(2), twofakey: "t" }, { ...cookieRow(3), twofakey: "t", wa_status: "eligible" }], "u1");
    expect(await availList(DGD, "cookies_only")).toHaveLength(1);
    expect(await availList(DGD, "cookies_2fa")).toHaveLength(1);
    expect(await availList(DGD, "page")).toHaveLength(1);
  });

  test("resaving the same rows is idempotent (no duplicate entries, added 0)", async () => {
    await handleFileSave(file(), [cookieRow(1)], "u1");
    const c = await handleFileSave(file(), [cookieRow(1)], "u1");
    expect(c.added).toBe(0);
    expect(await availList(DGD, "cookies_only")).toHaveLength(1);
  });

  test("invalid rows are counted and never pooled; previously pooled invalid row is removed", async () => {
    await handleFileSave(file(), [cookieRow(1)], "u1");
    expect(await availList(DGD, "cookies_only")).toHaveLength(1);
    const c = await handleFileSave(file(), [{ ...cookieRow(1), status: "bad" }, cookieRow(9)], "u1");
    expect(c).toMatchObject({ added: 1, skippedInvalid: 1 });
    const list = await availList(DGD, "cookies_only");
    expect(list).toHaveLength(1);
    expect(list[0].dedupKey).toBe("9");
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(0);
  });

  test("taken dedup keys are skipped and purged from available", async () => {
    await handleFileSave(file(), [cookieRow(1)], "u1");
    await redis.sadd(key("taken:global:" + DGD), "1");
    const c = await handleFileSave(file(), [cookieRow(1)], "u1");
    expect(c).toMatchObject({ skippedTaken: 1, added: 0 });
    expect(await availList(DGD, "cookies_only")).toHaveLength(0);
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(0);
  });

  test("adding 2FA promotes a row from cookies_only to cookies_2fa", async () => {
    await handleFileSave(file(), [cookieRow(1)], "u1");
    const c = await handleFileSave(file(), [{ ...cookieRow(1), twofakey: "t" }], "u1");
    expect(c.added).toBe(1);
    expect(await availList(DGD, "cookies_only")).toHaveLength(0);
    expect(await availList(DGD, "cookies_2fa")).toHaveLength(1);
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(0);
    expect(await dedupFor(DGD, "cookies_2fa", "1")).toBe(1);
  });

  test("demotion/ineligibility removes the row from its pool", async () => {
    await handleFileSave(file(), [{ ...cookieRow(1), twofakey: "t", wa_status: "eligible" }], "u1");
    expect(await availList(DGD, "page")).toHaveLength(1);
    const c = await handleFileSave(file(), [{ ...cookieRow(1), twofakey: "t" }], "u1");
    expect(c.added).toBe(1);
    expect(await availList(DGD, "page")).toHaveLength(0);
    expect(await availList(DGD, "cookies_2fa")).toHaveLength(1);
  });

  test("poolEnabled=false purges the file's rows and reports skippedFiltered", async () => {
    const rows = [cookieRow(1), cookieRow(2)];
    fakeSet(key("rows:f1"), JSON.stringify(rows));
    await handleFileSave(file(), rows, "u1");
    const c = await handleFileSave(file({ poolEnabled: false }), rows, "u1");
    expect(c).toMatchObject({ skippedFiltered: 2, added: 0 });
    expect(await availList(DGD, "cookies_only")).toHaveLength(0);
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(0);
  });

  test("files without a password are never pooled", async () => {
    const c = await handleFileSave(file({ password: undefined }), [cookieRow(1)], "u1");
    expect(c).toMatchObject({ skippedFiltered: 1 });
    expect(await availList(DGD, "cookies_only")).toHaveLength(0);
  });

  test("per-password namespaces stay isolated: same dedup key in both pools", async () => {
    await handleFileSave(file(), [cookieRow(1)], "u1");
    await handleFileSave(file({ id: "f2", userId: "u2", password: L0VE }), [cookieRow(1)], "u2");
    expect(await availList(DGD, "cookies_only")).toHaveLength(1);
    expect(await availList(L0VE, "cookies_only")).toHaveLength(1);
    expect(await availList(L0VE, "cookies_only")).not.toEqual(await availList(DGD, "cookies_only"));
  });
});

describe("removeFileRowsFromPools", () => {
  test("deleting a file removes its available pool entries", async () => {
    const f = file();
    const rows = [cookieRow(1), cookieRow(2)];
    fakeSet(key("rows:f1"), JSON.stringify(rows));
    await handleFileSave(f, rows, "u1");
    expect(await availList(DGD, "cookies_only")).toHaveLength(2);

    const removed = await removeFileRowsFromPools(f, "u1");
    expect(removed).toBe(2);
    expect(await availList(DGD, "cookies_only")).toHaveLength(0);
    expect(await dedupFor(DGD, "cookies_only", "1")).toBe(0);
  });

  test("rows already on the global taken list are not resurrected", async () => {
    const f = file();
    const rows = [cookieRow(1), cookieRow(2)];
    fakeSet(key("rows:f1"), JSON.stringify(rows));
    await handleFileSave(f, rows, "u1");
    await redis.sadd(key("taken:global:" + DGD), "1");

    const removed = await removeFileRowsFromPools(f, "u1");
    expect(removed).toBe(1);
    const list = await availList(DGD, "cookies_only");
    expect(list).toHaveLength(1);
    expect(list[0].dedupKey).toBe("1"); // taken row stays out of the pool
  });
});
