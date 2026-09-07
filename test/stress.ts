const envFile = `${import.meta.dir}/.env`;
if (await Bun.file(envFile).exists()) {
  for (const line of (await Bun.file(envFile).text()).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Bun.env[match[1]]) Bun.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const base = (Bun.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "") + "/api";
const session = Bun.env.SESSION_TOKEN;
const endpoint = Bun.env.STRESS_ENDPOINT || "/files";
const requests = Math.max(1, Number(Bun.env.STRESS_REQUESTS || 100));
const concurrency = Math.max(1, Math.min(requests, Number(Bun.env.STRESS_CONCURRENCY || 10)));
const timeoutMs = Math.max(1000, Number(Bun.env.STRESS_TIMEOUT_MS || 30000));
const cookie = session ? (session.includes("ss_session=") ? session : `ss_session=${session}`) : "";

const run = async () => {
  const samples: { ms: number; status: number }[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= requests) return;
      const started = performance.now();
      try {
        const response = await fetch(`${base}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`, {
          headers: cookie ? { Cookie: cookie } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer();
        samples.push({ ms: performance.now() - started, status: response.status });
      } catch {
        samples.push({ ms: performance.now() - started, status: 0 });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const times = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  const percentile = (p: number) => times[Math.min(times.length - 1, Math.ceil(times.length * p) - 1)] || 0;
  const successful = samples.filter(({ status }) => status >= 200 && status < 300).length;
  const statuses = [...new Set(samples.map(({ status }) => status))].sort((a, b) => a - b).join(",");
  console.log(`API ${base}${endpoint} | requests=${requests} concurrency=${concurrency}`);
  console.log(`ok=${successful}/${requests} status=${statuses} p50=${percentile(.5).toFixed(0)}ms p95=${percentile(.95).toFixed(0)}ms p99=${percentile(.99).toFixed(0)}ms max=${times.at(-1)?.toFixed(0)}ms`);
};

if (import.meta.main) await run();
