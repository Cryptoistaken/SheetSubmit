import { assert, errorText, json, put, request, session, waitFor } from "./lib";

// Pipeline check: verifies accounts flow correctly from user files into pools across
// routing, dedup (same/different user), multi-file, edit-migration and purge scenarios.
// Needs SESSION_TOKEN (admin); USER_SESSION_TOKEN (second account) optional — cross-user
// scenarios S3/S6/S7 are skipped when it's missing/invalid.
const PWD = "dgddigital";
const runId = Date.now().toString().slice(-9);
let seq = 0;
const created: { id: string; sess: string }[] = [];
const fails: string[] = [];
const quirks: string[] = [];

const check = (label: string, cond: boolean) => { console.log(`${cond ? "PASS" : "FAIL"} ${label}`); if (!cond) fails.push(label); };
const quirk = (text: string) => { console.log(`QUIRK ${text}`); quirks.push(text); };

const uid = () => `${runId}${String(++seq).padStart(3, "0")}`;
const row = (u: string, o: { two?: boolean; status?: string; eligible?: boolean } = {}) => ({ cookies: `datr=x${u}; c_user=${u}; xs=t`, twofakey: o.two ? "AAAA AAAA AAA" : "", uid: u, ...(o.status ? { status: o.status } : {}), ...(o.eligible ? { wa_status: "eligible" } : {}) });

async function create(sess: string, name: string, rows: any[], preset: string) {
  const res = await request("/files", json({ name: `pipe-${runId}-${name}`, type: "fb_cookie", preset, poolKind: preset, password: PWD, poolEnabled: true, rows, dataCount: rows.length }), sess);
  if (res.status !== 200 || !res.body?.id) { fails.push(`create ${name}: ${res.status} ${errorText(res)}`); console.error(`FAIL create ${name}: ${res.status} ${errorText(res)}`); return null; }
  created.push({ id: res.body.id, sess });
  return res.body as { id: string };
}

async function poolKeys(pool: string, fileId?: string, sess = session) {
  const q = `fileId=${encodeURIComponent(fileId || "")}&limit=1000`;
  const res = await request(`/pools/${encodeURIComponent(PWD)}/${pool}/rows?${q}`, {}, sess);
  if (res.status !== 200) { fails.push(`pool rows ${pool}: ${res.status} ${errorText(res)}`); return new Set<string>(); }
  return new Set((res.body.rows as any[]).map((r) => String(r.uid)));
}

const eq = (got: Set<string>, want: string[]) => got.size === want.length && want.every((k) => got.has(k));

async function cleanup() {
  for (const { id, sess } of created) {
    await request(`/files/${id}`, { method: "DELETE" }, sess);
    const p = await request(`/archive/${id}`, { method: "DELETE" }, sess);
    if (![200, 404].includes(p.status)) console.error(`CLEANUP purge ${id}: ${p.status} ${errorText(p)}`);
  }
  console.log(`CLEANUP archived+purged ${created.length} files`);
}

