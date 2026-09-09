import type { Context, Next } from "hono";
import type { Env } from "./shared";

// DEV-ONLY service door for the debugging agent. Opens only when
// ALLOW_AGENT_ACCESS=1 AND AGENT_TOKEN is set (both from env, never git).
// Seal before prod: unset ALLOW_AGENT_ACCESS on every production service.
export const agentDoorOpen = (env: Env) => env.ALLOW_AGENT_ACCESS === "1" && !!env.AGENT_TOKEN;

const enc = new TextEncoder();
async function sha256(s: string) { return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))); }

// constant-time compare on fixed-length digests (never compare raw tokens — leaks length)
export async function agentTokenOk(provided: string, expected: string) {
  if (!provided || !expected) return false;
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function agentTokenFrom(auth: string, xToken: string) {
  const bearer = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : "";
  return bearer || xToken.trim();
}

// 404s (not 403s) when closed, missing, or wrong — the door must not reveal it exists
export async function requireAgent(c: Context<{ Bindings: Env; Variables: { uid: string; agent: boolean } }>, next: Next) {
  if (!agentDoorOpen(c.env)) return c.json({ error: "not found" }, 404);
  const provided = agentTokenFrom(c.req.header("Authorization") || "", c.req.header("X-Agent-Token") || "");
  if (!(await agentTokenOk(provided, c.env.AGENT_TOKEN || ""))) return c.json({ error: "not found" }, 404);
  c.set("agent", true);
  return next();
}
