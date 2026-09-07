import { assert, assertStatus, base, errorText, fixtureDir, json, loadRows, request, session, waitFor } from "./lib";

const created: string[] = [];
const token = session;
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function create(name: string, rows: any[], preset: string) {
  const result = await request<any>("/files", json({ name: `live-${suffix}-${name}`, type: "fb_cookie", preset, poolKind: preset, password: "dgddigital", poolEnabled: true, rows, dataCount: rows.length, columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] }));
  assertStatus(result, 200, `create ${name}`); assert(result.body?.id, `create ${name}: missing id`); created.push(result.body.id); return result.body;
}

async function cleanup() {
  for (const id of created) {
    await request(`/files/${id}`, { method: "DELETE" });
    const archived = await request(`/archive/${id}`, { method: "DELETE" });
    if (![200, 404].includes(archived.status)) console.error(`CLEANUP archive ${id}: ${archived.status} ${errorText(archived)}`);
  }
}

async function run() {
  if (!token) throw new Error(`Set SESSION_TOKEN in ${fixtureDir}/.env`);
  let failures = 0;
  const health = await request<any>("/health", {}, ""); assertStatus(health, 200, "health"); assert(health.body?.ok === true, "health: ok=false"); console.log(`PASS /health ${health.status} version=${health.body.version}`);
  const me = await request<any>("/auth/me"); assertStatus(me, 200, "auth/me"); assert(me.body?.id, "auth/me: missing user id"); console.log(`PASS /auth/me ${me.status} uid=${me.body.id} admin=${me.body.isAdmin}`);
  const badCookie = await request("/files", {}, "ss_session=definitely-invalid");
  if (![401, 403].includes(badCookie.status)) { failures++; console.error(`FAIL invalid session rejection: got ${badCookie.status}: ${errorText(badCookie)}`); }

  const [cookieRows, rows2fa, pageRows] = await Promise.all([loadRows("cookie.xlsx"), loadRows("2fa.xlsx"), loadRows("Page.xlsx")]);
  assert(cookieRows.length === 5 && rows2fa.length === 5 && pageRows.length === 5, "fixtures: expected five rows in each workbook");
  const files = [await create("cookie", cookieRows, "cookie"), await create("2fa", rows2fa, "combo"), await create("page", pageRows, "page")];
  console.log(`PASS created ${files.length} fixture files with ${cookieRows.length + rows2fa.length + pageRows.length} rows`);

  const first = await request<any>(`/files/${files[0].id}/full`); assertStatus(first, 200, "file full"); assert(first.body.rows.length === 5 && first.body.seq === 0, "file full: initial rows/seq mismatch");
  const append = await request<any>(`/files/${files[0].id}/append`, { ...json({ base: 0, ops: [{ rowIdx: 0, cols: { status: "good" } }] }), method: "PUT" }); assertStatus(append, 200, "append"); assert(append.body.seq === 1, "append: seq did not increment");
  const conflict = await request(` /files/${files[0].id}/append`.trim(), { ...json({ base: 0, ops: [{ rowIdx: 0, cols: { status: "bad" } }] }), method: "PUT" }); assertStatus(conflict, 409, "stale append conflict");
  const persist = await request<any>(`/files/${files[0].id}/persist`, { ...put({ rows: cookieRows, dataCount: cookieRows.length, action: "live-test" }) }); assertStatus(persist, 200, "persist"); assert(persist.body.seq === 2, "persist: seq did not increment");
  const rows = await request<any[]>(`/files/${files[0].id}/rows`); assertStatus(rows, 200, "rows"); assert(rows.body.length === 5, "rows: count mismatch");
  const dups = await request(`/cross-dups?fileId=${files[0].id}`); assertStatus(dups, 200, "cross-file duplicates");

  const poolReady = await waitFor(async () => { const page = await request<any>("/pools/dgddigital/page"); return page.status === 200 && page.body.totals.available >= 5; });
  assert(poolReady, "pool feed did not become visible within 15 seconds");
  const hold = await request<any>("/pools/dgddigital/page/hold", json({ count: 1, mode: "pick", srcFileIds: [files[2].id] })); assertStatus(hold, 200, "pool hold"); assert(hold.body.holdId, "pool hold: missing hold id");
  const rejected = await request(`/pools/holds/${hold.body.holdId}/reject`, { method: "POST" }); assertStatus(rejected, 200, "pool hold reject");
  const claim = await request<any>("/pools/dgddigital/page/claim", json({ count: 1, srcFileId: files[2].id })); assertStatus(claim, 200, "pool claim");
  if (claim.body.downloadId) { const reverted = await request(`/pools/downloads/${claim.body.downloadId}/revert`, { method: "POST" }); assertStatus(reverted, 200, "pool claim revert"); }
  console.log("PASS pool feed, hold/reject, claim/revert");

  for (const id of created) { const archived = await request(`/files/${id}`, { method: "DELETE" }); assertStatus(archived, 200, `archive ${id}`); const purged = await request(`/archive/${id}`, { method: "DELETE" }); assertStatus(purged, 200, `purge ${id}`); }
  if (failures) throw new Error(`${failures} integration checks failed`);
  console.log(`PASS archive and purge ${created.length} fixture files`);
  console.log(`Live integration passed against ${base}`);
  return failures;
}

try { await run(); } finally { await cleanup(); }
