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
let passed = 0, failed = 0, total = 0;
const results: string[] = [];

async function test(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) {
  total++;
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    if (r.ok) { passed++; results.push(`\x1b[32m✅ PASS\x1b[0m  ${String(total).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m`); }
    else { failed++; results.push(`\x1b[31m❌ FAIL\x1b[0m  ${String(total).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m\n         ${r.detail ?? ""}`); }
  } catch (e) {
    const ms = Date.now() - t0;
    failed++;
    results.push(`\x1b[31m❌ ERROR\x1b[0m ${String(total).padStart(2)}. ${name} \x1b[90m(${ms}ms)\x1b[0m\n         ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(BASE + path, { ...init, redirect: "manual" });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, headers: res.headers, json, text };
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
    if (r.status === 200 && r.json?.id) { testFileId = r.json.id; return { ok: true }; }
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
    return r.status === 200 && r.json?.name === "TestApi Renamed"
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
    const found = Array.isArray(arch.json) && arch.json.find((f: any) => f.id === archivedFileId && f.deletedAt);
    return found ? { ok: true } : { ok: false, detail: `archive=${JSON.stringify(arch.json).slice(0, 200)}` };
  });

  await test("POST /api/archive/:id/restore", async () => {
    const r = await api(`/archive/${archivedFileId}/restore`, { method: "POST", headers: { Cookie: cookie } });
    const files = await api("/files", { headers: { Cookie: cookie } });
    const back = Array.isArray(files.json) && files.json.find((f: any) => f.id === archivedFileId && !f.deletedAt);
    return r.status === 200 && r.json?.ok && back ? { ok: true } : { ok: false, detail: `restore=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("POST /api/archive/batch-restore", async () => {
    await api(`/files/${archivedFileId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const r = await api("/archive/batch-restore", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ ids: [archivedFileId] }) });
    return r.status === 200 && r.json?.restored === 1 ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
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

  await test("GET /api/auth/photo/:userId → redirect or 404 (never 500)", async () => {
    const r = await api(`/auth/photo/${TEST_UID}`, { headers: { Cookie: cookie } });
    return r.status === 302 || r.status === 200 || r.status === 404
      ? { ok: true, detail: r.status === 404 ? "user has no TG profile photo" : `status=${r.status}` }
      : { ok: false, detail: `status=${r.status} body=${r.text.slice(0, 100)}` };
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
  const uniq = () => String(Date.now()).slice(-7) + String(Math.floor(Math.random()*90+10));
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
    return r.status === 200 && r.json?.ok === false ? { ok: true } : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/pools/downloads/:id?format=json (+ 404)", async () => {
    const r = await api(`/pools/downloads/${downloadId}?format=json`, { headers: { Cookie: cookie } });
    const nf = await api("/pools/downloads/doesnotexist123?format=json", { headers: { Cookie: cookie } });
    const ok = r.status === 200 && Array.isArray(r.json?.rows) && nf.status === 404;
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
  console.log(`\x1b[1mResults: \x1b[32m${passed} passed\x1b[0m, \x1b[31m${failed} failed\x1b[0m, ${total} total\n`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((e) => { console.error("Fatal:", e); process.exit(1); });
