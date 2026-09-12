// Local e2e stack helper (test env only, never prod).
// Usage: bun scripts/e2e-local.ts up|down|status|test [--headed] [extra playwright args]
//   up     -> test DB + schema + backend :3001 + web :8080
//   test   -> npx playwright test e2e/page-entry.spec.ts (headed by default)
//   down   -> stop backend/web + test containers
//   status -> ports + health check
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;
const BACKEND = join(ROOT, "backend");
const WEB = join(ROOT, "Pages");
const TMP = join(tmpdir(), "opencode");
const DB = "postgres://postgres:postgres@localhost:5432/sheetsubmit_test";
const BE_URL = "http://127.0.0.1:3001";
const WEB_URL = "http://127.0.0.1:8080";

const pidFile = (n: string) => join(TMP, `e2e-${n}.pid`);
const logFile = (n: string) => join(TMP, `e2e-${n}.log`);

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  return p.exited;
}

async function healthy(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

async function waitFor(url: string, label: string, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await healthy(url)) return;
    await Bun.sleep(1000);
  }
  throw new Error(`${label} never came up: ${url}\nsee ${logFile(label)}`);
}

function startDetached(name: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const log = Bun.file(logFile(name));
  const p = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: log,
    stderr: log,
  });
  Bun.write(pidFile(name), String(p.pid));
  p.unref();
  console.log(`${name} pid ${p.pid} -> ${logFile(name)}`);
}

async function stopDetached(name: string) {
  try {
    const pid = Number(await Bun.file(pidFile(name)).text());
    if (pid) process.kill(pid);
    console.log(`stopped ${name} (${pid})`);
  } catch { console.log(`no ${name} pidfile (already down?)`); }
}

const [cmd = "up", ...rest] = Bun.argv.slice(2);

if (cmd === "up") {
  await sh(["docker", "compose", "-f", "docker-compose.test.yml", "up", "-d"], ROOT);
  await sh(["bun", "scripts/schema.ts", "bootstrap"], BACKEND, { DATABASE_URL: DB });
  startDetached("be", ["bun", "src/server.ts"], BACKEND, {
    DATABASE_URL: DB, PORT: "3001", ALLOW_TEST_AUTH: "1",
    ADMIN_IDS: "e2e-user", SESSION_SECRET: "e2e-test-secret",
    FRONTEND_URL: WEB_URL,
  });
  await waitFor(`${BE_URL}/api/health`, "be");
  startDetached("web", ["bun", "server.js"], WEB, { PORT: "8080", BACKEND_URL: BE_URL });
  await waitFor(WEB_URL, "web");
  console.log(`UP  backend ${BE_URL}  web ${WEB_URL}`);
} else if (cmd === "down") {
  await stopDetached("web");
  await stopDetached("be");
  await sh(["docker", "compose", "-f", "docker-compose.test.yml", "down"], ROOT);
  console.log("DOWN");
} else if (cmd === "status") {
  console.log("backend:", (await healthy(`${BE_URL}/api/health`)) ? "UP" : "DOWN", BE_URL);
  console.log("web:", (await healthy(WEB_URL)) ? "UP" : "DOWN", WEB_URL);
} else if (cmd === "test") {
  const headed = rest.includes("--headed") ? [] : ["--headed"];
  const args = ["playwright", "test", "e2e/page-entry.spec.ts", ...headed, ...rest.filter((a) => a !== "--headed")];
  const code = await sh(["npx", ...args], WEB, { E2E_BASE_URL: WEB_URL });
  process.exit(code);
} else {
  console.log("usage: bun scripts/e2e-local.ts up|down|status|test [--headed]");
  process.exit(1);
}
