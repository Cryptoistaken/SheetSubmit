type Account = { name?: string; session: string };
type Sample = { ms: number; status: number; ok: boolean };

const envFile = `${import.meta.dir}/.env`;
if (await Bun.file(envFile).exists()) {
  for (const line of await Bun.file(envFile).text().then((text) => text.split(/\r?\n/))) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Bun.env[match[1]]) Bun.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const base = (Bun.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "") + "/api";
const iterations = Math.max(1, Number(Bun.env.BENCH_ITERATIONS || 5));
const timeoutMs = Math.max(1000, Number(Bun.env.BENCH_TIMEOUT_MS || 30000));
const endpoints = (Bun.env.BENCH_ENDPOINTS || "/health,/auth/me,/wallet,/files")
  .split(",").map((path) => path.trim()).filter(Boolean);

const readAccounts = async (): Promise<Account[]> => {
  const path = Bun.env.ACCOUNTS_FILE || `${import.meta.dir}/accounts.json`;
  if (!(await Bun.file(path).exists())) {
    if (Bun.env.SESSION_TOKEN) return [{ name: Bun.env.ACCOUNT_NAME || "admin", session: Bun.env.SESSION_TOKEN }];
    throw new Error(`Missing ${path}; set SESSION_TOKEN in ${envFile}`);
  }
  const value = await Bun.file(path).json();
  const accounts = Array.isArray(value) ? value : value.accounts;
  if (!Array.isArray(accounts) || accounts.some((account) => typeof account?.session !== "string" || !account.session)) {
    throw new Error(`${path} must contain [{"name":"account","session":"..."}] or {"accounts":[...]}`);
  }
  return accounts;
};

const cookie = (session: string) => session.includes("ss_session=") ? session : `ss_session=${session}`;

const request = async (path: string, session?: string): Promise<Sample> => {
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path.startsWith("/") ? path : `/${path}`}`, {
      headers: session ? { Cookie: cookie(session) } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ms: performance.now() - started, status: response.status, ok: response.ok };
  } catch {
    return { ms: performance.now() - started, status: 0, ok: false };
  }
};

const percentile = (values: number[], p: number) => values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] || 0;

const report = (label: string, samples: Sample[]) => {
  const times = samples.map(({ ms }) => ms).sort((a, b) => a - b);
  const statuses = [...new Set(samples.map(({ status }) => status))].join(",");
  console.log(`${label.padEnd(24)} n=${samples.length} ok=${samples.filter(({ ok }) => ok).length}/${samples.length} status=${statuses} min=${times[0]?.toFixed(0)}ms p50=${percentile(times, .5).toFixed(0)}ms p95=${percentile(times, .95).toFixed(0)}ms max=${times.at(-1)?.toFixed(0)}ms`);
};

if (import.meta.main) {
  const accounts = await readAccounts();
  console.log(`API ${base} | ${accounts.length} account(s) | ${iterations} iteration(s) | timeout ${timeoutMs}ms`);
  for (const path of endpoints) {
    const samples: Sample[] = [];
    for (let i = 0; i < iterations; i++) samples.push(await request(path));
    report(`anonymous ${path}`, samples);
    for (const account of accounts) {
      const accountSamples: Sample[] = [];
      for (let i = 0; i < iterations; i++) accountSamples.push(await request(path, account.session));
      report(`${account.name || "account"} ${path}`, accountSamples);
    }
  }
}
