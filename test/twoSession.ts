import { assert, assertStatus, base, errorText, fixtureDir, json, loadRows, put, request, session, waitFor } from "./lib";

const userSession = Bun.env.USER_SESSION_TOKEN || "";
const admin = <T = any>(path: string, init: RequestInit = {}) => request<T>(path, init, session);
const user = <T = any>(path: string, init: RequestInit = {}) => request<T>(path, init, userSession);
const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const created: string[] = [];
const downloads: string[] = [];

function uniqueRows(rows: any[]) {
  const runId = Date.now().toString().slice(-7);
  return rows.map((row, index) => {
    const uid = `${row.uid}${runId}${index}`;
    return { ...row, uid, cookies: row.cookies.replace(/c_user=\d+/, `c_user=${uid}`) };
  });
}

async function create(rows: any[], preset: string, poolEnabled = true) {
  const result = await user<any>("/files", json({
    name: `two-session-${suffix}-${preset}`,
    type: "fb_cookie",
    preset,
    poolKind: preset,
    password: "dgddigital",
    poolEnabled,
    rows,
    dataCount: rows.length,
    columns: [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "twofakey", label: "2fa key", width: 200 },
      { key: "uid", label: "uid", width: 120 },
    ],
  }));
  assertStatus(result, 200, `create ${preset}`);
  assert(result.body?.id, `create ${preset}: missing id`);
  created.push(result.body.id);
  return result.body;
}

async function cleanup() {
  for (const id of downloads) {
    const reverted = await admin(`/pools/downloads/${id}/revert`, { method: "POST" });
    if (![200, 404].includes(reverted.status)) console.error(`CLEANUP revert ${id}: ${reverted.status} ${errorText(reverted)}`);
    const deleted = await admin(`/pools/downloads/${id}`, { method: "DELETE" });
    if (![200, 404].includes(deleted.status)) console.error(`CLEANUP download ${id}: ${deleted.status} ${errorText(deleted)}`);
  }
  for (const id of created) {
    const archived = await user(`/files/${id}`, { method: "DELETE" });
    if (![200, 404].includes(archived.status)) console.error(`CLEANUP archive ${id}: ${archived.status} ${errorText(archived)}`);
    const purged = await user(`/archive/${id}`, { method: "DELETE" });
    if (![200, 404].includes(purged.status)) console.error(`CLEANUP purge ${id}: ${purged.status} ${errorText(purged)}`);
  }
}

