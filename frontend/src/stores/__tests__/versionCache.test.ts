import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

// versionCache imports `dedupKeyForRow` from "@/stores/sheetStore", which pulls
// the whole store module (and its `@/lib/api` import). Mock `@/lib/api` before
// importing versionCache so nothing touches `window.APP_CONFIG`.
const state = {
  getVersionCalls: 0,
  fail: true,
  rows: [{ cookies: "c_user=9;", uid: "9", twofakey: "" }],
};

mock.module("@/lib/api", () => ({
  api: {
    getVersion: async (_id: string, v: number) => {
      state.getVersionCalls++;
      if (state.fail) throw new Error("network down");
      return { v, rows: state.rows, action: null, ts: null };
    },
    adminGetVersion: async () => {
      throw new Error("admin path not used in these tests");
    },
  },
}));

const { getVersionRows } = await import("../versionCache");

let origError: typeof console.error;
beforeEach(() => {
  state.getVersionCalls = 0;
  state.fail = true;
  origError = console.error;
  console.error = () => {}; // silence the store's catch-path logging
});
afterEach(() => {
  console.error = origError;
});

describe("versionCache", () => {
  it("failed version fetch is not cached", async () => {
    const r1 = await getVersionRows("f1", 3);
    expect(r1.ok).toBe(false);
    expect(r1.rows).toEqual([]);
    expect(r1.keys.size).toBe(0);
    expect(state.getVersionCalls).toBe(1);

    // Same (fileId, v) now succeeds — the earlier failure must not have
    // poisoned the cache, so it re-fetches and returns the real rows.
    state.fail = false;
    state.getVersionCalls = 0;
    const r2 = await getVersionRows("f1", 3);
    expect(r2.ok).toBe(true);
    expect(r2.rows).toEqual(state.rows);
    expect(r2.keys.has("9")).toBe(true);
    expect(state.getVersionCalls).toBe(1); // it did re-fetch, no poisoned hit
  });

  it("successful version fetch is cached (api invoked once)", async () => {
    state.fail = false;
    state.getVersionCalls = 0;

    const a = await getVersionRows("f2", 1);
    expect(a.ok).toBe(true);
    expect(state.getVersionCalls).toBe(1);

    const b = await getVersionRows("f2", 1);
    expect(b).toBe(a); // same cached object
    expect(b.rows).toEqual(state.rows);
    expect(state.getVersionCalls).toBe(1); // second call served from cache
  });
});