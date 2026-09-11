import { afterEach, describe, expect, it, mock } from "bun:test";

// filetypes seam: cell validation, TOTP codes, fb-cookie behavior, file
// classification. fbcookie.ts imports the real `@/lib/api` (which touches
// `window` at load), so the network boundary is stubbed before import — the
// same pattern as the sheetStore suite. Time is stubbed per-test for TOTP:
// expected codes are RFC 6238 SHA-1 vectors, not recomputed values.
const fbCheckResults: { valid: string[]; dead: string[]; uncertain: string[] } = {
  valid: [],
  dead: [],
  uncertain: [],
};

mock.module("@/lib/api", () => ({
  api: {
    fbCheck: async () => ({ ...fbCheckResults }),
    getWaCache: async () => ({ cache: {} }),
  },
}));

const { validateCell } = await import("../validation");
const { getCachedTOTP } = await import("../totp");
const { isPageFile, getFileBehavior } = await import("../index");
const { createFbCookieBehavior } = await import("../fbcookie");

const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  fbCheckResults.valid = [];
  fbCheckResults.dead = [];
  fbCheckResults.uncertain = [];
});

const COLS = [
  { key: "cookies", label: "cookies", width: 340 },
  { key: "twofakey", label: "2fa key", width: 200 },
  { key: "uid", label: "uid", width: 120 },
];

function ctx(over: Record<string, unknown> = {}) {
  return {
    rows: [{ cookies: "", twofakey: "", uid: "" }],
    rowIdx: 0,
    colKey: "cookies",
    value: "",
    invalidCells: new Set<string>(),
    showToast: (_msg: string) => {},
    ...over,
  } as Parameters<ReturnType<typeof createFbCookieBehavior>["onCellChange"]>[0];
}

describe("validateCell", () => {
  it("accepts empty values in every column", () => {
    for (const col of ["cookies", "twofakey", "uid", "status"]) {
      expect(validateCell(col, "").valid).toBe(true);
    }
  });

  it("requires c_user=ID inside cookies", () => {
    expect(validateCell("cookies", "xs=1; datr=abc").valid).toBe(false);
    expect(validateCell("cookies", "xs=1; datr=abc").msg).toContain("c_user");
    expect(validateCell("cookies", "c_user=123; xs=1").valid).toBe(true);
  });

  it("accepts the No_2Fa skip marker as a valid key", () => {
    expect(validateCell("twofakey", "No_2Fa").valid).toBe(true);
  });

  it("rejects short keys", () => {
    const r = validateCell("twofakey", "ABCD2345");
    expect(r.valid).toBe(false);
    expect(r.msg).toContain("short");
  });

  it("rejects non-base32 keys", () => {
    const r = validateCell("twofakey", "NOT!VALID!KEY!!!");
    expect(r.valid).toBe(false);
    expect(r.msg).toContain("base32");
  });

  it("normalizes spaces, dashes and lowercase before validating", () => {
    expect(validateCell("twofakey", "abcd 2345-efgh 6723").valid).toBe(true);
  });

  it("requires digits-only UIDs", () => {
    expect(validateCell("uid", "123456").valid).toBe(true);
    const r = validateCell("uid", "12ab34");
    expect(r.valid).toBe(false);
    expect(r.msg).toContain("digits");
  });

  it("passes unknown columns through", () => {
    expect(validateCell("wa_status", "anything").valid).toBe(true);
  });
});

describe("getCachedTOTP", () => {
  // Secret is base32("12345678901234567890"); vectors from RFC 6238 §B.
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it("returns null for an empty secret", async () => {
    expect(await getCachedTOTP("")).toBeNull();
  });

  it("matches the RFC 6238 vector at t=59s", async () => {
    Date.now = () => 59_000;
    expect(await getCachedTOTP(SECRET)).toEqual({ code: "287082" });
  });

  it("matches the RFC 6238 vector at t=1111111109s (leading zero kept)", async () => {
    Date.now = () => 1_111_111_109_000;
    expect(await getCachedTOTP(SECRET)).toEqual({ code: "081804" });
  });

  it("rolls the code in the next 30s step", async () => {
    Date.now = () => 59_000;
    const first = await getCachedTOTP(SECRET + "A");
    Date.now = () => 89_000;
    const second = await getCachedTOTP(SECRET + "A");
    expect(first?.code).toBe("287082");
    expect(second?.code).not.toBe(first?.code);
  });
});

describe("isPageFile", () => {
  const twoFaCols = COLS;
  const noTwoFaCols = COLS.filter((c) => c.key !== "twofakey");

  it("rejects null files", () => {
    expect(isPageFile(null)).toBe(false);
    expect(isPageFile(undefined)).toBe(false);
  });

  it("matches explicit page preset / poolKind with a 2fa column", () => {
    expect(isPageFile({ id: "1", name: "x", type: "fb_cookie", preset: "page", columns: twoFaCols })).toBe(true);
    expect(isPageFile({ id: "1", name: "x", type: "fb_cookie", poolKind: "page", columns: twoFaCols })).toBe(true);
  });

  it("falls back to the Page* file name when no preset is set", () => {
    expect(isPageFile({ id: "1", name: "Page batch 3", type: "fb_cookie", columns: twoFaCols })).toBe(true);
  });

  it("rejects cookie/combo files even with a 2fa column", () => {
    expect(isPageFile({ id: "1", name: "Page batch 3", type: "fb_cookie", preset: "cookie", columns: twoFaCols })).toBe(false);
    expect(isPageFile({ id: "1", name: "cookies", type: "fb_cookie", preset: "combo", columns: twoFaCols })).toBe(false);
  });

  it("requires the 2fa column", () => {
    expect(isPageFile({ id: "1", name: "Page batch", type: "fb_cookie", preset: "page", columns: noTwoFaCols })).toBe(false);
  });
});

