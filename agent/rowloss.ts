// agent/rowloss.ts — API-level row-loss regression (Fixes 1, 3, 5).
// DEV BACKEND ONLY: mints users via POST /api/test/login (404s unless
// ALLOW_TEST_AUTH=1 — never prod). All files namespaced per-run, cleaned up.
//
// Checks:
//   A. stale-base structural persist → 409 version conflict (Fix 1)
//   B. uid-only + status-only rows survive a persist round-trip (Fix 3)
//   C. snapshot restore brings back a deleted row (Fix 5)
//   D. >500 rows refused server-side on create + persist (strict cap)
//   E. double bad save still recoverable via snapshot index 1 (Fix #8)
//   F. purge tombstones the log trail for admin forensics (Fix #8)
//
// Usage: bun agent/rowloss.ts --admin-uid <id-in-dev-ADMIN_IDS> [--base <url>]
import { loadAgentEnv } from "./env";
await loadAgentEnv();

const argv = Bun.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`agent/rowloss — row-loss regression (dev backend only)\n\n  bun agent/rowloss.ts --admin-uid <id-in-dev-ADMIN_IDS> [--base <url>]`);
  process.exit(0);
}
const flag = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
};

const base = (flag("base") || Bun.env.BACKEND_URL || "").trim().replace(/\/+$/, "");
if (!base) throw new Error("BACKEND_URL is required (agent/.env or --base) — DEV backend only");
const adminUid = flag("admin-uid") || Bun.env.AGENT_ADMIN_UID || "";
if (!/^[A-Za-z0-9_-]{1,64}$/.test(adminUid)) throw new Error("--admin-uid <id-in-dev-ADMIN_IDS> is required");
const ownerUid = `agent-qa-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PWD = "dgddigital";
const fails: string[] = [];
const pass = (l: string) => console.log(`PASS ${l}`);
const fail = (l: string, d = "") => { console.log(`FAIL ${l}${d ? ` — ${d}` : ""}`); fails.push(l); };

async function api(path: string, opts: { method?: string; body?: unknown; session?: string } = {}) {
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
  let body: any = text;
  try { body = text ? JSON.parse(text) : ""; } catch { /* raw */ }
  return { status: res.status, body };
}

async function login(uid: string, name: string): Promise<string> {
  const res = await fetch(`${base}/api/test/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid, name }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) throw new Error("test login door closed — backend needs ALLOW_TEST_AUTH=1 (never prod)");
  const getSet = (res.headers as any).getSetCookie?.bind(res.headers);
  const cookies: string[] = typeof getSet === "function" ? getSet() : [res.headers.get("set-cookie") || ""];
  const tok = cookies.map((c) => c.match(/(?:^|;\s*)ss_session=([^;]+)/)?.[1]).find(Boolean);
  if (!tok) throw new Error("no ss_session cookie");
  return decodeURIComponent(tok);
}

const created: { id: string }[] = [];
let ownerSession = "";
async function cleanup(owner: string) {
  for (const f of created) {
    await api(`/api/files/${f.id}`, { method: "DELETE", session: owner });
    await api(`/api/archive/${f.id}`, { method: "DELETE", session: owner });
  }
  console.log(`CLEANUP ${created.length} file(s) archived+purged`);
}

