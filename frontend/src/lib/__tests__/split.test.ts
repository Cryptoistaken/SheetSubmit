import { describe, expect, it, mock } from "bun:test";
mock.module("@/lib/api", () => ({ api: {} }));
const { splitRows } = await import("../xlsx");

describe("splitRows", () => {
  it("splits evenly", () => {
    expect(splitRows([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });
  it("ceil division", () => {
    expect(splitRows([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(splitRows([1, 2, 3, 4, 5], 3)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("clamps N > len", () => {
    expect(splitRows([1, 2], 5)).toEqual([[1], [2]]);
  });
  it("N=1 returns single chunk", () => {
    expect(splitRows([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  });
  it("empty", () => {
    expect(splitRows([], 2)).toEqual([[]]);
  });
});
