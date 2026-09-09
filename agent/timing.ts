// agent/timing.ts — read-only latency + payload sweep of the hot APIs, twice each:
// once direct to the backend, once via the front (Cloudflare) URL. The delta
// is Cloudflare + extra-hop overhead. No writes.
// Secrets from agent/.env (gitignored): BACKEND_URL, FRONT_URL (defaults to
// the Pages site), AGENT_TOKEN, SS_SESSION (short-lived TEST session only).
// Usage: bun agent/timing.ts
import { loadAgentEnv } from "./env";
await loadAgentEnv();
const base = (Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
const front = (Bun.env.FRONT_URL || "https://sheetsubmit.pages.dev").trim().replace(/\/+$/, "");
const agentTok = (Bun.env.AGENT_TOKEN || "").trim();
const session = (Bun.env.SS_SESSION || "").trim();
if (!base) throw new Error("BACKEND_URL is required");

type Auth = "none" | "agent" | "session";
type Row = { origin: string; path: string; status: number; ms: number; bytes: number; serverMs: string; note?: string };
async function hit(origin: string, path: string, auth: Auth): Promise<Row> {
  const headers: Record<string, string> = {};
  if (auth === "agent") headers.Authorization = `Bearer ${agentTok}`;
  if (auth === "session") headers.Cookie = `ss_session=${session}`;
  const started = Date.now();
  try {
    const res = await fetch(origin + path, { headers, signal: AbortSignal.timeout(30_000) });
    const bytes = (await res.arrayBuffer()).byteLength;
    return { origin, path, status: res.status, ms: Date.now() - started, bytes, serverMs: res.headers.get("server-timing") || "-" };
  } catch (e) { return { origin, path, status: 0, ms: Date.now() - started, bytes: 0, serverMs: "-", note: String((e as Error)?.message || e) }; }
}
function show(r: Row) {
  const tag = r.origin === base ? "direct" : "front ";
  console.log(`${tag} ${String(r.status).padStart(3)} ${String(r.ms).padStart(5)}ms ${String(r.bytes).padStart(9)}B srv:${r.serverMs}${r.note ? "  ← " + r.note : ""}  ${r.path}`);
}
async function both(path: string, auth: Auth) {
  if (auth === "agent" && !agentTok) { console.log(`  - skipping ${path} (no AGENT_TOKEN)`); return; }
  if (auth === "session" && !session) { console.log(`  - skipping ${path} (no SS_SESSION)`); return; }
  const d = await hit(base, path, auth); show(d);
  const f = await hit(front, path, auth); show(f);
  if (d.status === 200 && f.status === 200) console.log(`      delta (front-direct): ${f.ms - d.ms}ms`);
}
async function getJson(path: string, auth: Auth) {
  const headers: Record<string, string> = {};
  if (auth === "agent") headers.Authorization = `Bearer ${agentTok}`;
  if (auth === "session") headers.Cookie = `ss_session=${session}`;
  const res = await fetch(base + path, { headers, signal: AbortSignal.timeout(30_000) });
  const body = await res.json().catch(() => null);
  console.log(`${String(res.status).padStart(3)} ${path}`);
  return body;
}

const plan: [string, Auth][] = [
  ["/api/health", "none"], ["/api/agent/health", "agent"], ["/api/agent/stats", "agent"],
  ["/api/worker/health", "none"], ["/api/bot/info", "none"], ["/api/auth/telegram/config", "none"],
  ["/api/auth/me", "session"], ["/api/wallet", "session"], ["/api/archive", "session"],
  ["/api/cross-dups", "session"], ["/api/admin/stats", "session"], ["/api/admin/users", "session"],
  ["/api/pools", "session"], ["/api/pools/holds", "session"], ["/api/pools/downloads", "session"],
  ["/api/files", "session"],
];
for (const [path, auth] of plan) await both(path, auth);

if (session) {
  const files = (await getJson("/api/files", "session")) as { id: string; rowCount?: number; name?: string }[] | null;
  const top = Array.isArray(files) ? [...files].sort((a, b) => (b.rowCount || 0) - (a.rowCount || 0))[0] : null;
  if (top) {
    console.log(`largest file: ${top.name || top.id} (${top.rowCount || 0} rows)`);
    await both(`/api/files/${encodeURIComponent(top.id)}/full`, "session");
    await both(`/api/files/${encodeURIComponent(top.id)}/rows`, "session");
  }
  const pwd = "dgddigital", pool = "cookies_only"; // repo-known constants, see PoolsView
  await both(`/api/pools/${pwd}/${pool}`, "session");
  await both(`/api/pools/${pwd}/${pool}/rows?limit=100`, "session");
  await both(`/api/pools/${pwd}/${pool}/verified-counts`, "session");
  await both(`/api/pools/${pwd}/${pool}/user-files`, "session");
  const holds = (await getJson("/api/pools/holds", "session")) as { id: string }[] | null;
  if (Array.isArray(holds) && holds[0]?.id) await both(`/api/pools/downloads/${encodeURIComponent(holds[0].id)}/detail`, "session");
}
