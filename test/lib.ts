type Json = Record<string, any> | any[];

const envFile = `${import.meta.dir}/.env`;
if (await Bun.file(envFile).exists()) {
  for (const line of (await Bun.file(envFile).text()).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Bun.env[match[1]]) Bun.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

export const base = `${(Bun.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "")}/api`;
export const timeoutMs = Math.max(1000, Number(Bun.env.TEST_TIMEOUT_MS || 30000));
export const session = Bun.env.SESSION_TOKEN || "";
export const cookie = (value = session) => value ? (value.includes("ss_session=") ? value : `ss_session=${value}`) : "";
export const fixtureDir = `${import.meta.dir}`;

export type Result<T = Json> = { status: number; ok: boolean; ms: number; body: T | string; headers: Headers };

export async function request<T = Json>(path: string, init: RequestInit = {}, token = session): Promise<Result<T>> {
  const started = performance.now();
  const headers = new Headers(init.headers);
  if (token) headers.set("Cookie", cookie(token));
  if (init.body && !headers.has("content-type")) headers.set("Content-Type", "application/json");
  try {
    const response = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, { ...init, headers, signal: init.signal || AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: T | string = text;
    try { body = text ? JSON.parse(text) as T : ""; } catch { /* keep non-JSON diagnostic body */ }
    return { status: response.status, ok: response.ok, ms: performance.now() - started, body, headers: response.headers };
  } catch (error) {
    return { status: 0, ok: false, ms: performance.now() - started, body: String(error), headers: new Headers() };
  }
}

export function json(body: unknown): RequestInit { return { method: "POST", body: JSON.stringify(body) }; }
export function put(body: unknown): RequestInit { return { method: "PUT", body: JSON.stringify(body) }; }
export function errorText(result: Result) { return typeof result.body === "string" ? result.body.slice(0, 300) : JSON.stringify(result.body).slice(0, 300); }
export function assertStatus(result: Result, expected: number | number[], label: string) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  if (!statuses.includes(result.status)) throw new Error(`${label}: expected ${statuses.join("/")}, got ${result.status}: ${errorText(result)}`);
}
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export async function loadRows(fileName: string) {
  const XLSX = await import("../Pages/node_modules/xlsx/xlsx.mjs");
  const workbook = XLSX.read(await Bun.file(`${fixtureDir}/${fileName}`).arrayBuffer(), { type: "array" });
  const values = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
  return values.map((source) => ({ cookies: String(source[0] || ""), twofakey: String(source[1] || ""), uid: String(source[0] || "").match(/c_user=(\d+)/)?.[1] || "" })).filter((row) => row.cookies);
}
export function percentile(values: number[], p: number) { return values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * p) - 1))] || 0; }
export function report(label: string, samples: Result[]) {
  const times = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const failures = samples.filter((sample) => !sample.ok);
  const statuses = [...new Set(samples.map((sample) => sample.status))].sort((a, b) => a - b).join(",");
  console.log(`${label} n=${samples.length} ok=${samples.length - failures.length}/${samples.length} status=${statuses} p50=${percentile(times, .5).toFixed(0)}ms p95=${percentile(times, .95).toFixed(0)}ms p99=${percentile(times, .99).toFixed(0)}ms max=${times.at(-1)?.toFixed(0)}ms`);
  for (const failure of failures.slice(0, 3)) console.log(`  failure ${failure.status}: ${errorText(failure)}`);
  return failures.length;
}
export async function waitFor(check: () => Promise<boolean>, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return true; await Bun.sleep(250); }
  return false;
}
