// History engine — faithful port of the old server's snapshot/delta engine.
// Redis keys are byte-identical: ss:hist:<id>, ss:hist:<id>:v:<v>,
// ss:blob:<hash>, ss:blobrefs:<hash>.
import crypto from "node:crypto";
import type { Row } from "../lib/shared";
import {
  HISTORY_CHECKPOINT_EVERY,
  HISTORY_GC_INTERVAL_MS,
  HISTORY_RETENTION_DAYS,
} from "../config/env";
import { delKey, getJSON, key, redis } from "./redis";

export function histMetaKey(id: string): string {
  return "hist:" + id;
}
export function histBlobKey(id: string, v: number): string {
  return "hist:" + id + ":v:" + v;
}
export function versionRef(fileId: string, v: number): string {
  return fileId + ":" + v;
}

function blobContentKey(hash: string): string {
  return "blob:" + hash;
}
function blobRefsKey(hash: string): string {
  return "blobrefs:" + hash;
}

function hashRows(rows: Row[]): string {
  return crypto.createHash("sha1").update(JSON.stringify(rows || [])).digest("hex");
}

function rowEqual(a?: Row, b?: Row): boolean {
  a = a || {};
  b = b || {};
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (a[ak[i]] !== b[ak[i]]) return false;
  }
  return true;
}

interface Delta {
  changed: Record<number, Row>;
  rowCount: number;
}

// Index-based delta: { changed: {rowIdx: row}, rowCount }. Only row values that
// differ from the parent version (same index) are recorded.
function computeDelta(prevRows: Row[], rows: Row[]): Delta {
  const prev = prevRows || [];
  const cur = rows || [];
  const changed: Record<number, Row> = {};
  const n = Math.max(prev.length, cur.length);
  for (let i = 0; i < n; i++) {
    if (!rowEqual(prev[i], cur[i])) changed[i] = cur[i] || {};
  }
  return { changed, rowCount: cur.length };
}

// Rebuild rows by applying a delta onto a base rows array (index-based).
export function applyDelta(rows: Row[], delta: Delta | null | undefined): Row[] {
  let out = (rows || []).slice();
  const rowCount = delta && typeof delta.rowCount === "number" ? delta.rowCount : out.length;
  const changed = (delta && delta.changed) || {};
  for (const k in changed) {
    const idx = parseInt(k, 10);
    if (isNaN(idx) || idx < 0 || idx >= rowCount) continue;
    while (out.length <= idx) out.push({});
    out[idx] = changed[k];
  }
  if (out.length > rowCount) out = out.slice(0, rowCount);
  return out;
}

interface HistPayload {
  type?: string;
  hash?: string;
  rows?: Row[];
  parentHash?: string;
  changed?: Record<number, Row>;
  rowCount?: number;
}

interface HistRec {
  v: number;
  ts: number;
  action: string;
  rowCount: number;
  parentV: number | null;
  type: string;
  hash: string | null;
  name: string | null;
}

async function readBlobByHash(hash: string): Promise<Row[] | null> {
  if (!hash) return null;
  const rows = await getJSON<Row[]>(blobContentKey(hash));
  return Array.isArray(rows) ? rows : null;
}

// Delete a blob and its refset only when nothing references it anymore.
async function gcBlobIfOrphaned(hash: string): Promise<void> {
  if (!hash) return;
  try {
    const size = await redis.scard(key(blobRefsKey(hash)));
    if (size === 0) {
      await redis.del(key(blobContentKey(hash)), key(blobRefsKey(hash)));
      console.log("[GC] hash " + hash.slice(0, 8) + "... removed (no refs)");
    }
  } catch (e) {
    console.error("[GC] orphan-check error:", (e as Error).message);
  }
}

// In-process per-file serialization of the history meta read-then-write. Snapshot
// and prune both re-read the meta key and rewrite it; without a lock a prune that
// lands between a snapshot's read and write clobbers the newest record (BE-8). The
// lock chains on a per-file promise so overlapping calls run strictly in order.
const fileLocks = new Map<string, Promise<unknown>>();