describe("getFileBehavior", () => {
  it("serves the fb_cookie behavior", () => {
    const b = getFileBehavior("fb_cookie");
    expect(b).toBeDefined();
    expect(typeof b?.onCellChange).toBe("function");
    expect(typeof b?.checkAccounts).toBe("function");
  });

  it("returns undefined for unknown types", () => {
    expect(getFileBehavior("nope")).toBeUndefined();
  });
});

describe("fb-cookie onCellChange", () => {
  const behavior = createFbCookieBehavior();

  it("flags invalid cookies and clears the flag once fixed", () => {
    const c = ctx({ value: "xs=1" });
    behavior.onCellChange(c);
    expect(c.invalidCells.has("0:cookies")).toBe(true);
    const c2 = ctx({ value: "c_user=7;", invalidCells: c.invalidCells });
    behavior.onCellChange(c2);
    expect(c2.invalidCells.has("0:cookies")).toBe(false);
  });

  it("autofills uid from pasted cookies, never overwrites a manual uid", () => {
    const c = ctx({ value: "c_user=4242; xs=1" });
    behavior.onCellChange(c);
    expect(c.rows[0].uid).toBe("4242");
    const c2 = ctx({ rows: [{ cookies: "c_user=1;", twofakey: "", uid: "manual" }], value: "c_user=1;" });
    behavior.onCellChange(c2);
    expect(c2.rows[0].uid).toBe("manual");
  });

  it("clears WA state when cookies lose their c_user", () => {
    const c = ctx({
      rows: [{ cookies: "xs=1", twofakey: "", uid: "", wa_status: "eligible", wa_ban_reason: "x", wa_page_name: "p", wa_linked_number: "n" }],
      value: "xs=1",
    });
    behavior.onCellChange(c);
    expect(c.rows[0].wa_status).toBe("");
    expect(c.rows[0].wa_page_name).toBeNull();
  });

  it("flags invalid 2fa keys in the invalid set", () => {
    const c = ctx({ colKey: "twofakey", value: "short" });
    behavior.onCellChange(c);
    expect(c.invalidCells.has("0:twofakey")).toBe(true);
  });
});

describe("fb-cookie dot actions", () => {
  const behavior = createFbCookieBehavior();

  it("onDotDoubleTap returns null without a key", async () => {
    expect(await behavior.onDotDoubleTap({ cookies: "c_user=1;" })).toBeNull();
  });

  it("onDotDoubleTap copies the live TOTP for the row key", async () => {
    Date.now = () => 59_000;
    const r = await behavior.onDotDoubleTap({
      cookies: "c_user=1;",
      twofakey: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    });
    expect(r).toEqual({ action: "totp_copied", code: "287082" });
  });

  it("onDotHold shows only the log matching the row identity", () => {
    const logs = [{ username: "1", at: 1 }, { username: "2", at: 2 }];
    const r = behavior.onDotHold({ cookies: "c_user=2;", uid: "2" }, logs);
    expect(r.action).toBe("show_logs");
    expect(r.label).toBe("2");
    expect(r.logs).toEqual([{ username: "2", at: 2 }]);
  });

  it("onDotHold yields no logs for an unknown identity", () => {
    const r = behavior.onDotHold({ cookies: "c_user=9;", uid: "9" }, [{ username: "1" }]);
    expect(r.logs).toEqual([]);
  });
});

describe("fb-cookie checkAccounts", () => {
  const behavior = createFbCookieBehavior();

  it("throws when no row carries an identity", async () => {
    await expect(behavior.checkAccounts([{ cookies: "", uid: "" }])).rejects.toThrow("No UIDs found");
  });

  it("marks rows good/bad/pending from the check verdict and reports counts", async () => {
    fbCheckResults.valid = ["1"];
    fbCheckResults.dead = ["2"];
    fbCheckResults.uncertain = ["3"];
    const rows = [
      { cookies: "c_user=1;", uid: "", status: "" },
      { cookies: "c_user=2;", uid: "", status: "", wa_status: "eligible", wa_ban_reason: "b", wa_page_name: "p", wa_linked_number: "n" },
      { cookies: "c_user=3;", uid: "", status: "" },
    ];
    const res = await behavior.checkAccounts(rows);
    expect(res).toEqual({ total: 3, valid: 1, dead: 1, uncertain: 1 });
    expect(rows[0].status).toBe("good");
    expect(rows[1].status).toBe("bad");
    expect(rows[1].wa_status).toBe("");
    expect(rows[2].status).toBe("pending");
  });

  it("fills missing uids from cookies before checking", async () => {
    fbCheckResults.valid = ["55"];
    const rows = [{ cookies: "c_user=55;", uid: "", status: "" }];
    await behavior.checkAccounts(rows);
    expect(rows[0].uid).toBe("55");
    expect(rows[0].status).toBe("good");
  });
});
