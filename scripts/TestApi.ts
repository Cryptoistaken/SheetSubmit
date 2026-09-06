// load .env from same directory as this script
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const env = readFileSync(resolve(__dirname, ".env"), "utf8");
  for (const line of env.split("\n")) {
    const [k, ...rest] = line.split("=");
    const v = rest.join("=").trim();
    if (k && !process.env[k.trim()]) process.env[k.trim()] = v;
  }
} catch {}

const BASE = "https://sheetsubmit.traderspopy.workers.dev/api";
const SECRET = process.env.TEST_SESSION_SECRET;
const EXPECT_VERSION = process.env.EXPECT_VERSION; // fail fast if live worker is not the redeployed version yet
const TEST_UID = process.env.TEST_UID || "8447133985";
if (!SECRET) throw new Error("Set TEST_SESSION_SECRET before running this live test");

// ── Filter: `bun scripts/TestApi.ts <f...>` or TEST_FILTER="<f...>" (space/comma-separated).
// Each filter is a test number (90), range (55-70), or case-insensitive name substring (claim).
// Numbers are stable file order (shown in output). Stateful tests need their setup tests — include those ranges too.
const FILTER_ARG = (process.env.TEST_FILTER || process.argv.slice(2).map((a) => a.replace(/^-+/, "").replace(/^(filter|only|grep)=/, "")).join(" ")).trim();
const FILTERS = FILTER_ARG.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
if (FILTERS.includes("h") || FILTERS.includes("help")) {
  console.log(`Usage: bun scripts/TestApi.ts [number|range|substring ...]\n  bun scripts/TestApi.ts 90-97       # only tests 90–97\n  bun scripts/TestApi.ts claim pools # any test with "claim" or "pools" in the name\n  TEST_FILTER=archive bun scripts/TestApi.ts`);
  process.exit(0);
}

