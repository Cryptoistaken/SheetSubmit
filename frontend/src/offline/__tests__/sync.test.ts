import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { OfflineDb, QueuedSave, QueuedSaveKind } from "@/offline/db";
import type { OfflineSync, SyncApi } from "@/offline/sync";

// sync.ts imports @/lib/api, which reads `window.APP_CONFIG` at module load, and
// registers online/offline listeners on `window`. Bun has no `window`, so provide
// a minimal stub before importing the module so the real sync code can run.
interface WindowStub {
  APP_CONFIG: { apiBase?: string };
  handlers: Record<string, Array<() => void>>;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
}

const win: WindowStub = {
  APP_CONFIG: {},
  handlers: {},
  addEventListener(type, fn) {
    (this.handlers[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    this.handlers[type] = (this.handlers[type] ?? []).filter((h) => h !== fn);
  },
};
(globalThis as Record<string, unknown>).window = win;

const { createOfflineSync } = await import("@/offline/sync");

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { configurable: true, value });
}

class FakeDb implements OfflineDb {
  records = new Map<number, QueuedSave>();
  private nextId = 1;
  unavailable = false;

  async enqueue(save: { fileId: string; kind: QueuedSaveKind; payload: unknown }): Promise<QueuedSave> {
    const id = this.nextId++;
    const record: QueuedSave = {
      id,
      fileId: save.fileId,
      kind: save.kind,
      payload: save.payload,
      ts: Date.now(),
    };
    this.records.set(id, record);
    return record;
  }

  async list(fileId?: string): Promise<QueuedSave[]> {
    const all = [...this.records.values()];
    const rows = fileId ? all.filter((r) => r.fileId === fileId) : all;
    return rows.sort((a, b) => a.id - b.id);
  }

