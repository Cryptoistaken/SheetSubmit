// Tests for the delta-append + seq versioning routes in backend/src/routes/files.ts.
// The real redis + auth modules are replaced: redis by the in-memory fake
// (WATCH/MULTI optimistic locking), auth by middleware that sets req.userId and
// loads req.file from the seeded files list. Routes are exercised over a real
// HTTP server so handler wiring (status codes, response shape) is verified.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import express from "express";
import type { StoredFile } from "../src/lib/shared";
import { fakeSet, installAuthMock, installRedisMock, key, redis, resetStore, store } from "./redis-mock";

installRedisMock();
installAuthMock();

const { filesRouter } = await import("../src/routes/files");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use("/api/files", filesRouter);

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

function seedFile(id: string): StoredFile {
  const file: StoredFile = {
    id,
    name: "File " + id,
    type: "fb_cookie",
    userId: "user1",
    createdAt: 1,
    updatedAt: 1,
    rowCount: 0,
    columns: null,
    dataCount: 0,
  };
  fakeSet(key("files:user1"), JSON.stringify([file]));
  return file;
}

async function api(route: string, body?: unknown, method: "GET" | "PUT" | "POST" = body === undefined ? "GET" : "PUT"): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + "/api/files" + route, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const parsed = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
const storedRows = (id: string) => parsed(store[key("rows:" + id)]) as Record<string, string>[];

