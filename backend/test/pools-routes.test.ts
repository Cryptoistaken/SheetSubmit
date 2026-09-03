// HTTP tests for backend/src/routes/pools.ts — admin-only claim/download/revert
// lifecycle over a real Express server. The redis + auth modules are replaced
// (in-memory fake, header-driven auth) so the atomicity guarantees that protect
// against double-claims, the per-password take blocklists, and revert semantics
// are verified end to end through the route wiring.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import { fakeSet, installAuthMock, installRedisMock, key, resetStore, setBeforeExec, store } from "./redis-mock";

installRedisMock();
installAuthMock();

const ADMIN = "admin1";

const { poolsRouter } = await import("../src/routes/pools");
const { redis } = await import("../src/services/redis");

const app = express();
app.use(express.json());
app.use("/api/pools", poolsRouter);

let server: ReturnType<typeof app.listen>;
let baseUrl = "";

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = "http://127.0.0.1:" + (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resetStore();
});

const DGD = "dgddigital";
const PWD = DGD;

function availKey(poolId: string, password = PWD): string {
  return key(`pool:${password}:${poolId}:available`);
}
function dedupKey(poolId: string, password = PWD): string {
  return key(`pool:${password}:${poolId}:dedup`);
}

// Row entry exactly as addRowsToPools writes it (minus addedAt which is set by callers).
function entry(dk: number, srcUserId: string, srcFileId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dedupKey: String(dk),
    uid: String(dk),
    cookies: `c_user=${dk}; useragent=x`,
    twofakey: "",
    wa_status: "",
    password: PWD,
    srcUserId,
    srcFileId,
    srcRowIdx: dk - 1,
    addedAt: 1,
    ...over,
  };
}

function seedRows(fid: string, dks: number[]): void {
  fakeSet(
    key("rows:" + fid),
    JSON.stringify(dks.map((dk) => ({ uid: String(dk), cookies: `c_user=${dk}; useragent=x`, twofakey: "", wa_status: "" }))),
  );
}

function seedPool(poolId: string, entries: Record<string, unknown>[], password = PWD): void {
  fakeSet(availKey(poolId, password), entries.map((e) => JSON.stringify(e)));
  fakeSet(dedupKey(poolId, password), new Set(entries.map((e) => String(e.dedupKey))));
}

