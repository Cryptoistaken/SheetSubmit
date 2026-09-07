const envFile = `${import.meta.dir}/.env`;
if (await Bun.file(envFile).exists()) {
  for (const line of (await Bun.file(envFile).text()).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !Bun.env[match[1]]) Bun.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

const base = (Bun.env.API_BASE || "http://localhost:3000").replace(/\/+$/, "") + "/api";
const session = Bun.env.SESSION_TOKEN;
const cookie = session ? (session.includes("ss_session=") ? session : `ss_session=${session}`) : "";

const check = async (path: string, authenticated = false) => {
  const response = await fetch(`${base}${path}`, {
    headers: authenticated && cookie ? { Cookie: cookie } : {},
    signal: AbortSignal.timeout(Number(Bun.env.TEST_TIMEOUT_MS || 30000)),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${body.slice(0, 200)}`);
  console.log(`PASS ${path} ${response.status}`);
};

if (import.meta.main) {
  await check("/health");
  if (!session) throw new Error(`Set SESSION_TOKEN in ${envFile}`);
  await check("/auth/me", true);
  await check("/files", true);
  console.log("Smoke test passed");
}
