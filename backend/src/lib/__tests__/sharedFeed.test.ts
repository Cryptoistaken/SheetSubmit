import { describe, expect, it } from "bun:test";

// Pool-identity seam (shared.ts): which row the pool sees (poolRowKey) and
// what counts as a pool-relevant change (poolFeedSig). selectFeedRows,
// pushSnapshot and isPersistConflict are covered from the Pages rowguard
// suite; this file covers the two predicates it builds on.
import { poolRowKey, poolFeedSig } from "../shared";

describe("poolRowKey", () => {
  it("prefers the uid column", () => {
    expect(poolRowKey({ uid: "123", cookies: "c_user=999;" })).toBe("123");
  });

  it("falls back to c_user inside cookies", () => {
    expect(poolRowKey({ uid: "", cookies: "xs=1; c_user=456; datr=z" })).toBe("456");
  });

  it("is empty when the row has no identity", () => {
    expect(poolRowKey({ uid: "", cookies: "xs=1" })).toBe("");
    expect(poolRowKey({})).toBe("");
  });
});

describe("poolFeedSig", () => {
  const row = { cookies: "c_user=1;", twofakey: "K", uid: "1", check_status: "", status: "good" };

  it("is stable for identical content", () => {
    expect(poolFeedSig({ ...row })).toBe(poolFeedSig({ ...row }));
  });

  it("changes on any pool-relevant field", () => {
    const base = poolFeedSig(row);
    expect(poolFeedSig({ ...row, cookies: "c_user=1; x=2" })).not.toBe(base);
    expect(poolFeedSig({ ...row, twofakey: "OTHER" })).not.toBe(base);
    expect(poolFeedSig({ ...row, uid: "2" })).not.toBe(base);
    expect(poolFeedSig({ ...row, check_status: "eligible" })).not.toBe(base);
    expect(poolFeedSig({ ...row, status: "bad" })).not.toBe(base);
  });

  it("ignores pool-irrelevant columns and null/empty equivalence", () => {
    const base = poolFeedSig(row);
    expect(poolFeedSig({ ...row, extra_col: "whatever" })).toBe(base);
    expect(poolFeedSig({ cookies: "c_user=1;", twofakey: "K", uid: "1" })).toBe(
      poolFeedSig({ cookies: "c_user=1;", twofakey: "K", uid: "1", check_status: null, status: undefined }),
    );
  });
});
