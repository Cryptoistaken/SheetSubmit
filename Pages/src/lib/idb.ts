// Pages/src/lib/idb.ts — tiny IndexedDB key-value + the durable side of sheet sync.
//
// Durability model ("save raw first"): every mutation is mirrored here
// synchronously from persist(), server-acked state is snapshotted on every
// ack/open, and boot replays mirror-on-snapshot when the server is stale or
// unreachable. The server seq guard stays the arbiter — replayed edits flush
// through the normal base/409 path, so this can never overwrite newer data.
//
// No banner, no modal: a quiet queued-dot (Topbar) is the only UI surface.
// Private-mode / quota failure degrades to today's memory-only behavior.

export interface JournalMirror {
  journal: { rowIdx: number; cols: Record<string, string> }[];
  structural: boolean;
  rows?: Record<string, unknown>[];
  base: number;
  ts: number;
}

export interface FileSnapshot {
  rows: Record<string, unknown>[];
  seq: number;
  ts: number;
  file?: unknown;
}

export const mirrorKey = (fileId: string) => `m:${fileId}`;
export const snapKey = (fileId: string) => `s:${fileId}`;

interface KvBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  delPrefix(prefix: string): Promise<void>;
}

function indexedDbBackend(dbName = "ss", store = "kv"): KvBackend | null {
  try {
    const idb =
      typeof indexedDB !== "undefined"
        ? indexedDB
        : (globalThis as Record<string, unknown>).indexedDB;
    if (!idb || typeof (idb as IDBFactory).open !== "function") return null;
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const req = (idb as IDBFactory).open(dbName, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(store);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    let dbp: Promise<IDBDatabase> | null = null;
    const db = () => (dbp ??= open());
    const tx = async (mode: IDBTransactionMode) => {
      const d = await db();
      return d.transaction(store, mode).objectStore(store);
    };
    const req = <T>(r: IDBRequest): Promise<T> =>
      new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      });
    return {
      get: async (key) => {
        try {
          const v = await req<unknown>(await (await tx("readonly")).get(key));
          return v === undefined ? null : v;
        } catch {
          return null;
        }
      },
      set: async (key, value) => {
        try {
          await req(await (await tx("readwrite")).put(value, key));
        } catch {
          /* durability is best-effort; memory state stays live */
        }
      },
      del: async (key) => {
        try {
          await req(await (await tx("readwrite")).delete(key));
        } catch {
          /* ignore */
        }
      },
      delPrefix: async (prefix) => {
        try {
          const s = await tx("readwrite");
          const keys = await req<IDBValidKey[]>((s as IDBObjectStore).getAllKeys());
          await Promise.all(
            keys
              .map(String)
              .filter((k) => k.startsWith(prefix))
              .map((k) => req((s as IDBObjectStore).delete(k))),
          );
        } catch {
          /* ignore */
        }
      },
    };
  } catch {
    return null;
  }
}

/** In-memory backend (tests, SSR, private-mode fallback). */
export function memoryBackend(): KvBackend & { size: () => number } {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => {
      m.set(k, v);
    },
    del: async (k) => {
      m.delete(k);
    },
    delPrefix: async (p) => {
      for (const k of [...m.keys()]) if (k.startsWith(p)) m.delete(k);
    },
    size: () => m.size,
  };
}

let backend: KvBackend | null | undefined;
function kv(): KvBackend {
  if (backend === undefined) backend = indexedDbBackend() ?? memoryBackend();
  return backend ?? memoryBackend();
}

/** Test hook: swap the backend (memory) and reset memoization. */
export function setKvBackend(b: KvBackend | null): void {
  backend = b ?? undefined;
}

export const idbAvailable = (): boolean => indexedDbBackend() !== null;
export const idbSet = (key: string, value: unknown): Promise<void> => kv().set(key, value);
export const idbGet = <T>(key: string): Promise<T | null> => kv().get(key) as Promise<T | null>;
export const idbDel = (key: string): Promise<void> => kv().del(key);
export const idbDelPrefix = (prefix: string): Promise<void> => kv().delPrefix(prefix);

/** Mirror the pending edit intent (called synchronously from persist()). */
export function mirrorPending(
  fileId: string,
  journal: { rowIdx: number; cols: Record<string, string> }[],
  structural: boolean,
  rows: Record<string, unknown>[] | undefined,
  base: number,
): Promise<void> {
  const m: JournalMirror = {
    journal,
    structural,
    base,
    ts: Date.now(),
    ...(structural && rows ? { rows } : {}),
  };
  return idbSet(mirrorKey(fileId), m);
}

/** Save the last server-acked state (rows + file meta for offline opens). */
export function snapshotFile(fileId: string, rows: Record<string, unknown>[], seq: number, file?: unknown): Promise<void> {
  return idbSet(snapKey(fileId), { rows, seq, ts: Date.now(), ...(file !== undefined ? { file } : {}) } satisfies FileSnapshot);
}

/** Drop all local state for a file (after confirmed purge). */
export function forgetFile(fileId: string): Promise<void> {
  return Promise.all([idbDel(mirrorKey(fileId)), idbDel(snapKey(fileId))]).then(() => undefined);
}

/** Rebuild rows from a snapshot + mirror (pure — unit-tested).
 * Structural mirror rows win (newest intent), then journal cell ops apply. */
export function applyMirror(
  snapRows: Record<string, unknown>[],
  mirror: JournalMirror | null,
): { rows: Record<string, unknown>[]; journal: { rowIdx: number; cols: Record<string, string> }[]; dirty: boolean } {
  if (!mirror || (!mirror.structural && !mirror.journal.length)) {
    return { rows: snapRows, journal: [], dirty: false };
  }
  const rows = (mirror.structural && mirror.rows ? mirror.rows : snapRows).map((r) => ({ ...r }));
  for (const op of mirror.journal) {
    if (!op || !Number.isInteger(op.rowIdx) || op.rowIdx < 0 || !op.cols) continue;
    while (rows.length <= op.rowIdx) rows.push({});
    rows[op.rowIdx] = { ...rows[op.rowIdx], ...op.cols };
  }
  return { rows, journal: mirror.journal, dirty: true };
}
