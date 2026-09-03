// Tests for the history engine's data-integrity logic (backend/src/services/history.ts),
// in particular pruneHistory's behavior on the happy paths and the delta-upgrade /
// corruption-abort paths. The real redis module is replaced by the in-memory fake.
import { describe, expect, test, beforeEach } from "bun:test";
import crypto from "node:crypto";
import { installRedisMock, resetStore, store, fakeSet, setBeforeExec } from "./redis-mock";
import { HISTORY_RETENTION_DAYS } from "../src/config/env";
import type { Row } from "../src/lib/shared";

installRedisMock();

const { pruneHistory, snapshotHistory, histMetaKey, histBlobKey, versionRef } = await import("../src/services/history");
const { key, getJSON } = await import("../src/services/redis");

const DAY = 86400000;
const now = Date.now();
const oldTs = now - (HISTORY_RETENTION_DAYS + 1) * DAY;

function sha1(rows: Row[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(rows)).digest("hex");
}
const blobContentKey = (hash: string) => "blob:" + hash;
const blobRefsKey = (hash: string) => "blobrefs:" + hash;

interface Rec {
  v: number;
  ts: number;
  action: string;
  rowCount: number;
  parentV: number | null;
  type: string;
  hash: string | null;
  name: null;
}

function rec(v: number, ts: number, type: string, hash: string | null, rowCount: number, parentV: number | null): Rec {
  return { v, ts, action: "edit", rowCount, parentV, type, hash, name: null };
}

// Seed a full version: version blob (type full, hash, rows), content-addressed
// blob, and its refset entry. The rec's hash field is filled in (matching what
// snapshotHistory stores in the meta) so the prune GC can release the blob.
function seedFull(fileId: string, r: Rec, rows: Row[]): string {
  const hash = sha1(rows);
  r.hash = hash;
  fakeSet(key(histBlobKey(fileId, r.v)), JSON.stringify({ type: "full", hash, rows }));
  fakeSet(key(blobContentKey(hash)), JSON.stringify(rows));
  fakeSet(key(blobRefsKey(hash)), new Set([versionRef(fileId, r.v)]));
  return hash;
}

// Seed a delta version: only the version blob (type delta). The parent chain it
// depends on must be seeded separately.
function seedDelta(fileId: string, r: Rec, parentHash: string, changed: Record<number, Row>, rowCount: number): void {
  fakeSet(key(histBlobKey(fileId, r.v)), JSON.stringify({ type: "delta", parentHash, changed, rowCount }));
}

function seedMeta(fileId: string, recs: Rec[]): void {
  fakeSet(key(histMetaKey(fileId)), JSON.stringify(recs));
}

const file = (id: string, name: string) => ({ id, name, type: "fb_cookie", createdAt: 1, updatedAt: 1, rowCount: 0, columns: null });

