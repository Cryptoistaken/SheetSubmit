import { assert, assertStatus, errorText, json, loadRows, request, session, waitFor } from "./lib";

// Duplicate checker: uploads the 2fa/cookie/Page fixtures as files under BOTH pool passwords,
// re-uploads the 2fa rows a second time as a new file, then asks the pool rows API whether
// it returns ALL accounts or only deduplicated ones. Cleans up (archive + purge) everything.
const PASSWORDS = ["dgddigital", "L0VE@12345"];
const POOLS = ["cookies_only", "cookies_2fa", "page"] as const;
const prefix = `dup${Date.now().toString(36).slice(-6)}`;
const created: string[] = [];
const failures: string[] = [];

const tag = (rows: any[]) => rows.map((row, i) => { const uid = `${prefix}${i}`; return { ...row, uid, cookies: row.cookies.replace(/c_user=\d+/, `c_user=${uid}`) }; });

async function create(label: string, rows: any[], preset: string, password: string) {
  const res = await request<any>("/files", json({ name: `dupcheck-${prefix}-${label}`, type: "fb_cookie", preset, poolKind: preset, password, poolEnabled: true, rows, dataCount: rows.length, columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] }));
  if (res.status !== 200 || !res.body?.id) { failures.push(`create ${label}@${password}: ${res.status} ${errorText(res)}`); console.error(`FAIL create ${label}@${password}: ${res.status} ${errorText(res)}`); return null; }
  created.push(res.body.id);
  console.log(`PASS create ${label}@${password} id=${res.body.id} rows=${rows.length}`);
  return res.body as { id: string };
}

/** Pooled rows for one source file (server-side src_file_id filter — pool-wide scans can exceed the 1000-row page). */
async function filePoolRows(password: string, pool: string, fileId: string) {
  const res = await request<any>(`/pools/${encodeURIComponent(password)}/${pool}/rows?fileId=${encodeURIComponent(fileId)}&limit=1000`);
  if (res.status !== 200) { failures.push(`pool rows ${password}/${pool}/${fileId}: ${res.status} ${errorText(res)}`); console.error(`FAIL pool rows ${password}/${pool} file=${fileId}: ${res.status} ${errorText(res)}`); return { total: 0, rows: [] as any[] }; }
  return { total: Number(res.body.total || 0), rows: (res.body.rows as any[]) || [] };
}

async function cleanup() {
  for (const id of created) {
    await request(`/files/${id}`, { method: "DELETE" });
    const purged = await request(`/archive/${id}`, { method: "DELETE" });
    if (![200, 404].includes(purged.status)) console.error(`CLEANUP purge ${id}: ${purged.status} ${errorText(purged)}`);
  }
  console.log(`CLEANUP archived+purged ${created.length} files`);
}

