import { describe, expect, it } from "bun:test";

// Overlay-flag seam: a dead row inside an approved hold keeps its red color
// AND the approved line (consumed unpaid) — dead must ride along instead of
// shadowing the other flags. Pure, runs everywhere.
import { applyHoldFlags } from "../files";

describe("applyHoldFlags", () => {
  it("sets dead alongside approved", () => {
    const row: Record<string, unknown> = {};
    applyHoldFlags(row as never, { hold: false, approved: true, dead: true });
    expect(row).toEqual({ _dead: true, _approved: true });
  });

  it("prefers hold over approved", () => {
    const row: Record<string, unknown> = {};
    applyHoldFlags(row as never, { hold: true, approved: true, dead: false });
    expect(row).toEqual({ _hold: true });
  });

  it("sets single flags", () => {
    const row: Record<string, unknown> = {};
    applyHoldFlags(row as never, { hold: true, approved: false, dead: false });
    expect(row).toEqual({ _hold: true });
  });

  it("leaves rows alone without state", () => {
    const row: Record<string, unknown> = { uid: "1" };
    applyHoldFlags(row as never, undefined);
    applyHoldFlags(row as never, { hold: false, approved: false, dead: false });
    expect(row).toEqual({ uid: "1" });
  });
});
