import { describe, expect, it } from "bun:test";

// Auth-session seam: HMAC sign/verify round-trip through real crypto.subtle
// (no mocks — the vectors are behavior: tampered/expired/foreign tokens must
// fail closed), plus the cookie string and admin allowlist.
import { signSession, verifySession, cookie, isAdmin } from "../session";
import type { Env } from "../shared";

const SECRET = "test-secret-for-suite-only";

describe("signSession / verifySession", () => {
  it("round-trips a uid", async () => {
    const token = await signSession("u1", SECRET);
    expect(token.split(".").length).toBe(2);
    expect(await verifySession(token, SECRET)).toEqual({ uid: "u1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await signSession("u1", SECRET);
    expect(await verifySession(token, "other-secret")).toBeNull();
  });

  it("rejects a tampered body", async () => {
    const token = await signSession("u1", SECRET);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: Date.now() + 999999 })).toString("base64url");
    expect(await verifySession(`${forged}.${sig}`, SECRET)).toBeNull();
    expect(body.length).toBeGreaterThan(0);
  });

  it("rejects malformed tokens", async () => {
    expect(await verifySession("", SECRET)).toBeNull();
    expect(await verifySession("nodot", SECRET)).toBeNull();
    expect(await verifySession("a.b.c", SECRET)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const realNow = Date.now;
    try {
      Date.now = () => 1_000_000;
      const token = await signSession("u1", SECRET);
      Date.now = () => 1_000_000 + 31 * 86_400_000;
      expect(await verifySession(token, SECRET)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  it("fails closed without a secret", async () => {
    await expect(signSession("u1", "")).rejects.toThrow("SESSION_SECRET missing");
    await expect(verifySession("a.b", "")).rejects.toThrow("SESSION_SECRET missing");
  });
});

describe("cookie", () => {
  it("emits a Secure SameSite=None cookie by default", () => {
    const c = cookie("tok");
    expect(c).toContain("ss_session=tok");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=None");
    expect(c).toContain("Max-Age=2592000");
  });

  it("emits a Lax cookie without Secure for http", () => {
    const c = cookie("tok", 60, false);
    expect(c).toContain("SameSite=Lax");
    expect(c).not.toContain("Secure");
    expect(c).toContain("Max-Age=60");
  });
});

describe("isAdmin", () => {
  const env = (ids?: string) => ({ ADMIN_IDS: ids }) as Env;

  it("matches members of a comma-separated allowlist, trimming spaces", () => {
    expect(isAdmin(env("a1, b2"), "b2")).toBe(true);
    expect(isAdmin(env("a1, b2"), "c3")).toBe(false);
  });

  it("denies everyone when the allowlist is missing", () => {
    expect(isAdmin(env(undefined), "a1")).toBe(false);
    expect(isAdmin(env(""), "a1")).toBe(false);
  });
});
