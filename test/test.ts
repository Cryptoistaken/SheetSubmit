import { assert, assertStatus, base, errorText, fixtureDir, json, loadRows, put, request, session, waitFor } from "./lib";

const created: string[] = [];
const failures: string[] = [];
const downloads: string[] = [];
const token = session;
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

async function create(name: string, rows: any[], preset: string, poolEnabled = true) {
  const result = await request<any>("/files", json({ name: `live-${suffix}-${name}`, type: "fb_cookie", preset, poolKind: preset, password: "dgddigital", poolEnabled, rows, dataCount: rows.length, columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] }));
  if (result.status !== 200 || !result.body?.id) { failures.push(`create ${name}: ${result.status} ${errorText(result)}`); console.error(`FAIL create ${name}: ${result.status} ${errorText(result)}`); return null; }
  created.push(result.body.id); console.log(`PASS create ${name} 200`); return result.body;
}

async function cleanup() {
  for (const id of downloads) await request(`/pools/downloads/${id}/revert`, { method: "POST" });
  for (const id of created) {
    await request(`/files/${id}`, { method: "DELETE" });
    const archived = await request(`/archive/${id}`, { method: "DELETE" });
    if (![200, 404].includes(archived.status)) console.error(`CLEANUP archive ${id}: ${archived.status} ${errorText(archived)}`);
  }
}

