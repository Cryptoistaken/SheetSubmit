type Jwk = { kty: string; kid?: string; n?: string; e?: string; alg?: string; use?: string };

let jwksCache: { keys: Jwk[]; exp: number } | null = null;
const JWKS_TTL = 3600_000;
const ISS = "https://oauth.telegram.org";
const JWKS_URLS = ["https://oauth.telegram.org/.well-known/jwks.json", "https://oauth.telegram.org/.well-known/openid-configuration"];

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(s)));
}

async function fetchJwks(): Promise<Jwk[]> {
  if (jwksCache && jwksCache.exp > Date.now()) return jwksCache.keys;
  let keys: Jwk[] | null = null;
  for (const url of JWKS_URLS) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const j: any = await r.json();
      if (Array.isArray(j.keys)) { keys = j.keys; break; }
      if (j.jwks_uri) {
        const r2 = await fetch(j.jwks_uri, { signal: AbortSignal.timeout(8000) });
        if (!r2.ok) continue;
        const j2: any = await r2.json();
        if (Array.isArray(j2.keys)) { keys = j2.keys; break; }
      }
    } catch {}
  }
  if (!keys) throw new Error("jwks unavailable");
  jwksCache = { keys, exp: Date.now() + JWKS_TTL };
  return keys;
}

async function verifyRs256(token: string, jwks: Jwk[]): Promise<{ header: any; payload: any }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [hB64, pB64, sB64] = parts;
  const header = b64urlJson(hB64);
  const payload = b64urlJson(pB64);
  if (header.alg !== "RS256") throw new Error("unsupported alg");
  const sig = b64urlDecode(sB64);
  const signingInput = new TextEncoder().encode(`${hB64}.${pB64}`);
  const ordered = header.kid ? [...jwks.filter((k) => k.kid === header.kid), ...jwks.filter((k) => k.kid !== header.kid)] : jwks;
  const seen = new Set<string>();
  const uniq: Jwk[] = [];
  for (const k of ordered) { const id = k.kid || `${k.n}:${k.e}`; if (!seen.has(id)) { seen.add(id); uniq.push(k); } }
  let ok = false;
  for (const jwk of uniq) {
    if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) continue;
    try {
      const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true } as any, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
      if (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, signingInput)) { ok = true; break; }
    } catch {}
  }
  if (!ok) throw new Error("invalid signature");
  return { header, payload };
}

export async function verifyTelegramIdToken(idToken: string, clientId: string): Promise<{ uid: string; name: string; username: string; picture: string; phone: string }> {
  if (!idToken || typeof idToken !== "string" || idToken.length > 8192) throw new Error("invalid token");
  const jwks = await fetchJwks();
  const { payload } = await verifyRs256(idToken, jwks);
  const now = Math.floor(Date.now() / 1000);
  const iss = String(payload.iss || "");
  if (iss !== ISS && iss !== ISS + "/") throw new Error("invalid iss");
  const aud = payload.aud;
  const audOk = typeof aud === "string" ? aud === clientId : Array.isArray(aud) ? aud.some((value) => String(value) === clientId) : String(aud) === clientId;
  if (!audOk) throw new Error("invalid aud");
  const exp = Number(payload.exp);
  const iat = Number(payload.iat);
  if (!Number.isFinite(exp) || exp <= now) throw new Error("token expired");
  if (!Number.isFinite(iat) || iat > now + 60) throw new Error("invalid iat");
  if (exp - iat > 86400) throw new Error("exp too far");
  const sub = String(payload.sub || payload.id || payload.user_id || payload.telegram_id || "");
  if (!/^\d{3,20}$/.test(sub)) throw new Error("invalid sub");
  const username = String(payload.preferred_username || payload.username || payload.tg_username || "");
  const name = String(payload.name || [payload.given_name, payload.family_name].filter(Boolean).join(" ") || payload.nickname || username || sub);
  const pictureRaw = typeof payload.picture === "string" ? payload.picture : "";
  const picture = /^https:\/\/\S{1,500}$/.test(pictureRaw) ? pictureRaw : "";
  const phone = typeof payload.phone_number === "string" ? payload.phone_number.trim().slice(0, 32) : "";
  return { uid: sub, name: name.slice(0, 128), username: username.slice(0, 64), picture, phone };
}

export function clearJwksCache() { jwksCache = null; }
export function setJwksCache(keys: Jwk[]) { jwksCache = { keys, exp: Date.now() + JWKS_TTL }; }