// ── HMAC session signer (mirrors worker/src/lib/session.ts) ──
const enc = new TextEncoder();
const b64 = (v: ArrayBuffer | string) =>
  btoa(typeof v === "string" ? v : String.fromCharCode(...new Uint8Array(v)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
async function signSession(uid: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = b64(JSON.stringify({ uid, exp: Date.now() + 30 * 86400000 }));
  const sig = b64(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${sig}`;
}

// ── Test runner ──
let passed = 0, failed = 0, total = 0, seq = 0, skipped = 0;
const results: string[] = [];
const matchFilter = (name: string, id: number) =>
  !FILTERS.length || FILTERS.some((f) => {
    const m = f.match(/^(\d+)-(\d+)$/);
    if (m) return id >= +m[1] && id <= +m[2];
    if (/^\d+$/.test(f)) return id === +f;
    return name.toLowerCase().includes(f);
  });

async function test(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) {
  const id = ++seq;
  if (!matchFilter(name, id)) { skipped++; return; }
  total++;
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    if (r.ok) { passed++; results.push(`\x1b[32m✅ PASS\x1b[0m  ${String(id).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m`); }
    else { failed++; results.push(`\x1b[31m❌ FAIL\x1b[0m  ${String(id).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m\n         ${r.detail ?? ""}`); }
  } catch (e) {
    const ms = Date.now() - t0;
    failed++;
    results.push(`\x1b[31m❌ ERROR\x1b[0m ${String(id).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m\n         ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ponytail: single 61s retry on 429 — the suite fires >10 claim POSTs and pool.claim caps at 10/min/IP
async function api(path: string, init?: RequestInit) {
  const once = async () => {
    const res = await fetch(BASE + path, { ...init, redirect: "manual" });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, headers: res.headers, json, text };
  };
  const first = await once();
  if (first.status !== 429) return first;
  await new Promise((r) => setTimeout(r, 61000));
  return once();
}

// polling helper: wait until rows endpoint reports expected total (handles waitUntil feedPools/archive)
async function pollRowsTotal(password: string, pool: string, qs: string, expected: number, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  const base = "/pools/" + password + "/" + pool + "/rows";
  const q = qs ? (qs.startsWith("?") ? qs : "?" + qs) : "?limit=1000";
  while (Date.now() < deadline) {
    const r = await api(base + q, { headers: { Cookie: cookie } });
    last = r.json;
    const total = typeof last?.total === "number" ? last.total : (Array.isArray(last?.rows) ? last.rows.length : -1);
    if (r.status === 200 && total === expected) return last;
    await new Promise((res) => setTimeout(res, 150));
  }
  return last;
}

// ── Tests ──
let cookie = "";
let testFileId = "";

const run = async () => {
  const sign = await signSession(TEST_UID);
  cookie = `ss_session=${sign}`;

  // idempotent pre-pass: revert leftover downloads from previous runs
  for (const pwd of ["dgddigital", "L0VE@12345"]) {
    const list = await api(`/pools/downloads`, { headers: { Cookie: cookie } });
    for (const d of (Array.isArray(list.json) ? list.json : []).filter((d: any) => d.password === pwd && !d.reverted)) {
      await api(`/pools/downloads/${d.id}/revert`, { method: "POST", headers: { Cookie: cookie } });
    }
  }

  await test("GET /api/health", async () => {
    const r = await api("/health");
    if (r.status !== 200 || r.json?.ok !== true || typeof r.json?.version !== "string")
      return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
    if (EXPECT_VERSION && r.json.version !== EXPECT_VERSION)
      return { ok: false, detail: `version=${r.json.version} expected=${EXPECT_VERSION} — redeploy hasn't landed yet` };
    console.log(`   live API version: ${r.json.version}`);
    return { ok: true };
  });

  await test("GET /api/bot/info", async () => {
    const r = await api("/bot/info");
    return r.status === 200 && typeof r.json?.username === "string"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/auth/telegram/config", async () => {
    const r = await api("/auth/telegram/config");
    return r.status === 200 && typeof r.json?.clientId === "string"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/auth/telegram/verify (invalid token)", async () => {
    const r = await api("/auth/telegram/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: "not-a-jwt" }),
    });
    return [401, 403, 503].includes(r.status)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/auth/me (no cookie) → 401", async () => {
    const r = await api("/auth/me");
    return r.status === 401 && r.json?.error === "not_authenticated"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/auth/me (valid cookie) → 200", async () => {
    const r = await api("/auth/me", { headers: { Cookie: cookie } });
    return r.status === 200 && (r.json?.user_id === TEST_UID || r.json?.id === TEST_UID)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/files (list)", async () => {
    const r = await api("/files", { headers: { Cookie: cookie } });
    return r.status === 200 && Array.isArray(r.json)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/files (create)", async () => {
    const r = await api("/files", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TestApi Run", type: "fb_cookie", password: "dgddigital", poolEnabled: false }),
    });
    if (r.status === 200 && r.json?.id && r.json?.lastAction === "created") { testFileId = r.json.id; return { ok: true }; }
    return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/files/:id/rows", async () => {
    const r = await api(`/files/${testFileId}/rows`, { headers: { Cookie: cookie } });
    return r.status === 200 && Array.isArray(r.json)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/files/:id/full", async () => {
    const r = await api(`/files/${testFileId}/full`, { headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.file && Array.isArray(r.json?.rows) && typeof r.json?.seq === "number"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("PUT /api/files/:id (rename)", async () => {
    const r = await api(`/files/${testFileId}`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "TestApi Renamed" }),
    });
    return r.status === 200 && r.json?.name === "TestApi Renamed" && r.json?.lastAction === "renamed"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("PUT /api/files/:id/persist (save 3 rows)", async () => {
    const rows = [
      { cookies: "c_user=111", uid: "111", twofakey: "", wa_status: "" },
      { cookies: "c_user=222", uid: "222", twofakey: "", wa_status: "" },
      { cookies: "c_user=333", uid: "333", twofakey: "", wa_status: "" },
    ];
    const r = await api(`/files/${testFileId}/persist`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ rows, action: "edit" }),
    });
    return r.status === 200 && r.json?.ok === true && typeof r.json?.seq === "number"
      && typeof r.json?.file?.liveCount === "number" && typeof r.json?.file?.deadCount === "number"
      && typeof r.json?.file?.pageCount === "number" && typeof r.json?.file?.lastAction === "string"
      && typeof r.json?.file?.dupCount === "number"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/files/:id/rows (verify 3 rows)", async () => {
    const r = await api(`/files/${testFileId}/rows`, { headers: { Cookie: cookie } });
    const count = Array.isArray(r.json) ? r.json.filter((row: any) => row?.cookies).length : 0;
    return r.status === 200 && count === 3
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} got ${count} rows with cookies, body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  let currentSeq = 0;
  await test("GET /api/files/:id/full → get seq", async () => {
    const r = await api(`/files/${testFileId}/full`, { headers: { Cookie: cookie } });
    currentSeq = r.json?.seq ?? 0;
    return typeof currentSeq === "number" && currentSeq > 0
      ? { ok: true }
      : { ok: false, detail: `seq=${currentSeq} body=${JSON.stringify(r.json)}` };
  });

  await test("PUT /api/files/:id/append (correct base)", async () => {
    const r = await api(`/files/${testFileId}/append`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ base: currentSeq, ops: [{ rowIdx: 0, cols: { uid: "999" } }] }),
    });
    return r.status === 200 && r.json?.ok === true && r.json?.seq === currentSeq + 1
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)} (expected seq=${currentSeq + 1})` };
  });

  await test("PUT /api/files/:id/append (wrong base) → 409", async () => {
    const r = await api(`/files/${testFileId}/append`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ base: 0, ops: [{ rowIdx: 0, cols: { uid: "111" } }] }),
    });
    return r.status === 409
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 409) body=${JSON.stringify(r.json)}` };
  });

  await test("PUT /api/files/:id/append (invalid payload) → 400", async () => {
    const r = await api(`/files/${testFileId}/append`, {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ base: "not a number", ops: "not array" }),
    });
    return r.status === 400
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 400) body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/auth/turnstile-verify (no token) → 403", async () => {
    const r = await api("/auth/turnstile-verify", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return r.status === 403 && r.json?.ok === false
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/auth/turnstile-verify (fake token) → 403", async () => {
    const r = await api("/auth/turnstile-verify", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "fake.dummy.token" }),
    });
    return r.status === 403 && r.json?.ok === false
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/auth/turnstile-verify (no body) → 403", async () => {
    const r = await api("/auth/turnstile-verify", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    return r.status === 403
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/admin/stats (as admin)", async () => {
    const r = await api("/admin/stats", { headers: { Cookie: cookie } });
    return r.status === 200 && typeof r.json?.totalUsers === "number"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/admin/users (as admin)", async () => {
    const r = await api("/admin/users", { headers: { Cookie: cookie } });
    return r.status === 200 && Array.isArray(r.json)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("GET /api/admin/user/:id (self)", async () => {
    const r = await api(`/admin/user/${TEST_UID}`, { headers: { Cookie: cookie } });
    return r.status === 200
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/admin/file/:id (test file)", async () => {
    const r = await api(`/admin/file/${testFileId}`, { headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.id === testFileId
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/pools (admin, array format)", async () => {
    const r = await api("/pools", { headers: { Cookie: cookie } });
    const pools = r.json?.pools;
    const valid = Array.isArray(pools) && pools.length > 0 && pools.every((p: any) => typeof p.id === "string" && typeof p.available === "number" && typeof p.password === "string" && typeof p.label === "string");
    return r.status === 200 && valid
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/pools/:pwd/:pool (detail format)", async () => {
    const r = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && r.json?.pool?.id === "cookies_only" && r.json?.password === "dgddigital"
      && typeof r.json?.totals?.available === "number" && Array.isArray(r.json?.users);
    return ok
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/pools/:pwd/:pool/rows (paginated format)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/rows?limit=10", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && r.json?.password === "dgddigital" && r.json?.poolId === "cookies_only"
      && typeof r.json?.total === "number" && r.json?.offset === 0 && r.json?.limit === 10 && Array.isArray(r.json?.rows);
    return ok
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/pools/:pwd/:pool/ledger", async () => {
    const r = await api("/pools/dgddigital/cookies_only/ledger", { headers: { Cookie: cookie } });
    return r.status === 200 && Array.isArray(r.json?.ledger)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("POST /api/pools/:pwd/:pool/claim (fresh empty pool) → 0", async () => {
    const r = await api("/pools/testpool_unused/cookies_only/claim", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });
    return r.status === 200 && r.json?.password === "testpool_unused" && r.json?.poolId === "cookies_only" && r.json?.claimed === 0 && Array.isArray(r.json?.rows) && !r.json?.downloadId
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/pools/:pwd/:pool (invalid pool) → 400", async () => {
    const r = await api("/pools/dgddigital/notapool", { headers: { Cookie: cookie } });
    return r.status === 400
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 400) body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/wa/cache (old shape)", async () => {
    const r = await api("/wa/cache?uids=111", { headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.cache !== undefined
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/archive (empty)", async () => {
    const r = await api("/archive", { headers: { Cookie: cookie } });
    return r.status === 200 && Array.isArray(r.json)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  let archivedFileId = "";
  await test("archive lifecycle: create → persist → delete → archive has deletedAt", async () => {
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "ArchiveTest" }) });
    if (cr.status !== 200 || !cr.json?.id) return { ok: false, detail: `create ${cr.status}` };
    archivedFileId = cr.json.id;
    await api(`/files/${archivedFileId}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: "c_user=777", uid: "777" }] }) });
    const del = await api(`/files/${archivedFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    if (del.status !== 200) return { ok: false, detail: `delete ${del.status}` };
    const arch = await api("/archive", { headers: { Cookie: cookie } });
    const found = Array.isArray(arch.json) && arch.json.find((f: any) => f.id === archivedFileId && f.deletedAt && f.lastAction === "archived");
    return found ? { ok: true } : { ok: false, detail: `archive=${JSON.stringify(arch.json).slice(0, 200)}` };
  });

  await test("POST /api/archive/:id/restore", async () => {
    const r = await api(`/archive/${archivedFileId}/restore`, { method: "POST", headers: { Cookie: cookie } });
    const files = await api("/files", { headers: { Cookie: cookie } });
    const back = Array.isArray(files.json) && files.json.find((f: any) => f.id === archivedFileId && !f.deletedAt);
    return r.status === 200 && r.json?.ok && back?.lastAction === "restored" ? { ok: true } : { ok: false, detail: `restore=${r.status} back=${JSON.stringify(back)?.slice(0, 150)}` };
  });

  await test("POST /api/archive/batch-restore", async () => {
    await api(`/files/${archivedFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api("/archive/batch-restore", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [archivedFileId] }) });
    const files = await api("/files", { headers: { Cookie: cookie } });
    const back = Array.isArray(files.json) && files.json.find((f: any) => f.id === archivedFileId && f.lastAction === "restored");
    return r.status === 200 && r.json?.restored === 1 && back ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)} back=${JSON.stringify(back)?.slice(0, 100)}` };
  });

  await test("POST /api/archive/batch-delete (permanent)", async () => {
    await api(`/files/${archivedFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [archivedFileId] }) });
    const arch = await api("/archive", { headers: { Cookie: cookie } });
    const gone = Array.isArray(arch.json) && !arch.json.find((f: any) => f.id === archivedFileId);
    return r.status === 200 && r.json?.deleted === 1 && gone ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  let dupA = "", dupB = "";
  await test("GET /api/cross-dups?fileId (with real dups)", async () => {
    const a = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DupA" }) });
    const b = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DupB" }) });
    if (a.status !== 200 || b.status !== 200) return { ok: false, detail: `create failed ${a.status}/${b.status}` };
    dupA = a.json.id; dupB = b.json.id;
    const row = { cookies: "c_user=555666777", uid: "555666777", twofakey: "" };
    for (const id of [dupA, dupB]) await api(`/files/${id}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [row] }) });
    const r = await api(`/cross-dups?fileId=${dupA}`, { headers: { Cookie: cookie } });
    const ok = r.status === 200 && r.json?.counts && r.json?.counts[dupA] >= 1 && r.json?.dups && r.json?.dups["555666777"]?.length === 2;
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/cross-dups (no fileId → counts only)", async () => {
    const r = await api("/cross-dups", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && typeof r.json?.counts === "object" && r.json?.counts[dupA] >= 1;
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("cleanup dup files (permanent)", async () => {
    for (const id of [dupA, dupB]) { await api(`/files/${id}`, { method: "DELETE", headers: { Cookie: cookie } }); await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [id] }) }); }
    const files = await api("/files", { headers: { Cookie: cookie } });
    const gone = Array.isArray(files.json) && !files.json.find((f: any) => f.id === dupA || f.id === dupB);
    return gone ? { ok: true } : { ok: false, detail: "dup files still present" };
  });

  await test("POST /api/fb/page-check (no cookie) → 400", async () => {
    const r = await api("/fb/page-check", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    return r.status === 400 && r.json?.error === "Cookie required"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/fb/page-check (fake cookie) → graceful error", async () => {
    const r = await api("/fb/page-check", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cookie: "c_user=1; xs=fake" }) });
    return r.status === 200 && r.json?.eligible === false && typeof r.json?.error === "string"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("POST /api/fb/wa-check (no cookie) → 400", async () => {
    const r = await api("/fb/wa-check", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    return r.status === 400 && r.json?.error === "Cookie required"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/fb/wa-check (fake cookie) → graceful error", async () => {
    const r = await api("/fb/wa-check", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ cookie: "c_user=1; xs=fake" }) });
    return r.status === 200 && r.json?.eligible === false && typeof r.json?.error === "string"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("GET /api/auth/me → CDN photoUrl + phone shape", async () => {
    const r = await api("/auth/me", { headers: { Cookie: cookie } });
    const u = r.json as any;
    const ok = r.status === 200 && u && "photoUrl" in u && "phone" in u && (u.photoUrl === null || /^https:\/\//.test(u.photoUrl));
    return ok
      ? { ok: true, detail: `photoUrl=${String(u.photoUrl).slice(0, 60)} phone=${u.phone ?? "none"}` }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(u).slice(0, 200)}` };
  });

  await test("GET /api/auth/photo/:userId → removed (404)", async () => {
    const r = await api(`/auth/photo/${TEST_UID}`, { headers: { Cookie: cookie } });
    return r.status === 404 ? { ok: true } : { ok: false, detail: `status=${r.status} expected 404` };
  });

  await test("GET /api/admin/users/search?q=", async () => {
    const r = await api("/admin/users/search?q=Crypto", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && Array.isArray(r.json) && r.json.some((u: any) => String(u.id) === TEST_UID && typeof u.fileCount === "number" && "photoUrl" in u);
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("GET /api/admin/user/:id (detail with files)", async () => {
    const r = await api(`/admin/user/${TEST_UID}`, { headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.id === TEST_UID && Array.isArray(r.json?.files) && typeof r.json?.fileCount === "number"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  let adminFileId = "";
  await test("admin file ops: PUT rename / rows / persist / logs / undo", async () => {
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "AdminFileTest", password: "dgddigital", poolEnabled: false }) });
    if (cr.status !== 200) return { ok: false, detail: `create ${cr.status}` };
    adminFileId = cr.json.id;
    const put = await api(`/admin/file/${adminFileId}`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "AdminRenamed" }) });
    const rows = await api(`/admin/file/${adminFileId}/rows`, { headers: { Cookie: cookie } });
    const persist = await api(`/admin/file/${adminFileId}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: "c_user=888", uid: "888" }] }) });
    const logs = await api(`/admin/file/${adminFileId}/logs`, { headers: { Cookie: cookie } });
    const undo = await api(`/admin/file/${adminFileId}/undo`, { headers: { Cookie: cookie } });
    const ok = put.status === 200 && put.json?.name === "AdminRenamed"
      && rows.status === 200 && Array.isArray(rows.json)
      && persist.status === 200 && persist.json?.ok === true && typeof persist.json?.seq === "number"
      && logs.status === 200 && Array.isArray(logs.json) && logs.json.length >= 1
      && undo.status === 200 && Array.isArray(undo.json?.undo) && Array.isArray(undo.json?.redo);
    return ok ? { ok: true } : { ok: false, detail: `put=${put.status} rows=${rows.status} persist=${persist.status} logs=${logs.status}(${JSON.stringify(logs.json).slice(0, 80)}) undo=${undo.status}` };
  });

  await test("admin archive ops: DELETE file → user archive → restore", async () => {
    const del = await api(`/admin/file/${adminFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const arch = await api(`/admin/user/${TEST_UID}/archive`, { headers: { Cookie: cookie } });
    const found = Array.isArray(arch.json) && arch.json.find((f: any) => f.id === adminFileId);
    const restore = await api(`/admin/user/${TEST_UID}/archive/${adminFileId}/restore`, { method: "POST", headers: { Cookie: cookie } });
    return del.status === 200 && found && restore.status === 200
      ? { ok: true }
      : { ok: false, detail: `del=${del.status} archFound=${!!found} restore=${restore.status}` };
  });

  await test("admin DELETE /api/admin/user/:id/archive/:fileId (permanent)", async () => {
    await api(`/admin/file/${adminFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api(`/admin/user/${TEST_UID}/archive/${adminFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const arch = await api(`/admin/user/${TEST_UID}/archive`, { headers: { Cookie: cookie } });
    const gone = Array.isArray(arch.json) && !arch.json.find((f: any) => f.id === adminFileId);
    return r.status === 200 && gone ? { ok: true } : { ok: false, detail: `status=${r.status} gone=${gone}` };
  });

  await test("DELETE /api/admin/user/:id (nonexistent) → ok", async () => {
    const r = await api("/admin/user/999999999", { method: "DELETE", headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.ok === true
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  let feedFileId = "";
  let downloadId = "";
  let availBefore = 0;
  let claimedCount = 0;
  await test("pool feed: persist row with c_user → pool counts increase", async () => {
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "PoolFeedTest", password: "dgddigital", poolEnabled: true }) });
    if (cr.status !== 200) return { ok: false, detail: `create ${cr.status}` };
    feedFileId = cr.json.id;
    const p = await api(`/files/${feedFileId}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: "c_user=100200300; xs=abc", uid: "100200300", twofakey: "" }] }) });
    if (p.status !== 200) return { ok: false, detail: `persist ${p.status}` };
    const r = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    const avail = r.json?.totals?.available ?? 0;
    return avail >= 1 ? { ok: true } : { ok: false, detail: `available=${avail} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("POST /api/pools/:pwd/:pool/claim → downloadId + rows", async () => {
    const before = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    availBefore = before.json?.totals?.available ?? 0;
    const r = await api("/pools/dgddigital/cookies_only/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 10000 }) });
    downloadId = r.json?.downloadId || "";
    claimedCount = r.json?.claimed ?? 0;
    return r.status === 200 && claimedCount === availBefore && claimedCount >= 1 && downloadId && Array.isArray(r.json?.rows) && r.json.rows.length === claimedCount
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} claimed=${claimedCount} availBefore=${availBefore} downloadId=${downloadId}` };
  });

  await test("GET /api/pools/downloads (history)", async () => {
    const r = await api("/pools/downloads", { headers: { Cookie: cookie } });
    const found = Array.isArray(r.json) && r.json.find((d: any) => d.id === downloadId && d.password === "dgddigital");
    return r.status === 200 && found ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("GET /api/pools/downloads/:id → xlsx blob", async () => {
    const r = await api(`/pools/downloads/${downloadId}`, { headers: { Cookie: cookie } });
    const isXlsx = r.status === 200 && /spreadsheetml/.test(r.headers.get("content-type") || "") && r.text.length > 100;
    return isXlsx ? { ok: true } : { ok: false, detail: `status=${r.status} ct=${r.headers.get("content-type")} len=${r.text.length}` };
  });

  await test("POST /api/pools/downloads/:id/revert → rows back to pool", async () => {
    const r = await api(`/pools/downloads/${downloadId}/revert`, { method: "POST", headers: { Cookie: cookie } });
    const detail = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    const avail = detail.json?.totals?.available ?? 0;
    return r.status === 200 && r.json?.ok && r.json?.reverted === claimedCount && avail === availBefore
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)} avail=${avail} expected=${availBefore}` };
  });

  await test("cleanup pool feed file (permanent)", async () => {
    await api(`/files/${feedFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [feedFileId] }) });
    return r.status === 200 && r.json?.deleted === 1 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  // ── Preset-aware file creation & pool routing ──
  const uniq = () => String(Date.now()).slice(-6) + String(Math.floor(Math.random()*90+10));
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  let cookiePresetFileId = "";
  let comboPresetFileId = "";
  let pagePresetFileId = "";
  let poolKindAliasFileId = "";
  let poolKindAliasSecondId = "";
  const su = uniq();
  const cookieUid = `880${su}1`.slice(0,12);
  const comboUid = `880${su}2`.slice(0,12);
  const pageVerifiedUid = `880${su}3`.slice(0,12);
  const pageUnverifiedUid = `880${su}4`.slice(0,12);
  const extraPageUid = `880${su}5`.slice(0,12);
  const newDownloads: string[] = [];

  await test("POST /api/files (preset=cookie, preset+poolKind persisted)", async () => {
    const r = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "TestApiPresetCookie"+su, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    if (r.status===200 && r.json?.id && r.json?.preset==="cookie" && r.json?.poolKind==="cookie") { cookiePresetFileId=r.json.id; return {ok:true}; }
    return { ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,300)} preset=${r.json?.preset} poolKind=${r.json?.poolKind}` };
  });

  await test("POST /api/files (poolKind=combo alias, normalized to preset)", async () => {
    const r = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "TestApiPresetCombo"+su, poolKind: "combo", password: "dgddigital", poolEnabled: true }) });
    if (r.status===200 && r.json?.id && r.json?.preset==="combo" && r.json?.poolKind==="combo") { comboPresetFileId=r.json.id; return {ok:true}; }
    return { ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,300)} preset=${r.json?.preset} poolKind=${r.json?.poolKind}` };
  });

  await test("POST /api/files (preset=page)", async () => {
    const r = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "TestApiPresetPage"+su, preset: "page", password: "dgddigital", poolEnabled: true }) });
    if (r.status===200 && r.json?.id && r.json?.preset==="page" && r.json?.poolKind==="page") { pagePresetFileId=r.json.id; return {ok:true}; }
    return { ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}` };
  });

  await test("POST /api/files (poolKind=page alias + preset=2fa normalized to combo)", async () => {
    const r1 = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "TestApiPoolKindPage"+su, poolKind: "page", password: "dgddigital", poolEnabled: true }) });
    const r2 = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "TestApiPreset2Fa"+su, preset: "2fa", password: "dgddigital", poolEnabled: true }) });
    poolKindAliasFileId = r1.json?.id || "";
    poolKindAliasSecondId = r2.json?.id || "";
    if (r1.status!==200 || !r1.json?.id || r1.json?.preset!=="page") return {ok:false, detail:`poolKind page: ${r1.status} ${JSON.stringify(r1.json).slice(0,200)}`};
    if (r2.status!==200 || !r2.json?.id || r2.json?.preset!=="combo") return {ok:false, detail:`preset 2fa->combo: ${r2.status} ${JSON.stringify(r2.json).slice(0,200)}`};
    await api(`/files/${r2.json.id}`, {method:"DELETE", headers:{Cookie:cookie}});
    const del2 = await api("/archive/batch-delete", {method:"POST", headers:{Cookie:cookie, "Content-Type":"application/json"}, body:JSON.stringify({ids:[r2.json.id]})});
    if (del2.status===200) poolKindAliasSecondId = "";
    return {ok:true};
  });

  await test("PUT /api/files/:id (update preset/poolKind)", async () => {
    const r = await api(`/files/${cookiePresetFileId}`, { method:"PUT", headers:{Cookie:cookie, "Content-Type":"application/json"}, body:JSON.stringify({ preset:"page" })});
    const ok1 = r.status===200 && r.json?.preset==="page" && r.json?.poolKind==="page";
    if (!ok1) return {ok:false, detail:`to page: status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    const r2 = await api(`/files/${cookiePresetFileId}`, { method:"PUT", headers:{Cookie:cookie, "Content-Type":"application/json"}, body:JSON.stringify({ poolKind:"cookie" })});
    const ok2 = r2.status===200 && r2.json?.preset==="cookie" && r2.json?.poolKind==="cookie";
    return ok2 ? {ok:true} : {ok:false, detail:`back to cookie: status=${r2.status} body=${JSON.stringify(r2.json).slice(0,200)}`};
  });

  await test("preset routing: cookie→cookies_only, combo→cookies_2fa, page(unverified)→page", async () => {
    const ck = await api(`/files/${cookiePresetFileId}/persist`, { method:"PUT", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({rows:[{cookies:`c_user=${cookieUid}; xs=abc`, uid:cookieUid}]})});
    const co = await api(`/files/${comboPresetFileId}/persist`, { method:"PUT", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({rows:[{cookies:`c_user=${comboUid}; xs=abc`, uid:comboUid, twofakey:"ABCDEF123456"}]})});
    const pg = await api(`/files/${pagePresetFileId}/persist`, { method:"PUT", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({rows:[
      {cookies:`c_user=${pageVerifiedUid}; xs=abc`, uid:pageVerifiedUid, twofakey:"VERIFYKEY1", wa_status:"eligible"},
      {cookies:`c_user=${pageUnverifiedUid}; xs=abc`, uid:pageUnverifiedUid, twofakey:"VERIFYKEY2", wa_status:"not_eligible"},
      {cookies:`c_user=${extraPageUid}; xs=abc`, uid:extraPageUid, twofakey:"VERIFYKEY3", wa_status:""},
    ]})});
    if (ck.status!==200 || co.status!==200 || pg.status!==200) return {ok:false, detail:`persist ck=${ck.status} co=${co.status} pg=${pg.status} bodies ${JSON.stringify(ck.json).slice(0,80)}/${JSON.stringify(co.json).slice(0,80)}/${JSON.stringify(pg.json).slice(0,80)}`};
    // waitUntil feedPools is async — poll until expected totals appear
    await pollRowsTotal("dgddigital", "page", `limit=1000&srcFileId=${pagePresetFileId}`, 3, 5000);
    await pollRowsTotal("dgddigital", "cookies_2fa", `limit=1000&srcFileId=${comboPresetFileId}`, 1, 5000);
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${cookiePresetFileId}`, 1, 5000);
    const pageRows = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    const comboRows = await api(`/pools/dgddigital/cookies_2fa/rows?limit=1000&srcFileId=${comboPresetFileId}`, {headers:{Cookie:cookie}});
    const cookieRows = await api(`/pools/dgddigital/cookies_only/rows?limit=1000&srcFileId=${cookiePresetFileId}`, {headers:{Cookie:cookie}});
    const pageRowUids = Array.isArray(pageRows.json?.rows) ? pageRows.json.rows.map((r:any)=>String(r.uid)) : [];
    const comboRowUids = Array.isArray(comboRows.json?.rows) ? comboRows.json.rows.map((r:any)=>String(r.uid)) : [];
    const cookieRowUids = Array.isArray(cookieRows.json?.rows) ? cookieRows.json.rows.map((r:any)=>String(r.uid)) : [];
    const pageHasVerified = pageRowUids.includes(pageVerifiedUid);
    const pageHasUnverified = pageRowUids.includes(pageUnverifiedUid);
    const pageHasExtra = pageRowUids.includes(extraPageUid);
    const comboHas = comboRowUids.includes(comboUid);
    const cookieHas = cookieRowUids.includes(cookieUid);
    const crossCheck = await api(`/pools/dgddigital/cookies_2fa/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    const leakedTo2fa = Array.isArray(crossCheck.json?.rows) && crossCheck.json.rows.some((r:any)=>String(r.uid)===pageUnverifiedUid);
    const comboInPage = pageRowUids.includes(comboUid);
    if (!pageHasVerified || !pageHasUnverified || !pageHasExtra) return {ok:false, detail:`page rows missing verified=${pageHasVerified} unverified=${pageHasUnverified} extra=${pageHasExtra} got ${JSON.stringify(pageRowUids).slice(0,200)} page status ${pageRows.status}`};
    if (leakedTo2fa) return {ok:false, detail:`page unverified leaked to cookies_2fa: ${JSON.stringify(crossCheck.json?.rows?.slice(0,2))}`};
    if (comboInPage) return {ok:false, detail:`combo row leaked to page`};
    if (!comboHas) return {ok:false, detail:`combo row missing in cookies_2fa: got ${JSON.stringify(comboRowUids).slice(0,200)} status ${comboRows.status}`};
    if (!cookieHas) return {ok:false, detail:`cookie row missing in cookies_only: got ${JSON.stringify(cookieRowUids).slice(0,200)} status ${cookieRows.status}`};
    if (!(Array.isArray(comboRows.json?.rows) && comboRows.json.rows.every((r:any)=> String(r.twofakey||"").trim() && String(r.twofakey)!=="No_2Fa"))) return {ok:false, detail:`combo rows missing twofakey`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/verified-counts (page pool, shape + verified/unverified)", async () => {
    const r = await api("/pools/dgddigital/page/verified-counts", {headers:{Cookie:cookie}});
    if (r.status!==200) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}`};
    const j=r.json as any;
    const shapeOk = typeof j.verified==="number" && typeof j.unverified==="number" && typeof j.totalAvailable==="number" && typeof j.pool==="string" && j.pool==="page";
    if (!shapeOk) return {ok:false, detail:`shape ${JSON.stringify(j).slice(0,300)}`};
    const pageRowsAll = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    const verifiedForFile = Array.isArray(pageRowsAll.json?.rows) ? pageRowsAll.json.rows.filter((r:any)=> String(r.wa_status||r.waStatus||"").toLowerCase()==="eligible").length : 0;
    const unverifiedForFile = Array.isArray(pageRowsAll.json?.rows) ? pageRowsAll.json.rows.filter((r:any)=> String(r.wa_status||r.waStatus||"").toLowerCase()!=="eligible").length : 0;
    if (verifiedForFile!==1 || unverifiedForFile!==2) return {ok:false, detail:`file-scoped verified=${verifiedForFile} unverified=${unverifiedForFile} expected 1/2`};
    if (j.verified <1 || j.unverified <1) return {ok:false, detail:`global counts verified=${j.verified} unverified=${j.unverified} expected >=1 each body=${JSON.stringify(j).slice(0,200)}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/page-counts alias (page)", async () => {
    const a = await api("/pools/dgddigital/page/verified-counts", {headers:{Cookie:cookie}});
    const b = await api("/pools/dgddigital/page/page-counts", {headers:{Cookie:cookie}});
    if (b.status!==200) return {ok:false, detail:`page-counts status=${b.status} body=${JSON.stringify(b.json).slice(0,200)}`};
    const eq = a.json?.verified===b.json?.verified && a.json?.unverified===b.json?.unverified && a.json?.pool===b.json?.pool;
    return eq ? {ok:true} : {ok:false, detail:`verified-counts ${JSON.stringify(a.json).slice(0,200)} vs page-counts ${JSON.stringify(b.json).slice(0,200)}`};
  });

  await test("GET /pools/:pwd/:pool/verified-counts (cookies_only, non-page)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/verified-counts", {headers:{Cookie:cookie}});
    if (r.status!==200) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (typeof r.json?.verified!=="number" || typeof r.json?.unverified!=="number" || typeof r.json?.totalAvailable!=="number") return {ok:false, detail:`shape ${JSON.stringify(r.json).slice(0,200)}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/verified-counts (cookies_2fa)", async () => {
    const r = await api("/pools/dgddigital/cookies_2fa/verified-counts", {headers:{Cookie:cookie}});
    if (r.status!==200) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (r.json?.pool!=="cookies_2fa") return {ok:false, detail:`pool=${r.json?.pool}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/verified-counts (invalid pool) → 400", async () => {
    const r = await api("/pools/dgddigital/notapool/verified-counts", {headers:{Cookie:cookie}});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("GET /pools/:pwd/:pool/rows?srcUid filter", async () => {
    const r = await api(`/pools/dgddigital/page/rows?limit=1000&srcUid=${TEST_UID}`, {headers:{Cookie:cookie}});
    const hasPageVerified = Array.isArray(r.json?.rows) && r.json.rows.some((x:any)=>String(x.uid)===pageVerifiedUid);
    const hasCombo = Array.isArray(r.json?.rows) && r.json.rows.some((x:any)=>String(x.uid)===comboUid);
    if (r.status!==200 || !Array.isArray(r.json?.rows)) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (!hasPageVerified) return {ok:false, detail:`srcUid filter missing pageVerifiedUid, got ${r.json.rows.length} rows`};
    if (hasCombo) return {ok:false, detail:`srcUid page rows incorrectly contains comboUid`};
    if (!r.json.rows.every((x:any)=> String(x._srcUid)===TEST_UID)) return {ok:false, detail:`every row must have _srcUid=${TEST_UID}, got ${JSON.stringify(r.json.rows.slice(0,2))}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/rows?srcFileId filter", async () => {
    const r = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (r.status!==200 || !Array.isArray(r.json?.rows) || r.json.rows.length!==3) return {ok:false, detail:`status=${r.status} total=${r.json?.total} rows=${JSON.stringify(r.json?.rows)?.slice(0,200)} expected 3`};
    const allSameFile = r.json.rows.every((x:any)=> String(x._srcFileId||"")===pagePresetFileId);
    if (!allSameFile) return {ok:false, detail:`_srcFileId mismatch ${JSON.stringify(r.json.rows.slice(0,2))}`};
    if (!r.json.rows.every((x:any)=> String(x._srcUid)===TEST_UID)) return {ok:false, detail:`every row must have _srcUid=${TEST_UID}, got ${JSON.stringify(r.json.rows.slice(0,2))}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/rows?srcFileId+srcUid combined", async () => {
    const r = await api(`/pools/dgddigital/page/rows?limit=1000&srcUid=${TEST_UID}&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (r.status!==200 || r.json?.total!==3) return {ok:false, detail:`status=${r.status} total=${r.json?.total} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (!Array.isArray(r.json?.rows) || !r.json.rows.every((x:any)=> String(x._srcUid)===TEST_UID && String(x._srcFileId)===pagePresetFileId)) return {ok:false, detail:`every row must have _srcUid=${TEST_UID} and _srcFileId=${pagePresetFileId}, got ${JSON.stringify(r.json.rows.slice(0,2))}`};
    const r2 = await api(`/pools/dgddigital/page/rows?limit=1000&srcUid=0000000000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (r2.status!==200 || r2.json?.total!==0) return {ok:false, detail:`wrong srcUid should yield 0 got ${r2.json?.total}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/rows?verifiedOnly / unverifiedOnly (page)", async () => {
    const v = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}&verifiedOnly=true`, {headers:{Cookie:cookie}});
    const uv = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}&unverifiedOnly=true`, {headers:{Cookie:cookie}});
    const vOk = v.status===200 && v.json?.total===1 && Array.isArray(v.json?.rows) && String(v.json.rows[0]?.uid)===pageVerifiedUid;
    const uvOk = uv.status===200 && uv.json?.total===2 && Array.isArray(uv.json?.rows) && uv.json.rows.every((r:any)=> String(r.wa_status||r.waStatus||"").toLowerCase()!=="eligible");
    if (!vOk) return {ok:false, detail:`verifiedOnly total=${v.json?.total} rows=${JSON.stringify(v.json?.rows)?.slice(0,200)} status ${v.status}`};
    if (!uvOk) return {ok:false, detail:`unverifiedOnly total=${uv.json?.total} rows=${JSON.stringify(uv.json?.rows)?.slice(0,200)} status ${uv.status}`};
    const v1 = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}&verifiedOnly=1`, {headers:{Cookie:cookie}});
    if (v1.json?.total!==1) return {ok:false, detail:`verifiedOnly=1 should be same as true got ${v1.json?.total}`};
    return {ok:true};
  });

  await test("GET /pools/:pwd/:pool/rows verifiedOnly+unverifiedOnly → 400", async () => {
    const r = await api(`/pools/dgddigital/page/rows?limit=1000&verifiedOnly=true&unverifiedOnly=true`, {headers:{Cookie:cookie}});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("GET /pools/:pwd/:pool/rows verifiedOnly on non-page → 400", async () => {
    const r = await api(`/pools/dgddigital/cookies_only/rows?limit=1000&verifiedOnly=true`, {headers:{Cookie:cookie}});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("GET /pools/:pwd/:pool/rows srcUid filter on cookies_2fa", async () => {
    const r = await api(`/pools/dgddigital/cookies_2fa/rows?limit=1000&srcUid=${TEST_UID}&srcFileId=${comboPresetFileId}`, {headers:{Cookie:cookie}});
    if (r.status!==200 || r.json?.total!==1) return {ok:false, detail:`status=${r.status} total=${r.json?.total} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (String(r.json.rows[0]?.uid)!==comboUid) return {ok:false, detail:`uid mismatch ${JSON.stringify(r.json.rows[0])}`};
    if (!r.json.rows.every((x:any)=> String(x._srcUid)===TEST_UID)) return {ok:false, detail:`every row must have _srcUid=${TEST_UID}, got ${JSON.stringify(r.json.rows.slice(0,2))}`};
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim srcUid filter", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, srcUid: TEST_UID})});
    if (r.status!==200 || typeof r.json?.claimed!=="number" || r.json.claimed <1) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (r.json?.downloadId) { newDownloads.push(r.json.downloadId); await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}}); }
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim srcFileId filter", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, srcFileId: pagePresetFileId})});
    if (r.status!==200 || r.json?.claimed!==1) return {ok:false, detail:`status=${r.status} claimed=${r.json?.claimed} body=${JSON.stringify(r.json).slice(0,200)}`};
    if (!r.json?.downloadId) return {ok:false, detail:`missing downloadId`};
    newDownloads.push(r.json.downloadId);
    const rev = await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    if (rev.status!==200) return {ok:false, detail:`revert ${rev.status}`};
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim claimForUser alias (srcUid)", async () => {
    const r = await api(`/pools/dgddigital/cookies_2fa/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, claimForUser: TEST_UID})});
    if (r.status!==200 || r.json?.claimed!==1) return {ok:false, detail:`status=${r.status} claimed=${r.json?.claimed} body=${JSON.stringify(r.json).slice(0,200)}`};
    newDownloads.push(r.json.downloadId);
    await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim userId alias (srcUid)", async () => {
    const r = await api(`/pools/dgddigital/cookies_2fa/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, userId: TEST_UID})});
    if (r.status!==200 || r.json?.claimed!==1) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}`};
    newDownloads.push(r.json.downloadId);
    await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim verifiedOnly (page, only eligible)", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:5, srcFileId: pagePresetFileId, verifiedOnly: true})});
    if (r.status!==200 || r.json?.claimed!==1) return {ok:false, detail:`status=${r.status} claimed=${r.json?.claimed} expected 1 body=${JSON.stringify(r.json).slice(0,300)}`};
    const hasVerified = Array.isArray(r.json?.rows) && r.json.rows.some((x:any)=> String(x.uid)===pageVerifiedUid);
    const hasUnverified = Array.isArray(r.json?.rows) && r.json.rows.some((x:any)=> String(x.uid)===pageUnverifiedUid);
    if (!hasVerified || hasUnverified) return {ok:false, detail:`verifiedOnly claimed wrong rows verified=${hasVerified} unverified=${hasUnverified} rows=${JSON.stringify(r.json.rows).slice(0,200)}`};
    newDownloads.push(r.json.downloadId);
    await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim unverifiedOnly (page, not eligible)", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:5, srcFileId: pagePresetFileId, unverifiedOnly: true})});
    if (r.status!==200 || r.json?.claimed!==2) return {ok:false, detail:`status=${r.status} claimed=${r.json?.claimed} expected 2 body=${JSON.stringify(r.json).slice(0,300)}`};
    const hasVerified = Array.isArray(r.json?.rows) && r.json.rows.some((x:any)=> String(x.uid)===pageVerifiedUid);
    if (hasVerified) return {ok:false, detail:`unverifiedOnly claimed verified row`};
    newDownloads.push(r.json.downloadId);
    await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim count:'all' (page, srcFileId-scoped)", async () => {
    const before = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    const totalBefore = before.json?.total ?? 0;
    if (totalBefore!==3) return {ok:false, detail:`before total=${totalBefore} expected 3`};
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:"all", srcFileId: pagePresetFileId})});
    if (r.status!==200 || r.json?.claimed!==3) return {ok:false, detail:`status=${r.status} claimed=${r.json?.claimed} expected 3 body=${JSON.stringify(r.json).slice(0,300)}`};
    if (!r.json?.downloadId) return {ok:false, detail:`missing downloadId`};
    newDownloads.push(r.json.downloadId);
    const after = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (after.json?.total!==0) return {ok:false, detail:`after total=${after.json?.total} expected 0`};
    const detail = await api(`/pools/downloads/${r.json.downloadId}/detail`, {headers:{Cookie:cookie}});
    if (detail.status!==200 || !Array.isArray(detail.json?.groups) || !Array.isArray(detail.json?.rows) || detail.json.rows.length!==3) return {ok:false, detail:`detail status=${detail.status} body=${JSON.stringify(detail.json).slice(0,300)}`};
    await api(`/pools/downloads/${r.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    const restored = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (restored.json?.total!==3) return {ok:false, detail:`restored total=${restored.json?.total} expected 3`};
    return {ok:true};
  });

  await test("POST /pools/:pwd/:pool/claim verifiedOnly+unverifiedOnly → 400", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, verifiedOnly:true, unverifiedOnly:true})});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("POST /pools/:pwd/:pool/claim verified filter on non-page → 400", async () => {
    const r = await api(`/pools/dgddigital/cookies_only/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, verifiedOnly:true})});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("POST /pools/:pwd/:pool/claim invalid srcUid → 400", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, srcUid:""})});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("POST /pools/:pwd/:pool/claim invalid srcFileId → 400", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, srcFileId:""})});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("POST /pools/:pwd/:pool/claim invalid count → 400", async () => {
    const r = await api(`/pools/dgddigital/page/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:0})});
    return r.status===400 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("GET /pools/downloads/:id/detail (shape + groups)", async () => {
    const claim = await api(`/pools/dgddigital/cookies_only/claim`, {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({count:1, srcFileId: cookiePresetFileId})});
    if (claim.status!==200 || !claim.json?.downloadId) return {ok:false, detail:`claim failed ${claim.status} ${JSON.stringify(claim.json).slice(0,200)}`};
    newDownloads.push(claim.json.downloadId);
    const r = await api(`/pools/downloads/${claim.json.downloadId}/detail`, {headers:{Cookie:cookie}});
    if (r.status!==200) return {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}`};
    const j=r.json as any;
    const shapeOk = typeof j.id==="string" && typeof j.poolId==="string" && typeof j.password==="string" && typeof j.claimed==="number" && Array.isArray(j.rows) && Array.isArray(j.keys) && Array.isArray(j.groups);
    if (!shapeOk) return {ok:false, detail:`shape ${JSON.stringify(j).slice(0,300)}`};
    if (j.groups.length===0) return {ok:false, detail:`groups empty`};
    const hasSrc = j.groups.some((g:any)=> g.srcUid===TEST_UID && g.srcFileId===cookiePresetFileId);
    if (!hasSrc) return {ok:false, detail:`groups missing srcUid/srcFileId ${JSON.stringify(j.groups).slice(0,200)} expected ${TEST_UID}/${cookiePresetFileId}`};
    await api(`/pools/downloads/${claim.json.downloadId}/revert`, {method:"POST", headers:{Cookie:cookie}});
    return {ok:true};
  });

  await test("GET /pools/downloads/:id/detail (not found) → 404", async () => {
    const r = await api(`/pools/downloads/doesnotexist123/detail`, {headers:{Cookie:cookie}});
    return r.status===404 ? {ok:true} : {ok:false, detail:`status=${r.status} body=${JSON.stringify(r.json)}`};
  });

  await test("archive cleanup removes page rows (preset-aware)", async () => {
    const before = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (before.json?.total!==3) return {ok:false, detail:`before total=${before.json?.total} expected 3`};
    await api(`/files/${pagePresetFileId}`, {method:"DELETE", headers:{Cookie:cookie}});
    const arch = await api("/archive", {headers:{Cookie:cookie}});
    const found = Array.isArray(arch.json) && arch.json.find((f:any)=> f.id===pagePresetFileId);
    if (!found) return {ok:false, detail:`not in archive`};
    const del = await api("/archive/batch-delete", {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({ids:[pagePresetFileId]})});
    if (del.status!==200 || del.json?.deleted!==1) return {ok:false, detail:`batch-delete ${del.status} ${JSON.stringify(del.json)}`};
    await pollRowsTotal("dgddigital", "page", `limit=1000&srcFileId=${pagePresetFileId}`, 0, 5000);
    const after = await api(`/pools/dgddigital/page/rows?limit=1000&srcFileId=${pagePresetFileId}`, {headers:{Cookie:cookie}});
    if (after.json?.total!==0) return {ok:false, detail:`after total=${after.json?.total} expected 0 leaked page rows not cleaned`};
    const comboStill = await api(`/pools/dgddigital/cookies_2fa/rows?limit=1000&srcFileId=${comboPresetFileId}`, {headers:{Cookie:cookie}});
    if (comboStill.json?.total!==1) return {ok:false, detail:`combo file should still have 1 row, got ${comboStill.json?.total}`};
    pagePresetFileId="";
    return {ok:true};
  });

  await test("cleanup preset files + revert leftover downloads", async () => {
    // fetch downloads once and revert all tracked non-reverted before archiving
    const dlRes = await api(`/pools/downloads`, {headers:{Cookie:cookie}});
    const toRevert = (Array.isArray(dlRes.json) ? dlRes.json : []).filter((d:any)=> newDownloads.includes(d.id) && !d.reverted);
    for (const d of toRevert) {
      await api(`/pools/downloads/${d.id}/revert`, {method:"POST", headers:{Cookie:cookie}});
    }
    const ids = [cookiePresetFileId, comboPresetFileId, poolKindAliasFileId, poolKindAliasSecondId].filter(Boolean) as string[];
    for (const id of ids) await api(`/files/${id}`, {method:"DELETE", headers:{Cookie:cookie}});
    if (ids.length) {
      const r = await api("/archive/batch-delete", {method:"POST", headers:{Cookie:cookie,"Content-Type":"application/json"}, body:JSON.stringify({ids})});
      if (r.status!==200) return {ok:false, detail:`batch-delete ${r.status} ${JSON.stringify(r.json)}`};
    }
    // verify cleanup across page/cookies_only/cookies_2fa and both passwords
    const pools = ["page", "cookies_only", "cookies_2fa"] as const;
    const passwords = ["dgddigital", "L0VE@12345"] as const;
    for (const id of ids) {
      for (const pwd of passwords) {
        for (const pool of pools) {
          const last = await pollRowsTotal(pwd, pool, `limit=1000&srcFileId=${id}`, 0, 5000);
          const total = typeof last?.total === "number" ? last.total : -1;
          if (total !== 0) return {ok:false, detail:`file ${id} rows not cleaned in ${pwd}/${pool} total=${total} body=${JSON.stringify(last).slice(0,200)}`};
        }
      }
    }
    return {ok:true};
  });

  // ── Hold flow (PRICES + FIFO + wallet-light) ──
  let holdFileId = "";
  let holdId1 = "";
  let holdId2 = "";
  const holdSu = String(Date.now()).slice(-6);
  const holdUidA = `990${holdSu}1`.slice(0,12);
  const holdUidB = `990${holdSu}2`.slice(0,12);
  const holdUidC = `990${holdSu}3`.slice(0,12);

  await test("hold setup: create file + persist 3 rows for FIFO", async () => {
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "HoldTest"+holdSu, password: "dgddigital", poolEnabled: true, preset: "cookie" }) });
    if (cr.status !== 200 || !cr.json?.id) return { ok: false, detail: `create ${cr.status} ${JSON.stringify(cr.json).slice(0,200)}` };
    holdFileId = cr.json.id;
    const pr = await api(`/files/${holdFileId}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [
      { cookies: `c_user=${holdUidA}; xs=a`, uid: holdUidA },
      { cookies: `c_user=${holdUidB}; xs=b`, uid: holdUidB },
      { cookies: `c_user=${holdUidC}; xs=c`, uid: holdUidC },
    ] }) });
    if (pr.status !== 200) return { ok: false, detail: `persist ${pr.status}` };
    const pol = await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${holdFileId}`, 3, 5000);
    if (pol?.total !== 3) return { ok: false, detail: `poll total=${pol?.total} expected 3 body=${JSON.stringify(pol).slice(0,200)}` };
    return { ok: true };
  });

  await test("POST /api/pools/:pwd/:pool/hold fifo count 1 (happy) → HOLD + .02", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "fifo" }) });
    if (r.status !== 200) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}` };
    const h = r.json as any;
    holdId1 = h.holdId || h.downloadId || "";
    const ok = (h.held === 1 || h.claimed === 1) && holdId1 && h.status === "HOLD" && Array.isArray(h.rows) && h.rows.length === 1 && h.mode === "fifo" && h.unitPrice === 0.02 && h.total === 0.02;
    if (!ok) return { ok: false, detail: `held=${h.held} claimed=${h.claimed} holdId=${holdId1} status=${h.status} unitPrice=${h.unitPrice} total=${h.total} mode=${h.mode} body=${JSON.stringify(h).slice(0,300)}` };
    // FIFO: first hold should be smallest row_key (holdUidA) due to inserted_at stable order
    if (String(h.rows[0]?.uid) !== holdUidA) return { ok: false, detail: `FIFO order expected ${holdUidA} got ${h.rows[0]?.uid} rows=${JSON.stringify(h.rows).slice(0,200)}` };
    // rows should now be held, not available
    const av = await api("/pools/dgddigital/cookies_only/rows?limit=1000&srcFileId="+holdFileId, { headers: { Cookie: cookie } });
    if (av.json?.total !== 2) return { ok: false, detail: `after hold total=${av.json?.total} expected 2 body=${JSON.stringify(av.json).slice(0,200)}` };
    return { ok: true };
  });

  await test("GET /api/pools/holds (list contains hold)", async () => {
    const r = await api("/pools/holds", { headers: { Cookie: cookie } });
    if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}` };
    const found = r.json.find((h: any) => h.id === holdId1 && h.status === "HOLD" && h.poolId === "cookies_only");
    if (!found) return { ok: false, detail: `hold ${holdId1} not in list ${JSON.stringify(r.json).slice(0,300)}` };
    if (found.unitPrice !== 0.02 || found.total !== 0.02) return { ok: false, detail: `pricing unitPrice=${found.unitPrice} total=${found.total} expected 0.02` };
    if (found.mode !== "fifo") return { ok: false, detail: `mode=${found.mode} expected fifo` };
    return { ok: true };
  });

  await test("GET /api/pools/holds?status=HOLD filter", async () => {
    const r = await api("/pools/holds?status=HOLD", { headers: { Cookie: cookie } });
    if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, detail: `status=${r.status}` };
    if (!r.json.some((h: any) => h.id === holdId1)) return { ok: false, detail: `filtered missing ${holdId1}` };
    if (r.json.some((h: any) => h.status !== "HOLD")) return { ok: false, detail: `filter returned non-HOLD ${JSON.stringify(r.json.slice(0,2))}` };
    return { ok: true };
  });

  await test("POST /api/pools/holds/:id/approve (happy) → APPROVED + claimed", async () => {
    const r = await api(`/pools/holds/${holdId1}/approve`, { method: "POST", headers: { Cookie: cookie } });
    if (r.status !== 200 || !r.json?.ok) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
    if (r.json?.status !== "APPROVED") return { ok: false, detail: `status=${r.json?.status} expected APPROVED` };
    const dl: any = await api(`/pools/downloads/${holdId1}?format=json`, { headers: { Cookie: cookie } }).then(x => x.json).catch(() => null);
    if (!dl || dl.status !== "APPROVED") return { ok: false, detail: `download status=${dl?.status} expected APPROVED body=${JSON.stringify(dl).slice(0,200)}` };
    if (dl.unitPrice !== 0.02 || dl.total !== 0.02) return { ok: false, detail: `pricing after approve unitPrice=${dl.unitPrice} total=${dl.total}` };
    const detail: any = await api(`/pools/downloads/${holdId1}/detail`, { headers: { Cookie: cookie } }).then(x => x.json).catch(() => null);
    if (!detail || detail.status !== "APPROVED") return { ok: false, detail: `detail status=${detail?.status}` };
    return { ok: true };
  });

  await test("POST /api/pools/:pwd/:pool/hold with srcUids/srcFileIds + pick mode", async () => {
    // remaining 2 rows available, pick via srcFileIds array, count all
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: "all", mode: "pick", srcUids: [TEST_UID], srcFileIds: [holdFileId] }) });
    if (r.status !== 200) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0,300)}` };
    const h = r.json as any;
    holdId2 = h.holdId || h.downloadId || "";
    if (!holdId2 || (h.held !== 2 && h.claimed !== 2)) return { ok: false, detail: `held=${h.held} claimed=${h.claimed} id=${holdId2} body=${JSON.stringify(h).slice(0,300)}` };
    if (h.unitPrice !== 0.02 || h.total !== 0.04) return { ok: false, detail: `price unit=${h.unitPrice} total=${h.total} expected 0.02/0.04` };
    if (h.mode !== "pick") return { ok: false, detail: `mode=${h.mode} expected pick` };
    if (!Array.isArray(h.srcUids) || !h.srcUids.includes(TEST_UID)) return { ok: false, detail: `srcUids=${JSON.stringify(h.srcUids)}` };
    return { ok: true };
  });

  await test("POST /api/pools/holds/:id/reject (happy) → REJECTED + rows return available", async () => {
    const r = await api(`/pools/holds/${holdId2}/reject`, { method: "POST", headers: { Cookie: cookie } });
    if (r.status !== 200 || !r.json?.ok) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
    if (r.json?.status !== "REJECTED") return { ok: false, detail: `status=${r.json?.status} expected REJECTED` };
    const dl: any = await api(`/pools/downloads/${holdId2}?format=json`, { headers: { Cookie: cookie } }).then(x => x.json).catch(() => null);
    if (!dl || dl.status !== "REJECTED" || !dl.reverted) return { ok: false, detail: `dl status=${dl?.status} reverted=${dl?.reverted} body=${JSON.stringify(dl).slice(0,200)}` };
    // also test alias /return
    const retCheck = await api(`/pools/holds/${holdId2}/return`, { method: "POST", headers: { Cookie: cookie } });
    if (retCheck.status !== 400) return { ok: false, detail: `second reject via alias should be 400 already rejected, got ${retCheck.status} ${JSON.stringify(retCheck.json)}` };
    const av = await api("/pools/dgddigital/cookies_only/rows?limit=1000&srcFileId="+holdFileId, { headers: { Cookie: cookie } });
    if (av.json?.total !== 2) return { ok: false, detail: `after reject total=${av.json?.total} expected 2 (A already approved so 2 left) body=${JSON.stringify(av.json).slice(0,200)}` };
    return { ok: true };
  });

  await test("GET /api/pools/holds (no status) returns HOLD+APPROVED not REJECTED", async () => {
    const r = await api("/pools/holds", { headers: { Cookie: cookie } });
    if (r.status !== 200 || !Array.isArray(r.json)) return { ok: false, detail: `status=${r.status}` };
    const hasApproved = r.json.some((h: any) => h.id === holdId1 && String(h.status).toUpperCase() === "APPROVED");
    if (!hasApproved) return { ok: false, detail: `APPROVED ${holdId1} missing in ${JSON.stringify(r.json).slice(0,300)}` };
    const hasRejected = r.json.some((h: any) => h.id === holdId2);
    if (hasRejected) return { ok: false, detail: `REJECTED ${holdId2} should not appear in no-status list ${JSON.stringify(r.json).slice(0,300)}` };
    // explicit status filters still work
    const filtHold = await api("/pools/holds?status=APPROVED", { headers: { Cookie: cookie } });
    if (!Array.isArray(filtHold.json) || !filtHold.json.some((h: any) => h.id === holdId1)) return { ok: false, detail: `APPROVED filter missing ${holdId1}` };
    const filtRej = await api("/pools/holds?status=REJECTED", { headers: { Cookie: cookie } });
    if (!Array.isArray(filtRej.json) || !filtRej.json.some((h: any) => h.id === holdId2)) return { ok: false, detail: `REJECTED filter missing ${holdId2}` };
    return { ok: true };
  });

  await test("POST /api/pools/:pwd/:pool/hold pick without srcUids/srcFileIds → 400", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "pick" }) });
    if (r.status !== 400) return { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)} expected 400 for pick without sources` };
    const r2 = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "pick", srcUids: [] }) });
    if (r2.status !== 400) return { ok: false, detail: `empty srcUids should also be 400, got ${r2.status}` };
    return { ok: true };
  });

  await test("GET /api/pools/downloads/:id for HOLD → 409 until APPROVED", async () => {
    // create temp file with 1 row, hold it, verify blob blocked then approved blob allowed
    const tmpSu = String(Date.now()).slice(-6);
    const tmpUid = `992${tmpSu}`.slice(0, 12);
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "HoldGate"+tmpSu, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid = cr.json?.id;
    if (!fid) return { ok: false, detail: `create ${cr.status}` };
    await api(`/files/${fid}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=${tmpUid}; xs=x`, uid: tmpUid }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid}`, 1, 5000);
    const h = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "fifo", srcFileId: fid }) });
    const hid = (h.json as any)?.holdId || (h.json as any)?.downloadId;
    if (h.status !== 200 || !hid) return { ok: false, detail: `hold ${h.status} ${JSON.stringify(h.json).slice(0,200)}` };
    const blobHold = await api(`/pools/downloads/${hid}`, { headers: { Cookie: cookie } });
    if (blobHold.status !== 409) return { ok: false, detail: `HOLD blob should be 409, got ${blobHold.status} body=${JSON.stringify(blobHold.json).slice(0,200)}` };
    const jsonHold = await api(`/pools/downloads/${hid}?format=json`, { headers: { Cookie: cookie } });
    if (jsonHold.status !== 200 || String(jsonHold.json?.status).toUpperCase() !== "HOLD") return { ok: false, detail: `HOLD json should still be 200 HOLD, got ${jsonHold.status} ${JSON.stringify(jsonHold.json).slice(0,200)}` };
    const appr = await api(`/pools/holds/${hid}/approve`, { method: "POST", headers: { Cookie: cookie } });
    if (appr.status !== 200) return { ok: false, detail: `approve ${appr.status}` };
    const blobApproved = await api(`/pools/downloads/${hid}`, { headers: { Cookie: cookie } });
    if (blobApproved.status !== 200) return { ok: false, detail: `APPROVED blob should be 200, got ${blobApproved.status}` };
    await api(`/pools/downloads/${hid}/revert`, { method: "POST", headers: { Cookie: cookie } });
    await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid] }) });
    return { ok: true };
  });

  await test("hold cleanup: revert approved hold via downloads revert allowed? then purge file", async () => {
    // approved hold should be reverted via downloads revert path (should succeed)
    const rev = await api(`/pools/downloads/${holdId1}/revert`, { method: "POST", headers: { Cookie: cookie } });
    // after revert, approved rows become available again
    if (rev.status !== 200 || !rev.json?.ok) return { ok: false, detail: `revert approved ${rev.status} ${JSON.stringify(rev.json)}` };
    const av = await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${holdFileId}`, 3, 5000);
    if (av?.total !== 3) return { ok: false, detail: `after revert total=${av?.total} expected 3` };
    await api(`/files/${holdFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const del = await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [holdFileId] }) });
    if (del.status !== 200) return { ok: false, detail: `batch-delete ${del.status}` };
    const after = await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${holdFileId}`, 0, 5000);
    if (after?.total !== 0) return { ok: false, detail: `after purge total=${after?.total}` };
    return { ok: true };
  });

  await test("POST /api/pools/:pwd/:pool/hold invalid count → 400", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 0 }) });
    return r.status === 400 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/pools/:pwd/:pool/hold invalid mode → 400", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "badmode" }) });
    return r.status === 400 ? { ok: true } : { ok: false, detail: `status=${r.status}` };
  });

  await test("POST /api/pools/:pwd/:pool/hold invalid srcUids → 400", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcUids: [""] }) });
    return r.status === 400 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/pools/:pwd/:pool/hold unverifiedOnly on non-page → 400", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, unverifiedOnly: true }) });
    return r.status === 400 ? { ok: true } : { ok: false, detail: `status=${r.status}` };
  });

  await test("POST /api/pools/:pwd/:pool/hold no auth → 401", async () => {
    const r = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) });
    return r.status === 401 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/pools/holds no auth → 401", async () => {
    const r = await api("/pools/holds");
    return r.status === 401 ? { ok: true } : { ok: false, detail: `status=${r.status}` };
  });

  await test("POST /api/pools/holds/:id/approve not found → 404", async () => {
    const r = await api("/pools/holds/doesnotexisthold123/approve", { method: "POST", headers: { Cookie: cookie } });
    return r.status === 404 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/pools/holds/:id/reject not found → 404", async () => {
    const r = await api("/pools/holds/doesnotexisthold123/reject", { method: "POST", headers: { Cookie: cookie } });
    return r.status === 404 ? { ok: true } : { ok: false, detail: `status=${r.status}` };
  });

  await test("POST /api/pools/holds/:id/approve no auth → 401", async () => {
    const r = await api("/pools/holds/someid/approve", { method: "POST" });
    return r.status === 401 ? { ok: true } : { ok: false, detail: `status=${r.status}` };
  });

  await test("GET /api/pools/downloads includes status/unitPrice/total/mode", async () => {
    // create a claim to verify extended fields
    const cf = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "PriceCheck"+holdSu, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid = cf.json?.id;
    if (!fid) return { ok: false, detail: `create ${cf.status}` };
    await api(`/files/${fid}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=991${holdSu}; xs=x`, uid: `991${holdSu}` }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid}`, 1, 5000);
    const cl = await api("/pools/dgddigital/cookies_only/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcFileId: fid }) });
    if (cl.status !== 200 || cl.json?.unitPrice !== 0.02) return { ok: false, detail: `claim unitPrice=${cl.json?.unitPrice} expected 0.02 body=${JSON.stringify(cl.json).slice(0,200)}` };
    const dlId = cl.json?.downloadId;
    const list = await api("/pools/downloads", { headers: { Cookie: cookie } });
    const found = Array.isArray(list.json) && list.json.find((d: any) => d.id === dlId);
    if (!found || found.status !== "CLAIMED" || found.unitPrice !== 0.02) return { ok: false, detail: `dl list status=${found?.status} unitPrice=${found?.unitPrice} body=${JSON.stringify(found).slice(0,200)}` };
    await api(`/pools/downloads/${dlId}/revert`, { method: "POST", headers: { Cookie: cookie } });
    await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid] }) });
    return { ok: true };
  });

  // ── Task 3: durable pool prices + Task 4: download delete ──
  await test("GET /api/pools/:pwd/:pool/price (default)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/price", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && r.json?.poolId === "cookies_only" && r.json?.password === "dgddigital" && typeof r.json?.price === "number" && r.json.price === 0.02;
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0,200)}` };
  });

  await test("PUT /api/pools/:pwd/:pool/price (set + get)", async () => {
    const set = await api("/pools/dgddigital/cookies_only/price", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ price: 0.99 }) });
    if (set.status !== 200 || set.json?.price !== 0.99 || set.json?.poolId !== "cookies_only") return { ok: false, detail: `set status=${set.status} body=${JSON.stringify(set.json).slice(0,200)}` };
    const get = await api("/pools/dgddigital/cookies_only/price", { headers: { Cookie: cookie } });
    if (get.status !== 200 || get.json?.price !== 0.99) return { ok: false, detail: `get status=${get.status} body=${JSON.stringify(get.json).slice(0,200)}` };
    // claim should use stored price
    const cf = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "PriceDurable"+holdSu, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid = cf.json?.id;
    if (!fid) return { ok: false, detail: `create ${cf.status}` };
    await api(`/files/${fid}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=993${holdSu}; xs=x`, uid: `993${holdSu}` }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid}`, 1, 5000);
    const cl = await api("/pools/dgddigital/cookies_only/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcFileId: fid }) });
    if (cl.status !== 200 || cl.json?.unitPrice !== 0.99 || cl.json?.total !== 0.99) { await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } }); await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid] }) }); return { ok: false, detail: `claim price mismatch unitPrice=${cl.json?.unitPrice} total=${cl.json?.total} body=${JSON.stringify(cl.json).slice(0,200)}` }; }
    await api(`/pools/downloads/${cl.json.downloadId}/revert`, { method: "POST", headers: { Cookie: cookie } });
    await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid] }) });
    // restore default
    const rst = await api("/pools/dgddigital/cookies_only/price", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ price: 0.02 }) });
    if (rst.status !== 200 || rst.json?.price !== 0.02) return { ok: false, detail: `restore status=${rst.status} body=${JSON.stringify(rst.json).slice(0,200)}` };
    return { ok: true };
  });

  await test("PUT /api/pools/:pwd/:pool/price invalid price → 400", async () => {
    const cases = [{ price: -1 }, { price: 1001 }, { price: "bad" }, {}];
    for (const b of cases) {
      const r = await api("/pools/dgddigital/cookies_only/price", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(b) });
      if (r.status !== 400) return { ok: false, detail: `body=${JSON.stringify(b)} status=${r.status} expected 400 body=${JSON.stringify(r.json)}` };
    }
    const badPool = await api("/pools/dgddigital/notapool/price", { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ price: 1 }) });
    if (badPool.status !== 400) return { ok: false, detail: `invalid pool should be 400 got ${badPool.status}` };
    return { ok: true };
  });

  await test("GET/PUT /api/pools/:pwd/:pool/price no auth → 401", async () => {
    const g = await api("/pools/dgddigital/cookies_only/price");
    const p = await api("/pools/dgddigital/cookies_only/price", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ price: 1 }) });
    return g.status === 401 && p.status === 401 ? { ok: true } : { ok: false, detail: `get=${g.status} put=${p.status}` };
  });

  await test("DELETE /api/pools/downloads/:id only reverted/rejected (active→400, reverted→ok, missing→404)", async () => {
    const cf = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DelDlTest"+holdSu, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid = cf.json?.id;
    if (!fid) return { ok: false, detail: `create ${cf.status}` };
    await api(`/files/${fid}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=994${holdSu}; xs=x`, uid: `994${holdSu}` }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid}`, 1, 5000);
    const cl = await api("/pools/dgddigital/cookies_only/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcFileId: fid }) });
    const dlId = cl.json?.downloadId;
    if (!dlId) return { ok: false, detail: `claim failed ${cl.status} ${JSON.stringify(cl.json).slice(0,200)}` };
    const activeDel = await api(`/pools/downloads/${dlId}`, { method: "DELETE", headers: { Cookie: cookie } });
    if (activeDel.status !== 400) return { ok: false, detail: `active delete should be 400 got ${activeDel.status} body=${JSON.stringify(activeDel.json)}` };
    const rev = await api(`/pools/downloads/${dlId}/revert`, { method: "POST", headers: { Cookie: cookie } });
    if (rev.status !== 200) return { ok: false, detail: `revert ${rev.status}` };
    const okDel = await api(`/pools/downloads/${dlId}`, { method: "DELETE", headers: { Cookie: cookie } });
    if (okDel.status !== 200 || !okDel.json?.ok) return { ok: false, detail: `reverted delete status=${okDel.status} body=${JSON.stringify(okDel.json)}` };
    const gone = await api(`/pools/downloads/${dlId}?format=json`, { headers: { Cookie: cookie } });
    if (gone.status !== 404) return { ok: false, detail: `deleted download should be 404 got ${gone.status}` };
    const nf = await api(`/pools/downloads/doesnotexist_del123`, { method: "DELETE", headers: { Cookie: cookie } });
    if (nf.status !== 404) return { ok: false, detail: `missing delete should be 404 got ${nf.status}` };
    // also test HOLD → rejected then delete
    const cf2 = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DelHoldTest"+holdSu, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid2 = cf2.json?.id;
    await api(`/files/${fid2}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=995${holdSu}; xs=x`, uid: `995${holdSu}` }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid2}`, 1, 5000);
    const hold = await api("/pools/dgddigital/cookies_only/hold", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, mode: "fifo", srcFileId: fid2 }) });
    const hid = (hold.json as any)?.holdId || (hold.json as any)?.downloadId;
    const activeHoldDel = await api(`/pools/downloads/${hid}`, { method: "DELETE", headers: { Cookie: cookie } });
    if (activeHoldDel.status !== 400) return { ok: false, detail: `active hold delete should be 400 got ${activeHoldDel.status}` };
    await api(`/pools/holds/${hid}/reject`, { method: "POST", headers: { Cookie: cookie } });
    const rejDel = await api(`/pools/downloads/${hid}`, { method: "DELETE", headers: { Cookie: cookie } });
    if (rejDel.status !== 200 || !rejDel.json?.ok) return { ok: false, detail: `rejected delete status=${rejDel.status} body=${JSON.stringify(rejDel.json)}` };
    const noAuth = await api(`/pools/downloads/${hid}`, { method: "DELETE" });
    if (noAuth.status !== 401) return { ok: false, detail: `no auth delete should be 401 got ${noAuth.status}` };
    await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api(`/files/${fid2}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid, fid2] }) });
    return { ok: true };
  });

  await test("GET /api/pools/:pwd/:pool delegator aggregation source-user based", async () => {
    const su = String(Date.now()).slice(-6);
    const uidA = `996${su}`.slice(0, 12);
    const uidB = `997${su}`.slice(0, 12);
    const cf = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "DelegatorTest"+su, preset: "cookie", password: "dgddigital", poolEnabled: true }) });
    const fid = cf.json?.id;
    if (!fid) return { ok: false, detail: `create ${cf.status}` };
    await api(`/files/${fid}/persist`, { method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ rows: [{ cookies: `c_user=${uidA}; xs=a`, uid: uidA }, { cookies: `c_user=${uidB}; xs=b`, uid: uidB }] }) });
    await pollRowsTotal("dgddigital", "cookies_only", `limit=1000&srcFileId=${fid}`, 2, 5000);
    const detail = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    if (detail.status !== 200 || !Array.isArray(detail.json?.users)) return { ok: false, detail: `detail status=${detail.status} body=${JSON.stringify(detail.json).slice(0,200)}` };
    const me = detail.json.users.find((u: any) => u.userId === TEST_UID);
    if (!me) return { ok: false, detail: `delegator ${TEST_UID} missing users=${JSON.stringify(detail.json.users).slice(0,200)}` };
    if (typeof me.available !== "number" || me.claimed !== "number" || me.available < 2) return { ok: false, detail: `delegator counts available=${me.available} claimed=${me.claimed} expected available>=2` };
    const cl = await api("/pools/dgddigital/cookies_only/claim", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1, srcFileId: fid }) });
    const dlId = cl.json?.downloadId;
    const after = await api("/pools/dgddigital/cookies_only", { headers: { Cookie: cookie } });
    const meAfter = Array.isArray(after.json?.users) ? after.json.users.find((u: any) => u.userId === TEST_UID) : null;
    if (!meAfter) return { ok: false, detail: `delegator missing after claim` };
    if (meAfter.available !== 1 || meAfter.claimed !== 1) return { ok: false, detail: `after claim available=${meAfter.available} claimed=${meAfter.claimed} expected 1/1` };
    if (dlId) await api(`/pools/downloads/${dlId}/revert`, { method: "POST", headers: { Cookie: cookie } });
    await api(`/files/${fid}`, { method: "DELETE", headers: { Cookie: cookie } });
    await api("/archive/batch-delete", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [fid] }) });
    return { ok: true };
  });

  await test("DELETE /api/files/:id (cleanup)", async () => {
    const r = await api(`/files/${testFileId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    return r.status === 200 && r.json?.ok === true
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("DELETE /api/archive/:id (single)", async () => {
    const cr = await api("/files", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ name: "SingleDelTest" }) });
    if (cr.status !== 200 || !cr.json?.id) return { ok: false, detail: `create ${cr.status}` };
    const id = cr.json.id;
    await api(`/files/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api(`/archive/${id}`, { method: "DELETE", headers: { Cookie: cookie } });
    const arch = await api("/archive", { headers: { Cookie: cookie } });
    const gone = Array.isArray(arch.json) && !arch.json.find((f: any) => f.id === id);
    return r.status === 200 && gone ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/pools/:pwd/:pool/user-files (+ invalid pool → 400)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/user-files", { headers: { Cookie: cookie } });
    const bad = await api("/pools/dgddigital/notapool/user-files", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && Array.isArray(r.json?.users) && typeof r.json?.noSrcAvail === "number" && bad.status === 400;
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} bad=${bad.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("POST /api/pools/:pwd/:pool/revert (unknown id → 200)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/revert", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ id: "doesnotexist123" }) });
    return r.status === 200 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/admin/user/:id/ban|unban (dummy + bad action → 400)", async () => {
    const ban = await api("/admin/user/999999999/ban", { method: "POST", headers: { Cookie: cookie } });
    const unban = await api("/admin/user/999999999/unban", { method: "POST", headers: { Cookie: cookie } });
    const bad = await api("/admin/user/999999999/freeze", { method: "POST", headers: { Cookie: cookie } });
    const ok = ban.status === 200 && ban.json?.ok === true && unban.status === 200 && unban.json?.ok === true && bad.status === 400;
    return ok ? { ok: true } : { ok: false, detail: `ban=${ban.status} unban=${unban.status} bad=${bad.status}` };
  });

  await test("POST /api/fb/check (empty uids) → 400", async () => {
    const r = await api("/fb/check", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ uids: [] }) });
    return r.status === 400 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/auth/device/claim (bad token) → ok:false", async () => {
    const r = await api("/auth/device/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: "bad-token-123" }) });
    return r.json?.ok === false && (r.status === 200 || r.status === 403) ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/pools/downloads/:id?format=json (+ 404)", async () => {
    const r = await api(`/pools/downloads/${downloadId}?format=json`, { headers: { Cookie: cookie } });
    const nf = await api("/pools/downloads/doesnotexist123?format=json", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && typeof r.json?.claimed === "number" && r.json?.id === downloadId && nf.status === 404;
    return ok ? { ok: true } : { ok: false, detail: `status=${r.status} nf=${nf.status} body=${JSON.stringify(r.json).slice(0, 200)}` };
  });

  await test("POST /webhook/tg (no secret) → 401", async () => {
    const res = await fetch(BASE.replace(/\/api$/, "") + "/webhook/tg", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return res.status === 401 ? { ok: true } : { ok: false, detail: `status=${res.status}` };
  });

  await test("GET /api/auth/logout (clears cookie)", async () => {
    const r = await api("/auth/logout", { method: "POST", headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.ok === true && /ss_session=.*Max-Age=0/.test(r.headers.get("set-cookie") || "")
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/auth/me (no cookie after logout) → 401", async () => {
    const r = await api("/auth/me");
    return r.status === 401 && r.json?.error === "not_authenticated"
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 401) body=${JSON.stringify(r.json)}` };
  });

  // ── Summary ──
  console.log("\n" + results.join("\n") + "\n");
  console.log(`\x1b[1mResults: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${total} total` + (FILTERS.length ? ` (filter: "${FILTER_ARG}", ${skipped} skipped)` : ``) + `\n`);
  if (!total && FILTERS.length) console.log(`No tests matched — run with --help for usage.\n`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