async function withFileLock<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(fileId);
  const tail = prev ? prev.then(fn, fn) : fn();
  fileLocks.set(fileId, tail);
  try {
    return await tail;
  } finally {
    if (fileLocks.get(fileId) === tail) fileLocks.delete(fileId);
  }
}

// Save the current rows as a new version. Returns the version number, or null on failure.
// Version numbers are collision-proof: meta is re-read inside WATCH and the write
// commits through MULTI, so a concurrent snapshot that bumps the meta key aborts our
// exec and we retry with a fresh v (never tied to the file's seq: counter).
export async function snapshotHistory(fileId: string, action: string, rows: Row[]): Promise<number | null> {
  return withFileLock(fileId, async () => {
    try {
      const now = Date.now();
      const rowsArr = Array.isArray(rows) ? rows : [];
      const rowCount = rowsArr.length;
      const hash = hashRows(rowsArr);

      for (let attempt = 0; attempt < 5; attempt++) {
        await redis.watch(key(histMetaKey(fileId)));
        const meta = (await getJSON<HistRec[]>(histMetaKey(fileId))) || [];
        const v = meta.length ? meta[meta.length - 1].v + 1 : 1;
        const isCheckpoint = v === 1 || v % HISTORY_CHECKPOINT_EVERY === 0;
        let payload: HistPayload | null = null;

        // Between checkpoints try a delta vs the parent version keep it smaller.
        if (!isCheckpoint && meta.length) {
          const prevRec = meta[meta.length - 1];
          const prevRows = await materializeVersion(fileId, prevRec.v);
          if (Array.isArray(prevRows)) {
            const delta = computeDelta(prevRows, rowsArr);
            const deltaObj: HistPayload = {
              type: "delta",
              parentHash: prevRec.hash || hashRows(prevRows),
              changed: delta.changed,
              rowCount,
            };
            if (JSON.stringify(deltaObj).length < JSON.stringify(rowsArr).length) {
              payload = deltaObj;
            }
          }
        }

        const type = payload ? "delta" : "full";
        if (type === "full") payload = { type: "full", hash, rows: rowsArr };

        const rec: HistRec = {
          v,
          ts: now,
          action: action || "edit",
          rowCount,
          parentV: meta.length ? meta[meta.length - 1].v : null,
          type,
          hash,
          name: null,
        };

        // Read-only checks can't be queued in MULTI — run them before exec.
        const contentExists = type === "full" ? await redis.exists(key(blobContentKey(hash))) : false;

        const p = redis.multi();
        p.set(key(histBlobKey(fileId, v)), JSON.stringify(payload));
        if (type === "full") {
          if (!contentExists) p.set(key(blobContentKey(hash)), JSON.stringify(rowsArr));
          p.sadd(key(blobRefsKey(hash)), versionRef(fileId, v));
        }
        p.set(key(histMetaKey(fileId)), JSON.stringify(meta.concat([rec])));

        const res = await p.exec();
        if (res === null) continue;
        console.log("[Hist] snapshot v" + v + " action=" + rec.action + " type=" + type + " rows=" + rowCount + " file=" + fileId);
        return v;
      }
      try {
        await redis.unwatch();
      } catch {
        // ignore
      }
      return null;
    } catch (e) {
      console.error("[Hist] snapshot error file=" + fileId + ":", (e as Error).message);
      return null;
    }
  });
}

export async function getHistoryMeta(fileId: string): Promise<HistRec[]> {
  return ((await getJSON<HistRec[]>(histMetaKey(fileId))) || []).slice().reverse();
}

// Read the full rows of a version that carries a 'full' payload (or a legacy array payload).
async function readFullRows(fileId: string, rec: HistRec): Promise<Row[] | null> {
  if (!rec) return null;
  const payload = await getJSON<Row[] | HistPayload>(histBlobKey(fileId, rec.v));
  if (Array.isArray(payload)) return payload;
  if (payload && payload.type === "full") {
    if (Array.isArray(payload.rows)) return payload.rows;
    return await readBlobByHash(payload.hash || "");
  }
  return null;
}