async function run() {
  if (!session) throw new Error("Set SESSION_TOKEN in test/.env");
  const me = await request<any>("/auth/me");
  assertStatus(me, 200, "auth/me");
  assert(me.body?.isAdmin, "pool rows API is admin-only — SESSION_TOKEN in test/.env must be an admin account");
  console.log(`PASS /auth/me uid=${me.body.id} admin=${me.body.isAdmin}`);

  const [rows2fa, rowsCookie, rowsPage] = await Promise.all([loadRows("2fa.xlsx"), loadRows("cookie.xlsx"), loadRows("Page.xlsx")]);
  assert(rows2fa.length && rowsCookie.length && rowsPage.length, "fixtures: 2fa.xlsx / cookie.xlsx / Page.xlsx must each have rows");
  const [fa, fc, fp] = [tag(rows2fa), tag(rowsCookie), tag(rowsPage)];
  const uniquePerPassword = new Set([...fa, ...fc, ...fp].map((r) => r.uid)).size;

  // Phase 1 — first upload per password: 2fa + cookie + page files (uids unique to this run)
  const firstByPwd = new Map<string, { twoA: string; cookieA: string; pageA: string }>();
  for (const password of PASSWORDS) {
    const a = await create("2fa-a", fa, "combo", password);
    const ck = await create("cookie-a", fc, "cookie", password);
    const pg = await create("page-a", fp, "page", password);
    if (a && ck && pg) firstByPwd.set(password, { twoA: a.id, cookieA: ck.id, pageA: pg.id });
  }
  assert(firstByPwd.size === PASSWORDS.length, "first-phase file creation failed");

  // fixture rows route by preset: combo+2fa → cookies_2fa, cookie → cookies_only, page+2fa → page
  const firstFiles = [
    { key: "2fa-a", pool: "cookies_2fa", want: fa.length },
    { key: "cookie-a", pool: "cookies_only", want: fc.length },
    { key: "page-a", pool: "page", want: fp.length },
  ] as const;
  const fed = await waitFor(async () => {
    for (const [password, ref] of firstByPwd) for (const f of firstFiles) if ((await filePoolRows(password, f.pool, ref[f.key as keyof typeof ref])).total < f.want) return false;
    return true;
  }, 30000);
  assert(fed, "pool feed (first uploads) did not become visible within 30s");
  console.log("PASS pool feed visible for first uploads");

  // Phase 2 — re-upload the SAME 2fa rows as NEW files (cross-file duplicate) under each password
  const dupByPwd = new Map<string, string>();
  for (const password of PASSWORDS) {
    const b = await create("2fa-b-dup", fa, "combo", password);
    if (b) dupByPwd.set(password, b.id);
  }
  await Bun.sleep(4000); // give the async feedPools of the dup files time to land

  console.log(`\n=== POOL STATE (per source file, this run's uids ${prefix}*) ===`);
  let firstPooled = 0, dupPooled = 0;
  for (const [password, ref] of firstByPwd) {
    for (const f of firstFiles) {
      const { total } = await filePoolRows(password, f.pool, ref[f.key as keyof typeof ref]);
      firstPooled += total;
      console.log(`${password} / ${f.pool} <- ${f.key}: ${total} (pushed ${f.want})`);
      if (total !== f.want) failures.push(`${password}/${f.key}: expected ${f.want} pooled rows, got ${total}`);
    }
    const dupId = dupByPwd.get(password);
    if (dupId) {
      const dup = await filePoolRows(password, "cookies_2fa", dupId);
      dupPooled += dup.total;
      console.log(`${password} / cookies_2fa <- 2fa-b-dup (exact copy): ${dup.total} (pushed ${fa.length})`);
    }
  }

  console.log(`\n=== VERDICT ===`);
  console.log(`Pushed per password: ${uniquePerPassword} unique accounts + ${fa.length} exact duplicates (re-uploaded as new files)`);
  if (dupPooled === 0 && firstPooled === PASSWORDS.length * uniquePerPassword) {
    console.log(`RESULT: the pool API returns ONLY DEDUPLICATED accounts.`);
    console.log(`  - dedup key = (pool password, pool_id, uid/row_key); FIRST file to feed an account wins`);
    console.log(`  - the duplicate re-upload contributed 0 rows — silently dropped at feed time (pg.ts "add" op)`);
    console.log(`  - rows?fileId=<first-file> → ${fa.length}, rows?fileId=<dup-file> → 0 proves the pool stores only the first file's copy`);
    console.log(`  - no cross-password dedup: each pool password holds its own independent copy of the accounts`);
  } else if (dupPooled === PASSWORDS.length * fa.length) {
    console.log(`RESULT: the pool API returns ALL accounts — duplicates INCLUDED (${dupPooled} dup rows pooled)`);
  } else {
    console.log(`RESULT: MIXED — first-file rows pooled: ${firstPooled}, duplicate rows pooled: ${dupPooled}`);
  }
  if (failures.length) throw new Error(`${failures.length} dup-check failure(s): ${failures.join(" | ")}`);
  console.log("\nDuplicate check passed");
}

try { await run(); } finally { await cleanup(); }
