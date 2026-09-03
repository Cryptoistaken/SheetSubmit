export type QueuedSaveKind = "append" | "persist";

export interface QueuedSave {
  id: number;
  fileId: string;
  kind: QueuedSaveKind;
  payload: unknown;
  ts: number;
}

export interface OfflineDb {
  enqueue(save: { fileId: string; kind: QueuedSaveKind; payload: unknown }): Promise<QueuedSave>;
  list(fileId?: string): Promise<QueuedSave[]>;
  remove(ids: number[]): Promise<void>;
  count(fileId?: string): Promise<number>;
  clear(): Promise<void>;
  available(): Promise<boolean>;
}

const DB_NAME = "sheetsubmit-offline";
const DB_VERSION = 1;
const STORE_NAME = "queue";

let openPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!openPromise) {
    openPromise = new Promise((resolve) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        resolve(null);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, {
            keyPath: "id",
            autoIncrement: true,
          });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return openPromise;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function runInTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openDb().then((db) => {
    if (!db) throw new Error("IndexedDB unavailable");
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return new Promise<T>((resolve, reject) => {
      let value: T | undefined;
      transaction.oncomplete = () => resolve(value as T);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
      work(store)
        .then((result) => {
          value = result;
        })
        .catch(reject);
    });
  });
}

export const offlineDb: OfflineDb = {
  async available(): Promise<boolean> {
    const db = await openDb();
    return db !== null;
  },

  async enqueue(save) {
    const db = await openDb();
    if (!db) {
      return { id: 0, fileId: save.fileId, kind: save.kind, payload: save.payload, ts: Date.now() };
    }
    return runInTransaction("readwrite", async (store) => {
      const key = await requestResult(
        store.add({ fileId: save.fileId, kind: save.kind, payload: save.payload, ts: Date.now() }),
      );
      const record = await requestResult(store.get(key));
      return record as QueuedSave;
    });
  },

  async list(fileId) {
    const db = await openDb();
    if (!db) return [];
    const all = await runInTransaction("readonly", async (store) => {
      return (await requestResult(store.getAll())) as QueuedSave[];
    });
    const rows = fileId ? all.filter((record) => record.fileId === fileId) : all;
    return rows.sort((a, b) => a.id - b.id);
  },

  async remove(ids) {
    const db = await openDb();
    if (!db || ids.length === 0) return;
    await runInTransaction("readwrite", async (store) => {
      for (const id of ids) {
        await requestResult(store.delete(id));
      }
    });
  },

  async count(fileId) {
    const db = await openDb();
    if (!db) return 0;
    return runInTransaction("readonly", async (store) => {
      if (fileId) {
        const all = (await requestResult(store.getAll())) as QueuedSave[];
        return all.filter((record) => record.fileId === fileId).length;
      }
      return requestResult(store.count());
    });
  },

  async clear() {
    const db = await openDb();
    if (!db) return;
    await runInTransaction("readwrite", async (store) => {
      await requestResult(store.clear());
    });
  },
};