// Rebuild the rows for a given version by walking back to the nearest 'full'
// ancestor and applying deltas forward. Falls back to surfacing any surviving
// full payload if intermediate versions are missing.
export async function materializeVersion(fileId: string, v: number): Promise<Row[] | null> {
  try {
    const meta = (await getJSON<HistRec[]>(histMetaKey(fileId))) || [];
    let recIdx = -1;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].v === v) {
        recIdx = i;
        break;
      }
    }
    if (recIdx === -1) return null;

    // Walk back for the nearest full ancestor (legacy array payloads count as full).
    let baseIdx = -1;
    for (let i = recIdx; i >= 0; i--) {
      if (meta[i].type === "full") {
        baseIdx = i;
        break;
      }
      const probe = await getJSON<Row[] | HistPayload>(histBlobKey(fileId, meta[i].v));
      if (Array.isArray(probe)) {
        baseIdx = i;
        break;
      }
    }

    if (baseIdx !== -1) {
      if (baseIdx === recIdx) return await readFullRows(fileId, meta[recIdx]);
      let rows = await readFullRows(fileId, meta[baseIdx]);
      if (Array.isArray(rows)) {
        let ok = true;
        for (let j = baseIdx + 1; j <= recIdx; j++) {
          const pd = await getJSON<Row[] | HistPayload>(histBlobKey(fileId, meta[j].v));
          if (pd && !Array.isArray(pd) && pd.type === "delta") {
            rows = applyDelta(rows, pd as Delta);
          } else if (Array.isArray(pd)) {
            rows = pd;
          } else if (pd && !Array.isArray(pd) && pd.type === "full") {
            rows = Array.isArray(pd.rows) ? pd.rows : await readBlobByHash(pd.hash || "");
          } else {
            ok = false;
            break;
          }
          if (!Array.isArray(rows)) {
            ok = false;
            break;
          }
        }
        if (ok) return rows;
      }
    }

    // Chain missing: try the content-addressed blob for the target hash...
    if (meta[recIdx].hash) {
      const direct = await readBlobByHash(meta[recIdx].hash || "");
      if (Array.isArray(direct)) return direct;
    }
    // ...last resort: scan every surviving payload, newest first, for full rows.
    const scanP = redis.pipeline();
    meta.forEach((rec) => scanP.get(key(histBlobKey(fileId, rec.v))));
    const results = (await scanP.exec()) || [];
    for (let i = recIdx; i >= 0; i--) {
      const raw = results[i][1];
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw as string);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && parsed.type === "full" && Array.isArray(parsed.rows)) return parsed.rows;
      } catch {
        continue;
      }
    }
    return null;
  } catch (e) {
    console.error("[Hist] materialize error file=" + fileId + " v" + v + ":", (e as Error).message);
    return null;
  }
}

// Age-only prune: drop versions (and their blobs) older than HISTORY_RETENTION_DAYS.
// Also releases blob refs and garbage-collects orphaned content-addressed blobs.
export async function pruneHistory(fileId: string): Promise<number> {
  return withFileLock(fileId, async () => {
    try {
      const meta = (await getJSON<HistRec[]>(histMetaKey(fileId))) || [];
      if (!meta.length) return 0;
      const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 86400000;
      const kept: HistRec[] = [];
      const removed: HistRec[] = [];
      meta.forEach((rec) => {
        if (rec.ts < cutoff) removed.push(rec);
        else kept.push(rec);
      });
      if (!removed.length) return 0;

      // If the oldest retained version is a delta, re-write it as a full snapshot
      // BEFORE deleting the (older) versions it depends on, so the chain stays
      // rebuildable after the prune.
      let upgrade: { rec: HistRec; hash: string; rows: Row[] } | null = null;
      if (kept.length && kept[0].type !== "full") {
        const stableRows = await materializeVersion(fileId, kept[0].v);
        if (Array.isArray(stableRows)) {
          upgrade = { rec: kept[0], hash: hashRows(stableRows), rows: stableRows };
        } else {
          console.error(
            "[Hist] prune ABORTED file=" + fileId +
            " — oldest retained version is a delta and materialization failed; skipping prune to keep history chain intact",
          );
          return 0;
        }
      }

      const p = redis.pipeline();
      removed.forEach((rec) => {
        p.del(key(histBlobKey(fileId, rec.v)));
        if (rec.type === "full" && rec.hash) {
          p.srem(key(blobRefsKey(rec.hash)), versionRef(fileId, rec.v));
        }
      });
      if (upgrade) {
        upgrade.rec.type = "full";
        upgrade.rec.hash = upgrade.hash;
        upgrade.rec.rowCount = upgrade.rows.length;
        p.set(key(blobContentKey(upgrade.hash)), JSON.stringify(upgrade.rows));
        p.sadd(key(blobRefsKey(upgrade.hash)), versionRef(fileId, upgrade.rec.v));
        p.set(key(histBlobKey(fileId, upgrade.rec.v)), JSON.stringify({ type: "full", hash: upgrade.hash, rows: upgrade.rows }));
      }
      p.set(key(histMetaKey(fileId)), JSON.stringify(kept));
      await p.exec();

      const hashes: Record<string, boolean> = {};
      removed.forEach((rec) => {
        if (rec.type === "full" && rec.hash) hashes[rec.hash] = true;
      });
      for (const h in hashes) {
        await gcBlobIfOrphaned(h);
      }
      console.log("[Hist] pruned " + removed.length + " version(s) older than " + HISTORY_RETENTION_DAYS + "d file=" + fileId);
      return removed.length;
    } catch (e) {
      console.error("[Hist] prune error file=" + fileId + ":", (e as Error).message);
      return 0;
    }
  });
}

