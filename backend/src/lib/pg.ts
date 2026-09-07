import { SQL } from "bun";
import type { Row, SheetFile } from "./shared";

const db = new SQL({
  url: Bun.env.DATABASE_URL || "",
  max: 10,
  idleTimeout: 20,
  connectionTimeout: 10,
  maxLifetime: 1800,
});

export async function closeDatabase() { await db.close(); }
export async function pingDatabase() { await db`SELECT 1`; }
export async function bootstrapDatabase() { await db.unsafe(await Bun.file(new URL("../../sql/001_initial.sql", import.meta.url)).text()); }
const j = (v: any) => JSON.stringify(v);

const pools = ["cookies_only", "cookies_2fa", "page"] as const;
type Pool = typeof pools[number];
const prices: Record<Pool, number> = { cookies_only: .02, cookies_2fa: .05, page: .1 };
const json = (v: any) => v == null ? null : typeof v === "string" ? JSON.parse(v) : v;
const key = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
const eligible = (r: any) => String(r?.wa_status ?? r?.waStatus ?? "").toLowerCase() === "eligible";
const real2fa = (r: Row) => { const v = String(r.twofakey ?? r["2fa key"] ?? "").trim(); return !!v && v !== "No_2Fa"; };
const preset = (v: unknown) => { const s = String(v || "").toLowerCase(); return s === "2fa" ? "combo" : ["cookie", "combo", "page"].includes(s) ? s : null; };
function classify(r: Row, p?: string | null): Pool | null {
  if (!/c_user=\d+/.test(String(r.cookies || "")) || !r.uid || ["bad", "dead"].includes(String(r.status || "").toLowerCase())) return null;
  const two = real2fa(r); if (p === "page") return two ? "page" : "cookies_only"; if (p === "combo") return two ? "cookies_2fa" : "cookies_only"; if (p === "cookie") return "cookies_only";
  return eligible(r) && two ? "page" : two ? "cookies_2fa" : "cookies_only";
}
function counts(rows: Row[]) { let live = 0, dead = 0, page = 0, dup = 0; const keys = new Map<string, number>(); for (const r of rows) { const s = String(r.status || "").toLowerCase(); if (s === "good") live++; else if (s === "bad") dead++; if (String(r.wa_status || "").toLowerCase() === "eligible") page++; const k = key(r); if (k) keys.set(k, (keys.get(k) || 0) + 1); } keys.forEach((n) => { if (n > 1) dup += n; }); return { liveCount: live, deadCount: dead, pageCount: page, dupCount: dup }; }
const rowOut = (r: any) => ({ ...json(r.data), _key: r.row_key, _state: r.state, _claimedBy: r.claimed_by, _claimedAt: r.claimed_at, _srcUid: r.src_uid, _srcFileId: r.src_file_id, _insertedAt: r.inserted_at, _holdId: r.hold_id });
const price = (p: string) => prices[p as Pool] ?? 0;

