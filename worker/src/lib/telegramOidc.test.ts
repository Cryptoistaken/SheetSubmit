import { describe, it, expect, beforeEach } from "vitest";
import { verifyTelegramIdToken, setJwksCache, clearJwksCache } from "./telegramOidc";

function b64url(v: string) { return btoa(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64urlJson(o: unknown) { return b64url(JSON.stringify(o)); }

async function makeToken(payload: Record<string, unknown>, kid = "test") {
  const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk: any = await crypto.subtle.exportKey("jwk", kp.publicKey);
  setJwksCache([{ kty: "RSA", kid, n: jwk.n, e: jwk.e, alg: "RS256" }]);
  const header = { alg: "RS256", kid, typ: "JWT" };
  const hB64 = b64urlJson(header);
  const pB64 = b64urlJson(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, new TextEncoder().encode(`${hB64}.${pB64}`));
  const sB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${hB64}.${pB64}.${sB64}`;
}

describe("telegramOidc", () => {
  beforeEach(() => clearJwksCache());
  it("verifies valid token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await makeToken({ iss: "https://oauth.telegram.org", aud: "cid123", sub: "123456789", exp: now + 3600, iat: now, name: "Test User" });
    const r = await verifyTelegramIdToken(tok, "cid123");
    expect(r.uid).toBe("123456789");
    expect(r.name).toBe("Test User");
  });
  it("rejects wrong iss", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await makeToken({ iss: "https://evil.com", aud: "cid123", sub: "123", exp: now + 3600, iat: now });
    await expect(verifyTelegramIdToken(tok, "cid123")).rejects.toThrow(/iss/);
  });
  it("rejects wrong aud", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await makeToken({ iss: "https://oauth.telegram.org", aud: "other", sub: "123", exp: now + 3600, iat: now });
    await expect(verifyTelegramIdToken(tok, "cid123")).rejects.toThrow(/aud/);
  });
  it("rejects expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tok = await makeToken({ iss: "https://oauth.telegram.org", aud: "cid123", sub: "123", exp: now - 10, iat: now - 100 });
    await expect(verifyTelegramIdToken(tok, "cid123")).rejects.toThrow(/expired/);
  });
});
