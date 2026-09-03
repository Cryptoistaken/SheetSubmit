import { api, type AppendPayload } from "@/lib/api";
import { fileTypeDef, type Row } from "@/lib/types";
import { offlineDb, type OfflineDb, type QueuedSave, type QueuedSaveKind } from "./db";

export interface SyncApi {
  append(id: string, payload: unknown, opts?: { keepalive?: boolean }): Promise<{ ok: boolean; seq: number }>;
  persist(id: string, payload: unknown, opts?: { keepalive?: boolean }): Promise<{ ok: boolean; seq?: number }>;
  getFileFull(id: string): Promise<{ file: { id: string; type: string }; rows: Row[]; logs: unknown[]; undo: unknown[]; redo: unknown[]; seq?: number }>;
}

export interface OfflineSync {
  isOnline(): boolean;
  subscribe(fn: () => void): () => void;
  pendingCount(fileId?: string): Promise<number>;
  queueSave(save: { fileId: string; kind: QueuedSaveKind; payload: unknown }): Promise<void>;
  flush(fileId?: string): Promise<{ flushed: number; failed: number }>;
}

const listeners = new Set<() => void>();

function notifyListeners() {
  for (const fn of listeners) fn();
}

function isOnline(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return true;
  return navigator.onLine;
}

export function createOfflineSync(deps: { db: OfflineDb; api: SyncApi }): OfflineSync {
  let flushing = false;

  async function mergeAndPersist(record: QueuedSave) {
    const fresh = await deps.api.getFileFull(record.fileId);
    const rows: Row[] = fresh.rows ?? [];
    const payload = record.payload as AppendPayload;
    for (const op of payload.ops ?? []) {
      if (rows[op.rowIdx] === undefined) continue;
      rows[op.rowIdx] = { ...rows[op.rowIdx], ...op.cols };
    }
    const columns = fileTypeDef(fresh.file.type).columns;
    const dataCount = rows.filter((row) => columns.some((c) => row[c.key])).length;
    await deps.api.persist(record.fileId, { rows, logs: [], undo: [], redo: [], dataCount });
  }

  return {
    isOnline() {
      return isOnline();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    pendingCount(fileId) {
      return deps.db.count(fileId).catch(() => 0);
    },

    async queueSave(save) {
      await deps.db.enqueue(save);
    },

    async flush(fileId) {
      if (!(await deps.db.available())) return { flushed: 0, failed: 0 };
      if (flushing) return { flushed: 0, failed: 0 };
      flushing = true;
      try {
        const records = await deps.db.list(fileId);
        let flushed = 0;
        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          try {
            if (record.kind === "append") {
              try {
                await deps.api.append(record.fileId, record.payload);
              } catch (err) {
                if (err instanceof Error && err.message.startsWith("409")) {
                  await mergeAndPersist(record);
                } else {
                  throw err;
                }
              }
            } else {
              await deps.api.persist(record.fileId, record.payload);
            }
            await deps.db.remove([record.id]);
            flushed++;
          } catch {
            return { flushed, failed: records.length - i };
          }
        }
        return { flushed, failed: 0 };
      } finally {
        flushing = false;
      }
    },
  };
}

export const offlineSync = createOfflineSync({ db: offlineDb, api });

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    notifyListeners();
    void offlineSync.flush();
  });
  window.addEventListener("offline", () => notifyListeners());
}