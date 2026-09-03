// Redis backup loop — faithful port of the old server's backup.js.
import Redis, { type RedisOptions } from "ioredis";
import { BACKUP_INTERVAL_MS, REDIS_BACKUP_URL } from "../config/env";

let _backupRedis: Redis | null = null;
let _lastKeyCount: number | null = null;

function getBackupRedis(): Redis | null {
  if (!_backupRedis && REDIS_BACKUP_URL) {
    const opts: RedisOptions = {
      maxRetriesPerRequest: 2,
      retryStrategy: (times: number) => Math.min(times * 300, 3000),
      lazyConnect: true,
    };
    if (REDIS_BACKUP_URL.startsWith("rediss://") || REDIS_BACKUP_URL.includes("upstash.io")) {
      opts.tls = {};
    }
    _backupRedis = new Redis(REDIS_BACKUP_URL, opts);
    _backupRedis.on("error", (err) => {
      console.error("[Backup] Backup Redis error: " + err.message);
    });
  }
  return _backupRedis;
}

async function copyKeys(source: Redis, dest: Redis): Promise<{ count: number; errors: number }> {
  let count = 0;
  let errors = 0;
  let cursor = "0";
  do {
    const result = await source.scan(cursor, "MATCH", "ss:*", "COUNT", "500");
    cursor = result[0];
    const keys = result[1];
    if (keys.length === 0) continue;

    // Phase (a): type + ttl for every key in this batch — one round trip.
    const metaP = source.pipeline();
    for (const key of keys) {
      metaP.type(key);
      metaP.ttl(key);
    }
    const metaRes = await metaP.exec();
    const meta: { type: string; ttl: number }[] = [];
    for (let i = 0; i < keys.length; i++) {
      const t = metaRes ? metaRes[i * 2] : null;
      const ttl = metaRes ? metaRes[i * 2 + 1] : null;
      if (!t || t[0] || !ttl || ttl[0]) {
        errors++;
        if (errors <= 3) console.error("[Backup] type/ttl failed for " + keys[i]);
        meta.push({ type: "none", ttl: 0 });
        continue;
      }
      meta.push({ type: String(t[1]), ttl: Number(ttl[1]) });
    }

    // Phase (b): one pipeline per value-type group — one round trip per group.
    const groups: { list: string[]; set: string[]; hash: string[]; string: string[]; other: string[] } = {
      list: [],
      set: [],
      hash: [],
      string: [],
      other: [],
    };
    for (let i = 0; i < keys.length; i++) {
      const t = meta[i].type;
      if (t === "list") groups.list.push(keys[i]);
      else if (t === "set") groups.set.push(keys[i]);
      else if (t === "hash") groups.hash.push(keys[i]);
      else if (t === "string") groups.string.push(keys[i]);
      else if (t !== "none") groups.other.push(keys[i]);
    }

    const values = new Map<string, unknown>();
    if (groups.string.length > 0) {
      const p = source.pipeline();
      groups.string.forEach((k) => p.get(k));
      const r = await p.exec();
      (r || []).forEach((slot, i) => {
        if (slot[0]) {
          errors++;
          if (errors <= 3) console.error("[Backup] get failed for " + groups.string[i] + ": " + (slot[0] as Error).message);
        } else {
          values.set(groups.string[i], slot[1]);
        }
      });
    }
    if (groups.list.length > 0) {
      const p = source.pipeline();
      groups.list.forEach((k) => p.lrange(k, 0, -1));
      const r = await p.exec();
      (r || []).forEach((slot, i) => {
        if (slot[0]) {
          errors++;
          if (errors <= 3) console.error("[Backup] lrange failed for " + groups.list[i] + ": " + (slot[0] as Error).message);
        } else {
          values.set(groups.list[i], slot[1]);
        }
      });
    }
    if (groups.set.length > 0) {
      const p = source.pipeline();
      groups.set.forEach((k) => p.smembers(k));
      const r = await p.exec();
      (r || []).forEach((slot, i) => {
        if (slot[0]) {
          errors++;
          if (errors <= 3) console.error("[Backup] smembers failed for " + groups.set[i] + ": " + (slot[0] as Error).message);
        } else {
          values.set(groups.set[i], slot[1]);
        }
      });
    }
    if (groups.hash.length > 0) {
      const p = source.pipeline();
      groups.hash.forEach((k) => p.hgetall(k));
      const r = await p.exec();
      (r || []).forEach((slot, i) => {
        if (slot[0]) {
          errors++;
          if (errors <= 3) console.error("[Backup] hgetall failed for " + groups.hash[i] + ": " + (slot[0] as Error).message);
        } else {
          values.set(groups.hash[i], slot[1]);
        }
      });
    }
    if (groups.other.length > 0) {
      const p = source.pipeline();
      groups.other.forEach((k) => p.dump(k));
      const r = await p.exec();
      (r || []).forEach((slot, i) => {
        if (slot[0]) {
          errors++;
          if (errors <= 3) console.error("[Backup] dump failed for " + groups.other[i] + ": " + (slot[0] as Error).message);
        } else {
          values.set(groups.other[i], slot[1]);
        }
      });
    }

    // Phase (c): one pipeline writing everything to the destination.
    const writeP = dest.pipeline();
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const t = meta[i].type;
      if (t === "none") continue;
      const val = values.get(key);
      if (val === undefined) continue;
      const ttlMs = meta[i].ttl > 0 ? meta[i].ttl * 1000 : 0;
      if (t === "string") {
        if (val === null) continue;
        if (ttlMs > 0) writeP.set(key, val as string, "PX", ttlMs);
        else writeP.set(key, val as string);
        count++;
      } else if (t === "list") {
        const items = val as string[];
        if (items.length === 0) continue;
        writeP.del(key);
        writeP.rpush(key, ...items);
        if (ttlMs > 0) writeP.pexpire(key, ttlMs);
        count++;
      } else if (t === "set") {
        const members = val as string[];
        if (members.length === 0) continue;
        writeP.del(key);
        writeP.sadd(key, ...members);
        if (ttlMs > 0) writeP.pexpire(key, ttlMs);
        count++;
      } else if (t === "hash") {
        const obj = val as Record<string, string>;
        const hkeys = Object.keys(obj);
        if (hkeys.length === 0) continue;
        writeP.del(key);
        const bulk: string[] = [];
        for (const hk of hkeys) bulk.push(hk, obj[hk]);
        writeP.hset(key, bulk);
        if (ttlMs > 0) writeP.pexpire(key, ttlMs);
        count++;
      } else {
        if (!val) continue;
        writeP.restore(key, ttlMs, val as Buffer, "REPLACE");
        count++;
      }
    }
    const writeRes = await writeP.exec();
    if (writeRes) {
      for (const slot of writeRes) {
        if (slot[0]) {
          errors++;
          count--;
        }
      }
    }
  } while (cursor !== "0");
  if (errors > 0) console.error("[Backup] " + errors + " key(s) failed to copy");
  return { count, errors };
}