async function run() {
  if (!token) throw new Error(`Set SESSION_TOKEN in ${fixtureDir}/.env`);
  const health = await request<any>("/health", {}, ""); assertStatus(health, 200, "health"); assert(health.body?.ok === true, "health: ok=false"); console.log(`PASS /health ${health.status} version=${health.body.version}`);
  const me = await request<any>("/auth/me"); assertStatus(me, 200, "auth/me"); assert(me.body?.id, "auth/me: missing user id"); console.log(`PASS /auth/me ${me.status} uid=${me.body.id} admin=${me.body.isAdmin}`);
  const badCookie = await request("/files", {}, "ss_session=definitely-invalid");
  if (![401, 403].includes(badCookie.status)) { failures.push(`invalid session rejection: ${badCookie.status} ${errorText(badCookie)}`); console.error(`FAIL invalid session rejection: got ${badCookie.status}: ${errorText(badCookie)}`); }

  const [cookieRows, rows2fa, pageRows] = await Promise.all([loadRows("cookie.xlsx"), loadRows("2fa.xlsx"), loadRows("Page.xlsx")]);
  assert(cookieRows.length === 5 && rows2fa.length === 5 && pageRows.length === 5, "fixtures: expected five rows in each workbook");
  const runId = Date.now().toString().slice(-7);
  const uniqueRows = (rows: any[]) => rows.map((row, index) => { const uid = `${row.uid}${runId}${index}`; return { ...row, uid, cookies: row.cookies.replace(/c_user=\d+/, `c_user=${uid}`) }; });
  const files = (await Promise.all([["cookie", uniqueRows(cookieRows), "cookie"], ["2fa", uniqueRows(rows2fa), "combo"], ["page", uniqueRows(pageRows), "page"]].map(([name, rows, preset]) => create(name as string, rows as any[], preset as string)))).filter(Boolean) as any[];
  console.log(`Created ${files.length}/3 fixture files`);

  for (const [label, path] of [["wallet", "/wallet"], ["wallet methods", "/wallet/methods"], ["admin stats", "/admin/stats"], ["pools", "/pools"], ["archive", "/archive"]] as const) {
    const result = await request(path); if (result.status < 200 || result.status >= 300) { failures.push(`${label}: ${result.status} ${errorText(result)}`); console.error(`FAIL ${label}: ${result.status} ${errorText(result)}`); } else console.log(`PASS ${label} ${result.status}`);
  }

  if (files.length < 3) { console.error("BLOCKED file lifecycle and pool allocation checks because one or more creates failed"); throw new Error(`${failures.length} checks failed; file lifecycle blocked`); }

  const first = await request<any>(`/files/${files[0].id}/full`); assertStatus(first, 200, "file full"); assert(first.body.rows.length === 5 && first.body.seq === 0, "file full: initial rows/seq mismatch");
  const append = await request<any>(`/files/${files[0].id}/append`, { ...json({ base: 0, ops: [{ rowIdx: 0, cols: { status: "good" } }] }), method: "PUT" }); assertStatus(append, 200, "append"); assert(append.body.seq === 1, "append: seq did not increment");
  const conflict = await request(` /files/${files[0].id}/append`.trim(), { ...json({ base: 0, ops: [{ rowIdx: 0, cols: { status: "bad" } }] }), method: "PUT" }); assertStatus(conflict, 409, "stale append conflict");
  const persist = await request<any>(`/files/${files[0].id}/persist`, { ...put({ rows: cookieRows, dataCount: cookieRows.length, action: "live-test" }) }); assertStatus(persist, 200, "persist"); assert(persist.body.seq === 2, "persist: seq did not increment");
  const rows = await request<any[]>(`/files/${files[0].id}/rows`); assertStatus(rows, 200, "rows"); assert(rows.body.length === 5, "rows: count mismatch");
  const dups = await request(`/cross-dups?fileId=${files[0].id}`); assertStatus(dups, 200, "cross-file duplicates");

  const archiveFile = await create("archive", uniqueRows(cookieRows), "cookie", false);
  assert(archiveFile, "archive fixture creation failed");
  assertStatus(await request(`/files/${archiveFile.id}`, { method: "DELETE" }), 200, "soft archive");
  const archived = await request<any[]>("/archive"); assertStatus(archived, 200, "archive listing"); assert(archived.body.some((file) => file.id === archiveFile.id), "archive listing missing archived file");
  assertStatus(await request(`/archive/${archiveFile.id}/restore`, { method: "POST" }), 200, "archive restore");
  const restored = await request<any[]>("/files"); assertStatus(restored, 200, "restored file listing"); assert(restored.body.some((file) => file.id === archiveFile.id), "restored file missing from active listing");
  assertStatus(await request(`/files/${archiveFile.id}`, { method: "DELETE" }), 200, "archive before permanent delete");
  assertStatus(await request(`/archive/${archiveFile.id}`, { method: "DELETE" }), 200, "permanent delete");
  const afterPurge = await request<any[]>("/archive"); assertStatus(afterPurge, 200, "archive after permanent delete"); assert(!afterPurge.body.some((file) => file.id === archiveFile.id), "permanently deleted file remains archived");
  console.log("PASS archive restore and permanent delete");

  const dupUid = `991${Date.now().toString().slice(-10)}`;
  const dupRow = (uid: string) => ({ cookies: `c_user=${uid}; xs=test`, twofakey: "JBSWY3DPEHPK3PXP", uid });
  const dupA = await create("dups-a", [dupRow(dupUid), dupRow(`${dupUid}1`)], "combo", false);
  const dupB = await create("dups-b", [dupRow(dupUid), dupRow(`${dupUid}2`)], "combo", false);
  assert(dupA && dupB, "duplicate fixtures creation failed");
  const duplicateResult = await request<any>(`/cross-dups?fileId=${dupA.id}`); assertStatus(duplicateResult, 200, "duplicate detection"); assert(duplicateResult.body.counts[dupA.id] > 0 && duplicateResult.body.dups[dupUid]?.length === 2, "duplicate detection missed shared UID");
  console.log("PASS duplicate detection");

  const priceBefore = await request<any>("/pools/dgddigital/page/price"); assertStatus(priceBefore, 200, "pool price read");
  const nextPrice = priceBefore.body.price === 1000 ? priceBefore.body.price - 0.01 : priceBefore.body.price + 0.01;
  assertStatus(await request("/pools/dgddigital/page/price", { method: "PUT", body: JSON.stringify({ price: nextPrice }) }), 200, "pool price update");
  const priceAfter = await request<any>("/pools/dgddigital/page/price"); assertStatus(priceAfter, 200, "pool price verify"); assert(priceAfter.body.price === nextPrice, "pool price update was not persisted");
  assertStatus(await request("/pools/dgddigital/page/price", { method: "PUT", body: JSON.stringify({ price: priceBefore.body.price }) }), 200, "pool price restore");
  console.log("PASS pool price update and restore");

  const pageSimpleMissing = await request("/fb/page-simple", json({})); assertStatus(pageSimpleMissing, 400, "simple check missing cookie");
  const syntheticCookie = `c_user=${dupUid}; xs=invalid-test`;
  const pageSimple = await request<any>("/fb/page-simple", json({ cookie: syntheticCookie })); assertStatus(pageSimple, 200, "simple check contract"); assert(typeof pageSimple.body.eligible === "boolean" && "error" in pageSimple.body, "simple check response shape invalid");
  const cache = await request<any>(`/fb/cache?uids=${dupUid}`); assertStatus(cache, 200, "simple check cache read"); assert(cache.body.cache && typeof cache.body.cache === "object", "simple check cache response invalid");
  console.log(`PASS simple check contract eligible=${pageSimple.body.eligible}`);

  const poolReady = await waitFor(async () => { const page = await request<any>(`/pools/dgddigital/page/rows?fileId=${files[2].id}&limit=10`); return page.status === 200 && page.body.total >= 5; });
  assert(poolReady, "pool feed did not become visible within 15 seconds");
  const hold = await request<any>("/pools/dgddigital/page/hold", json({ count: 1, mode: "pick", srcFileIds: [files[2].id] })); assertStatus(hold, 200, "pool hold"); assert(hold.body.holdId, "pool hold: missing hold id");
  const approvedHold = await request<any>("/pools/dgddigital/page/hold", json({ count: 1, mode: "pick", srcFileIds: [files[2].id] })); assertStatus(approvedHold, 200, "second pool hold"); assert(approvedHold.body.holdId, "second pool hold: missing hold id");
  const approved = await request<any>(`/pools/holds/${approvedHold.body.holdId}/approve`, { method: "POST" }); assertStatus(approved, 200, "pool hold approve"); assert(approved.body.status === "APPROVED", "pool hold approve status mismatch");
  if (approvedHold.body.downloadId) { downloads.push(approvedHold.body.downloadId); assertStatus(await request(`/pools/downloads/${approvedHold.body.downloadId}/detail`), 200, "approved download detail"); }
  const rejected = await request(`/pools/holds/${hold.body.holdId}/reject`, { method: "POST" }); assertStatus(rejected, 200, "pool hold reject");
  const claim = await request<any>("/pools/dgddigital/page/claim", json({ count: 1, srcFileId: files[2].id })); assertStatus(claim, 200, "pool claim");
  if (claim.body.downloadId) { downloads.push(claim.body.downloadId); const reverted = await request(`/pools/downloads/${claim.body.downloadId}/revert`, { method: "POST" }); assertStatus(reverted, 200, "pool claim revert"); assertStatus(await request(`/pools/downloads/${claim.body.downloadId}`, { method: "DELETE" }), 200, "reverted download delete"); downloads.splice(downloads.indexOf(claim.body.downloadId), 1); }
  console.log("PASS pool feed, hold/reject, claim/revert");

  const wallet = await request<any>("/wallet"); assertStatus(wallet, 200, "wallet read");
  assertStatus(await request("/wallet/withdraw", json({ amount: 0, method: "bkash", account: "01700000000" })), 400, "withdrawal validation");
  assertStatus(await request("/wallet/requests/missing-live-test/reject", { method: "POST" }), 404, "missing withdrawal decision");
  const withdrawAmount = Math.min(Number(wallet.body.balance || 0), 0.01);
  if (withdrawAmount > 0) {
    const withdrawal = await request<any>("/wallet/withdraw", json({ amount: withdrawAmount, method: "bkash", account: "01700000000" })); assertStatus(withdrawal, 200, "withdrawal create");
    assertStatus(await request(`/wallet/requests/${withdrawal.body.id}/reject`, { method: "POST" }), 200, "withdrawal reject");
    const second = await request<any>("/wallet/withdraw", json({ amount: withdrawAmount, method: "bkash", account: "01700000000" })); assertStatus(second, 200, "second withdrawal create");
    assertStatus(await request(`/wallet/requests/${second.body.id}/approve`, { method: "POST" }), 200, "withdrawal approve");
    console.log("PASS withdrawal reject/refund and approve");
  } else {
    assertStatus(await request("/wallet/withdraw", json({ amount: 0.01, method: "bkash", account: "01700000000" })), 400, "insufficient withdrawal");
    console.log("SKIP withdrawal approve/reject: wallet balance is zero");
  }

  for (const id of created) { const archived = await request(`/files/${id}`, { method: "DELETE" }); if (![200, 404].includes(archived.status)) assertStatus(archived, 200, `archive ${id}`); const purged = await request(`/archive/${id}`, { method: "DELETE" }); if (![200, 404].includes(purged.status)) assertStatus(purged, 200, `purge ${id}`); }
  if (failures.length) throw new Error(`${failures.length} integration checks failed: ${failures.join(" | ")}`);
  console.log(`PASS archive and purge ${created.length} fixture files`);
  console.log(`Live integration passed against ${base}`);
  return failures;
}

try { await run(); } finally { await cleanup(); }
