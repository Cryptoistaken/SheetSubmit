// Tests for updateUserFilesAtomic (backend/src/services/files.ts): WATCH/MULTI
// optimistic locking — normal update, not-found, conflict-retry without lost
// updates, and per-user isolation. The real redis module is replaced by the
// in-memory fake; setBeforeExec simulates a concurrent writer mid-transaction.
import { describe, expect, test, beforeEach } from "bun:test";
import { installRedisMock, resetStore, setBeforeExec, fakeSet } from "./redis-mock";
import type { StoredFile } from "../src/lib/shared";

installRedisMock();

const { updateUserFilesAtomic } = await import("../src/services/files");
const { key, getJSON } = await import("../src/services/redis");

const fileA = { id: "a", name: "A", type: "fb_cookie", createdAt: 1, updatedAt: 1, rowCount: 0, columns: null };
const fileB = { id: "b", name: "B", type: "fb_cookie", createdAt: 2, updatedAt: 2, rowCount: 0, columns: null };
const fileC = { id: "c", name: "C", type: "fb_cookie", createdAt: 3, updatedAt: 3, rowCount: 0, columns: null };
const fileD = { id: "d", name: "D", type: "fb_cookie", createdAt: 4, updatedAt: 4, rowCount: 0, columns: null };
const concurrentFile = { id: "z", name: "Z", type: "fb_cookie", createdAt: 5, updatedAt: 5, rowCount: 0, columns: null };

const ids = (files: StoredFile[]) => files.map((f) => f.id);

describe("updateUserFilesAtomic", () => {
  beforeEach(() => {
    resetStore();
  });

  test("basic update: mutator's result is returned and the list is persisted", async () => {
    fakeSet(key("files:user1"), JSON.stringify([fileA]));

    const result = await updateUserFilesAtomic("user1", (files) => {
      files.push(fileB);
      return "added";
    });

    expect(result).toBe("added");
    expect(ids((await getJSON<StoredFile[]>("files:user1"))!)).toEqual(["a", "b"]);
  });

  test("not found: mutator returns null -> helper returns null, stored list unchanged", async () => {
    fakeSet(key("files:user1"), JSON.stringify([fileA]));

    const result = await updateUserFilesAtomic("user1", (files) =>
      files.find((f) => f.id === "missing") ? "found" : null,
    );

    expect(result).toBeNull();
    expect(await getJSON<StoredFile[]>("files:user1")).toEqual([fileA]);
  });

  test("conflict retry: concurrent writer is not lost, mutator applies on top", async () => {
    fakeSet(key("files:user1"), JSON.stringify([fileA]));
    let injected = false;
    setBeforeExec(() => {
      if (!injected) {
        injected = true;
        fakeSet(key("files:user1"), JSON.stringify([fileA, concurrentFile]));
      }
    });

    const result = await updateUserFilesAtomic("user1", (files) => {
      files.push(fileB);
      return "mutated";
    });

    expect(injected).toBe(true);
    expect(result).toBe("mutated");
    const stored = (await getJSON<StoredFile[]>("files:user1"))!;
    expect(ids(stored)).toEqual(["a", "z", "b"]);
    expect(stored.find((f) => f.id === "z")).toEqual(concurrentFile);
    expect(stored.find((f) => f.id === "b")).toEqual(fileB);
  });

  test("multiple files: one user's list does not affect another's", async () => {
    fakeSet(key("files:user1"), JSON.stringify([fileA]));
    fakeSet(key("files:user2"), JSON.stringify([fileC]));

    const r1 = await updateUserFilesAtomic("user1", (files) => {
      files.push(fileB);
      return "ok1";
    });
    const r2 = await updateUserFilesAtomic("user2", (files) => {
      files.push(fileD);
      return "ok2";
    });

    expect(r1).toBe("ok1");
    expect(r2).toBe("ok2");
    expect(ids((await getJSON<StoredFile[]>("files:user1"))!)).toEqual(["a", "b"]);
    expect(ids((await getJSON<StoredFile[]>("files:user2"))!)).toEqual(["c", "d"]);
  });
});