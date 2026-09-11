// agent/pipeline.ts — end-to-end pipeline run on behalf of freshly minted TEST users.
// DEV BACKEND ONLY: users are minted through POST /api/test/login, which 404s unless
// ALLOW_TEST_AUTH=1 (never set on prod) — the script aborts on a closed door, so it
// can never run against prod. All data is namespaced per-run and cleaned up.
//
// Flow (password dgddigital, pool cookies_2fa, preset combo):
//   1. mint owner (regular) + admin (--admin-uid must be in dev ADMIN_IDS)
//   2. owner uploads a file with N unique rows → wait until pooled
//   3. admin sets unit price (restored afterwards)
//   4. admin takes a HOLD of the file's rows (pool take side is admin-only)
//   5. admin approves the hold
//   6. owner wallet checked; --wait-settle polls for the credit (settle ≈5min+30s sweep)
//   7. cleanup: reject hold if still pending, archive+purge file, restore price,
//      delete auto-minted owner unless --keep-users (use --keep to skip all cleanup)
//   8. --with-routing also runs test/pipeline.ts with the minted sessions
//
// Usage:
//   bun agent/pipeline.ts --admin-uid <id-in-dev-ADMIN_IDS> [--count 2] [--price 0.10]
//     [--owner-uid <id>] [--wait-settle] [--with-routing] [--keep] [--keep-users]
import { loadAgentEnv } from "./env";
await loadAgentEnv();

const USAGE = `agent/pipeline — e2e pipeline on behalf of minted test users (dev backend only)

  bun agent/pipeline.ts --admin-uid <id-in-dev-ADMIN_IDS> [--count 2] [--price 0.10]
    [--owner-uid <id>] [--wait-settle] [--settle-timeout-ms 420000]
    [--with-routing] [--keep] [--keep-users] [--base <url>]

  --admin-uid   REQUIRED: uid listed in the dev backend's ADMIN_IDS (pool take,
                approve, price and reads are admin-only in this backend)
  --wait-settle poll the owner wallet until the hold credit lands (else reports
                "settlement pending" — payout happens ~5min after approve + sweep)
  --with-routing run the existing test/pipeline.ts routing suite with the same
                minted sessions before the hold flow
  --keep        skip all cleanup (inspect dev state afterwards)
`;

const argv = Bun.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
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