describe("pruneHistory", () => {
  beforeEach(() => {
    resetStore();
  });

  test("normal prune removes only versions older than the retention cutoff", async () => {
    const f = "f1";
    const r1 = rec(1, oldTs, "full", null, 1, null);
    const r2 = rec(2, oldTs, "full", null, 2, 1);
    const r3 = rec(3, oldTs, "full", null, 3, 2);
    const r4 = rec(4, now, "full", null, 4, 3);
    const r5 = rec(5, now, "full", null, 5, 4);
    const h1 = seedFull(f, r1, [{ u: "1" }]);
    const h2 = seedFull(f, r2, [{ u: "1" }, { u: "2" }]);
    const h3 = seedFull(f, r3, [{ u: "1" }, { u: "2" }, { u: "3" }]);
    const h4 = seedFull(f, r4, [{ u: "1" }, { u: "2" }, { u: "3" }, { u: "4" }]);
    const h5 = seedFull(f, r5, [{ u: "1" }, { u: "2" }, { u: "3" }, { u: "4" }, { u: "5" }]);
    seedMeta(f, [r1, r2, r3, r4, r5]);

    const pruned = await pruneHistory(f);

    expect(pruned).toBe(3);
    for (const v of [1, 2, 3]) {
      expect(store[key(histBlobKey(f, v))]).toBeUndefined();
    }
    for (const h of [h1, h2, h3]) {
      expect(store[key(blobContentKey(h))]).toBeUndefined();
      expect(store[key(blobRefsKey(h))]).toBeUndefined();
    }
    expect(store[key(histBlobKey(f, 4))]).toBeDefined();
    expect(store[key(histBlobKey(f, 5))]).toBeDefined();
    expect(store[key(blobContentKey(h4))]).toBeDefined();
    expect(store[key(blobContentKey(h5))]).toBeDefined();
    expect(store[key(blobRefsKey(h4))]).toEqual(new Set(["f1:4"]));
    expect(store[key(blobRefsKey(h5))]).toEqual(new Set(["f1:5"]));

    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(meta!.map((r) => r.v)).toEqual([4, 5]);
  });

  test("delta upgrade: oldest retained delta is rewritten as a full snapshot", async () => {
    const f = "f2";
    const baseRows = [{ u: "1" }, { u: "2", c: "x" }];
    const materialized = [{ u: "1" }, { u: "2", c: "x", d: "y" }];
    const r1 = rec(1, oldTs, "full", null, 1, null);
    const r2 = rec(2, oldTs, "full", null, 2, 1);
    const r3 = rec(3, oldTs, "full", null, 2, 2);
    const r4 = rec(4, now, "delta", sha1(materialized), 2, 3);
    const r5 = rec(5, now, "full", null, 3, 4);
    const h1 = seedFull(f, r1, [{ u: "1" }]);
    const h2 = seedFull(f, r2, [{ u: "1" }, { u: "2" }]);
    const h3 = seedFull(f, r3, baseRows);
    seedDelta(f, r4, h3, { 1: { u: "2", c: "x", d: "y" } }, 2);
    const h5 = seedFull(f, r5, [{ u: "1" }, { u: "2", c: "x", d: "y" }, { u: "3" }]);
    seedMeta(f, [r1, r2, r3, r4, r5]);

    const pruned = await pruneHistory(f);

    expect(pruned).toBe(3);
    const H = sha1(materialized);

    const upgradedBlob = JSON.parse(store[key(histBlobKey(f, 4))] as string);
    expect(upgradedBlob.type).toBe("full");
    expect(upgradedBlob.hash).toBe(H);
    expect(upgradedBlob.rows).toEqual(materialized);

    expect(JSON.parse(store[key(blobContentKey(H))] as string)).toEqual(materialized);
    expect(store[key(blobRefsKey(H))]).toEqual(new Set(["f2:4"]));

    for (const v of [1, 2, 3]) {
      expect(store[key(histBlobKey(f, v))]).toBeUndefined();
    }
    for (const h of [h1, h2, h3]) {
      expect(store[key(blobContentKey(h))]).toBeUndefined();
      expect(store[key(blobRefsKey(h))]).toBeUndefined();
    }
    expect(store[key(histBlobKey(f, 5))]).toBeDefined();
    expect(store[key(blobContentKey(h5))]).toBeDefined();

    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(meta!.length).toBe(2);
    expect(meta![0].v).toBe(4);
    expect(meta![0].type).toBe("full");
    expect(meta![0].hash).toBe(H);
    expect(meta![1].v).toBe(5);
  });

  test("corruption abort: oldest retained delta cannot be materialized -> prune skipped, chain untouched", async () => {
    const f = "f3";
    // v1..v3 full versions whose version blobs are MISSING (parent chain broken);
    // only the content-addressed blobs + refsets survive.
    const r1 = rec(1, oldTs, "full", "h1", 1, null);
    const r2 = rec(2, oldTs, "full", "h2", 1, 1);
    const r3 = rec(3, oldTs, "full", "h3", 1, 2);
    const r4 = rec(4, now, "delta", "h4", 1, 3);
    fakeSet(key(blobContentKey("h1")), JSON.stringify([{ u: "1" }]));
    fakeSet(key(blobRefsKey("h1")), new Set(["f3:1"]));
    fakeSet(key(blobContentKey("h2")), JSON.stringify([{ u: "1" }]));
    fakeSet(key(blobRefsKey("h2")), new Set(["f3:2"]));
    fakeSet(key(blobContentKey("h3")), JSON.stringify([{ u: "1" }]));
    fakeSet(key(blobRefsKey("h3")), new Set(["f3:3"]));
    seedDelta(f, r4, "h3", { 0: { u: "9" } }, 1);
    seedMeta(f, [r1, r2, r3, r4]);

    const pruned = await pruneHistory(f);

    expect(pruned).toBe(0);
    for (const h of ["h1", "h2", "h3"]) {
      expect(store[key(blobContentKey(h))]).toBeDefined();
      expect(store[key(blobRefsKey(h))]).toBeDefined();
    }
    const deltaBlob = JSON.parse(store[key(histBlobKey(f, 4))] as string);
    expect(deltaBlob.type).toBe("delta");
    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(meta!.map((r) => r.v)).toEqual([1, 2, 3, 4]);
  });
});

