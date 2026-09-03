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
      body: JSON.stringify({ name: "TestApi Run", type: "fb_cookie", password: "dgddigital", poolEnabled: true }),
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

  await test("POST /api/pools/:pwd/:pool/claim (empty pool)", async () => {
    const r = await api("/pools/dgddigital/cookies_only/claim", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });
    return r.status === 200 && r.json?.password === "dgddigital" && r.json?.poolId === "cookies_only" && r.json?.claimed === 0 && Array.isArray(r.json?.rows)
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json).slice(0, 300)}` };
  });

  await test("GET /api/pools/:pwd/:pool (invalid pool) → 400", async () => {
    const r = await api("/pools/dgddigital/notapool", { headers: { Cookie: cookie } });
    return r.status === 400
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 400) body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/wa/cache", async () => {
    const r = await api("/wa/cache", { headers: { Cookie: cookie } });
    return r.status === 200 && r.json?.enabled === false
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} body=${JSON.stringify(r.json)}` };
  });

  await test("GET /api/cross-dups → 404", async () => {
    const r = await api("/cross-dups", { headers: { Cookie: cookie } });
    return r.status === 404
      ? { ok: true }
      : { ok: false, detail: `status=${r.status} (expected 404) body=${JSON.stringify(r.json)}` };
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
    const r = await api("/auth/logout", { headers: { Cookie: cookie } });
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