describe("PUT /api/files/:id/append", () => {
  test("applies ops to existing rows and returns seq = base+1", async () => {
    seedFile("f1");
    fakeSet(key("rows:f1"), JSON.stringify([{ a: "1" }]));
    fakeSet(key("seq:f1"), "0");

    const r = await api("/f1/append", { base: 0, ops: [{ rowIdx: 0, cols: { b: "2" } }] });

    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.seq).toBe(1);
    expect(storedRows("f1")).toEqual([{ a: "1", b: "2" }]);
    expect(store[key("seq:f1")]).toBe("1");
  });

  test("pads with empty rows when rowIdx is beyond the array length", async () => {
    seedFile("f2");
    fakeSet(key("rows:f2"), JSON.stringify([{ a: "1" }]));

    const r = await api("/f2/append", { base: 0, ops: [{ rowIdx: 3, cols: { x: "y" } }] });

    expect(r.status).toBe(200);
    expect(r.json.seq).toBe(1);
    expect(storedRows("f2")).toEqual([{ a: "1" }, {}, {}, { x: "y" }]);
    expect(store[key("seq:f2")]).toBe("1");
  });

  test("conflict: base mismatch returns 409 and changes nothing", async () => {
    seedFile("f3");
    fakeSet(key("rows:f3"), JSON.stringify([{ a: "1" }]));
    fakeSet(key("seq:f3"), "2");

    const r = await api("/f3/append", { base: 1, ops: [{ rowIdx: 0, cols: { b: "2" } }] });

    expect(r.status).toBe(409);
    expect(r.json).toEqual({ error: "version conflict", serverSeq: 2 });
    expect(storedRows("f3")).toEqual([{ a: "1" }]);
    expect(store[key("seq:f3")]).toBe("2");
  });

  test("action snapshots history and still applies ops", async () => {
    seedFile("f4");
    fakeSet(key("rows:f4"), JSON.stringify([{ a: "1" }]));

    const r = await api("/f4/append", {
      base: 0,
      action: "append",
      ops: [{ rowIdx: 0, cols: { c: "3" } }],
    });

    expect(r.status).toBe(200);
    expect(r.json.seq).toBe(1);
    expect(storedRows("f4")).toEqual([{ a: "1", c: "3" }]);
    const meta = parsed(store[key("hist:f4")]) as { v: number; action: string }[];
    expect(Array.isArray(meta)).toBe(true);
    expect(meta.length).toBe(1);
    expect(meta[0].action).toBe("append");
  });

  test("appends newLogs incrementally onto the server log list", async () => {
    seedFile("f5");
    fakeSet(key("rows:f5"), JSON.stringify([]));
    fakeSet(key("logs:f5"), [JSON.stringify({ m: 1 }), JSON.stringify({ m: 2 })]);

    const r = await api("/f5/append", {
      base: 0,
      ops: [{ rowIdx: 0, cols: { a: "1" } }],
      newLogs: [{ m: 3 }, { m: 4 }],
    });

    expect(r.status).toBe(200);
    const stored = (store[key("logs:f5")] as string[]).map((l) => parsed(l));
    expect(stored).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }, { m: 4 }]);
  });

  test("newLogs/undoNew/redoNew LTRIM to 500/100", async () => {
    seedFile("f6");
    fakeSet(key("rows:f6"), JSON.stringify([]));
    fakeSet(
      key("logs:f6"),
      Array.from({ length: 510 }, (_, i) => JSON.stringify({ m: i })),
    );
    fakeSet(
      key("undo:f6"),
      Array.from({ length: 120 }, (_, i) => JSON.stringify({ u: i })),
    );

    const r = await api("/f6/append", {
      base: 0,
      ops: [{ rowIdx: 0, cols: { a: "1" } }],
      newLogs: [{ m: 999 }],
      undoNew: [{ u: 999 }],
      redoNew: [{ r: 1 }, { r: 2 }],
    });

    expect(r.status).toBe(200);
    const logs = (store[key("logs:f6")] as string[]).map((l) => parsed(l));
    expect(logs.length).toBe(500);
    expect(logs[logs.length - 1]).toEqual({ m: 999 });
    const undo = (store[key("undo:f6")] as string[]).map((l) => parsed(l));
    expect(undo.length).toBe(100);
    expect(undo[undo.length - 1]).toEqual({ u: 999 });
    const redo = (store[key("redo:f6")] as string[]).map((l) => parsed(l));
    expect(redo).toEqual([{ r: 1 }, { r: 2 }]);
  });

  test("second append with next entries only: both sets present, no duplicates", async () => {
    seedFile("f7");
    fakeSet(key("rows:f7"), JSON.stringify([]));

    const r1 = await api("/f7/append", {
      base: 0,
      ops: [{ rowIdx: 0, cols: { a: "1" } }],
      newLogs: [{ m: 1 }, { m: 2 }],
      undoNew: [{ u: 1 }],
      redoNew: [{ r: 1 }],
    });
    expect(r1.status).toBe(200);

    const r2 = await api("/f7/append", {
      base: 1,
      ops: [{ rowIdx: 0, cols: { b: "2" } }],
      newLogs: [{ m: 3 }],
      undoNew: [{ u: 2 }],
      redoNew: [{ r: 2 }],
    });
    expect(r2.status).toBe(200);

    expect((store[key("logs:f7")] as string[]).map(parsed)).toEqual([{ m: 1 }, { m: 2 }, { m: 3 }]);
    expect((store[key("undo:f7")] as string[]).map(parsed)).toEqual([{ u: 1 }, { u: 2 }]);
    expect((store[key("redo:f7")] as string[]).map(parsed)).toEqual([{ r: 1 }, { r: 2 }]);
  });

  test("omitted undoNew/redoNew preserves existing stack entries", async () => {
    seedFile("f8");
    fakeSet(key("rows:f8"), JSON.stringify([]));
    fakeSet(key("undo:f8"), [JSON.stringify({ u: 1 }), JSON.stringify({ u: 2 })]);
    fakeSet(key("redo:f8"), [JSON.stringify({ r: 1 })]);

    const r = await api("/f8/append", {
      base: 0,
      ops: [{ rowIdx: 0, cols: { a: "1" } }],
      newLogs: [{ m: 1 }],
    });

    expect(r.status).toBe(200);
    expect((store[key("undo:f8")] as string[]).map(parsed)).toEqual([{ u: 1 }, { u: 2 }]);
    expect((store[key("redo:f8")] as string[]).map(parsed)).toEqual([{ r: 1 }]);
  });

  test("invalid payload returns 400", async () => {
    seedFile("f10");
    const bad = [
      { base: 0, ops: "nope" },
      { base: 0, ops: [{ rowIdx: -1, cols: {} }] },
      { base: 0, ops: [{ rowIdx: 0, cols: [] }] },
      { base: "0", ops: [] },
    ];
    for (const body of bad) {
      const r = await api("/f10/append", body as any);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: "invalid append payload" });
    }
  });

  test("rejects rowIdx beyond the cap (DoS guard)", async () => {
    seedFile("f11");
    const r = await api("/f11/append", { base: 0, ops: [{ rowIdx: 1e9, cols: { a: "1" } }] });

    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid append payload" });
    expect(store[key("rows:f11")]).toBeUndefined();
  });

  test("rejects more than MAX_OPS ops in one payload (DoS guard)", async () => {
    seedFile("f12");
    const ops = Array.from({ length: 10001 }, () => ({ rowIdx: 0, cols: { a: "1" } }));

    const r = await api("/f12/append", { base: 0, ops });

    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid append payload" });
    expect(store[key("rows:f12")]).toBeUndefined();
  });

  test("rejects appends that would grow rows beyond the cap", async () => {
    seedFile("f13");
    fakeSet(key("rows:f13"), JSON.stringify(Array.from({ length: 100001 }, () => ({}))));

    const r = await api("/f13/append", { base: 0, ops: [{ rowIdx: 0, cols: { a: "1" } }] });

    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid append payload" });
  });
});

