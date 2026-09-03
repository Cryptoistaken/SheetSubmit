const _totpCache = new Map<string, string>();

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function _generateTOTP(secret: string): Promise<string> {
  if (!secret) return Promise.resolve("");
  const normalized = secret.replace(/\s/g, "").toUpperCase();
  let bits = "";
  for (let i = 0; i < normalized.length; i++) {
    const val = ALPHABET.indexOf(normalized[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.substr(i * 8, 8), 2);
  }
  return crypto.subtle
    .importKey("raw", bytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
    .then((key) => {
      const epoch = Math.floor(Date.now() / 1000);
      const time = Math.floor(epoch / 30);
      const timeBytes = new ArrayBuffer(8);
      new DataView(timeBytes).setUint32(4, time, false);
      return crypto.subtle.sign("HMAC", key, new Uint8Array(timeBytes));
    })
    .then((hash) => {
      const h = new Uint8Array(hash);
      const offset = h[h.length - 1] & 0x0f;
      const code =
        ((h[offset] & 0x7f) << 24) |
        ((h[offset + 1] & 0xff) << 16) |
        ((h[offset + 2] & 0xff) << 8) |
        (h[offset + 3] & 0xff);
      return (code % 1000000).toString().padStart(6, "0");
    });
}

export function generateTOTP(secret: string): Promise<string> {
  return _generateTOTP(secret);
}

export async function getCachedTOTP(secret: string): Promise<{ code: string } | null> {
  if (!secret) return null;
  const step = Math.floor(Date.now() / 30000);
  const cacheKey = secret + ":" + step;
  const cached = _totpCache.get(cacheKey);
  if (cached) return { code: cached };
  const code = await _generateTOTP(secret);
  if (code) {
    _totpCache.set(cacheKey, code);
    if (_totpCache.size > 100) {
      const firstKey = _totpCache.keys().next().value;
      if (firstKey !== undefined) _totpCache.delete(firstKey);
    }
    return { code };
  }
  return null;
}