let _backupRunning = false;

export async function createBackup(source: Redis): Promise<number> {
  if (_backupRunning) return -2;
  _backupRunning = true;
  try {
    const dest = getBackupRedis();
    if (!dest) return -1;
    if (dest.status !== "ready") {
      try {
        await dest.connect();
      } catch (e) {
        console.error("[Backup] connect failed: " + (e as Error).message);
        return -1;
      }
    }

    const dirty = await source.get("ss:meta:dirty");
    if (!dirty && _lastKeyCount !== null) return 0;

    const keyCount = await source.dbsize();
    const result = await copyKeys(source, dest);
    if (result.errors > 0) {
      console.error("[Backup] Copy had " + result.errors + " error(s), keeping dirty marker for retry");
      return result.count;
    }
    const dirtyAfter = await source.get("ss:meta:dirty");
    if (dirtyAfter && dirtyAfter !== dirty) {
      console.log("[Backup] New write during copy, keeping dirty marker");
      return result.count;
    }
    // Atomically delete the marker ONLY if it still holds the value we just
    // observed. If a writer updated ss:meta:dirty between the read above and
    // this delete, the compare-and-delete skips it and the next pass re-syncs.
    await source.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      "ss:meta:dirty",
      dirtyAfter || "",
    );
    console.log(
      "[Backup] Synced " + result.count + " ss:* keys" +
      (keyCount === _lastKeyCount ? "" : " (" + _lastKeyCount + "→" + keyCount + " total)"),
    );
    _lastKeyCount = keyCount;
    return result.count;
  } catch (e) {
    console.error("[Backup] createBackup error: " + (e as Error).message);
    return -1;
  } finally {
    _backupRunning = false;
  }
}

export async function restoreFromBackup(dest: Redis): Promise<boolean> {
  try {
    const dbsize = await dest.dbsize();
    if (dbsize > 3) {
      console.log("[Backup] Main Redis has " + dbsize + " keys, skipping restore");
      return false;
    }

    const source = getBackupRedis();
    if (!source) return false;
    if (source.status !== "ready") {
      try {
        await source.connect();
      } catch (e) {
        console.error("[Backup] restore connect failed: " + (e as Error).message);
        return false;
      }
    }

    const backupCount = await source.dbsize();
    if (backupCount === 0) return false;

    const result = await copyKeys(source, dest);
    console.log("[Backup] Restored " + result.count + " keys from backup Redis");
    return result.count > 0;
  } catch (e) {
    console.error("[Backup] restoreFromBackup error: " + (e as Error).message);
    return false;
  }
}

export function startBackupLoop(source: Redis): void {
  if (!REDIS_BACKUP_URL) return;
  setTimeout(async () => {
    await createBackup(source);
    setInterval(() => {
      void createBackup(source);
    }, BACKUP_INTERVAL_MS);
    console.log("[Backup] Scheduled every " + BACKUP_INTERVAL_MS / 60000 + " min");
  }, 10000);
}