// Remove the full history for a file (meta + every version blob). Used on permanent delete.
export async function delHistoryKeys(fileId: string): Promise<void> {
  try {
    const meta = (await getJSON<HistRec[]>(histMetaKey(fileId))) || [];
    const p = redis.pipeline();
    p.del(key(histMetaKey(fileId)));
    const hashes: Record<string, boolean> = {};
    meta.forEach((rec) => {
      p.del(key(histBlobKey(fileId, rec.v)));
      if (rec.type === "full" && rec.hash) {
        p.srem(key(blobRefsKey(rec.hash)), versionRef(fileId, rec.v));
        hashes[rec.hash] = true;
      }
    });
    await p.exec();
    for (const h in hashes) {
      await gcBlobIfOrphaned(h);
    }
    console.log("[Hist] deleted history file=" + fileId + " versions=" + meta.length);
  } catch (e) {
    console.error("[Hist] delete error file=" + fileId + ":", (e as Error).message);
    await delKey(histMetaKey(fileId));
  }
}

// Delete history for many files with bounded parallelism (was: N sequential
// Redis round-trips per file — scales linearly with the batch size).
export async function deleteFilesHistory(fileIds: string[], concurrency = 4): Promise<void> {
  const ids = [...fileIds];
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    for (;;) {
      const id = ids.shift();
      if (id === undefined) return;
      await delHistoryKeys(id);
    }
  });
  await Promise.all(workers);
}

// Global blob GC sweep (best-effort, ~every HISTORY_GC_INTERVAL_MS).
export async function gcHistoryBlobs(): Promise<void> {
  try {
    let cursor = "0";
    let scanned = 0;
    let deleted = 0;
    do {
      const res = await redis.scan(cursor, "MATCH", "ss:blobrefs:*", "COUNT", 100);
      cursor = res[0];
      const keys = res[1] || [];
      for (let i = 0; i < keys.length; i++) {
        scanned++;
        const hash = keys[i].slice("ss:blobrefs:".length);
        if (!hash) continue;
        const size = await redis.scard(key(blobRefsKey(hash)));
        if (size === 0) {
          await redis.del(key(blobContentKey(hash)), key(blobRefsKey(hash)));
          deleted++;
        }
      }
    } while (cursor !== "0");
    console.log("[GC] sweep scanned=" + scanned + " refsets, deleted=" + deleted + " orphan blob(s)");
  } catch (e) {
    console.error("[GC] sweep error:", (e as Error).message);
  }
}

let historyGcStarted = false;
export function startHistoryGc(): void {
  if (historyGcStarted) return;
  historyGcStarted = true;
  const timer = setInterval(gcHistoryBlobs, HISTORY_GC_INTERVAL_MS);
  if (timer && timer.unref) timer.unref();
}
