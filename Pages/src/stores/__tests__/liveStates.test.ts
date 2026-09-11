import { describe, expect, it, mock } from "bun:test";

// Store seam (slice 3): applyLiveStates patches overlay flags by pool key
// through the real store. Cells, order and unrelated rows must survive.
// The empty api mock exists only so the store module loads under bun
// (api.ts touches window at import); the merge path never calls it.
mock.module("@/lib/api", () => ({ api: {} }));
const _lsStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => _lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => { _lsStore.set(k, String(v)); },
  removeItem: (k: string) => { _lsStore.delete(k); },
  clear: () => { _lsStore.clear(); },
};

const { useSheetStore } = await import("../sheetStore");
function seedRows() {
  useSheetStore.setState({
    rows: [
      { cookies: "c_user=11;", uid: "11", twofakey: "KEYA" } as never,
      { cookies: "c_user=22;", uid: "22", twofakey: "" } as never,
      { cookies: "", uid: "", twofakey: "" } as never,
    ],
  });
}

describe("applyLiveStates", () => {
  it("patches flags by pool key without touching cells", () => {
    seedRows();
    useSheetStore.getState().applyLiveStates({ "11": { hold: true }, "22": { dead: true } });
    const rows = useSheetStore.getState().rows as Array<Record<string, unknown>>;
    expect(rows[0]._hold).toBe(true);
    expect(rows[0].cookies).toBe("c_user=11;");
    expect(rows[0].twofakey).toBe("KEYA");
    expect(rows[1]._dead).toBe(true);
    expect(rows[1].uid).toBe("22");
  });

  it("clears flags explicitly and ignores unknown keys and keyless rows", () => {
    seedRows();
    useSheetStore.getState().applyLiveStates({ "11": { hold: true } });
    useSheetStore.getState().applyLiveStates({ "11": {}, "99": { dead: true } });
    const rows = useSheetStore.getState().rows as Array<Record<string, unknown>>;
    expect(rows[0]._hold ?? false).toBe(false);
    expect(rows[0]._approved ?? false).toBe(false);
    expect(rows[0]._dead ?? false).toBe(false);
    expect(rows.length).toBe(3);
    expect(rows[2].twofakey).toBe("");
  });

  it("matches rows by c_user when uid is empty", () => {
    useSheetStore.setState({
      rows: [{ cookies: "xs=1; c_user=33;", uid: "", twofakey: "" } as never],
    });
    useSheetStore.getState().applyLiveStates({ "33": { approved: true } });
    const rows = useSheetStore.getState().rows as Array<Record<string, unknown>>;
    expect(rows[0]._approved).toBe(true);
  });
});
