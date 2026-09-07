import { assert, assertStatus, base, json, loadRows, percentile, put, report, request, session } from "./lib";

const iterations = Math.max(1, Number(Bun.env.BENCH_ITERATIONS || 20));
const concurrency = Math.max(1, Number(Bun.env.BENCH_CONCURRENCY || 5));
const created: string[] = [];
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function concurrent<T>(count: number, fn: () => Promise<T>) { return Promise.all(Array.from({ length: count }, fn)); }
async function cleanup() { for (const id of created) { await request(`/files/${id}`, { method: "DELETE" }); await request(`/archive/${id}`, { method: "DELETE" }); } }

async function run() {
  if (!session) throw new Error("Set SESSION_TOKEN in test/.env");
  const rows = await loadRows("Page.xlsx");
  const made = await request<any>("/files", json({ name: `benchmark-${suffix}`, type: "fb_cookie", preset: "page", poolKind: "page", password: "dgddigital", poolEnabled: false, rows, dataCount: rows.length })); assertStatus(made, 200, "benchmark setup"); created.push(made.body.id);
  const id = made.body.id;
  const full = await request<any>(`/files/${id}/full`); assertStatus(full, 200, "benchmark setup full");
  const scenarios: [string, () => Promise<any>][] = [
    ["GET /files", () => request("/files")],
    ["GET /files/:id/full", () => request(`/files/${id}/full`)],
    ["GET /files/:id/rows", () => request(`/files/${id}/rows`)],
    ["GET /pools", () => request("/pools")],
  ];
  let failures = 0;
  console.log(`API ${base} | iterations=${iterations} concurrency=${concurrency}`);
  for (const [label, call] of scenarios) {
    for (let i = 0; i < 3; i++) await call();
    failures += report(label, await concurrent(iterations, call));
  }
  let seq = full.body.seq;
  const appendSamples: any[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = await request<any>(`/files/${id}/append`, { ...json({ base: seq, ops: [{ rowIdx: i % rows.length, cols: { status: `bench-${i}` } }] }), method: "PUT" });
    appendSamples.push(sample); if (sample.status === 200) seq = sample.body.seq;
  }
  failures += report("PUT /files/:id/append", appendSamples);
  const persistSamples = await concurrent(Math.max(1, Math.min(iterations, 10)), () => request(`/files/${id}/persist`, { ...put({ rows, dataCount: rows.length, action: "benchmark" }) }));
  failures += report("PUT /files/:id/persist", persistSamples);
  assert(failures === 0, `${failures} benchmark samples failed`);
}

try { await run(); } finally { await cleanup(); }
