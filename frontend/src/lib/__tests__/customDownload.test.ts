import { describe, expect, it, mock } from "bun:test";

// xlsx.ts imports `@/lib/api` (for hydrateWaCache). Mock it before importing so
// nothing touches `window.APP_CONFIG`.
mock.module("@/lib/api", () => ({
  api: {},
}));

const { buildCustomRows } = await import("../xlsx");

describe("buildCustomRows", () => {
  const rows = [
    { uid: "1", cookies: "c_user=1;", twofakey: "key1", status: "good" },
    { uid: "2", cookies: "c_user=2;", twofakey: "", status: "good" },
    { uid: "3", cookies: "c_user=3;", twofakey: "key3", status: "bad" },
    { uid: "4", cookies: "c_user=4;", twofakey: "No_2Fa", status: "good" },
  ];

  it("exports uid, password, cookies, 2fakey — no header", () => {
    const data = buildCustomRows(rows, "mypw");
    expect(data).toEqual([
      ["1", "mypw", "c_user=1;", "key1"],
      ["2", "mypw", "c_user=2;", ""],
      ["3", "mypw", "c_user=3;", "key3"],
      ["4", "mypw", "c_user=4;", ""],
    ]);
  });

  it("applies the filter and keeps only-cookie rows with an empty 2fa cell", () => {
    const data = buildCustomRows(rows, "mypw", (r) => r.status === "good");
    expect(data).toEqual([
      ["1", "mypw", "c_user=1;", "key1"],
      ["2", "mypw", "c_user=2;", ""],
      ["4", "mypw", "c_user=4;", ""],
    ]);
  });

  it("combo filter keeps only good rows with cookie and 2fa", () => {
    const data = buildCustomRows(rows, "mypw", (r) => !!(r.status === "good" && r.cookies && r.twofakey));
    expect(data).toEqual([
      ["1", "mypw", "c_user=1;", "key1"],
      ["4", "mypw", "c_user=4;", ""],
    ]);
  });

  it("strips the No_2Fa bubble marker", () => {
    const data = buildCustomRows(rows, "mypw", (r) => r.status === "good" && !!r.twofakey);
    expect(data).toEqual([
      ["1", "mypw", "c_user=1;", "key1"],
      ["4", "mypw", "c_user=4;", ""],
    ]);
  });
});