const PWD = "dgddigital";
const POOL = "cookies_2fa";
const PRESET = "combo";
const base = (flag("base") || Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
if (!base) throw new Error("BACKEND_URL is required (agent/.env or --base) — point it at the DEV backend, never prod");
const adminUid = flag("admin-uid") || Bun.env.AGENT_ADMIN_UID || "";
if (!UID_RE.test(adminUid)) throw new Error("--admin-uid <id-in-dev-ADMIN_IDS> is required (pool take/approve/price are admin-only)");
const ownerUid = flag("owner-uid") || `agent-qa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
if (!UID_RE.test(ownerUid)) throw new Error("invalid --owner-uid");
const ownerOwned = !flag("owner-uid"); // only auto-minted users are ever auto-deleted
const count = Math.min(50, Math.max(1, Number(flag("count") || "2") || 2));
const price = Number(flag("price") ?? "0.1");
if (!Number.isFinite(price) || price < 0 || price > 1000) throw new Error("--price must be 0-1000 (USD)");
const settleTimeout = Math.max(30_000, Number(flag("settle-timeout-ms") || "420000") || 420000);

const run = Date.now().toString().slice(-9);
let seq = 0;
const fails: string[] = [];
const pass = (label: string) => console.log(`PASS ${label}`);
const fail = (label: string, detail = "") => {
  console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  fails.push(label);
};

type ReqOpts = { method?: string; body?: unknown; session?: string };
async function api<T = any>(path: string, opts: ReqOpts = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.session ? { Cookie: `ss_session=${opts.session}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: T = text as unknown as T;
  try { body = text ? (JSON.parse(text) as T) : ("" as unknown as T); } catch { /* keep raw */ }
  return { status: res.status, body };
}

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
  if (!res.ok) throw new Error(`test login failed for ${uid}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const getSet = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSet === "function" ? getSet.call(res.headers) : (res.headers.get("set-cookie") || "").split(/,(?=[^;,]+=[^;,]*;)/);
  const token = cookies.map((c) => c.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]).find(Boolean);
  if (!token) throw new Error(`test login for ${uid}: no ss_session cookie in response`);
  return decodeURIComponent(token);
}

async function waitFor(label: string, check: () => Promise<boolean>, timeout = 20_000): Promise<boolean> {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) {
      fail(label, "timed out waiting");
      return false;
    }
    await Bun.sleep(1000);
  }
}

// run-scoped state for cleanup
let ownerSession = "";
let adminSession = "";
let fileId: string | null = null;
let holdId: string | null = null;
let origPrice: number | null = null;
let settled = false;

async function cleanup() {
  if (has("--keep")) {
    console.log(`KEEP --keep set: hold=${holdId} file=${fileId} left in place for inspection`);
    return;
  }
  if (holdId && !settled) {
    try {
      const pending = await api<any[]>(`/api/pools/holds?status=PENDING`, { session: adminSession });
      if (Array.isArray(pending.body) && pending.body.some((h) => h.id === holdId)) {
        const r = await api(`/api/pools/holds/${holdId}/return`, { method: "POST", session: adminSession });
        console.log(`CLEANUP hold return: ${r.status}`);
      } else {
        console.log(`CLEANUP hold ${holdId} no longer pending — left as dev ledger data`);
      }
    } catch (e) { console.log(`CLEANUP hold return failed: ${String(e).slice(0, 160)}`); }
  }
  if (fileId) {
    const del = await api(`/api/files/${fileId}`, { method: "DELETE", session: ownerSession });
    const purge = await api(`/api/archive/${fileId}`, { method: "DELETE", session: ownerSession });
    console.log(`CLEANUP file archive+purge: ${del.status}/${purge.status}`);
  }
  if (origPrice != null) {
    const r = await api(`/api/pools/${PWD}/${POOL}/price`, { method: "PUT", body: { price: origPrice }, session: adminSession });
    console.log(`CLEANUP price restore $${origPrice}: ${r.status}`);
  }
  if (ownerOwned && !has("--keep-users")) {
    const r = await api(`/api/admin/user/${encodeURIComponent(ownerUid)}`, { method: "DELETE", session: adminSession });
    console.log(`CLEANUP delete test user ${ownerUid}: ${r.status}`);
  }
}

async function main() {
  // 0. backend reachable + versions
  const health = await api<any>("/api/health");
  if (health.status !== 200 || !health.body?.ok) throw new Error(`backend unreachable: ${health.status} ${JSON.stringify(health.body).slice(0, 160)}`);
  pass(`backend ok version=${health.body.version}`);

  // 1. mint users
  ownerSession = await testLogin(ownerUid, "Agent QA Owner");
  const ownerMe = await api<any>("/auth/me", { session: ownerSession });
  if (ownerMe.status !== 200) throw new Error(`owner me failed: ${ownerMe.status}`);
  pass(`owner minted uid=${ownerMe.body.id} isAdmin=${ownerMe.body.isAdmin}`);
  adminSession = await testLogin(adminUid, "Agent QA Admin");
  const adminMe = await api<any>("/auth/me", { session: adminSession });
  if (adminMe.status !== 200 || !adminMe.body?.isAdmin) {
    throw new Error(`admin check failed for ${adminUid} (isAdmin=${adminMe.body?.isAdmin}) — uid must be in the DEV backend's ADMIN_IDS`);
  }
  pass(`admin minted uid=${adminMe.body.id}`);

  // 2. optional: existing routing suite with the same sessions
  if (has("--with-routing")) {
    console.log(`--- test/pipeline.ts with minted sessions ---`);
    const proc = Bun.spawnSync(["bun", "test/pipeline.ts"], {
      cwd: `${import.meta.dir}/..`,
      env: { ...Bun.env, API_BASE: base, SESSION_TOKEN: adminSession, USER_SESSION_TOKEN: ownerSession },
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode === 0) pass("routing suite (test/pipeline.ts)");
    else fail("routing suite (test/pipeline.ts)", `exit=${proc.exitCode}`);
  }

  // 3. owner wallet baseline (fresh user → 0)
  const w0 = await api<any>("/api/wallet", { session: ownerSession });
  if (w0.status !== 200) throw new Error(`owner wallet failed: ${w0.status}`);
  const balBefore = Number(w0.body?.balance ?? NaN);
  if (!Number.isFinite(balBefore)) throw new Error("owner wallet: no numeric balance");
  console.log(`owner wallet before: $${balBefore.toFixed(2)}${balBefore !== 0 ? " (not fresh — target adjusted)" : ""}`);

  // 4. owner uploads file with unique rows
  const uids = Array.from({ length: count }, () => `${run}${String(seq++).padStart(2, "0")}`);
  const rows = uids.map((u) => ({ cookies: `datr=x${u}; c_user=${u}; xs=t`, twofakey: "AAAA AAAA AAA", uid: u }));
  const created = await api<any>("/api/files", {
    body: { name: `agent-qa-${run}`, type: "fb_cookie", preset: PRESET, poolKind: PRESET, password: PWD, poolEnabled: true, rows, dataCount: rows.length },
    session: ownerSession,
  });
  if (created.status !== 200 || !created.body?.id) throw new Error(`owner upload failed: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  fileId = created.body.id as string;
  pass(`owner uploaded file=${fileId} rows=${count}`);

  // 5. wait until pooled (admin read)
  const pooled = await waitFor("pool feed", async () => {
    const r = await api<any>(`/api/pools/${PWD}/${POOL}/rows?fileId=${encodeURIComponent(fileId!)}&limit=100`, { session: adminSession });
    if (r.status !== 200 || !Array.isArray(r.body?.rows)) return false;
    const have = new Set((r.body.rows as any[]).map((x) => String(x.uid)));
    return uids.every((u) => have.has(u));
  });
  if (pooled) pass(`pooled ${count}/${count} rows in ${POOL}`);

  // 6. admin sets price (restore in cleanup)
  const cur = await api<any>(`/api/pools/${PWD}/${POOL}/price`, { session: adminSession });
  if (cur.status === 200 && Number.isFinite(Number(cur.body?.price))) origPrice = Number(cur.body.price);
  const set = await api(`/api/pools/${PWD}/${POOL}/price`, { method: "PUT", body: { price }, session: adminSession });
  if (set.status !== 200) throw new Error(`price set failed: ${set.status}`);
  pass(`price $${price} (was ${origPrice == null ? "unset" : `$${origPrice}`})`);

  // 7. admin takes HOLD of the file's rows (take side is admin-only)
  const hold = await api<any>(`/api/pools/${PWD}/${POOL}/hold`, {
    body: { count, mode: "fifo", srcFileIds: [fileId] },
    session: adminSession,
  });
  if (hold.status !== 200 || !(hold.body?.holdId || hold.body?.downloadId)) {
    throw new Error(`hold failed: ${hold.status} ${JSON.stringify(hold.body).slice(0, 200)}`);
  }
  holdId = String(hold.body.holdId || hold.body.downloadId);
  const held = Number(hold.body.held ?? hold.body.claimed ?? 0);
  if (held === count) pass(`hold ${holdId} took ${held}/${count} (unit $${Number(hold.body.unitPrice ?? price).toFixed(2)})`);
  else fail(`hold ${holdId} took ${held}/${count}`, JSON.stringify(hold.body).slice(0, 200));

  // 8. admin approves
  const appr = await api<any>(`/api/pools/holds/${holdId}/approve`, { method: "POST", session: adminSession });
  if (appr.status !== 200) fail(`approve ${holdId}`, `${appr.status} ${JSON.stringify(appr.body).slice(0, 200)}`);
  else pass(`approve ${holdId} approved=${appr.body?.approved} dead=${appr.body?.dead} paid=${appr.body?.paid}`);
  const expected = balBefore + (Number.isFinite(Number(appr.body?.paid)) ? Number(appr.body.paid) : count * price);

  // 9. owner wallet — credit lands at settle (~5min window + 30s sweep)
  const w1 = await api<any>("/api/wallet", { session: ownerSession });
  const balNow = Number(w1.body?.balance ?? NaN);
  console.log(`owner wallet after approve: $${Number.isFinite(balNow) ? balNow.toFixed(2) : "?"} (target $${expected.toFixed(2)} at settle)`);
  if (has("--wait-settle")) {
    const ok = await waitFor("settle credit", async () => {
      const w = await api<any>("/api/wallet", { session: ownerSession });
      return w.status === 200 && Number(w.body?.balance ?? -1) >= expected - 1e-9;
    }, settleTimeout);
    if (ok) {
      settled = true;
      pass(`settled — owner credited $${expected.toFixed(2)}`);
    }
  } else if (Number.isFinite(balNow) && balNow >= expected - 1e-9) {
    settled = true;
    pass(`owner already credited $${expected.toFixed(2)}`);
  } else {
    console.log(`INFO settlement pending (5-min revert window + 30s sweep) — re-run with --wait-settle to block for it`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(fails.length ? `FAILURES:\n- ${fails.join("\n- ")}` : "All pipeline checks passed.");
  if (fails.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  fail("pipeline aborted", String((e as Error)?.message || e).slice(0, 300));
  process.exitCode = 1;
} finally {
  try { await cleanup(); } catch (e) { console.log(`CLEANUP error: ${String(e).slice(0, 160)}`); }
}
