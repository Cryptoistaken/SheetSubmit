import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkRate } from "../src/lib/rateLimit";
import { signSession, verifySession } from "../src/lib/session";

describe("session secret enforcement", () => {
  it("signSession throws without secret", async () => { await expect(signSession("123", "" as any)).rejects.toThrow(); });
  it("verifySession throws without secret", async () => { await expect(verifySession("a.b", "" as any)).rejects.toThrow(); });
  it("sign+verify roundtrip with secret", async () => {
    const tok = await signSession("999", "test-secret-12345");
    const v = await verifySession(tok, "test-secret-12345");
    expect(v?.uid).toBe("999");
  });
  it("verify fails with wrong secret", async () => {
    const tok = await signSession("999", "s1");
    const v = await verifySession(tok, "s2");
    expect(v).toBeNull();
  });
});

describe("rateLimit bounded", () => {
  it("allows under limit and blocks over", () => {
    const k = `test:${Date.now()}:${Math.random()}`;
    for (let i = 0; i < 5; i++) expect(checkRate(k, 5, 60000)).toBe(true);
    expect(checkRate(k, 5, 60000)).toBe(false);
  });
  it("respects window", async () => {
    const k = `win:${Date.now()}:${Math.random()}`;
    expect(checkRate(k, 1, 10)).toBe(true);
    expect(checkRate(k, 1, 10)).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(checkRate(k, 1, 10)).toBe(true);
  });
});

describe("CORS", () => {
  it("echoes allowed origin", async () => {
    const res = await SELF.fetch("http://example.com/api/health", { headers: { Origin: "https://sheetsubmit.pages.dev" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://sheetsubmit.pages.dev");
  });
  it("handles OPTIONS preflight", async () => {
    const res = await SELF.fetch("http://example.com/api/health", { method: "OPTIONS", headers: { Origin: "https://sheetsubmit.pages.dev" } });
    expect(res.status).toBe(204);
  });
  it("does not echo disallowed origin", async () => {
    const res = await SELF.fetch("http://example.com/api/health", { headers: { Origin: "https://evil.com" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
