import { beforeEach, describe, expect, it } from "bun:test";

// Outbox durability unit tests: memory backend, mirror/replay pure logic.
import {
  applyMirror,
  idbDel,
  idbGet,
  idbSet,
  memoryBackend,
  mirrorKey,
  setKvBackend,
  snapKey,
  type JournalMirror,
} from "../idb";

beforeEach(() => {
  setKvBackend(memoryBackend());
});

describe("idb kv", () => {
  it("round-trips set/get/del", async () => {
    expect(await idbGet(mirrorKey("f1"))).toBeNull();
    await idbSet(mirrorKey("f1"), { journal: [], structural: false, base: 3, ts: 1 });
    expect(await idbGet<{ base: number }>(mirrorKey("f1"))).toMatchObject({ base: 3 });
    await idbDel(mirrorKey("f1"));
    expect(await idbGet(mirrorKey("f1"))).toBeNull();
  });

  it("snapshots are per-file", async () => {
    await idbSet(snapKey("a"), { rows: [{ uid: "1" }], seq: 5, ts: 1 });
    await idbSet(snapKey("b"), { rows: [], seq: 0, ts: 1 });
    expect(((await idbGet<{ rows: unknown[] }>(snapKey("a")))?.rows ?? []).length).toBe(1);
  });
});

describe("applyMirror", () => {
  const snap = [{ cookies: "c_user=1;", uid: "1", twofakey: "" }];

  it("no mirror → clean, no replay", () => {
    const r = applyMirror(snap, null);
    expect(r.dirty).toBe(false);
    expect(r.journal).toEqual([]);
    expect(r.rows).toEqual(snap);
  });

  it("empty mirror → clean", () => {
    const m: JournalMirror = { journal: [], structural: false, base: 4, ts: 1 };
    expect(applyMirror(snap, m).dirty).toBe(false);
  });

  it("cell journal replays onto snapshot rows", () => {
    const m: JournalMirror = {
      journal: [{ rowIdx: 0, cols: { twofakey: "K" } }],
      structural: false,
      base: 4,
      ts: 1,
    };
    const r = applyMirror(snap, m);
    expect(r.dirty).toBe(true);
    expect(r.rows[0]).toMatchObject({ cookies: "c_user=1;", twofakey: "K" });
    expect(r.journal).toHaveLength(1);
  });

  it("structural mirror rows win, journal applies on top", () => {
    const m: JournalMirror = {
      journal: [{ rowIdx: 1, cols: { cookies: "c_user=9;" } }],
      structural: true,
      rows: [{ cookies: "c_user=2;", uid: "2", twofakey: "" }],
      base: 4,
      ts: 1,
    };
    const r = applyMirror(snap, m);
    expect(r.dirty).toBe(true);
    expect(r.rows[0]).toMatchObject({ uid: "2" });
    expect(r.rows[1]).toMatchObject({ cookies: "c_user=9;" });
  });

  it("skips malformed ops without throwing", () => {
    const m = {
      journal: [{ rowIdx: -1, cols: { a: "b" } }, null, { rowIdx: 0, cols: null }],
      structural: false,
      base: 0,
      ts: 1,
    } as unknown as JournalMirror;
    const r = applyMirror(snap, m);
    expect(r.rows[0]).toMatchObject({ cookies: "c_user=1;" });
  });
});
