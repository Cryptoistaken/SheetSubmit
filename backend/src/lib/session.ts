import type { Context, Next } from "hono";
import type { Env } from "./shared";

const enc = new TextEncoder();
const b64 = (v: ArrayBuffer | string) => btoa(typeof v === "string" ? v : String.fromCharCode(...new Uint8Array(v))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (v: string) => atob(v.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((v.length + 3) % 4));
async function key(secret: string, usage: ("sign" | "verify")[]) { if (!secret) throw new Error("SESSION_SECRET missing"); return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage); }
export async function signSession(uid: string, secret: string) { if (!secret) throw new Error("SESSION_SECRET missing"); const body = b64(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 })); const sig = b64(await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), enc.encode(body))); return `${body}.${sig}`; }
export async function verifySession(token: string, secret: string) { if (!secret) throw new Error("SESSION_SECRET missing"); const [body, sig] = token.split("."); if (!body || !sig) return null; const valid = await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), Uint8Array.from(unb64(sig), (c) => c.charCodeAt(0)), enc.encode(body)); if (!valid) return null; try { const data = JSON.parse(unb64(body)); return data.exp > Date.now() ? { uid: String(data.uid) } : null; } catch { return null; } }
export function cookie(token: string, maxAge = 2592000) { return `ss_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`; }
export async function requireAuth(c: Context<{ Bindings: Env; Variables: { uid: string } }>, next: Next) { const token = c.req.header("Cookie")?.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]; if (!c.env.SESSION_SECRET) return c.json({ error: "Server configuration error" }, 500); const session = token && await verifySession(token, c.env.SESSION_SECRET); if (!session) return c.json({ error: "Not authenticated" }, 401); c.set("uid", session.uid); return next(); }
export const isAdmin = (env: Env, uid: string) => (env.ADMIN_IDS || "").split(",").map((v) => v.trim()).includes(uid);
