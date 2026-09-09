// agent/call.ts — authenticated backend caller through the dev agent door.
// Secrets come from agent/.env (this folder, gitignored); real env vars override.
// Usage:
//   bun agent/call.ts GET /api/agent/health
//   bun agent/call.ts POST /api/pools/holds/<id>/approve '{}'
// Never prints the token. Prints status, latency, pretty JSON.
import { loadAgentEnv } from "./env";
await loadAgentEnv();
const token = (Bun.env.AGENT_TOKEN || "").trim();
const base = (Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
const [methodRaw, path, bodyRaw] = Bun.argv.slice(2);
if (!token) throw new Error("AGENT_TOKEN is required");
if (!base) throw new Error("BACKEND_URL is required (e.g. https://<service>.up.railway.app)");
const method = (methodRaw || "GET").toUpperCase();
if (!path?.startsWith("/")) throw new Error("path must start with / (e.g. /api/agent/health)");
const started = Date.now();
const res = await fetch(base + path, {
  method,
  headers: { Authorization: `Bearer ${token}`, ...(bodyRaw !== undefined ? { "Content-Type": "application/json" } : {}) },
  body: bodyRaw,
  signal: AbortSignal.timeout(30_000),
});
const ms = Date.now() - started;
const text = await res.text();
let body: unknown = text;
try { body = JSON.parse(text); } catch {}
console.log(`${res.status} ${method} ${path} (${ms}ms)`);
console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
if (!res.ok) process.exit(1);