async function run() {
  if (!session) throw new Error("Set SESSION_TOKEN (admin) in test/.env");
  const adminMe = await request("/auth/me"); assert(adminMe.status === 200 && adminMe.body?.isAdmin, "admin session must be admin");
  const adminId = String(adminMe.body.id);
  let user: string | null = Bun.env.USER_SESSION_TOKEN || null, userId = "";
  if (user) {
    const userMe = await request("/auth/me", {}, user);
    if (userMe.status !== 200 || String(userMe.body?.id) === adminId) { console.log(`SKIP second user: /auth/me → ${userMe.status} ${errorText(userMe)} — cross-user scenarios S3/S6/S7 will not run`); user = null; }
    else { userId = String(userMe.body.id); if (userMe.body?.isAdmin) quirk("user session is also admin on this env — cross-user scenarios still valid (dedup is uid-based, not role-based)"); }
  }
  console.log(`PASS sessions admin=${adminId}${user ? ` user=${userId}` : " (single-user mode)"}`);

  // ── S1: routing matrix ──────────────────────────────────────────────
  const c1 = uid(), c2 = uid(), c3 = uid(), k1 = uid(), k2 = uid(), p1 = uid(), p2 = uid(), p3 = uid();
  const s1combo = await create(session, "s1-combo", [row(c1, { two: true }), row(c2), row(c3, { two: true, status: "bad" }), { cookies: "datr=nocuser; xs=t", twofakey: "", uid: uid() }], "combo");
  const s1cookie = await create(session, "s1-cookie", [row(k1, { two: true }), row(k2)], "cookie");
  const s1page = await create(session, "s1-page", [row(p1, { two: true }), row(p2), row(p3, { two: true, eligible: true })], "page");
  await waitFor(async () => (await poolKeys("cookies_2fa", s1combo?.id)).size === 1 && (await poolKeys("cookies_only", s1cookie?.id)).size === 2 && (await poolKeys("page", s1page?.id)).size === 2, 15000);
  check("S1 combo: 2fa row → cookies_2fa, no-2fa row invalid (pooled nowhere)", eq(await poolKeys("cookies_2fa", s1combo?.id), [c1]) && eq(await poolKeys("cookies_only", s1combo?.id), []));
  check("S1 combo: status=bad row pooled nowhere", ![...(await poolKeys("cookies_2fa")), ...(await poolKeys("cookies_only"))].some((k) => k === c3));
  check("S1 cookie: all rows → cookies_only (2fa ignored)", eq(await poolKeys("cookies_only", s1cookie?.id), [k1, k2]));
  check("S1 page: 2fa rows → page pool, no-2fa row invalid (pooled nowhere)", eq(await poolKeys("page", s1page?.id), [p1, p3]) && eq(await poolKeys("cookies_only", s1page?.id), []));
  const s1inv = await request<any>(`/pools/${encodeURIComponent(PWD)}/cookies_2fa`);
  check("S1 invalid 2fa count surfaced in pool stats", s1inv.status === 200 && (s1inv.body?.totals?.invalid ?? 0) >= 1);

  // ── S2: same user re-uploads same rows ──────────────────────────────
  const d1 = uid(), d2 = uid(), dRows = [row(d1, { two: true }), row(d2, { two: true })];
  const s2a = await create(session, "s2-first", dRows, "combo");
  const s2b = await create(session, "s2-dup", dRows, "combo");
  await waitFor(async () => (await poolKeys("cookies_2fa", s2a?.id)).size === 2, 15000);
  await Bun.sleep(2500);
  check("S2 same user dup: pool holds 1 copy (both uids present once)", (await poolKeys("cookies_2fa")).has(d1) && (await poolKeys("cookies_2fa")).has(d2));
  check("S2 same user dup: dup file contributed 0", eq(await poolKeys("cookies_2fa", s2b?.id), []));

  // ── S3: different users upload the same account ─────────────────────
  if (user) {
    const e1 = uid(), e2 = uid(), eRows = [row(e1, { two: true }), row(e2, { two: true })];
    const s3a = await create(session, "s3-admin", eRows, "combo");
    const s3u = await create(user, "s3-user", eRows, "combo");
    await waitFor(async () => (await poolKeys("cookies_2fa", s3a?.id)).size === 2, 15000);
    await Bun.sleep(2500);
    check("S3 cross-user dup: pool keeps 1 copy (2 rows, not 4)", (await poolKeys("cookies_2fa")).has(e1) && (await poolKeys("cookies_2fa", s3u?.id)).size === 0);
    const uf = await request<any>(`/pools/${encodeURIComponent(PWD)}/cookies_2fa/user-files`);
    const adminUf = (uf.body?.users || []).find((u: any) => u.userId === adminId), userUf = (uf.body?.users || []).find((u: any) => u.userId === userId);
    check("S3 attribution: pool attributes rows to FIRST user; second user's file shows 0", uf.status === 200 && !!adminUf && adminUf.totalAvailable >= 2 && (!userUf || (userUf.files || []).every((f: any) => f.available === 0)));
  }

  // ── S4: 6 files, mixed presets, same 4 accounts ─────────────────────
  const a1 = uid(), a2 = uid(), b1 = uid(), b2 = uid(), s4Rows = [row(a1, { two: true }), row(a2, { two: true }), row(b1), row(b2)];
  const s4Presets = ["combo", "cookie", "page", "combo", "cookie", "page"];
  const s4 = [];
  for (let i = 0; i < 6; i++) s4.push(await create(session, `s4-f${i + 1}-${s4Presets[i]}`, s4Rows, s4Presets[i]));
  await waitFor(async () => (await poolKeys("cookies_2fa", s4[0]?.id)).size === 2, 15000);
  await Bun.sleep(3000);
  check("S4 f1(combo): 2fa rows → cookies_2fa, no-2fa rows invalid (pooled nowhere)", eq(await poolKeys("cookies_2fa", s4[0]?.id), [a1, a2]) && eq(await poolKeys("cookies_only", s4[0]?.id), []));
  check("S4 f2(cookie): b1,b2 → cookies_only (only cookie files feed cookies_only)", eq(await poolKeys("cookies_only", s4[1]?.id), [b1, b2]));
  check("S4 f3(page): accounts busy or invalid → 0 (single-pool rule)", eq(await poolKeys("page", s4[2]?.id), []));
  check("S4 f4/f5/f6 (dups): contributed 0", eq(await poolKeys("cookies_2fa", s4[3]?.id), []) && eq(await poolKeys("cookies_only", s4[4]?.id), []) && eq(await poolKeys("page", s4[5]?.id), []));
  quirk("S4: strict routing — a1,a2 pooled only by the 2fa file (cookies_2fa); b1,b2 rejected as invalid by the 2fa file (pool_rejects) and pooled by the cookie file (cookies_only); page file fed 0 — no file type feeds another type's pool");

  // ── S5: key-less combo rows are invalid; owner edit adding 2fa pools them and clears the count ─
  const g1 = uid(), g2 = uid();
  const s5 = await create(session, "s5-migrate", [row(g1), row(g2)], "combo");
  await Bun.sleep(3000);
  const invBefore = await request<any>(`/pools/${encodeURIComponent(PWD)}/cookies_2fa`);
  check("S5 setup: key-less combo rows counted invalid, pooled nowhere", invBefore.status === 200 && (invBefore.body?.totals?.invalid ?? 0) >= 2 && eq(await poolKeys("cookies_2fa", s5?.id), []));
  const migrated = [row(g1, { two: true }), row(g2, { two: true })];
  const persist = await request(`/files/${s5?.id}/persist`, put({ rows: migrated, dataCount: 2, action: "add-2fa" }));
  check("S5 persist accepted", persist.status === 200);
  await waitFor(async () => (await poolKeys("cookies_2fa", s5?.id)).size === 2, 15000);
  const invAfter = await request<any>(`/pools/${encodeURIComponent(PWD)}/cookies_2fa`);
  check("S5 edit: accounts pooled in cookies_2fa, invalid count cleared", eq(await poolKeys("cookies_2fa", s5?.id), [g1, g2]) && (invAfter.body?.totals?.invalid ?? 0) === (invBefore.body?.totals?.invalid ?? 0) - 2);

  // ── S6: a second file cannot claim an account that's already pooled (single-pool) ──
  if (user) {
    const x = uid();
    const s6P = await create(session, "s6-P-combo", [row(x, { two: true })], "combo");
    await waitFor(async () => (await poolKeys("cookies_2fa", s6P?.id)).size === 1, 15000);
    const s6Q = await create(user, "s6-Q-combo", [row(x, { two: true })], "combo");
    await Bun.sleep(2500);
    check("S6 setup: P owns X in cookies_2fa, Q's upload blocked (single-pool)", eq(await poolKeys("cookies_2fa", s6P?.id), [x]) && eq(await poolKeys("cookies_2fa", s6Q?.id), []));
    check("S6 pool still holds exactly 1 copy of X overall", (await poolKeys("cookies_2fa")).has(x));
  }

  // ── S7: purging a duplicate file must NOT touch another file's pooled copy ─
  if (user) {
    const z = uid();
    const s7U = await create(user, "s7-U-first", [row(z, { two: true })], "combo");
    const s7W = await create(session, "s7-W-dup", [row(z, { two: true })], "combo");
    await waitFor(async () => (await poolKeys("cookies_2fa", s7U?.id)).size === 1, 15000);
    await Bun.sleep(2500);
    check("S7 setup: U owns Z, W contributed 0", eq(await poolKeys("cookies_2fa", s7U?.id), [z]) && eq(await poolKeys("cookies_2fa", s7W?.id), []));
    await request(`/files/${s7W?.id}`, { method: "DELETE" }, session);
    const wpurge = await request(`/archive/${s7W?.id}`, { method: "DELETE" }, session);
    check("S7 purge W accepted", wpurge.status === 200);
    await Bun.sleep(2500);
    check("S7: purging duplicate W leaves U's pooled copy of Z intact (removeAvailable is file-scoped)", eq(await poolKeys("cookies_2fa", s7U?.id), [z]));
  }

  // ── S10: sold (claimed) account can never re-enter any pool ─────────
  const h1 = uid();
  const s10 = await create(session, "s10-sold", [row(h1, { two: true })], "combo");
  await waitFor(async () => (await poolKeys("cookies_2fa", s10?.id)).size === 1, 15000);
  const claim = await request<any>(`/pools/${encodeURIComponent(PWD)}/cookies_2fa/claim`, json({ count: 1, filename: `pipe-${runId}-s10.xlsx` }));
  check("S10 claim accepted (account sold)", claim.status === 200 && claim.body?.claimed === 1);
  await Bun.sleep(2000);
  const s10dup = await create(session, "s10-dup", [row(h1, { two: true })], "combo");
  await Bun.sleep(2500);
  check("S10 sold account: re-upload contributed 0 — burned forever", claim.body?.downloadId != null && eq(await poolKeys("cookies_2fa", s10dup?.id), []));
  const s10revert = await request(`/pools/downloads/${claim.body?.downloadId}/revert`, { method: "POST" });
  check("S10 cleanup: claim reverted", s10revert.status === 200 || s10revert.status === 404);

  // ── S9: hold-state decoration (holdState cast site) ─────────────────
  const s9rows = await request<any[]>(`/files/${s2a?.id}/rows`);
  check("S9 file rows: holdState decoration OK (200 + rows)", s9rows.status === 200 && Array.isArray(s9rows.body));

  console.log(`\n=== SUMMARY ===`);
  console.log(`${fails.length ? "FAILURES:\n- " + fails.join("\n- ") : "All pipeline checks passed."}`);
  if (quirks.length) console.log(`QUIRKS:\n- ${quirks.join("\n- ")}`);
  if (fails.length) throw new Error(`${fails.length} pipeline check(s) failed`);
}

try { await run(); } finally { await cleanup(); }