describe("POST /api/files", () => {
  test("ignores client-controlled id and binds data to the server-generated id", async () => {
    const r = await api("/", { id: "evil-client-id", name: "New", type: "fb_cookie" }, "POST");

    expect(r.status).toBe(200);
    expect(r.json.id).toBeDefined();
    expect(r.json.id).not.toBe("evil-client-id");
    expect(r.json.userId).toBe("user1");
    const files = JSON.parse(store[key("files:user1")] as string) as StoredFile[];
    expect(files).toHaveLength(1);
    expect(files[0].id).toBe(r.json.id);
    fakeSet(key("rows:" + r.json.id), JSON.stringify([{ a: "1" }]));
    const full = await api("/" + r.json.id + "/full");
    expect(full.status).toBe(200);
    expect(full.json.rows).toEqual([{ a: "1" }]);
    expect(full.json.file.id).toBe(r.json.id);
  });
});

describe("seq versioning on full read + persist", () => {
  test("GET /full includes seq from the stored counter", async () => {
    seedFile("g1");
    fakeSet(key("rows:g1"), JSON.stringify([{ a: "1" }]));
    fakeSet(key("seq:g1"), "5");

    const r = await api("/g1/full");

    expect(r.status).toBe(200);
    expect(r.json.seq).toBe(5);
    expect(r.json.file.id).toBe("g1");
    expect(r.json.rows).toEqual([{ a: "1" }]);
  });

  test("full persist replaces undo/redo as lists", async () => {
    seedFile("g3");

    const r = await api("/g3/persist", { undo: [{ u: 1 }, { u: 2 }], redo: [{ r: 1 }] });

    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((store[key("undo:g3")] as string[]).map(parsed)).toEqual([{ u: 1 }, { u: 2 }]);
    expect((store[key("redo:g3")] as string[]).map(parsed)).toEqual([{ r: 1 }]);
    expect(Array.isArray(store[key("undo:g3")])).toBe(true);
    expect(Array.isArray(store[key("redo:g3")])).toBe(true);
  });

  test("full persist over an existing list replaces it wholesale", async () => {
    seedFile("g4");
    fakeSet(key("undo:g4"), [JSON.stringify({ u: 1 })]);

    const r = await api("/g4/persist", { undo: [{ u: 2 }, { u: 3 }] });

    expect(r.status).toBe(200);
    expect((store[key("undo:g4")] as string[]).map(parsed)).toEqual([{ u: 2 }, { u: 3 }]);
  });

  test("GET /full migrates legacy string-blob undo/redo to lists", async () => {
    seedFile("g5");
    fakeSet(key("rows:g5"), JSON.stringify([{ a: "1" }]));
    fakeSet(key("seq:g5"), "0");
    fakeSet(key("undo:g5"), JSON.stringify([{ u: 9 }]));
    fakeSet(key("redo:g5"), JSON.stringify([{ r: 9 }]));

    const r = await api("/g5/full");

    expect(r.status).toBe(200);
    expect(r.json.undo).toEqual([{ u: 9 }]);
    expect(r.json.redo).toEqual([{ r: 9 }]);
    expect(Array.isArray(store[key("undo:g5")])).toBe(true);
    expect(Array.isArray(store[key("redo:g5")])).toBe(true);
  });

  test("full persist advances seq and returns it", async () => {
    seedFile("g2");
    fakeSet(key("seq:g2"), "1");

    const r = await api("/g2/persist", { rows: [{ a: "9" }] });

    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.seq).toBe(2);
    expect(r.json.file.id).toBe("g2");
    expect(store[key("seq:g2")]).toBe("2");
    expect(storedRows("g2")).toEqual([{ a: "9" }]);
  });
});