import { session } from "./lib";

const origin = (Bun.env.WEB_URL || Bun.env.API_BASE || "https://sheetsubmit.pages.dev").replace(/\/+$/, "");
const iterations = Math.max(1, Number(Bun.env.PERF_ITERATIONS || 5));
const timeoutMs = Math.max(1000, Number(Bun.env.PERF_TIMEOUT_MS || 30000));
const cookie = session ? { Cookie: session } : {};

type Sample = {
  ms: number;
  status: number;
  bytes: number;
  cache: string;
  encoding: string;
};

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0;
}

async function measure(url: string): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: cookie,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.arrayBuffer();
    return {
      ms: performance.now() - started,
      status: response.status,
      bytes: Number(response.headers.get("content-length") || body.byteLength),
      cache: response.headers.get("cf-cache-status") || "-",
      encoding: response.headers.get("content-encoding") || "identity",
    };
  } catch {
    return { ms: performance.now() - started, status: 0, bytes: 0, cache: "-", encoding: "-" };
  }
}

function report(label: string, samples: Sample[]) {
  const times = samples.map((sample) => sample.ms);
  const failures = samples.filter((sample) => sample.status < 200 || sample.status >= 400);
  const bytes = samples.find((sample) => sample.bytes)?.bytes || 0;
  const cache = [...new Set(samples.map((sample) => sample.cache))].join(",");
  const encoding = [...new Set(samples.map((sample) => sample.encoding))].join(",");
  console.log(`${label}: status=${samples.at(-1)?.status || 0} p50=${percentile(times, .5).toFixed(0)}ms p95=${percentile(times, .95).toFixed(0)}ms bytes=${bytes} cache=${cache} encoding=${encoding}`);
  if (failures.length) console.log(`  failures=${failures.length}/${samples.length}`);
}

function assetUrls(html: string) {
  const urls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => new URL(match[1], origin))
    .filter((url) => url.origin === origin && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/logo")))
    .map((url) => url.href);
  return [...new Set(urls)];
}

async function run() {
  const pageUrl = `${origin}/`;
  const firstPage = await fetch(pageUrl, { headers: cookie, signal: AbortSignal.timeout(timeoutMs) });
  const html = await firstPage.text();
  if (!firstPage.ok) throw new Error(`Website returned HTTP ${firstPage.status}`);

  console.log(`Performance: ${origin}`);
  console.log(`Session: ${session ? "enabled" : "not set"}`);
  console.log(`Iterations: ${iterations}`);

  const pages = await Promise.all(Array.from({ length: iterations }, () => measure(pageUrl)));
  report("HTML", pages);

  const assets = assetUrls(html);
  console.log(`Assets discovered: ${assets.length}`);
  const assetSamples = await Promise.all(assets.map(async (url) => {
    const samples = await Promise.all(Array.from({ length: iterations }, () => measure(url)));
    return { url, samples };
  }));
  for (const asset of assetSamples) report(new URL(asset.url).pathname, asset.samples);

  if (session) report("/api/auth/me", await Promise.all(Array.from({ length: iterations }, () => measure(`${origin}/api/auth/me`))));
}

if (process.argv.includes("--help")) {
  console.log("Usage: bun test/performance.ts");
  console.log("Optional env: WEB_URL, PERF_ITERATIONS, PERF_TIMEOUT_MS, SESSION_TOKEN");
} else {
  await run();
}
