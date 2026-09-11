// agent/users.ts — mint, verify and delete TEST-ONLY users for agent-driven testing.
// Goes through POST /api/test/login (the same TEST-ONLY door Playwright uses).
// DEV BACKEND ONLY: aborts unless the test-auth door answers. The door 404s when
// ALLOW_TEST_AUTH is unset — which must always be the case on prod — so this
// script can never create users on prod. Uids are namespaced `agent-qa-*`.
//
// Secrets: BACKEND_URL from agent/.env (gitignored); real env vars override.
// Minted sessions are NEVER printed — with --save they are upserted into
// agent/.env (gitignored) as AGENT_SESSION_<UID> for reuse.
//
// Usage:
//   bun agent/users.ts create --name "Agent QA" [--uid custom-id] [--count 2] [--save]
//   bun agent/users.ts check --session <ss_session>
//   bun agent/users.ts delete --uid <id> --as-admin <admin-ss_session>
import { loadAgentEnv } from "./env";
await loadAgentEnv();

const USAGE = `agent/users — TEST-ONLY user manager (dev backend only, never prod)

  bun agent/users.ts create --name "Agent QA" [--uid <id>] [--count 1] [--prefix agent-qa] [--save]
  bun agent/users.ts check --session <ss_session>
  bun agent/users.ts delete --uid <id> --as-admin <admin-ss_session>

Flags:
  --base <url>   backend root (default BACKEND_URL from agent/.env)
  --save         upsert minted sessions into agent/.env (gitignored), never prints them
Admin note: isAdmin comes from the backend's dev ADMIN_IDS list. To get an admin
test user, pass --uid <id-already-in-dev-ADMIN_IDS>; --save, then reuse its session.
`;

const argv = Bun.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}
const has = (name: string) => argv.includes(`--${name}`);
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const base = (flag("base") || Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
if (!base) throw new Error("BACKEND_URL is required (agent/.env or --base) — point it at the DEV backend, never prod");

async function testLogin(uid: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/test/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, name }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) {
    throw new Error("test login door closed (404) — backend needs ALLOW_TEST_AUTH=1. Never enable it on prod; point BACKEND_URL at dev.");
  }
  if (!res.ok) throw new Error(`test login failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const setCookies: string[] =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get("set-cookie") || "").split(/,(?=[^;,]+=[^;,]*;)/);
  const match = setCookies.map((c) => c.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]).find(Boolean);
  if (!match) throw new Error("test login: no ss_session cookie in response");
  return decodeURIComponent(match);
}

async function me(session: string): Promise<{ id: string; isAdmin: boolean; name: string }> {
  const res = await fetch(`${base}/api/auth/me`, {
    headers: { Cookie: `ss_session=${session}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`auth/me failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { id: string; isAdmin?: boolean; name?: string };
  return { id: String(body.id), isAdmin: !!body.isAdmin, name: String(body.name || "") };
}

const san = (uid: string) => uid.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 48);

async function saveSessions(entries: { uid: string; session: string }[]) {
  const path = `${import.meta.dir}/.env`;
  let text = "";
  try { text = await Bun.file(path).text(); } catch { /* first write */ }
  const lines = text.split("\n").filter((l) => {
    const k = l.split("=")[0]?.trim();
    return !entries.some((e) => k === `AGENT_SESSION_${san(e.uid)}`) && k !== "AGENT_LAST_SESSION";
  });
  for (const e of entries) lines.push(`AGENT_SESSION_${san(e.uid)}='${e.session}'`);
  if (entries.length) lines.push(`AGENT_LAST_SESSION='${entries[entries.length - 1].session}'`);
  await Bun.write(path, lines.join("\n").replace(/\n+$/, "\n"));
  console.log(`saved ${entries.length} session(s) to agent/.env (gitignored)`);
}

const cmd = argv[0];

if (cmd === "create") {
  const name = (flag("name") || "Agent QA").slice(0, 128);
  const count = Math.min(20, Math.max(1, Number(flag("count") || "1") || 1));
  const prefix = (flag("prefix") || "agent-qa").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "agent-qa";
  const fixedUid = flag("uid");
  if (fixedUid && !UID_RE.test(fixedUid)) throw new Error("invalid --uid (1-64 chars: A-Z a-z 0-9 _ -)");
  if (fixedUid && count > 1) throw new Error("--uid cannot be combined with --count > 1");
  const saved: { uid: string; session: string }[] = [];
  for (let i = 0; i < count; i++) {
    const uid = fixedUid || `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${i ? `-${i}` : ""}`;
    const session = await testLogin(uid, count > 1 ? `${name} ${i + 1}` : name);
    const info = await me(session);
    console.log(`ok uid=${info.id} name=${info.name || name} isAdmin=${info.isAdmin}`);
    if (!info.isAdmin) console.log(`  hint: for an admin test user, re-run with --uid <id-in-dev-ADMIN_IDS>`);
    saved.push({ uid: info.id, session });
  }
  if (has("--save")) await saveSessions(saved);
  else console.log(`(sessions not printed; re-run with --save to store them in agent/.env)`);
} else if (cmd === "check") {
  const session = flag("session") || Bun.env.AGENT_LAST_SESSION || "";
  if (!session) throw new Error("--session <ss_session> is required (or set AGENT_LAST_SESSION via --save)");
  const info = await me(session);
  console.log(`ok uid=${info.id} name=${info.name} isAdmin=${info.isAdmin}`);
} else if (cmd === "delete") {
  const uid = flag("uid") || "";
  const adminSession = flag("as-admin") || "";
  if (!UID_RE.test(uid)) throw new Error("--uid <id> is required");
  if (!adminSession) throw new Error("--as-admin <admin-ss_session> is required (admin-only route)");
  const res = await fetch(`${base}/api/admin/user/${encodeURIComponent(uid)}`, {
    method: "DELETE",
    headers: { Cookie: `ss_session=${adminSession}` },
    signal: AbortSignal.timeout(30_000),
  });
  console.log(`delete ${uid}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) process.exit(1);
} else {
  console.error(`unknown command: ${cmd}\n${USAGE}`);
  process.exit(1);
}