async function indexOp(op: string, a: any) {
  switch (op) {
    case "ensureUser": await db`INSERT INTO users(user_id,name,username,photo_url,phone) VALUES(${a.id},${a.name || ""},${a.username || ""},${a.photoUrl || null},${a.phone || null}) ON CONFLICT(user_id) DO UPDATE SET name=EXCLUDED.name,username=EXCLUDED.username,photo_url=COALESCE(EXCLUDED.photo_url,users.photo_url),phone=COALESCE(EXCLUDED.phone,users.phone)`; return { ok: true };
    case "user": return (await db`SELECT * FROM users WHERE user_id=${a.id}`)[0] || null;
    case "users": return db`SELECT * FROM users ORDER BY created_at DESC`;
    case "ban": await db`UPDATE users SET banned=${!!a.banned} WHERE user_id=${a.id}`; return { ok: true };
    case "register": await db`INSERT INTO file_index(file_id,owner_id,archived,data) VALUES(${a.file.id},${a.uid},false,${j(a.file)}) ON CONFLICT(file_id) DO UPDATE SET owner_id=EXCLUDED.owner_id,archived=false,data=EXCLUDED.data,updated_at=now()`; return { ok: true };
    case "file": { const r: any = (await db`SELECT data,owner_id,archived FROM file_index WHERE file_id=${a.id}`)[0]; return r ? { ...r, data: typeof r.data === "string" ? r.data : JSON.stringify(r.data) } : null; }
    case "files": { const rows = a.archived === "all" ? await db`SELECT data FROM file_index WHERE owner_id=${a.uid}` : a.archived === 1 ? await db`SELECT data FROM file_index WHERE owner_id=${a.uid} AND archived=true` : await db`SELECT data FROM file_index WHERE owner_id=${a.uid} AND archived=false`; return rows.map((r: any) => json(r.data)); }
    case "archive": await db`UPDATE file_index SET archived=${!!a.archived},data=${j(a.file)},updated_at=now() WHERE file_id=${a.id}`; return { ok: true };
    case "batchArchive": await db.transaction(async (tx: any) => { for (const f of a.files as SheetFile[]) await tx`UPDATE file_index SET archived=false,data=${j(f)},updated_at=now() WHERE file_id=${f.id}`; }); return { ok: true };
    case "purge": await db`DELETE FROM file_index WHERE file_id=${a.id}`; return { ok: true };
    case "batchPurge": await db`DELETE FROM file_index WHERE file_id=ANY(${db.array((a.ids || []).map(String))})`; return { ok: true };
    case "deleteUser": await db`DELETE FROM users WHERE user_id=${a.id}`; return { ok: true };
    case "walletCredit": { const uid = String(a.uid || a.userId || ""), amount = Number(a.amount ?? a.credit ?? 0); if (!uid || !Number.isFinite(amount) || amount === 0) throw new Error("invalid wallet credit"); const r: any = (await db`INSERT INTO wallets(user_id,balance) VALUES(${uid},${amount}) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+EXCLUDED.balance RETURNING balance`)[0]; return { ok: true, balance: Number(r.balance) }; }
    case "walletGet": { const uid = String(a.uid || a.userId || ""); if (!uid) throw new Error("uid required"); const r: any = (await db`SELECT balance FROM wallets WHERE user_id=${uid}`)[0]; return { uid, balance: r ? Number(r.balance) : 0 }; }
    case "walletWithdrawals": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); return db`SELECT * FROM withdrawals WHERE user_id=${uid} ORDER BY created_at DESC`; }
    case "walletWithdraw": { const uid = String(a.uid || ""), id = String(a.id || ""), method = String(a.method || "").trim(), account = String(a.account || ""); const amount = Number(a.amount); if (!uid || !id || !method || !account || !Number.isFinite(amount) || amount <= 0) throw new Error("invalid withdrawal"); const now = Date.now(); return db.transaction(async (tx: any) => { await tx`INSERT INTO wallets(user_id,balance) VALUES(${uid},0) ON CONFLICT(user_id) DO NOTHING`; const updated = await tx`UPDATE wallets SET balance=balance-${amount} WHERE user_id=${uid} AND balance>=${amount} RETURNING balance`; if (!updated.length) throw new Error("insufficient balance"); await tx`INSERT INTO withdrawals(id,user_id,amount,method,account,status,created_at,updated_at) VALUES(${id},${uid},${amount},${method},${account},'PENDING',${now},${now})`; return { id, amount, method, account, status: "PENDING", created_at: now, updated_at: now }; }); }
    case "walletRequests": { const status = String(a.status || "").trim(); return status ? db`SELECT w.*,u.name,u.username,u.photo_url FROM withdrawals w LEFT JOIN users u ON u.user_id=w.user_id WHERE w.status=${status} ORDER BY w.created_at DESC` : db`SELECT w.*,u.name,u.username,u.photo_url FROM withdrawals w LEFT JOIN users u ON u.user_id=w.user_id ORDER BY w.created_at DESC`; }
    case "walletDecision": { const id = String(a.id || ""), status = String(a.status || ""); if (!id || !["APPROVED", "REJECTED"].includes(status)) throw new Error("invalid wallet decision"); return db.transaction(async (tx: any) => { const row: any = (await tx`SELECT amount,user_id,status FROM withdrawals WHERE id=${id} FOR UPDATE`)[0]; if (!row) throw new Error("withdrawal not found"); if (row.status !== "PENDING") return { id, status: row.status }; await tx`UPDATE withdrawals SET status=${status},updated_at=${Date.now()} WHERE id=${id}`; if (status === "REJECTED") await tx`INSERT INTO wallets(user_id,balance) VALUES(${row.user_id},${row.amount}) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+EXCLUDED.balance`; return { id, status }; }); }
    case "paymentMethodsGet": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); const r: any = (await db`SELECT v FROM meta WHERE k=${`paymentMethods:${uid}`}`)[0]; return r?.v ?? {}; }
    case "paymentMethodsSet": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); const methods = a.methods ?? {}; await db`INSERT INTO meta(k,v) VALUES(${`paymentMethods:${uid}`},${j(methods)}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; return { ok: true }; }
    case "adminUsers": { const rows: any[] = await db`SELECT u.*,COUNT(f.file_id) FILTER (WHERE f.archived=false) AS "fileCount",COUNT(f.file_id) FILTER (WHERE f.archived=true) AS "archivedCount" FROM users u LEFT JOIN file_index f ON f.owner_id=u.user_id GROUP BY u.user_id ORDER BY u.created_at DESC`; return rows; }
    case "metaSet": await db`INSERT INTO meta(k,v) VALUES(${a.k},${j(a.v)}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; return { ok: true };
    case "metaGet": { const r: any = (await db`SELECT v FROM meta WHERE k=${a.k}`)[0]; return r?.v ?? null; }
    case "metaGetMany": { const rows: any[] = await db`SELECT k,v FROM meta WHERE k=ANY(${db.array((a.keys || []).slice(0, 1000))})`; return Object.fromEntries(rows.map((r) => [r.k, r.v])); }
    case "metaDel": await db`DELETE FROM meta WHERE k=${a.k}`; return { ok: true };
    case "allFiles": return db`SELECT data,owner_id FROM file_index`;
    case "stats": { const r: any = (await db`SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM file_index WHERE archived=false) AS files`)[0]; return { totalUsers: Number(r.users), totalFiles: Number(r.files) }; }
    case "session": await db`INSERT INTO sessions(token,user_id,exp) VALUES(${a.token},${a.uid},${a.exp}) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,exp=EXCLUDED.exp`; return { ok: true };
    case "getSession": return (await db`SELECT * FROM sessions WHERE token=${a.token} AND exp>${Date.now()}`)[0] || null;
    case "deleteSession": await db`DELETE FROM sessions WHERE token=${a.token}`; return { ok: true };
    case "deviceSet": return deviceOp("set", a);
    case "deviceGet": return deviceOp("get", a);
    case "deviceDelete": return deviceOp("delete", a);
    case "deviceByChat": return deviceOp("byChat", a);
    case "deviceSession": return deviceOp("session", a);
    default: throw new Error(`unknown operation: ${op}`);
  }
}
async function deviceOp(kind: string, a: any) {
  const didKey = `device:${a.did}`, chatKey = `deviceByChat:${a.chatId}`;
  if (kind === "get") { const r: any = (await db`SELECT v FROM meta WHERE k=${didKey}`)[0]; return r?.v ?? null; }
  if (kind === "byChat") { const r: any = (await db`SELECT v FROM meta WHERE k=${chatKey}`)[0]; return r?.v ?? null; }
  return db.transaction(async (tx: any) => {
    const current: any = (await tx`SELECT v FROM meta WHERE k=${didKey} FOR UPDATE`)[0]; if (current) await tx`DELETE FROM meta WHERE k=${`deviceByChat:${current.v.chatId}`}`;
    const previous: any = (await tx`SELECT v FROM meta WHERE k=${chatKey} FOR UPDATE`)[0]; if (previous) await tx`DELETE FROM meta WHERE k=${`device:${previous.v.did}`}`;
    if (kind === "delete") await tx`DELETE FROM meta WHERE k=${didKey}`; else { await tx`INSERT INTO meta(k,v) VALUES(${didKey},${j({ chatId: a.chatId })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; await tx`INSERT INTO meta(k,v) VALUES(${chatKey},${j({ did: a.did })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; }
    return { ok: true };
  });
}

async function fileOp(id: string, op: string, a: any) {
  if (op === "init") return db.transaction(async (tx: any) => { await tx`INSERT INTO file_meta(file_id,data,seq) VALUES(${id},${j(a.file)},0) ON CONFLICT(file_id) DO UPDATE SET data=EXCLUDED.data,seq=0`; await tx`DELETE FROM file_rows WHERE file_id=${id}`; await tx`DELETE FROM file_logs WHERE file_id=${id}`; for (const [i, r] of (a.rows || []).entries()) await tx`INSERT INTO file_rows(file_id,idx,data) VALUES(${id},${i},${j(r)})`; return { ok: true }; });
  if (op === "meta") { const r: any = (await db`SELECT data FROM file_meta WHERE file_id=${id}`)[0]; return r?.data ?? null; }
  if (op === "seq") { const r: any = (await db`SELECT seq FROM file_meta WHERE file_id=${id}`)[0]; return { seq: Number(r?.seq || 0) }; }
  const readRows = async (q: any = db) => (await q`SELECT data FROM file_rows WHERE file_id=${id} ORDER BY idx`).map((r: any) => json(r.data) as Row);
  if (op === "rows") return readRows();
  if (op === "full") { const r: any = (await db`SELECT seq FROM file_meta WHERE file_id=${id}`)[0]; return { rows: await readRows(), seq: Number(r?.seq || 0) }; }
  if (op === "counts") return counts(await readRows());
  if (["keys", "dupKeys", "projection"].includes(op)) { const rows = await readRows(); const limit = Math.min(10000, Math.max(1, Number(a.limit) || 10000)); return rows.flatMap((r: Row, i: number) => { const k = key(r); return k ? [{ k, i }] : []; }).slice(0, limit); }
  if (op === "wipe") return db.transaction(async (tx: any) => { const rows = (await tx`SELECT data FROM file_rows WHERE file_id=${id}`).map((r: any) => json(r.data)); await tx`DELETE FROM file_meta WHERE file_id=${id}`; return { ok: true, rows }; });
  if (op === "getLogs") return db`SELECT id,ts,action,seq FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200`;
  if (op !== "save" && op !== "append") throw new Error(`unknown operation: ${op}`);
  return db.transaction(async (tx: any) => {
    const meta: any = (await tx`SELECT data,seq FROM file_meta WHERE file_id=${id} FOR UPDATE`)[0]; if (!meta) throw new Error("file not found"); const current = Number(meta.seq);
    let rows: Row[] = (await tx`SELECT data FROM file_rows WHERE file_id=${id} ORDER BY idx`).map((r: any) => json(r.data));
    if (op === "append") { if (!Number.isInteger(a.base) || a.base !== current) throw new Error("version conflict"); if (!Array.isArray(a.ops) || a.ops.length > 10000) throw new Error("invalid append payload"); for (const x of a.ops) { if (!x || !Number.isInteger(x.rowIdx) || x.rowIdx < 0 || x.rowIdx > 100000 || !x.cols || Array.isArray(x.cols)) throw new Error("invalid op"); while (rows.length <= x.rowIdx) rows.push({}); rows[x.rowIdx] = { ...rows[x.rowIdx], ...x.cols }; } }
    else if (Array.isArray(a.rows)) rows = a.rows;
    const file = a.file || meta.data; if (file) { Object.assign(file, counts(rows)); file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = String(a.action || (op === "append" ? "append" : "edit")); if (a.dataCount !== undefined) file.dataCount = a.dataCount; }
    const next = current + 1; await tx`UPDATE file_meta SET data=${j(file)},seq=${next} WHERE file_id=${id}`; await tx`DELETE FROM file_rows WHERE file_id=${id}`; for (const [i, r] of rows.entries()) await tx`INSERT INTO file_rows(file_id,idx,data) VALUES(${id},${i},${j(r)})`; await tx`INSERT INTO file_logs(file_id,ts,action,seq) VALUES(${id},${Date.now()},${String(a.action || (op === "append" ? "append" : "edit"))},${next})`; await tx`DELETE FROM file_logs WHERE file_id=${id} AND id NOT IN (SELECT id FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200)`;
    return { ok: true, seq: next, ...(op === "append" ? { file, rows } : Array.isArray(a.rows) ? { rows } : {}) };
  });
}

function poolFilters(a: any) { const u = Array.isArray(a.srcUids) ? a.srcUids.map(String).filter(Boolean) : a.srcUid ? [String(a.srcUid)] : []; const f = Array.isArray(a.srcFileIds) ? a.srcFileIds.map(String).filter(Boolean) : a.srcFileId ? [String(a.srcFileId)] : []; return { u, f }; }
function downloadShape(r: any) { const unit = r.unit_price == null ? price(r.pool_id) : Number(r.unit_price); const total = r.total == null ? +(unit * Number(r.claimed)).toFixed(2) : Number(r.total); return { id: r.id, poolId: r.pool_id, pool_id: r.pool_id, claimedBy: r.claimed_by, claimed_by: r.claimed_by, claimed: Number(r.claimed), filename: r.filename, rows: json(r.rows), keys: json(r.keys), reverted: !!r.reverted, ts: Number(r.ts), status: r.status || (r.reverted ? "REVERTED" : "CLAIMED"), unitPrice: unit, unit_price: r.unit_price == null ? null : Number(r.unit_price), total, mode: r.mode || null, srcUids: json(r.src_uids), srcFileIds: json(r.src_file_ids), selection: json(r.selection) }; }

async function poolOp(password: string, op: string, a: any) {
  const p = String(a.pool || ""); if (["priceGet", "priceSet", "summary", "detail", "counts", "claim", "hold", "verifiedCounts", "pageCounts", "pageVerifiedCounts", "userFiles", "ledger"].includes(op) && !pools.includes(p as Pool)) throw new Error("invalid pool");
  if (op === "priceGet") { const r: any = (await db`SELECT price FROM pool_settings WHERE password=${password} AND pool_id=${p}`)[0]; return { poolId: p, password, price: r ? Number(r.price) : price(p) }; }
  if (op === "priceSet") { const n = Number(a.price); if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("invalid price"); await db`INSERT INTO pool_settings(password,pool_id,price) VALUES(${password},${p},${n}) ON CONFLICT(password,pool_id) DO UPDATE SET price=EXCLUDED.price`; return { poolId: p, password, price: n }; }
  if (op === "add") return db.transaction(async (tx: any) => { (tx as any).json = j; let added = 0; const pp = preset(a.preset ?? a.poolKind ?? a.filePreset ?? a.file?.preset ?? a.file?.poolKind); for (const r of a.rows as Row[]) { const pool = classify(r, pp), k = key(r); if (!pool || !k) continue; if (a.srcFileId && pp) await tx`DELETE FROM pool_rows WHERE password=${password} AND pool_id<>${pool} AND row_key=${k} AND src_file_id=${a.srcFileId} AND state='available'`; const exists = await tx`SELECT 1 FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND row_key=${k}`; if (!exists.length) { await tx`INSERT INTO pool_rows(password,pool_id,row_key,data,src_uid,src_file_id,inserted_at) VALUES(${password},${pool},${k},${tx.json(r)},${a.srcUid || null},${a.srcFileId || null},${Date.now()})`; await tx`INSERT INTO pool_ledger(password,pool_id,row_key,user_id,action,ts) VALUES(${password},${pool},${k},${a.uid || null},'add',${Date.now()})`; added++; } } return { added }; });
  if (op === "counts") { const r: any[] = await db`SELECT pool_id,COUNT(*) n FROM pool_rows WHERE password=${password} AND state='available' GROUP BY pool_id`; return Object.fromEntries(pools.map((x) => [x, Number(r.find((y) => y.pool_id === x)?.n || 0)])); }
  if (op === "summary") { const r: any = (await db`SELECT COUNT(*) FILTER(WHERE state='available') available,COUNT(*) FILTER(WHERE state='claimed') claimed,COUNT(DISTINCT src_uid) users FROM pool_rows WHERE password=${password} AND pool_id=${p}`)[0]; return { available: Number(r.available), claimed: Number(r.claimed), users: Number(r.users) }; }
  if (op === "detail") return (await db`SELECT row_key,data,state,claimed_by,claimed_at,src_uid,src_file_id,inserted_at,hold_id FROM pool_rows WHERE password=${password} AND pool_id=${p} ORDER BY inserted_at,row_key`).map(rowOut);
  if (op === "userFiles") { const rows: any[] = await db`SELECT src_uid,src_file_id,state,COUNT(*) n FROM pool_rows WHERE password=${password} AND pool_id=${p} AND src_uid IS NOT NULL GROUP BY src_uid,src_file_id,state`; const users = new Map<string, any>(); let noSrcAvail = 0; for (const r of rows) { if (r.state === "available" && !r.src_uid) noSrcAvail += Number(r.n); const u = users.get(r.src_uid) || { userId: r.src_uid, files: [], totalAvailable: 0, totalClaimed: 0 }; const f = u.files.find((x: any) => x.fileId === (r.src_file_id || "_unknown")) || { fileId: r.src_file_id || "_unknown", available: 0, claimed: 0 }; f[r.state] = Number(r.n); if (!u.files.includes(f)) u.files.push(f); u.totalAvailable += r.state === "available" ? Number(r.n) : 0; u.totalClaimed += r.state === "claimed" ? Number(r.n) : 0; users.set(r.src_uid, u); } return { users: [...users.values()], noSrcAvail }; }
  if (op === "verifiedCounts" || op === "pageCounts" || op === "pageVerifiedCounts") { const all: any[] = await db`SELECT data FROM pool_rows WHERE password=${password} AND pool_id=${p} AND state='available' LIMIT 5000`; const total: any = (await db`SELECT COUNT(*) n FROM pool_rows WHERE password=${password} AND pool_id=${p} AND state='available'`)[0]; const verified = all.filter((r) => eligible(r.data)).length; return { pool: p, verified, unverified: all.length - verified, totalAvailable: Number(total.n), ...(p === "page" ? { totalCookies2faAvailable: Number(total.n), unverifiedScanned: all.length } : {}), truncated: Number(total.n) > 5000, scanCap: 5000 }; }
  if (op === "downloads" || op === "holds") { const where = op === "holds" ? a.status ? db`AND status=${String(a.status).toUpperCase()}` : db`AND status IN ('HOLD','APPROVED')` : db``; const rows = await db`SELECT * FROM downloads WHERE password=${password} ${where} ORDER BY ts DESC LIMIT 50`; const out = rows.map(downloadShape); return op === "holds" ? { holds: out, downloads: out } : { downloads: out }; }
  if (op === "download" || op === "downloadDetail") { const r: any = (await db`SELECT * FROM downloads WHERE password=${password} AND id=${a.id}`)[0]; if (!r) return null; const out = downloadShape(r); if (op === "download") return out; const groups: any[] = []; for (const k of json(r.keys) as string[]) { const x: any = (await db`SELECT src_uid,src_file_id FROM pool_rows WHERE password=${password} AND pool_id=${r.pool_id} AND row_key=${k}`)[0]; const old = groups.find((g) => g.srcUid === (x?.src_uid ?? null) && g.srcFileId === (x?.src_file_id ?? null)); if (old) old.count++; else groups.push({ srcUid: x?.src_uid ?? null, srcFileId: x?.src_file_id ?? null, count: 1 }); } return { ...out, groups }; }
  if (op === "downloadDelete") { const r: any = (await db`SELECT status,reverted FROM downloads WHERE password=${password} AND id=${a.id}`)[0]; if (!r) throw new Error("not found"); if (!r.reverted && !["REVERTED", "REJECTED"].includes(r.status)) throw new Error("active record cannot be deleted"); await db`DELETE FROM downloads WHERE password=${password} AND id=${a.id}`; return { ok: true }; }
  if (op === "claim" || op === "hold") return allocate(password, op, p, a);
  if (["holdApprove", "holdReject", "holdRevert", "holdReturn", "revertDownload"].includes(op)) return transition(password, op, a);
  if (op === "removeAvailable") return db.transaction(async (tx: any) => { for (const k of a.keys || []) { const r = await tx`DELETE FROM pool_rows WHERE password=${password} AND pool_id=${a.pool} AND row_key=${k} AND state='available' RETURNING row_key`; if (r.length) await tx`INSERT INTO pool_ledger(password,pool_id,row_key,user_id,action,ts) VALUES(${password},${a.pool},${k},${a.uid || ""},'remove',${Date.now()})`; } return { ok: true }; });
  if (op === "ledger") return { ledger: await db`SELECT * FROM pool_ledger WHERE password=${password} AND pool_id=${p} ORDER BY id DESC LIMIT 500` };
  if (op === "revert") { const r: any = (await db`SELECT * FROM pool_ledger WHERE password=${password} AND id=${a.id}`)[0]; if (!r) return null; await db`UPDATE pool_rows SET state='available',claimed_by=NULL,claimed_at=NULL,hold_id=NULL WHERE password=${password} AND pool_id=${r.pool_id} AND row_key=${r.row_key}`; return { ok: true }; }
  throw new Error(`unknown operation: ${op}`);
}

async function selectRows(tx: any, password: string, pool: string, a: any, limit: number) {
  const { u, f } = poolFilters(a), cap = a.verifiedOnly || a.unverifiedOnly ? 5000 : limit;
  if (!u.length && f.length === 1) {
    const rows: any[] = await tx`SELECT row_key,data FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' AND src_file_id=${f[0]} ORDER BY inserted_at,row_key LIMIT ${cap} FOR UPDATE SKIP LOCKED`;
    const normalized = rows.map((r) => ({ ...r, data: json(r.data) }));
    return (a.verifiedOnly || a.unverifiedOnly) ? normalized.filter((r) => a.verifiedOnly ? eligible(r.data) : !eligible(r.data)).slice(0, limit) : normalized;
  }
  const rows: any[] = u.length && f.length
    ? await tx`SELECT row_key,data FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' AND src_uid=ANY(${db.array(u)}::text[]) AND src_file_id=ANY(${db.array(f)}::text[]) ORDER BY inserted_at,row_key LIMIT ${cap} FOR UPDATE SKIP LOCKED`
    : u.length
      ? await tx`SELECT row_key,data FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' AND src_uid=ANY(${db.array(u)}::text[]) ORDER BY inserted_at,row_key LIMIT ${cap} FOR UPDATE SKIP LOCKED`
      : f.length
        ? await tx`SELECT row_key,data FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' AND src_file_id=ANY(${db.array(f)}::text[]) ORDER BY inserted_at,row_key LIMIT ${cap} FOR UPDATE SKIP LOCKED`
        : await tx`SELECT row_key,data FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' ORDER BY inserted_at,row_key LIMIT ${cap} FOR UPDATE SKIP LOCKED`;
  const normalized = rows.map((r) => ({ ...r, data: json(r.data) })); return (a.verifiedOnly || a.unverifiedOnly) ? normalized.filter((r) => a.verifiedOnly ? eligible(r.data) : !eligible(r.data)).slice(0, limit) : normalized;
}
async function allocate(password: string, op: string, pool: string, a: any) {
  const want = a.count === "all" ? 10000 : Math.min(10000, Math.max(1, Number(a.count) || 1)); if (a.verifiedOnly && a.unverifiedOnly) throw new Error("verifiedOnly and unverifiedOnly are mutually exclusive"); if ((a.verifiedOnly || a.unverifiedOnly) && pool !== "page") throw new Error("verified filters only for page pool");
  if (op === "hold" && a.mode === "pick" && !((a.srcUids || []).length || (a.srcFileIds || []).length || a.srcUid || a.srcFileId)) throw new Error("pick mode requires srcUids or srcFileIds");
  return db.transaction(async (tx: any) => { (tx as any).json = j; const rows = await selectRows(tx, password, pool, a, want); if (!rows.length) return op === "hold" ? { claimed: 0, held: 0, count: 0, rows: [], holdId: null, downloadId: null, filename: null, status: "HOLD", unitPrice: price(pool), total: 0, mode: a.mode || "fifo" } : { claimed: 0, rows: [], downloadId: null, filename: a.filename || null, status: null, unitPrice: price(pool), total: 0, mode: "fifo" };
    const id = String(a.downloadId || a.holdId || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`), now = Date.now(), state = op === "hold" ? "held" : "claimed", status = op === "hold" ? "HOLD" : "CLAIMED"; const unit = Number(((await tx`SELECT price FROM pool_settings WHERE password=${password} AND pool_id=${pool}`)[0]?.price ?? price(pool))); const data = rows.map((r: any) => r.data), keys = rows.map((r: any) => r.row_key); for (const r of rows) { await tx`UPDATE pool_rows SET state=${state},hold_id=${op === "hold" ? id : null},claimed_by=${a.uid},claimed_at=${now} WHERE password=${password} AND pool_id=${pool} AND row_key=${r.row_key}`; await tx`INSERT INTO pool_ledger(password,pool_id,row_key,user_id,action,ts) VALUES(${password},${pool},${r.row_key},${a.uid},${op},${now})`; } const filename = String(a.filename || `${pool}_${id.slice(-4)}.xlsx`); await tx`INSERT INTO downloads(id,password,pool_id,claimed_by,claimed,filename,keys,rows,reverted,ts,status,unit_price,total,mode,src_uids,src_file_ids,selection) VALUES(${id},${password},${pool},${a.uid},${rows.length},${filename},${tx.json(keys)},${tx.json(data)},false,${now},${status},${unit},${+(unit * rows.length).toFixed(2)},${a.mode || "fifo"},${tx.json(a.srcUids || (a.srcUid ? [String(a.srcUid)] : null))},${tx.json(a.srcFileIds || (a.srcFileId ? [String(a.srcFileId)] : null))},${tx.json({ verifiedOnly: !!a.verifiedOnly, unverifiedOnly: !!a.unverifiedOnly })})`; return op === "hold" ? { claimed: rows.length, held: rows.length, count: rows.length, rows: data, holdId: id, downloadId: id, filename, status, unitPrice: unit, total: +(unit * rows.length).toFixed(2), mode: a.mode || "fifo", srcUids: a.srcUids || null, srcFileIds: a.srcFileIds || null } : { claimed: rows.length, rows: data, downloadId: id, filename, status, unitPrice: unit, total: +(unit * rows.length).toFixed(2), mode: "fifo" }; });
}
async function transition(password: string, op: string, a: any) { return db.transaction(async (tx: any) => { const d: any = (await tx`SELECT * FROM downloads WHERE password=${password} AND id=${a.id} FOR UPDATE`)[0]; if (!d) throw new Error("not found"); if (op === "revertDownload" && d.status === "REVERTED") return { ok: true, id: d.id, status: "REVERTED" }; const keys = json(d.keys) as string[], now = Date.now(); const sourceRows: any[] = []; for (const key of keys) sourceRows.push(...await tx`SELECT src_uid FROM pool_rows WHERE password=${password} AND pool_id=${d.pool_id} AND row_key=${String(key)}`); const credit = new Map<string, number>(); for (const row of sourceRows) if (row.src_uid) credit.set(String(row.src_uid), (credit.get(String(row.src_uid)) || 0) + Number(d.unit_price ?? price(d.pool_id))); if (["holdApprove"].includes(op)) { if (d.status !== "HOLD") throw new Error(d.status === "APPROVED" ? "already approved" : "not a hold"); for (const k of keys) { await tx`UPDATE pool_rows SET state='claimed',hold_id=NULL,claimed_by=${d.claimed_by || a.uid},claimed_at=${now} WHERE password=${password} AND pool_id=${d.pool_id} AND row_key=${k} AND state='held' AND hold_id=${d.id}`; await tx`INSERT INTO pool_ledger(password,pool_id,row_key,user_id,action,ts) VALUES(${password},${d.pool_id},${k},${a.uid || d.claimed_by},'approve',${now})`; } for (const [uid, amount] of credit) await tx`INSERT INTO wallets(user_id,balance) VALUES(${uid},${amount}) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+EXCLUDED.balance`; await tx`UPDATE downloads SET status='APPROVED',reverted=false WHERE password=${password} AND id=${d.id}`; return { ok: true, approved: keys.length, id: d.id, status: "APPROVED" }; }
    if (["holdReject", "holdRevert", "holdReturn"].includes(op) && d.status !== "HOLD") throw new Error(d.status === "REJECTED" ? "already rejected" : d.status === "APPROVED" ? "already approved" : "not a hold"); const action = d.status === "HOLD" ? "reject" : "revert"; for (const k of keys) { await tx`UPDATE pool_rows SET state='available',hold_id=NULL,claimed_by=NULL,claimed_at=NULL WHERE password=${password} AND pool_id=${d.pool_id} AND row_key=${k} AND ${action === "reject" ? tx`state='held' AND hold_id=${d.id}` : tx`TRUE`}`; await tx`INSERT INTO pool_ledger(password,pool_id,row_key,user_id,action,ts) VALUES(${password},${d.pool_id},${k},${a.uid || d.claimed_by},${action},${now})`; } if (d.status === "APPROVED") for (const [uid, amount] of credit) await tx`UPDATE wallets SET balance=balance-${amount} WHERE user_id=${uid}`; await tx`UPDATE downloads SET reverted=true,status=${action === "reject" ? "REJECTED" : "REVERTED"} WHERE password=${password} AND id=${d.id}`; return { ok: true, reverted: keys.length, ...(action === "reject" ? { rejected: keys.length } : {}), id: d.id, status: action === "reject" ? "REJECTED" : "REVERTED" }; }); }

export async function repository(namespace: "index" | "files" | "pools", name: string, op: string, args: Record<string, unknown>) {
  try { return namespace === "index" ? indexOp(op, args) : namespace === "files" ? fileOp(name, op, args) : poolOp(name, op, args); }
  catch (e) { throw e; }
}
