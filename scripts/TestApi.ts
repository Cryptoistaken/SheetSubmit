const BASE = "https://sheetsubmit.traderspopy.workers.dev/api";
const SECRET = process.env.TEST_SESSION_SECRET;
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
    return r.status === 200 && r.json?.ok === true
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
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

  await test("DELETE /api/files/:id (cleanup)", async () => {
    const r = await api(`/files/${testFileId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    return r.status === 200 && r.json?.ok === true
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
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
