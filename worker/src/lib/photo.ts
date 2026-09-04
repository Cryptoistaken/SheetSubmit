import { rpc } from "./do";
import type { Env } from "./shared";

const tg = (token: string, m: string, b: unknown) =>
  fetch(`https://api.telegram.org/bot${token}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json() as any);

/** Download the user's current Telegram avatar as base64. Server-side only —
 *  the bot token must never reach the browser. */
export async function fetchPhotoBytes(botToken: string, uid: string): Promise<{ data: string; type: string } | null> {
  try {
    const p = await tg(botToken, "getUserProfilePhotos", { user_id: Number(uid), limit: 1 });
    const fid = p?.result?.photos?.[0]?.slice(-1)?.[0]?.file_id;
    if (!fid) return null;
    const g = await tg(botToken, "getFile", { file_id: fid });
    const path: string | null = g?.result?.file_path ?? null;
    if (!path) return null;
    const dl = await fetch(`https://api.telegram.org/file/bot${botToken}/${path}`);
    if (!dl.ok) return null;
    const buf = new Uint8Array(await dl.arrayBuffer());
    if (!buf.length || buf.length > 500_000) return null;
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    return { data: btoa(bin), type: sniffImage(buf) || dl.headers.get("content-type") || "image/jpeg" };
  } catch { return null; }
}

/** Sniff image type from magic bytes — Telegram serves files as octet-stream. */
export function sniffImage(buf: Uint8Array): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  return null;
}
/** Fetch once and persist in IndexDO meta. Best-effort — never throws. */
export async function refreshPhoto(env: Env, uid: string): Promise<void> {
  try {
    if (!env.TG_BOT_TOKEN) return;
    const img = await fetchPhotoBytes(env.TG_BOT_TOKEN, uid);
    if (img) await rpc(env.INDEX, "global", "metaSet", { k: `photoimg:${uid}`, v: { ...img, ts: Date.now() } }).catch(() => {});
  } catch {}
}

export function photoBytes(img: { data: string }): Uint8Array {
  const bin = atob(img.data);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