async function api(route: string, opts: { method?: string; body?: unknown; userId?: string; query?: Record<string, string> } = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const { method = "GET", body, userId = ADMIN, query = {} } = opts;
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(baseUrl + "/api/pools" + route + (qs ? "?" + qs : ""), {
    method,
    headers: { "x-user-id": userId, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

const takenGlobal = async (password = PWD) => (await redis.smembers(key("taken:global:" + password))).sort();
const takenPool = async (poolId: string, password = PWD) => (await redis.smembers(key(`taken:pool:${password}:${poolId}`))).sort();
const availParsed = async (poolId: string, password = PWD) =>
  (await redis.lrange(availKey(poolId, password), 0, -1)).map((s) => JSON.parse(s));
const claimedParsed = async (poolId: string, password = PWD) =>
  (await redis.lrange(key(`pool:${password}:${poolId}:claimed`), 0, -1)).map((s) => JSON.parse(s));
const storedRows = async (fid: string) => JSON.parse(store[key("rows:" + fid)] as string) as Record<string, unknown>[];

describe("access control", () => {
  test("non-admin is rejected on list, claim, download, rows and ledger", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")]);
    expect((await api("/", { userId: "user1" })).status).toBe(403);
    expect((await api("/cookies_only/claim", { method: "POST", body: {}, userId: "user1" })).status).toBe(403);
    expect((await api("/" + PWD + "/cookies_only/download", { userId: "user1" })).status).toBe(403);
    expect((await api("/" + PWD + "/cookies_only/rows", { userId: "user1" })).status).toBe(403);
    expect((await api("/" + PWD + "/cookies_only/ledger", { userId: "user1" })).status).toBe(403);
    expect((await api("/" + PWD + "/cookies_only", { userId: "user1" })).status).toBe(403);
    expect((await api("/downloads", { userId: "user1" })).status).toBe(403);
  });
});

describe("claim", () => {
  test("claims N rows atomically: available shrinks, claimed grows, taken blocklists set, rows flagged", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u1", "f1"), entry(3, "u2", "f2")]);
    seedRows("f1", [1, 2]);
    seedRows("f2", [3]);
    await redis.hset(key(`pool:${PWD}:cookies_only:users`), "u1", "2");
    await redis.hset(key(`pool:${PWD}:cookies_only:users`), "u2", "1");

    const r = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: 2 } });

    expect(r.status).toBe(200);
    expect(r.json.claimed).toBe(2);
    expect(r.json.rows.map((x: { dedupKey: string }) => x.dedupKey).sort()).toEqual(["1", "2"]);
    expect(r.json.downloadId).toBeDefined();

    const avail = await availParsed("cookies_only");
    expect(avail).toHaveLength(1);
    expect(avail[0].dedupKey).toBe("3");
    const claimed = await claimedParsed("cookies_only");
    expect(claimed).toHaveLength(2);
    expect(claimed.every((c) => c.claimedBy === ADMIN && typeof c.claimedAt === "number")).toBe(true);

    const taken = await takenGlobal();
    expect(taken).toEqual(["1", "2"]);
    expect(await takenPool("cookies_only")).toEqual(["1", "2"]);
    expect((await redis.smembers(dedupKey("cookies_only"))).sort()).toEqual(["3"]);

    // per-user counters decremented for claimed rows only
    expect(await redis.hget(key(`pool:${PWD}:cookies_only:users`), "u1")).toBe("0");
    expect(await redis.hget(key(`pool:${PWD}:cookies_only:users`), "u2")).toBe("1");

    // owner rows flagged as taken for the user UI badge
    const f1 = await storedRows("f1");
    expect(f1[0]).toMatchObject({ _taken: true, _pool: "cookies_only", _takenBy: ADMIN });
    expect(typeof f1[0]._takenAt).toBe("number");
    expect(f1[1]._taken).toBe(true);
    expect((await storedRows("f2"))[0]._taken).toBeUndefined();

    // ledger + download record persisted
    const ledger = (await redis.lrange(key(`pool:${PWD}:cookies_only:ledger`), 0, -1)).map((s) => JSON.parse(s));
    expect(ledger.filter((l) => l.action === "claim")).toHaveLength(2);
    const dl = await api("/downloads");
    expect(dl.status).toBe(200);
    expect(dl.json).toHaveLength(1);
    expect(dl.json[0]).toMatchObject({ claimed: 2, poolId: "cookies_only", password: PWD, claimedBy: ADMIN, reverted: false });
    expect(dl.json[0].rowsCount).toBe(2);
  });

  test("claim all with no count takes every available row", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u1", "f1"), entry(3, "u1", "f1")]);
    const r = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(r.json.claimed).toBe(3);
    expect(await availParsed("cookies_only")).toHaveLength(0);
  });

  test("userId filter claims only that user's rows", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u2", "f2"), entry(3, "u1", "f1")]);
    const r = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: "all", userId: "u1" } });
    expect(r.status).toBe(200);
    expect(r.json.claimed).toBe(2);
    expect((await takenGlobal()).sort()).toEqual(["1", "3"]);
    expect(await availParsed("cookies_only")).toHaveLength(1);
    expect((await availParsed("cookies_only"))[0].dedupKey).toBe("2");
  });

  test("invalid count is rejected with 400", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")]);
    for (const bad of [0, -3, 1.5, "abc"]) {
      const r = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: bad } });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid count");
    }
  });

  test("claiming an empty pool returns claimed 0 without a download record", async () => {
    const r = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ claimed: 0, rows: [] });
    const dl = await api("/downloads");
    expect(dl.json).toEqual([]);
  });

  test("concurrent claims never double-claim: WATCH conflict retries against the updated list", async () => {
    const rows = [entry(1, "u1", "f1"), entry(2, "u1", "f1"), entry(3, "u1", "f1")];
    seedPool("cookies_only", rows);
    const injectedOnce = { done: false };
    // simulate another admin's claim finishing first (removes entry "1")
    setBeforeExec(() => {
      if (!injectedOnce.done) {
        injectedOnce.done = true;
        fakeSet(availKey("cookies_only"), rows.slice(1).map((e) => JSON.stringify(e)));
      }
    });

    const r1 = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: 2 } });
    // conflicted attempt retried and claimed 2 rows, never the already-taken "1"
    expect(injectedOnce.done).toBe(true);
    expect(r1.status).toBe(200);
    expect(r1.json.claimed).toBe(2);
    expect(r1.json.rows.map((x: { dedupKey: string }) => x.dedupKey).sort()).toEqual(["2", "3"]);
    expect((await takenGlobal()).sort()).toEqual(["2", "3"]);

    // a second claim sees the true remaining state: nothing left to take
    const r2 = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: {} });
    expect(r2.json.claimed).toBe(0);
    expect((await takenGlobal()).sort()).toEqual(["2", "3"]);
  });

  test("download alias claims and streams xlsx (1 col for cookies_only)", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")]);
    seedRows("f1", [1]);
    const r = await api("/" + PWD + "/cookies_only/download", { query: { count: "1" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("spreadsheetml");
    expect(r.headers.get("content-disposition")).toMatch(/filename="cookies_[A-Za-z0-9@._-]+_\d{4}-\d{2}-\d{2}_1_[a-z0-9]+\.xlsx"/);
    expect((await takenGlobal()).sort()).toEqual(["1"]);
  });

  test("legacy single-segment claim route uses the default password", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")], DGD);
    const r = await api("/cookies_only/claim", { method: "POST", body: { count: 1 } });
    expect(r.status).toBe(200);
    expect(r.json.claimed).toBe(1);
    expect(await takenGlobal(DGD)).toEqual(["1"]);
  });

  test("password namespaces are isolated in the take blocklist", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")], DGD);
    seedPool("cookies_only", [entry(7, "u1", "f1")], "L0VE@12345");
    const r = await api("/" + DGD + "/cookies_only/claim", { method: "POST", body: {} });
    expect(r.json.claimed).toBe(1);
    expect(await takenGlobal(DGD)).toEqual(["1"]);
    expect(await takenGlobal("L0VE@12345")).toEqual([]);
  });
});