describe("snapshotHistory", () => {
  beforeEach(() => {
    resetStore();
  });

  test("retries on WATCH conflict and allocates a non-colliding v", async () => {
    const f = "f4";
    const r1 = rec(1, now, "full", null, 1, null);
    seedFull(f, r1, [{ u: "1" }]);
    seedMeta(f, [r1]);

    // Simulate a concurrent snapshot committing v2 between our read and exec on
    // the first attempt. The retry must observe it and pick v3 instead of
    // colliding on v2 (the WATCH/MULTI conflict detection aborts the first exec).
    let fired = false;
    setBeforeExec(() => {
      if (fired) return;
      fired = true;
      const conc = rec(2, Date.now(), "full", sha1([{ u: "1" }, { u: "2" }]), 2, 1);
      const meta = JSON.parse(store[key(histMetaKey(f))] as string) as Rec[];
      fakeSet(key(histMetaKey(f)), JSON.stringify(meta.concat([conc])));
      fakeSet(key(histBlobKey(f, 2)), JSON.stringify({ type: "full", hash: conc.hash, rows: [{ u: "1" }, { u: "2" }] }));
    });

    const v = await snapshotHistory(f, "edit", [{ u: "1" }, { u: "2" }, { u: "3" }]);

    expect(fired).toBe(true);
    expect(v).toBe(3);
    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(meta!.map((r) => r.v)).toEqual([1, 2, 3]);
    expect(store[key(histBlobKey(f, 2))]).toBeDefined();
    expect(store[key(histBlobKey(f, 3))]).toBeDefined();
  });

  test("prune after snapshot does not lose the newest record", async () => {
    const f = "f5";
    const r1 = rec(1, oldTs, "full", null, 1, null);
    const r2 = rec(2, oldTs, "full", null, 2, 1);
    const r3 = rec(3, oldTs, "full", null, 3, 2);
    seedFull(f, r1, [{ u: "1" }]);
    seedFull(f, r2, [{ u: "1" }, { u: "2" }]);
    seedFull(f, r3, [{ u: "1" }, { u: "2" }, { u: "3" }]);
    seedMeta(f, [r1, r2, r3]);

    const rows = [{ u: "1" }, { u: "2" }, { u: "3" }, { u: "4" }];
    const v = await snapshotHistory(f, "edit", rows);
    expect(v).toBe(4);

    const pruned = await pruneHistory(f);
    expect(pruned).toBe(3);

    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(meta!.map((r) => r.v)).toEqual([4]);
  });

  test("concurrent snapshot + prune serialize; newest record survives", async () => {
    const f = "f6";
    const r1 = rec(1, oldTs, "full", null, 1, null);
    const r2 = rec(2, oldTs, "full", null, 2, 1);
    const r3 = rec(3, oldTs, "full", null, 3, 2);
    seedFull(f, r1, [{ u: "1" }]);
    seedFull(f, r2, [{ u: "1" }, { u: "2" }]);
    seedFull(f, r3, [{ u: "1" }, { u: "2" }, { u: "3" }]);
    seedMeta(f, [r1, r2, r3]);

    const rows = [{ u: "1" }, { u: "2" }, { u: "3" }, { u: "4" }];
    const [snapV, pruned] = await Promise.all([
      snapshotHistory(f, "edit", rows),
      pruneHistory(f),
    ]);

    const meta = await getJSON<Rec[]>("hist:" + f);
    expect(pruned).toBe(3);
    expect(meta!.length).toBe(1);
    expect(meta![0].v).toBe(snapV);
    expect(meta![0].ts).toBeGreaterThan(oldTs);
  });
});