async function main() {
  const owner = await login(ownerUid, "Agent QA RowLoss");
  ownerSession = owner;
  const admin = await login(adminUid, "Agent QA RowLoss Admin");
  const me = await api("/api/auth/me", { session: admin });
  if (me.status !== 200 || !me.body?.isAdmin) throw new Error(`${adminUid} is not admin on this backend (dev ADMIN_IDS?)`);

  const mk = (u: string, two = true) => ({ cookies: `datr=x${u}; c_user=${u}; xs=t`, twofakey: two ? "AAAA AAAA AAA" : "", uid: u, status: "" });
  const run = Date.now().toString().slice(-9);

  // A. stale base → 409
  {
    const u = `${run}01`;
    const c = await api("/api/files", { body: { name: `rowloss-A-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows: [mk(u)], dataCount: 1 }, session: owner });
    if (c.status !== 200 || !c.body?.id) throw new Error(`setup A failed: ${c.status}`);
    created.push({ id: c.body.id });
    const full = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    const seq = Number(full.body?.seq ?? 0);
    const p1 = await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [mk(u)], base: seq, action: "rowloss-A" }, session: owner });
    if (p1.status !== 200) fail("A setup persist", `${p1.status}`);
    else {
      const stale = await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [], base: seq, action: "rowloss-A-stale" }, session: owner });
      if (stale.status === 409 && JSON.stringify(stale.body).includes("version conflict")) pass("A stale-base persist rejected with 409 version conflict");
      else fail("A stale-base persist rejected", `${stale.status} ${JSON.stringify(stale.body).slice(0, 160)}`);
      const cur = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
      if (Array.isArray(cur.body?.rows) && cur.body.rows.some((r: any) => String(r.uid) === u)) pass("A server rows intact after rejected write");
      else fail("A server rows intact after rejected write", JSON.stringify(cur.body).slice(0, 160));
    }
  }

  // B. uid-only + status-only rows survive persist round-trip
  {
    const u1 = `${run}02`, u2 = `${run}03`;
    const rows = [mk(u1), { cookies: "", twofakey: "", uid: u2, status: "" }, { cookies: "", twofakey: "", uid: "", status: "bad" }];
    const c = await api("/api/files", { body: { name: `rowloss-B-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows, dataCount: 3 }, session: owner });
    if (c.status !== 200 || !c.body?.id) throw new Error(`setup B failed: ${c.status}`);
    created.push({ id: c.body.id });
    const full = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    const p = await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows, base: Number(full.body?.seq ?? 0), action: "rowloss-B" }, session: owner });
    const back = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    const have = new Set((Array.isArray(back.body?.rows) ? back.body.rows : []).map((r: any) => `u=${r.uid}|s=${r.status}`));
    if (p.status === 200 && have.has(`u=${u1}|s=`) && have.has(`u=${u2}|s=`) && have.has(`u=|s=bad`)) pass("B uid-only + status-only rows survive persist round-trip");
    else fail("B uid-only + status-only rows survive persist round-trip", `${p.status} have=${[...have].join(",")}`);
  }

  // C. snapshot restore brings back a deleted row
  {
    const u1 = `${run}04`, u2 = `${run}05`;
    const c = await api("/api/files", { body: { name: `rowloss-C-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows: [mk(u1), mk(u2)], dataCount: 2 }, session: owner });
    if (c.status !== 200 || !c.body?.id) throw new Error(`setup C failed: ${c.status}`);
    created.push({ id: c.body.id });
    const full = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    const del = await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [mk(u1)], base: Number(full.body?.seq ?? 0), action: "rowloss-C-delete" }, session: owner });
    if (del.status !== 200) fail("C delete-one persist", `${del.status}`);
    else {
      const r = await api<any>(`/api/files/${c.body.id}/restore-snapshot`, { method: "POST", session: owner });
      const back = new Set((Array.isArray(r.body?.rows) ? r.body.rows : []).map((x: any) => String(x.uid)));
      if (r.status === 200 && back.has(u1) && back.has(u2)) pass("C restore-snapshot brings back the deleted row");
      else fail("C restore-snapshot brings back the deleted row", `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  }

  // D. >500 rows refused server-side (strict cap, create + persist)
  {
    const rows = Array.from({ length: 501 }, (_, i) => mk(`${run}6${String(i).padStart(3, "0")}`));
    const c = await api("/api/files", { body: { name: `rowloss-D-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows, dataCount: 501 }, session: owner });
    if (c.status === 400) pass("D 501-row create refused with 400");
    else fail("D 501-row create refused with 400", `${c.status}`);
    const s = await api("/api/files", { body: { name: `rowloss-D2-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows: [mk(`${run}60`)], dataCount: 1 }, session: owner });
    if (s.status !== 200 || !s.body?.id) throw new Error(`setup D2 failed: ${s.status}`);
    created.push({ id: s.body.id });
    const full = await api<any>(`/api/files/${s.body.id}/full`, { session: owner });
    const p = await api(`/api/files/${s.body.id}/persist`, { method: "PUT", body: { rows, base: Number(full.body?.seq ?? 0), action: "rowloss-D" }, session: owner });
    if (p.status === 400) pass("D 501-row persist refused with 400");
    else fail("D 501-row persist refused with 400", `${p.status}`);
  }

  // E. double bad save still recoverable via snapshot index 1
  {
    const u1 = `${run}07`, u2 = `${run}08`;
    const c = await api("/api/files", { body: { name: `rowloss-E-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows: [mk(u1), mk(u2)], dataCount: 2 }, session: owner });
    if (c.status !== 200 || !c.body?.id) throw new Error(`setup E failed: ${c.status}`);
    created.push({ id: c.body.id });
    const f0 = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [mk(u1)], base: Number(f0.body?.seq ?? 0), action: "rowloss-E-bad1" }, session: owner });
    const f1 = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [], base: Number(f1.body?.seq ?? 0), action: "rowloss-E-bad2" }, session: owner });
    const r0 = await api<any>(`/api/files/${c.body.id}/restore-snapshot`, { method: "POST", body: { index: 0 }, session: owner });
    const got0 = new Set((Array.isArray(r0.body?.rows) ? r0.body.rows : []).map((x: any) => String(x.uid)));
    const r1 = await api<any>(`/api/files/${c.body.id}/restore-snapshot`, { method: "POST", body: { index: 1 }, session: owner });
    const got1 = new Set((Array.isArray(r1.body?.rows) ? r1.body.rows : []).map((x: any) => String(x.uid)));
    if (r0.status === 200 && got0.size === 1 && got0.has(u1) && r1.status === 200 && got1.has(u1) && got1.has(u2)) {
      pass("E index restore: 0 → [u1], 1 → [u1,u2] (double bad save recoverable)");
    } else fail("E index restore after double bad save", `${r0.status}/${r1.status} got0=[${[...got0]}] got1=[${[...got1]}]`);
  }

  // F. purge tombstones the log trail (admin forensics survive the wipe)
  {
    const u = `${run}09`;
    const c = await api("/api/files", { body: { name: `rowloss-F-${run}`, type: "fb_cookie", preset: "combo", poolKind: "combo", password: PWD, poolEnabled: false, rows: [mk(u)], dataCount: 1 }, session: owner });
    if (c.status !== 200 || !c.body?.id) throw new Error(`setup F failed: ${c.status}`);
    const full = await api<any>(`/api/files/${c.body.id}/full`, { session: owner });
    await api(`/api/files/${c.body.id}/persist`, { method: "PUT", body: { rows: [mk(u)], base: Number(full.body?.seq ?? 0), action: "rowloss-F-touch" }, session: owner });
    await api(`/api/files/${c.body.id}`, { method: "DELETE", session: owner });
    const purge = await api(`/api/archive/${c.body.id}`, { method: "DELETE", session: owner });
    if (purge.status !== 200) fail("F purge", `${purge.status}`);
    else {
      const logs = await api<any>(`/api/admin/file/${c.body.id}/logs`, { session: admin });
      if (logs.status === 200 && logs.body?.tombstoned === true && Array.isArray(logs.body?.tomb?.logs) && logs.body.tomb.logs.length >= 1 && logs.body.tomb.name === `rowloss-F-${run}`) {
        pass("F purged file serves log tombstone to admin");
      } else fail("F purged file serves log tombstone to admin", `${logs.status} ${JSON.stringify(logs.body).slice(0, 160)}`);
    }
  }

  console.log(`\n=== SUMMARY ===\n${fails.length ? `FAILURES:\n- ${fails.join("\n- ")}` : "All row-loss checks passed."}`);
  if (fails.length) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  fail("rowloss aborted", String((e as Error)?.message || e).slice(0, 300));
  process.exitCode = 1;
} finally {
  try { if (ownerSession) await cleanup(ownerSession); } catch { /* best effort */ }
}
