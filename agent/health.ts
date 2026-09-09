// agent/health.ts — one-shot backend + worker sweep for the debugging agent.
// Usage:
//   AGENT_TOKEN=<token> BACKEND_URL=https://<backend> bun agent/health.ts
// Hits /api/health, /api/agent/health, /api/worker/health. Exit 1 if backend unreachable.
const token = (Bun.env.AGENT_TOKEN || "").trim();
const base = (Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
if (!base) throw new Error("BACKEND_URL is required (e.g. https://<service>.up.railway.app)");
async function hit(path: string, auth: boolean) {
  const started = Date.now();
  try {
    const res = await fetch(base + path, {
      headers: auth && token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => null);
    return { path, status: res.status, ms: Date.now() - started, body };
  } catch (e) { return { path, status: 0, ms: Date.now() - started, error: String((e as Error)?.message || e) }; }
}
const [pub, door, worker] = await Promise.all([hit("/api/health", false), hit("/api/agent/health", true), hit("/api/worker/health", false)]);
for (const r of [pub, door, worker]) console.log(`${r.status} ${r.path} (${r.ms}ms)`, r.status === 200 ? JSON.stringify(r.body) : (r as { error?: string }).error ?? JSON.stringify(r.body));
if (pub.status !== 200) process.exit(1);