  async remove(ids: number[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async count(fileId?: string): Promise<number> {
    return fileId
      ? [...this.records.values()].filter((r) => r.fileId === fileId).length
      : this.records.size;
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  async available(): Promise<boolean> {
    return !this.unavailable;
  }
}

class FakeApi implements SyncApi {
  appendCalls: Array<{ id: string; payload: unknown }> = [];
  persistCalls: Array<{ id: string; payload: unknown }> = [];
  getFileFullCalls = 0;
  appendImpl: (id: string, payload: unknown) => Promise<{ ok: boolean; seq: number }> = async () => ({
    ok: true,
    seq: 0,
  });
  persistImpl: (id: string, payload: unknown) => Promise<{ ok: boolean; seq?: number }> = async () => ({
    ok: true,
  });
  full = {
    file: { id: "f1", type: "fb_cookie" },
    rows: [{ cookies: "", uid: "", twofakey: "" }],
    logs: [],
    undo: [],
    redo: [],
    seq: 0,
  };

  async append(id: string, payload: unknown) {
    this.appendCalls.push({ id, payload });
    return this.appendImpl(id, payload);
  }

  async persist(id: string, payload: unknown) {
    this.persistCalls.push({ id, payload });
    return this.persistImpl(id, payload);
  }

  async getFileFull(id: string) {
    this.getFileFullCalls++;
    return { ...this.full, file: { ...this.full.file, id } };
  }
}

let db: FakeDb;
let api: FakeApi;
let sync: OfflineSync;

beforeEach(() => {
  db = new FakeDb();
  api = new FakeApi();
  sync = createOfflineSync({ db, api });
});

describe("offline sync", () => {
  it("queueSave enqueues and pendingCount reflects the queued items", async () => {
    await sync.queueSave({ fileId: "f1", kind: "append", payload: { base: 0, ops: [] } });
    await sync.queueSave({ fileId: "f1", kind: "append", payload: { base: 1, ops: [] } });
    await sync.queueSave({ fileId: "f2", kind: "persist", payload: { rows: [] } });

    expect(await sync.pendingCount()).toBe(3);
    expect(await sync.pendingCount("f1")).toBe(2);
    expect(await sync.pendingCount("f2")).toBe(1);
  });

  it("flush drains oldest-first and empties the queue", async () => {
    await sync.queueSave({
      fileId: "f1",
      kind: "append",
      payload: { base: 0, ops: [{ rowIdx: 0, cols: { uid: "111" } }] },
    });
    await sync.queueSave({
      fileId: "f1",
      kind: "append",
      payload: { base: 0, ops: [{ rowIdx: 0, cols: { uid: "222" } }] },
    });

    const res = await sync.flush();

    expect(api.appendCalls.length).toBe(2);
    expect(api.appendCalls[0].payload).toMatchObject({ ops: [{ rowIdx: 0, cols: { uid: "111" } }] });
    expect(api.appendCalls[1].payload).toMatchObject({ ops: [{ rowIdx: 0, cols: { uid: "222" } }] });
    expect(res).toEqual({ flushed: 2, failed: 0 });
    expect(await db.count()).toBe(0);
  });

  it("409 conflict refetches, merges ops onto fresh rows, persists and removes the record", async () => {
    api.full = {
      file: { id: "f1", type: "fb_cookie" },
      rows: [{ cookies: "c_user=5;", uid: "server", twofakey: "" }],
      logs: [],
      undo: [],
      redo: [],
      seq: 4,
    };
    api.appendImpl = async () => {
      throw new Error("409 Conflict — version conflict");
    };
    await sync.queueSave({
      fileId: "f1",
      kind: "append",
      payload: { base: 0, ops: [{ rowIdx: 0, cols: { uid: "111" } }] },
    });

    const res = await sync.flush();

    expect(api.appendCalls.length).toBe(1);
    expect(api.getFileFullCalls).toBe(1);
    expect(api.persistCalls.length).toBe(1);
    const payload = api.persistCalls[0].payload as {
      rows: Array<Record<string, string>>;
      dataCount: number;
    };
    expect(payload.rows).toEqual([{ cookies: "c_user=5;", uid: "111", twofakey: "" }]);
    expect(payload.dataCount).toBe(1);
    expect(res).toEqual({ flushed: 1, failed: 0 });
    expect(await db.count()).toBe(0);
  });

  it("network error aborts flush, keeps the rest queued and counts them failed", async () => {
    api.appendImpl = async () => {
      throw new TypeError("fetch failed");
    };
    await sync.queueSave({ fileId: "f1", kind: "append", payload: { base: 0, ops: [] } });
    await sync.queueSave({ fileId: "f1", kind: "append", payload: { base: 1, ops: [] } });

    const res = await sync.flush();

    expect(api.appendCalls.length).toBe(1);
    expect(res).toEqual({ flushed: 0, failed: 2 });
    expect(await db.count()).toBe(2);
  });

  it("persist kind saves go straight to api.persist", async () => {
    await sync.queueSave({ fileId: "f1", kind: "persist", payload: { rows: [{ uid: "1" }] } });

    const res = await sync.flush();

    expect(api.persistCalls.length).toBe(1);
    expect(api.persistCalls[0].id).toBe("f1");
    expect(api.appendCalls.length).toBe(0);
    expect(res).toEqual({ flushed: 1, failed: 0 });
    expect(await db.count()).toBe(0);
  });

  it("flush is a no-op when the db is unavailable", async () => {
    db.unavailable = true;
    await sync.queueSave({ fileId: "f1", kind: "append", payload: { base: 0, ops: [] } });

    expect(await sync.flush()).toEqual({ flushed: 0, failed: 0 });
    expect(await db.count()).toBe(1);
  });

  it("subscribe fires on offline/online transitions and unsubscribes cleanly", async () => {
    setOnLine(true);
    const spy = mock(() => {});
    const unsub = sync.subscribe(spy);
    const fire = (type: "online" | "offline") => {
      for (const handler of win.handlers[type] ?? []) handler();
    };

    setOnLine(false);
    fire("offline");
    expect(spy).toHaveBeenCalledTimes(1);

    setOnLine(true);
    fire("online");
    expect(spy).toHaveBeenCalledTimes(2);

    unsub();
    fire("offline");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});