describe("revert", () => {
  test("reverts a claim: restores available + dedup, clears blocklists and _taken flags, marks record", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u1", "f1")]);
    seedRows("f1", [1, 2]);
    await redis.hset(key(`pool:${PWD}:cookies_only:users`), "u1", "2");

    const claim = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: {} });
    const id = claim.json.downloadId;

    const rev = await api("/downloads/" + id + "/revert", { method: "POST" });
    expect(rev.status).toBe(200);
    expect(rev.json).toEqual({ ok: true, reverted: 2 });

    expect((await availParsed("cookies_only")).map((e) => e.dedupKey).sort()).toEqual(["1", "2"]);
    expect(await claimedParsed("cookies_only")).toHaveLength(0);
    expect(await takenGlobal()).toEqual([]);
    expect(await takenPool("cookies_only")).toEqual([]);
    expect((await redis.smembers(dedupKey("cookies_only"))).sort()).toEqual(["1", "2"]);
    expect(await redis.hget(key(`pool:${PWD}:cookies_only:users`), "u1")).toBe("2");

    const f1 = await storedRows("f1");
    expect(f1[0]._taken).toBeUndefined();
    expect(f1[1]._taken).toBeUndefined();

    const dl = await api("/downloads");
    expect(dl.json[0].reverted).toBe(true);
    expect(dl.json[0].revertedBy).toBe(ADMIN);

    // double revert is rejected
    const again = await api("/downloads/" + id + "/revert", { method: "POST" });
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("already reverted");
  });

  test("revert of an unknown download id returns 404", async () => {
    const r = await api("/downloads/nope/revert", { method: "POST" });
    expect(r.status).toBe(404);
  });

  test("reverting one download leaves other claims intact", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u1", "f1")]);
    seedRows("f1", [1, 2]);
    const c1 = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: 1 } });
    const c2 = await api("/" + PWD + "/cookies_only/claim", { method: "POST", body: { count: 1 } });
    expect(c1.json.rows[0].dedupKey).toBe("1");
    expect(c2.json.rows[0].dedupKey).toBe("2");

    await api("/downloads/" + c2.json.downloadId + "/revert", { method: "POST" });
    expect(await takenGlobal()).toEqual(["1"]);
    expect((await availParsed("cookies_only")).map((e) => e.dedupKey)).toEqual(["2"]);
    expect((await claimedParsed("cookies_only")).map((c) => c.dedupKey).sort()).toEqual(["1"]);
  });
});

describe("read routes", () => {
  test("GET / lists per-password pool counts", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1")], DGD);
    seedPool("cookies_only", [entry(7, "u1", "f1")], "L0VE@12345");
    const r = await api("/");
    expect(r.status).toBe(200);
    expect(r.json.pools).toHaveLength(6);
    const dgd = r.json.pools.find((p: { password: string; id: string }) => p.password === DGD && p.id === "cookies_only");
    expect(dgd.available).toBe(1);
    const love = r.json.pools.find((p: { password: string; id: string }) => p.password === "L0VE@12345" && p.id === "cookies_only");
    expect(love.available).toBe(1);
  });

  test("GET /:password/:poolId aggregates per-user counts sorted by available desc", async () => {
    seedPool("cookies_only", [
      entry(1, "u1", "f1"),
      entry(2, "u1", "f1"),
      entry(3, "u2", "f2"),
    ]);
    fakeSet(key("user:u1"), JSON.stringify({ firstName: "Alice", lastName: "" }));
    fakeSet(key("user:u2"), JSON.stringify({ firstName: "Bob", lastName: "" }));

    const r = await api("/" + PWD + "/cookies_only");
    expect(r.status).toBe(200);
    expect(r.json.pool.id).toBe("cookies_only");
    expect(r.json.totals).toEqual({ available: 3, claimed: 0, users: 2 });
    expect(r.json.users.map((u: { userId: string; available: number }) => [u.userId, u.available])).toEqual([
      ["u1", 2],
      ["u2", 1],
    ]);
    expect(r.json.users[0].displayName).toBe("Alice");
    expect(r.json.users[0].isAdmin).toBe(false);
  });

  test("rows endpoint paginates and filters by user", async () => {
    seedPool("cookies_only", [entry(1, "u1", "f1"), entry(2, "u1", "f1"), entry(3, "u2", "f2"), entry(4, "u1", "f1")]);
    const page = await api("/" + PWD + "/cookies_only/rows", { query: { limit: "2", offset: "1" } });
    expect(page.json.total).toBe(4);
    expect(page.json.rows.map((x: { dedupKey: string }) => x.dedupKey)).toEqual(["2", "3"]);
    const filtered = await api("/" + PWD + "/cookies_only/rows", { query: { userId: "u2" } });
    expect(filtered.json.total).toBe(1);
    expect(filtered.json.rows[0].dedupKey).toBe("3");
  });
});
