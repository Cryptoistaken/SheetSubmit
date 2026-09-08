import { assert, assertStatus, errorText, json, loadRows, request, session, waitFor } from "./lib";

// Duplicate checker: uploads the 2fa/cookie/Page fixtures as files under BOTH pool passwords,
// re-uploads the 2fa rows a second time as a new file, then asks the pool rows API whether
// it returns ALL accounts or only deduplicated ones. Cleans up (archive + purge) everything.
const PASSWORDS = ["dgddigital", "L0VE@12345"];
const POOLS = ["cookies_only", "cookies_2fa", "page"] as const;
const prefix = `${Date.now().toString().slice(-9)}`; // digits only — pool classify() requires c_user=<digits>
const created: string[] = [];
const failures: string[] = [];

const tag = (rows: any[], base: number) => rows.map((row, i) => { const uid = `${prefix}${base}${i}`; return { ...row, uid, cookies: row.cookies.replace(/c_user=\d+/, `c_user=${uid}`) }; });

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
  const [fa, fc, fp] = [tag(rows2fa, 0), tag(rowsCookie, 1), tag(rowsPage, 2)];
  const uniquePerPassword = new Set([...fa, ...fc, ...fp].map((r) => r.uid)).size;

  // Phase 1 — first upload under dgddigital: 2fa + cookie + page files (uids unique to this run)
  const a = await create("2fa-a", fa, "combo", PASSWORDS[0]);
  const ck = await create("cookie-a", fc, "cookie", PASSWORDS[0]);
  const pg = await create("page-a", fp, "page", PASSWORDS[0]);
  assert(a && ck && pg, "first-phase file creation failed");
  const firstRef = { "2fa-a": a!.id, "cookie-a": ck!.id, "page-a": pg!.id };

  // fixture rows route by preset: combo+2fa → cookies_2fa, cookie → cookies_only, page+2fa → page
  const firstFiles = [
    { key: "2fa-a", pool: "cookies_2fa", want: fa.length },
    { key: "cookie-a", pool: "cookies_only", want: fc.length },
    { key: "page-a", pool: "page", want: fp.length },
  ] as const;
  const fed = await waitFor(async () => {
    for (const f of firstFiles) if ((await filePoolRows(PASSWORDS[0], f.pool, firstRef[f.key as keyof typeof firstRef])).total < f.want) return false;
    return true;
  }, 30000);
  assert(fed, "pool feed (first uploads) did not become visible within 30s");
  console.log("PASS pool feed visible for first uploads");

  // Phase 2 — same accounts under the SECOND password: must contribute 0 (account lives in one pool globally)
  const secondByPool: Record<string, string> = {};
  const second2fa = await create("2fa-b-pwd2", fa, "combo", PASSWORDS[1]);
  const secondCookie = await create("cookie-b-pwd2", fc, "cookie", PASSWORDS[1]);
  const secondPage = await create("page-b-pwd2", fp, "page", PASSWORDS[1]);
  if (second2fa) secondByPool["cookies_2fa"] = second2fa.id;
  if (secondCookie) secondByPool["cookies_only"] = secondCookie.id;
  if (secondPage) secondByPool["page"] = secondPage.id;

  // Phase 3 — re-upload the SAME 2fa rows as NEW file under the FIRST password (same-password duplicate)
  const dup = await create("2fa-c-dup", fa, "combo", PASSWORDS[0]);
  await Bun.sleep(4000); // give the async feedPools of the dup files time to land

  console.log(`\n=== POOL STATE (per source file, this run's uids ${prefix}*) ===`);
  let firstPooled = 0, blockedPooled = 0, dupPooled = 0;
  for (const f of firstFiles) {
    const { total } = await filePoolRows(PASSWORDS[0], f.pool, firstRef[f.key as keyof typeof firstRef]);
    firstPooled += total;
    console.log(`${PASSWORDS[0]} / ${f.pool} <- ${f.key}: ${total} (pushed ${f.want})`);
    if (total !== f.want) failures.push(`${PASSWORDS[0]}/${f.key}: expected ${f.want} pooled rows, got ${total}`);
  }
  for (const [pool, id] of Object.entries(secondByPool)) {
    const { total } = await filePoolRows(PASSWORDS[1], pool, id);
    blockedPooled += total;
    console.log(`${PASSWORDS[1]} / ${pool} <- same accounts, second password: ${total} (pushed ${fa.length})`);
    if (total !== 0) failures.push(`${PASSWORDS[1]}/${pool}: single-pool rule violated — ${total} rows pooled under a second password`);
  }
  if (dup) {
    const dupRows = await filePoolRows(PASSWORDS[0], "cookies_2fa", dup.id);
    dupPooled = dupRows.total;
    console.log(`${PASSWORDS[0]} / cookies_2fa <- 2fa-c-dup (exact copy): ${dupRows.total} (pushed ${fa.length})`);
  }

  console.log(`\n=== VERDICT ===`);
  console.log(`Pushed: ${uniquePerPassword} unique accounts, re-uploaded under a second password + as exact duplicates`);
  if (dupPooled === 0 && blockedPooled === 0 && firstPooled === uniquePerPassword) {
    console.log(`RESULT: an account lives in EXACTLY ONE pool — globally across passwords and pool types.`);
    console.log(`  - FIRST file to feed an account wins; later uploads (same or different password) contribute 0`);
    console.log(`  - same-password duplicate re-upload → 0 (dropped at feed time, pg.ts "add" op)`);
    console.log(`  - second-password upload → 0 (single-pool rule: busy anywhere = blocked)`);
  } else {
    console.log(`RESULT: MIXED — first-file rows pooled: ${firstPooled}, second-password rows: ${blockedPooled}, duplicate rows: ${dupPooled}`);
    if (dupPooled !== 0) failures.push(`duplicate re-upload pooled ${dupPooled} rows (expected 0)`);
    if (blockedPooled !== 0) failures.push(`second-password upload pooled ${blockedPooled} rows (expected 0)`);
  }
  if (failures.length) throw new Error(`${failures.length} dup-check failure(s): ${failures.join(" | ")}`);
  console.log("\nDuplicate check passed");
}

try { await run(); } finally { await cleanup(); }