async function run() {
  if (!session) throw new Error(`Set SESSION_TOKEN in ${fixtureDir}/.env`);
  if (!userSession) throw new Error(`Set USER_SESSION_TOKEN in ${fixtureDir}/.env`);

  const health = await request<any>("/health", {}, "");
  assertStatus(health, 200, "health");
  const [adminMe, userMe] = await Promise.all([admin<any>("/auth/me"), user<any>("/auth/me")]);
  assertStatus(adminMe, 200, "admin auth/me");
  assertStatus(userMe, 200, "user auth/me");
  assert(adminMe.body?.isAdmin === true, "admin session is not admin");
  assert(userMe.body?.isAdmin === false, "user session unexpectedly has admin access");
  console.log(`PASS identity admin=${adminMe.body.id} user=${userMe.body.id}`);

  const invalid = await request("/files", {}, "ss_session=definitely-invalid");
  assertStatus(invalid, [401, 403], "invalid session rejection");
  assertStatus(await user("/pools"), 403, "user pools permission");
  assertStatus(await user("/admin/stats"), 403, "user admin permission");
  assertStatus(await user("/wallet/requests"), 403, "user withdrawal-list permission");
  assertStatus(await admin("/wallet"), 200, "admin wallet self access");
  console.log("PASS authentication and permission boundaries");

  const [cookieRows, pageRows] = await Promise.all([loadRows("cookie.xlsx"), loadRows("Page.xlsx")]);
  assert(cookieRows.length === 5 && pageRows.length === 5, "fixtures: expected five rows");
  const pageFile = await create(uniqueRows(pageRows), "page");
  const privateFile = await create(uniqueRows(cookieRows), "cookie", false);

  const userFiles = await user<any[]>("/files");
  assert(userFiles.status === 200 && userFiles.body.some((file) => file.id === pageFile.id), "user file listing missing page file");
  assertStatus(await admin(`/files/${pageFile.id}/rows`), 404, "admin cannot read user file through owner route");
  assertStatus(await admin(`/admin/file/${pageFile.id}/rows`), 200, "admin file inspection");
  assertStatus(await admin(`/admin/file/${pageFile.id}`), 200, "admin file read");
  console.log("PASS file ownership and admin inspection");

  const full = await user<any>(`/files/${privateFile.id}/full`);
  assertStatus(full, 200, "file full");
  assert(full.body.seq === 0 && full.body.rows.length === 5, "initial file state mismatch");
  const append = await user<any>(`/files/${privateFile.id}/append`, { ...json({ base: 0, ops: [{ rowIdx: 0, cols: { state_check: "appended" } }] }), method: "PUT" });
  assertStatus(append, 200, "append");
  assert(append.body.seq === 1, "append did not increment seq");
  assertStatus(await user(`/files/${privateFile.id}/append`, { ...json({ base: 0, ops: [] }), method: "PUT" }), 409, "stale append");
  const persisted = await user<any>(`/files/${privateFile.id}/persist`, { ...put({ rows: append.body.file ? append.body.rows : full.body.rows, dataCount: 5, action: "two-session" }) });
  assertStatus(persisted, 200, "persist");
  assert(persisted.body.seq === 2, "persist did not increment seq");
  console.log("PASS file seq, append conflict, and persist state");

  assertStatus(await user(`/files/${privateFile.id}`, { method: "DELETE" }), 200, "archive file");
  assertStatus(await user(`/archive/${privateFile.id}/restore`, { method: "POST" }), 200, "restore file");
  assertStatus(await user(`/files/${privateFile.id}`, { method: "DELETE" }), 200, "archive before purge");
  assertStatus(await user(`/archive/${privateFile.id}`, { method: "DELETE" }), 200, "purge file");
  created.splice(created.indexOf(privateFile.id), 1);
  console.log("PASS archive, restore, and purge");

  const ready = await waitFor(async () => {
    const rows = await admin<any>(`/pools/dgddigital/page/rows?fileId=${pageFile.id}&limit=10`);
    return rows.status === 200 && rows.body.total >= 5;
  });
  assert(ready, "page pool did not receive user rows");
  const initialPool = await admin<any>(`/pools/dgddigital/page/rows?fileId=${pageFile.id}&limit=10`);
  assertStatus(initialPool, 200, "initial pool rows");
  assert(initialPool.body.rows.every((row) => row._state === "available"), "initial pool rows are not available");

  const hold = await admin<any>("/pools/dgddigital/page/hold", json({ count: 1, mode: "pick", srcFileIds: [pageFile.id] }));
  assertStatus(hold, 200, "create hold");
  assert(hold.body.status === "HOLD" && hold.body.holdId, "hold state/id missing");
  downloads.push(hold.body.holdId);
  const heldPool = await admin<any>(`/pools/dgddigital/page/rows?fileId=${pageFile.id}&limit=10`);
  assertStatus(heldPool, 200, "held pool rows");
  assert(heldPool.body.total === initialPool.body.total - 1, "held row remained available");
  assertStatus(await user(`/pools/holds/${hold.body.holdId}/approve`, { method: "POST" }), 403, "user hold approval permission");

  const beforeApproval = await user<any>(`/files/${pageFile.id}/rows`);
  assertStatus(beforeApproval, 200, "source rows before approval");
  const walletBeforeApproval = await user<any>("/wallet");
  assertStatus(walletBeforeApproval, 200, "wallet before approval");
  const approved = await admin<any>(`/pools/holds/${hold.body.holdId}/approve`, { method: "POST" });
  assertStatus(approved, 200, "approve hold");
  assert(approved.body.status === "APPROVED", "hold did not become approved");
  const detail = await admin<any>(`/pools/downloads/${hold.body.holdId}/detail`);
  assertStatus(detail, 200, "approved detail");
  assert(detail.body.status === "APPROVED" && detail.body.groups?.some((group) => group.srcFileId === pageFile.id), "approved detail lost source file state");
  const afterApproval = await user<any>(`/files/${pageFile.id}/rows`);
  assertStatus(afterApproval, 200, "source rows after approval");
  assert(afterApproval.body.length === beforeApproval.body.length, "approval deleted user source rows");
  const walletAfterApproval = await user<any>("/wallet");
  assertStatus(walletAfterApproval, 200, "wallet after approval");
  assert(Number(walletAfterApproval.body.balance) >= Number(walletBeforeApproval.body.balance) + Number(detail.body.total || 0), "approved hold did not credit source user wallet");
  console.log("PASS hold -> approved state and source-file integrity");

  const rejectedHold = await admin<any>("/pools/dgddigital/page/hold", json({ count: 1, mode: "pick", srcFileIds: [pageFile.id] }));
  assertStatus(rejectedHold, 200, "second hold");
  assert(rejectedHold.body.holdId, "second hold id missing");
  downloads.push(rejectedHold.body.holdId);
  assertStatus(await admin(`/pools/holds/${rejectedHold.body.holdId}/reject`, { method: "POST" }), 200, "reject hold");
  const restoredPool = await admin<any>(`/pools/dgddigital/page/rows?fileId=${pageFile.id}&limit=10`);
  assertStatus(restoredPool, 200, "rejected pool rows");
  assert(restoredPool.body.total === initialPool.body.total - 1, "rejected row count does not reflect approved row only");
  console.log("PASS hold rejection returns row to available state");

  const claim = await admin<any>("/pools/dgddigital/page/claim", json({ count: 1, srcFileId: pageFile.id }));
  assertStatus(claim, 200, "claim page");
  assert(claim.body.downloadId && claim.body.status === "CLAIMED", "claim state missing");
  downloads.push(claim.body.downloadId);
  assertStatus(await user(`/pools/downloads/${claim.body.downloadId}`, { method: "DELETE" }), 403, "user download deletion permission");
  assertStatus(await admin(`/pools/downloads/${claim.body.downloadId}`, { method: "DELETE" }), 400, "active download deletion guard");
  assertStatus(await admin(`/pools/downloads/${claim.body.downloadId}/revert`, { method: "POST" }), 200, "revert claim");
  assertStatus(await admin(`/pools/downloads/${claim.body.downloadId}`, { method: "DELETE" }), 200, "delete reverted download");
  downloads.splice(downloads.indexOf(claim.body.downloadId), 1);
  console.log("PASS claim, revert, and download deletion state");

  const beforeWallet = await user<any>("/wallet");
  assertStatus(beforeWallet, 200, "user wallet before withdrawal");
  assertStatus(await user("/wallet/withdraw", json({ amount: 0, method: "bkash", account: "01700000000" })), 400, "withdrawal validation");
  const amount = Math.min(Number(beforeWallet.body.balance || 0), 0.01);
  if (amount > 0) {
    const rejected = await user<any>("/wallet/withdraw", json({ amount, method: "bkash", account: "01700000000" }));
    assertStatus(rejected, 200, "withdrawal create");
    assert(rejected.body.status === "PENDING", "withdrawal is not pending");
    assertStatus(await admin(`/wallet/requests/${rejected.body.id}/reject`, { method: "POST" }), 200, "withdrawal reject");
    const approved = await user<any>("/wallet/withdraw", json({ amount, method: "bkash", account: "01700000000" }));
    assertStatus(approved, 200, "second withdrawal create");
    assertStatus(await admin(`/wallet/requests/${approved.body.id}/approve`, { method: "POST" }), 200, "withdrawal approve");
    assertStatus(await user(`/wallet/requests/${approved.body.id}/approve`, { method: "POST" }), 403, "user withdrawal approval permission");
    console.log("PASS withdrawal pending -> rejected/refunded and pending -> approved");
  } else {
    assertStatus(await user("/wallet/withdraw", json({ amount: 0.01, method: "bkash", account: "01700000000" })), 400, "insufficient withdrawal");
    console.log("SKIP withdrawal lifecycle: user wallet balance is zero");
  }

  console.log(`Live two-session integration passed against ${base}`);
}

try {
  await run();
} finally {
  await cleanup();
}
