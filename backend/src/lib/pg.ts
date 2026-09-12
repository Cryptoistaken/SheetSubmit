import postgres from "postgres";
import type { Row, SheetFile } from "./shared";
import { isPersistConflict, FILE_ROW_LIMIT, FILE_SNAPSHOT_LIMIT, pushSnapshot } from "./shared";
import { groupLiveStates } from "./live";
import { publishPoolCounts } from "./livePublish";
import type { FileSnapshot } from "./shared";
import { redisDel, redisDelPrefix, redisJsonGet, redisJsonGetMany, redisJsonSet } from "./redis";

const db = postgres(Bun.env.DATABASE_URL || "", {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  max_lifetime: 1800,
});

export async function closeDatabase() { await db.end(); }
export async function pingDatabase() { await db`SELECT 1`; }
export async function bootstrapDatabase() { await db.unsafe(await Bun.file(new URL("../../sql/001_initial.sql", import.meta.url)).text()); }
const j = (v: any) => v;

const txType = (t: string) => t === "CREDIT" || t === "DEBIT";
const pools = ["cookies_only", "cookies_2fa", "page"] as const;
type Pool = typeof pools[number];
const prices: Record<Pool, number> = { cookies_only: .02, cookies_2fa: .05, page: .1 };
// Pool availability flags (meta key "poolflags", admin-toggled in Settings).
// Stored per combination ("password:pool") so a file type can be on for one
// password and off for another. Legacy {types, passwords} blobs auto-migrate
// on read (combo on = both dims on). Takes from an off combo are free
// (unit price forced to 0, settlement skips zeroes).
const POOL_FLAG_POOLS = ["cookies_only", "cookies_2fa", "page"];
const POOL_FLAG_PASSWORDS = ["dgddigital", "Love@12345"];
const comboKey = (password: string, pool: string) => `${password}:${pool}`;
const poolFlagsShape = (v: any) => {
  const combos: Record<string, boolean> = {};
  for (const pwd of POOL_FLAG_PASSWORDS) for (const p of POOL_FLAG_POOLS) {
    const k = comboKey(pwd, p);
    combos[k] = (v as any)?.combos?.[k] !== undefined
      ? (v as any).combos[k] !== false
      : (v as any)?.types?.[p] !== false && (v as any)?.passwords?.[pwd] !== false;
  }
  return { combos };
};
const poolComboOff = async (password: string, pool: string) => { const r: any = (await db`SELECT v FROM meta WHERE k='poolflags'`)[0]; const f = poolFlagsShape(json(r?.v)); return (f.combos as any)[comboKey(password, pool)] === false; };
const poolLabel = (id: string) => id === "cookies_only" ? "Cookies" : id === "cookies_2fa" ? "2FA" : id === "page" ? "Page" : id;
const REVERT_WINDOW = 300_000; // first approve/reject opens a 5-minute window for exactly one flip; wallets pay at settlement
const json = (v: any) => v == null ? null : typeof v === "string" ? JSON.parse(v) : v;
const key = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
const eligible = (r: any) => String(r?.wa_status ?? r?.waStatus ?? "").toLowerCase() === "eligible";
const real2fa = (r: Row) => { const v = String(r.twofakey ?? r["2fa key"] ?? "").trim(); return !!v && v !== "No_2Fa"; };
const preset = (v: unknown) => { const s = String(v || "").toLowerCase(); return s === "2fa" ? "combo" : ["cookie", "combo", "page"].includes(s) ? s : null; };
const liveRow = (r: Row) => !!r.uid && /c_user=\d+/.test(String(r.cookies || "")) && !["bad", "dead"].includes(String(r.status || "").toLowerCase());
export function classify(r: Row, p?: string | null): Pool | null {
  if (!liveRow(r)) return null;
  // strict routing: a file type feeds ONLY its own pool — 2fa files → cookies_2fa, page files → page (2fa required: no 2fa = invalid/pool_rejects; page-eligible = verified, cookie+2fa only = unverified, claimable via unverifiedOnly)
  const two = real2fa(r); if (p === "page") return two ? "page" : null; if (p === "combo") return two ? "cookies_2fa" : null; if (p === "cookie") return "cookies_only";
  return eligible(r) && two ? "page" : two ? "cookies_2fa" : "cookies_only";
}
function counts(rows: Row[]) { let live = 0, dead = 0, page = 0, dup = 0; const keys = new Map<string, number>(); for (const r of rows) { const s = String(r.status || "").toLowerCase(); if (s === "good") live++; else if (s === "bad") dead++; if (String(r.wa_status || "").toLowerCase() === "eligible") page++; const k = key(r); if (k) keys.set(k, (keys.get(k) || 0) + 1); } keys.forEach((n) => { if (n > 1) dup += n; }); return { liveCount: live, deadCount: dead, pageCount: page, dupCount: dup }; }
const rowOut = (r: any) => ({ ...json(r.data), _key: r.row_key, _state: r.state, _claimedBy: r.claimed_by, _claimedAt: r.claimed_at, _srcUid: r.src_uid, _srcFileId: r.src_file_id, _insertedAt: r.inserted_at, _holdId: r.hold_id });
// ponytail: single bulk INSERT via jsonb_to_recordset — one param holds all rows; chunk into per-10k calls if files ever exceed ~50k rows
const bulkInsert = (tx: any, id: string, rows: Row[], start = 0) => tx`INSERT INTO file_rows(file_id,idx,data) SELECT ${id},s.idx,s.d FROM jsonb_to_recordset(${j(rows.map((r, i) => ({ idx: start + i, d: r })))}::jsonb) AS s(idx int,d jsonb)`;
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
    case "batchArchive": { const files = (a.files as SheetFile[]) || []; if (files.length > 40) throw new Error("too many files"); if (!files.length) return { ok: true }; await db`UPDATE file_index SET archived=false,data=s.d,updated_at=now() FROM jsonb_to_recordset(${j(files.map((f) => ({ id: f.id, d: f })))}::jsonb) AS s(id text,d jsonb) WHERE file_index.file_id=s.id`; return { ok: true }; }
    case "purge": await db`DELETE FROM file_index WHERE file_id=${a.id}`; return { ok: true };
    case "batchPurge": { const ids = (a.ids || []).map(String); if (!ids.length) return { ok: true }; await db`DELETE FROM file_index WHERE file_id IN ${db(ids)}`; return { ok: true }; }
    case "deleteUser": await db`DELETE FROM users WHERE user_id=${a.id}`; return { ok: true };
    case "settleHolds": {
      // run every 30s by the backend: pay out holds whose 5-minute revert window closed
      const due: any[] = await db`SELECT id,password,pool_id,claimed_by,unit_price,status FROM downloads WHERE settled=false AND status IN ('APPROVED','REJECTED') AND first_action_at IS NOT NULL AND first_action_at <= ${Date.now() - REVERT_WINDOW} ORDER BY first_action_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
      let settled = 0;
      for (const d of due) {
        await db.begin(async (tx: any) => {
          const cur: any = (await tx`SELECT status,settled FROM downloads WHERE id=${d.id} FOR UPDATE`)[0];
          if (!cur || cur.settled) return;
          if (String(cur.status) === "APPROVED") {
            const creditRows: any[] = await tx`SELECT src_uid,COUNT(*) n FROM pool_rows WHERE password=${d.password} AND pool_id=${d.pool_id} AND hold_id=${d.id} AND state='claimed' AND src_uid IS NOT NULL GROUP BY src_uid`;
            const deadRows: any[] = await tx`SELECT COUNT(*) n FROM pool_rows WHERE password=${d.password} AND pool_id=${d.pool_id} AND hold_id=${d.id} AND state='dead'`;
            const dead = Number(deadRows[0]?.n || 0);
            const unit = d.unit_price == null ? price(d.pool_id) : Number(d.unit_price);
            for (const cr of creditRows) {
              const uid = String(cr.src_uid), amount = +(Number(cr.n) * unit).toFixed(2);
              if (!Number.isFinite(amount) || amount <= 0) continue;
              await tx`INSERT INTO wallets(user_id,balance) VALUES(${uid},${amount}) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+EXCLUDED.balance`;
              const r: any = (await tx`SELECT balance FROM wallets WHERE user_id=${uid}`)[0];
              await tx`INSERT INTO wallet_transactions(id,user_id,type,amount,balance_after,description,meta,created_at) VALUES(${crypto.randomUUID()},${uid},'CREDIT',${amount},${Number(r.balance)},${`Earning - ${poolLabel(d.pool_id)} · ${Number(cr.n)} ${Number(cr.n) === 1 ? "row" : "rows"} paid`},${j({ pool_id: d.pool_id, download_id: d.id, rows: Number(cr.n), dead, unit_price: unit, settled: true })},${Date.now()})`;
            }
          }
          await tx`UPDATE downloads SET settled=true WHERE id=${d.id}`;
          settled++;
        }).catch((e: any) => console.error("[settle] hold failed", d?.id, e?.message ?? e));
      }
      if (settled) console.log(`[settle] settled ${settled} hold(s)`);
      return { ok: true, settled };
    }
    case "walletCredit": { const uid = String(a.uid || a.userId || ""); const adminUid = String(a.adminUid || ""); const debit = String((a as any).direction || "credit").toLowerCase() === "debit"; const title = String(a.title || "").trim().slice(0, 128) || (debit ? "Manual debit" : "Manual credit"); const amount = Math.round(Number(a.amount ?? a.credit ?? 0) * 100) / 100; if (!uid || !Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new Error("invalid credit"); const now = Date.now(); return db.begin(async (tx: any) => { await tx`INSERT INTO wallets(user_id,balance) VALUES(${uid},0) ON CONFLICT(user_id) DO NOTHING`; const updated: any = debit ? await tx`UPDATE wallets SET balance=balance-${amount} WHERE user_id=${uid} AND balance>=${amount} RETURNING balance` : await tx`UPDATE wallets SET balance=balance+${amount} WHERE user_id=${uid} RETURNING balance`; if (!updated.length) throw new Error("insufficient balance"); const bal = Number(updated[0].balance); const id = crypto.randomUUID(); await tx`INSERT INTO wallet_transactions(id,user_id,type,amount,balance_after,description,meta,created_at) VALUES(${id},${uid},${debit ? "DEBIT" : "CREDIT"},${amount},${bal},${title},${j({ manual: true, ...(adminUid ? { admin_uid: adminUid } : {}) })},${now})`; return { id, uid, amount, balance: bal, title, direction: debit ? "debit" : "credit" }; }); }
    case "walletGet": { const uid = String(a.uid || a.userId || ""); if (!uid) throw new Error("uid required"); const r: any = (await db`SELECT balance FROM wallets WHERE user_id=${uid}`)[0]; return { uid, balance: r ? Number(r.balance) : 0 }; }
    case "walletWithdrawals": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); return db`SELECT id,user_id,amount::float8 AS amount,method,account,status,created_at::float8 AS created_at,updated_at::float8 AS updated_at FROM withdrawals WHERE user_id=${uid} ORDER BY created_at DESC`; }
    case "walletTxList": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); return (await db`SELECT id,user_id,type,amount::float8 AS amount,balance_after::float8 AS balance_after,description,meta,created_at::float8 AS created_at FROM wallet_transactions WHERE user_id=${uid} ORDER BY created_at DESC LIMIT 200`).map((r: any) => ({ ...r, meta: json(r.meta) })); }
    case "walletWithdraw": { const uid = String(a.uid || ""), id = String(a.id || ""), method = String(a.method || "").trim(), account = String(a.account || ""); const amount = Number(a.amount); if (!uid || !id || !method || !account || !Number.isFinite(amount) || amount <= 0) throw new Error("invalid withdrawal"); const now = Date.now(); return db.begin(async (tx: any) => { await tx`INSERT INTO wallets(user_id,balance) VALUES(${uid},0) ON CONFLICT(user_id) DO NOTHING`; const updated = await tx`UPDATE wallets SET balance=balance-${amount} WHERE user_id=${uid} AND balance>=${amount} RETURNING balance`; if (!updated.length) throw new Error("insufficient balance"); const bal = Number(updated[0].balance); await tx`INSERT INTO withdrawals(id,user_id,amount,method,account,status,created_at,updated_at) VALUES(${id},${uid},${amount},${method},${account},'PENDING',${now},${now})`; await tx`INSERT INTO wallet_transactions(id,user_id,type,amount,balance_after,description,meta,created_at) VALUES(${crypto.randomUUID()},${uid},'DEBIT',${amount},${bal},${`Withdrawal via ${method}`},${j({ withdrawal_id: id, method, account })},${now})`; return { id, amount, method, account, status: "PENDING", created_at: now, updated_at: now }; }); }
    case "walletRequests": { const status = String(a.status || "").trim(); return status ? db`SELECT w.id,w.user_id,w.amount::float8 AS amount,w.method,w.account,w.status,w.created_at::float8 AS created_at,w.updated_at::float8 AS updated_at,u.name,u.username,u.photo_url FROM withdrawals w LEFT JOIN users u ON u.user_id=w.user_id WHERE w.status=${status} ORDER BY w.created_at DESC` : db`SELECT w.id,w.user_id,w.amount::float8 AS amount,w.method,w.account,w.status,w.created_at::float8 AS created_at,w.updated_at::float8 AS updated_at,u.name,u.username,u.photo_url FROM withdrawals w LEFT JOIN users u ON u.user_id=w.user_id ORDER BY w.created_at DESC`; }
    case "walletDecision": { const id = String(a.id || ""), status = String(a.status || ""); if (!id || !["APPROVED", "REJECTED"].includes(status)) throw new Error("invalid wallet decision"); return db.begin(async (tx: any) => { const row: any = (await tx`SELECT amount,user_id,status FROM withdrawals WHERE id=${id} FOR UPDATE`)[0]; if (!row) throw new Error("withdrawal not found"); if (row.status !== "PENDING") return { id, status: row.status }; await tx`UPDATE withdrawals SET status=${status},updated_at=${Date.now()} WHERE id=${id}`; if (status === "REJECTED") { await tx`INSERT INTO wallets(user_id,balance) VALUES(${row.user_id},${row.amount}) ON CONFLICT(user_id) DO UPDATE SET balance=wallets.balance+EXCLUDED.balance`; const r: any = (await tx`SELECT balance FROM wallets WHERE user_id=${row.user_id}`)[0]; await tx`INSERT INTO wallet_transactions(id,user_id,type,amount,balance_after,description,meta,created_at) VALUES(${crypto.randomUUID()},${row.user_id},'CREDIT',${row.amount},${Number(r.balance)},'Withdrawal refunded',${j({ withdrawal_id: id })},${Date.now()})`; } return { id, status }; }); }
    case "poolFlagsGet": { const r: any = (await db`SELECT v FROM meta WHERE k='poolflags'`)[0]; return poolFlagsShape(json(r?.v)); }
    case "poolFlagsSet": { const v = poolFlagsShape({ combos: (a as any).combos, types: (a as any).types, passwords: (a as any).passwords }); await db`INSERT INTO meta(k,v) VALUES('poolflags',${j(v)}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; void redisDel("ss:meta:poolflags"); return v; }
    case "paymentMethodsGet": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); const r: any = (await db`SELECT v FROM meta WHERE k=${`paymentMethods:${uid}`}`)[0]; return json(r?.v) ?? {}; }
    case "paymentMethodsSet": { const uid = String(a.uid || ""); if (!uid) throw new Error("uid required"); const methods = a.methods ?? {}; await db`INSERT INTO meta(k,v) VALUES(${`paymentMethods:${uid}`},${j(methods)}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; return { ok: true }; }
    case "adminUsers": { const rows: any[] = await db`SELECT u.*,COUNT(f.file_id) FILTER (WHERE f.archived=false) AS "fileCount",COUNT(f.file_id) FILTER (WHERE f.archived=true) AS "archivedCount" FROM users u LEFT JOIN file_index f ON f.owner_id=u.user_id GROUP BY u.user_id ORDER BY u.created_at DESC LIMIT 500`; return rows; }
    case "adminUsersSearch": { const q = String(a.q || "").trim().slice(0, 64); if (!q) return db`SELECT u.*,COUNT(f.file_id) FILTER (WHERE f.archived=false) AS "fileCount",COUNT(f.file_id) FILTER (WHERE f.archived=true) AS "archivedCount" FROM users u LEFT JOIN file_index f ON f.owner_id=u.user_id GROUP BY u.user_id ORDER BY u.created_at DESC LIMIT 50`; const like = `%${q}%`; return db`SELECT u.*,COUNT(f.file_id) FILTER (WHERE f.archived=false) AS "fileCount",COUNT(f.file_id) FILTER (WHERE f.archived=true) AS "archivedCount" FROM users u LEFT JOIN file_index f ON f.owner_id=u.user_id WHERE u.user_id ILIKE ${like} OR u.name ILIKE ${like} OR u.username ILIKE ${like} GROUP BY u.user_id ORDER BY u.created_at DESC LIMIT 50`; }
    case "metaSet": await db`INSERT INTO meta(k,v) VALUES(${a.k},${j(a.v)}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; void redisDel(`ss:meta:${a.k}`); return { ok: true };
    case "adminUser": { const rows: any[] = await db`SELECT u.*,COUNT(f.file_id) FILTER (WHERE f.archived=false) AS "fileCount",COUNT(f.file_id) FILTER (WHERE f.archived=true) AS "archivedCount" FROM users u LEFT JOIN file_index f ON f.owner_id=u.user_id WHERE u.user_id=${String(a.id || "")} GROUP BY u.user_id`; return rows[0] || null; }
    case "metaGet": { const k = String(a.k || ""), cached = await redisJsonGet(`ss:meta:${k}`); if (cached !== undefined) return cached; const r: any = (await db`SELECT v FROM meta WHERE k=${k}`)[0]; const value = json(r?.v) ?? null; if (r) void redisJsonSet(`ss:meta:${k}`, value, k.startsWith("wa:") ? 60 : 60); return value; }
    case "metaGetMany": { const keys: string[] = (Array.isArray(a.keys) ? a.keys : []).slice(0, 1000).map((k: unknown) => String(k)); if (!keys.length) return {}; const cached = await redisJsonGetMany<unknown>(keys.map((k: string) => `ss:meta:${k}`)); const values: [string, unknown | undefined][] = keys.map((k: string, i: number) => [k, cached?.[i]]); const missing = values.filter((entry) => entry[1] === undefined).map((entry) => entry[0]); const rows: any[] = missing.length ? await db`SELECT k,v FROM meta WHERE k IN ${db(missing)}` : []; const out: Record<string, unknown> = {}; for (const [k, value] of values) if (value !== undefined) out[k] = value; for (const r of rows) { out[r.k] = json(r.v); void redisJsonSet(`ss:meta:${r.k}`, out[r.k], 60); } return out; }
    case "metaDel": await db`DELETE FROM meta WHERE k=${a.k}`; void redisDel(`ss:meta:${a.k}`); return { ok: true };
    case "metaDelMany": { const keys = (Array.isArray(a.keys) ? a.keys : []).map(String).filter(Boolean).slice(0, 1000); if (!keys.length) return { ok: true, deleted: 0 }; const r: any = await db`DELETE FROM meta WHERE k IN ${db(keys)}`; for (const k of keys) void redisDel(`ss:meta:${k}`); return { ok: true, deleted: Number(r.count || 0) }; }
    case "allFiles": return db`SELECT data,owner_id FROM file_index`;
    case "stats": { const r: any = (await db`SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM file_index WHERE archived=false) AS files`)[0]; return { totalUsers: Number(r.users), totalFiles: Number(r.files) }; }
    case "session": await db`INSERT INTO sessions(token,user_id,exp) VALUES(${a.token},${a.uid},${a.exp}) ON CONFLICT(token) DO UPDATE SET user_id=EXCLUDED.user_id,exp=EXCLUDED.exp`; return { ok: true };
    case "getSession": return (await db`SELECT * FROM sessions WHERE token=${a.token} AND exp>${Date.now()}`)[0] || null;
    case "deleteSession": await db`DELETE FROM sessions WHERE token=${a.token}`; return { ok: true };
    case "sessionCleanup": await db`DELETE FROM sessions WHERE ctid IN (SELECT ctid FROM sessions WHERE exp<${Date.now()} LIMIT 1000)`; return { ok: true };
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
  if (kind === "get") { const r: any = (await db`SELECT v FROM meta WHERE k=${didKey}`)[0]; return json(r?.v) ?? null; }
  if (kind === "byChat") { const r: any = (await db`SELECT v FROM meta WHERE k=${chatKey}`)[0]; return json(r?.v) ?? null; }
  return db.begin(async (tx: any) => {
    const current: any = (await tx`SELECT v FROM meta WHERE k=${didKey} FOR UPDATE`)[0]; const cur = json(current?.v); if (cur) await tx`DELETE FROM meta WHERE k=${`deviceByChat:${cur.chatId}`}`;
    const previous: any = (await tx`SELECT v FROM meta WHERE k=${chatKey} FOR UPDATE`)[0]; const prev = json(previous?.v); if (prev) await tx`DELETE FROM meta WHERE k=${`device:${prev.did}`}`;
    if (kind === "delete") await tx`DELETE FROM meta WHERE k=${didKey}`; else { await tx`INSERT INTO meta(k,v) VALUES(${didKey},${j({ chatId: a.chatId })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; await tx`INSERT INTO meta(k,v) VALUES(${chatKey},${j({ did: a.did })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`; }
    return { ok: true };
  });
}

async function fileOp(id: string, op: string, a: any) {
  if (op === "init") return db.begin(async (tx: any) => { if ((a.rows || []).length > FILE_ROW_LIMIT) throw new Error("too many rows (max 500 per file)"); await tx`INSERT INTO file_meta(file_id,data,seq) VALUES(${id},${j(a.file)},0) ON CONFLICT(file_id) DO UPDATE SET data=EXCLUDED.data,seq=0`; await tx`DELETE FROM file_rows WHERE file_id=${id}`; await tx`DELETE FROM file_logs WHERE file_id=${id}`; if ((a.rows || []).length) await bulkInsert(tx, id, a.rows); return { ok: true }; });
  if (op === "meta") { const r: any = (await db`SELECT data FROM file_meta WHERE file_id=${id}`)[0]; return r?.data ?? null; }
  if (op === "seq") { const r: any = (await db`SELECT seq FROM file_meta WHERE file_id=${id}`)[0]; return { seq: Number(r?.seq || 0) }; }
  const readRows = async (q: any = db) => (await q`SELECT data FROM file_rows WHERE file_id=${id} ORDER BY idx`).map((r: any) => json(r.data) as Row);
  if (op === "rows") return readRows();
  if (op === "full") { const r: any = (await db`SELECT seq FROM file_meta WHERE file_id=${id}`)[0]; return { rows: await readRows(), seq: Number(r?.seq || 0) }; }
  if (op === "counts") return counts(await readRows());
  if (["keys", "dupKeys", "projection"].includes(op)) { const limit = Math.min(10000, Math.max(1, Number(a.limit) || 10000)); const krows: any[] = await db`SELECT idx AS i,COALESCE(NULLIF(data->>'uid',''),substring(data->>'cookies' from 'c_user=([0-9]+)')) AS k FROM file_rows WHERE file_id=${id} AND COALESCE(NULLIF(data->>'uid',''),substring(data->>'cookies' from 'c_user=([0-9]+)')) IS NOT NULL ORDER BY idx LIMIT ${limit}`; return krows.map((r: any) => ({ k: String(r.k), i: Number(r.i) })); }
  if (op === "wipe") return db.begin(async (tx: any) => {
    const rows = (await tx`SELECT data FROM file_rows WHERE file_id=${id}`).map((r: any) => json(r.data));
    // forensics tombstone (Fix #8): file_logs cascades away with file_index, so
    // the last log trail is preserved in meta KV before anything is deleted.
    const m: any = (await tx`SELECT data,seq FROM file_meta WHERE file_id=${id}`)[0];
    const logs: any[] = await tx`SELECT ts::float8 AS ts,action,seq FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200`;
    const md = m ? json(m.data) : null;
    await tx`INSERT INTO meta(k,v) VALUES(${`filetomb:${id}`},${j({ id, name: md?.name ?? null, ownerUid: a.uid ? String(a.uid) : null, purgedAt: Date.now(), rowCount: rows.length, seq: m ? Number(m.seq) : 0, logs })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`;
    await tx`DELETE FROM file_rows WHERE file_id=${id}`; await tx`DELETE FROM file_logs WHERE file_id=${id}`; await tx`DELETE FROM file_meta WHERE file_id=${id}`; await tx`DELETE FROM meta WHERE k=${`filesnap:${id}`}`; return { ok: true, rows };
  });
  if (op === "tombGet") { const r: any = (await db`SELECT v FROM meta WHERE k=${`filetomb:${id}`}`)[0]; return r ? json(r.v) : null; }
  if (op === "getLogs") return db`SELECT id,ts::float8 AS ts,action,seq FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200`;
  const snapKey = `filesnap:${id}`;
  // snapshot list, newest-first; tolerates the legacy single-{rows} shape.
  const readSnaps = async (q: any = db): Promise<FileSnapshot[]> => {
    const r: any = (await q`SELECT v FROM meta WHERE k=${snapKey}`)[0];
    const v = r ? json(r.v) : null;
    if (!v) return [];
    const list = Array.isArray(v.snaps) ? v.snaps : Array.isArray(v.rows) ? [{ rows: v.rows, seq: Number(v.seq ?? 0), ts: Number(v.ts ?? 0) }] : [];
    return list.filter((s: any) => s && Array.isArray(s.rows)).map((s: any) => ({ rows: s.rows as Row[], seq: Number(s.seq ?? 0), ts: Number(s.ts ?? 0) }));
  };
  if (op === "snapGet") { const snaps = await readSnaps(); const s = snaps[0]; return s ? { ...s, count: snaps.length } : null; }
  if (op === "snapRestore") return db.begin(async (tx: any) => {
    const meta: any = (await tx`SELECT data,seq FROM file_meta WHERE file_id=${id} FOR UPDATE`)[0]; if (!meta) throw new Error("file not found");
    const snaps = await readSnaps(tx);
    const idx = Number.isInteger(a.index) ? Math.max(0, a.index as number) : 0;
    const prev = snaps[idx];
    if (!prev) throw new Error("no snapshot");
    const rows: Row[] = prev.rows;
    const file = meta.data; if (file) { Object.assign(file, counts(rows)); file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = "restored"; }
    const next = Number(meta.seq) + 1; await tx`UPDATE file_meta SET data=${j(file)},seq=${next} WHERE file_id=${id}`;
    await tx`DELETE FROM file_rows WHERE file_id=${id}`;
    if (rows.length) await bulkInsert(tx, id, rows);
    await tx`INSERT INTO file_logs(file_id,ts,action,seq) VALUES(${id},${Date.now()},${"restore"},${next})`; await tx`DELETE FROM file_logs WHERE file_id=${id} AND id NOT IN (SELECT id FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200)`;
    return { ok: true, seq: next, rows, file, restoredSeq: Number(prev.seq ?? 0), snapshots: snaps.length };
  });
  if (op !== "save" && op !== "append") throw new Error(`unknown operation: ${op}`);
  return db.begin(async (tx: any) => {
    const meta: any = (await tx`SELECT data,seq FROM file_meta WHERE file_id=${id} FOR UPDATE`)[0]; if (!meta) throw new Error("file not found"); const current = Number(meta.seq);
    // meta-only save (rename): skip the full row read + DELETE + re-INSERT entirely
    if (op === "save" && !Array.isArray(a.rows)) { const mfile = a.file || meta.data; const mnext = current + 1; await tx`UPDATE file_meta SET data=${j(mfile)},seq=${mnext} WHERE file_id=${id}`; await tx`INSERT INTO file_logs(file_id,ts,action,seq) VALUES(${id},${Date.now()},${String(a.action || "edit")},${mnext})`; await tx`DELETE FROM file_logs WHERE file_id=${id} AND id NOT IN (SELECT id FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200)`; return { ok: true, seq: mnext }; }
    let rows: Row[] = (await tx`SELECT data FROM file_rows WHERE file_id=${id} ORDER BY idx`).map((r: any) => json(r.data));
    if (op === "save" && Array.isArray(a.rows)) {
      // structural save: refuse to overwrite a newer seq (two editors), enforce
      // the per-file row cap, and roll the pre-write state into snapshots first.
      if (a.rows.length > FILE_ROW_LIMIT) throw new Error("too many rows (max 500 per file)");
      if (isPersistConflict(a.base, current)) throw new Error("version conflict");
      const prev = await readSnaps(tx);
      await tx`INSERT INTO meta(k,v) VALUES(${`filesnap:${id}`},${j({ snaps: pushSnapshot(prev, { rows, seq: current, ts: Date.now() }, FILE_SNAPSHOT_LIMIT) })}) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`;
    }
    const origLen = rows.length, touched = new Map<number, Row>();
    if (op === "append") { if (!Number.isInteger(a.base) || a.base !== current) throw new Error("version conflict"); if (!Array.isArray(a.ops) || a.ops.length > 10000) throw new Error("invalid append payload"); for (const x of a.ops) { if (!x || !Number.isInteger(x.rowIdx) || x.rowIdx < 0 || x.rowIdx >= FILE_ROW_LIMIT || !x.cols || Array.isArray(x.cols)) throw new Error("invalid op"); while (rows.length <= x.rowIdx) rows.push({}); rows[x.rowIdx] = { ...rows[x.rowIdx], ...x.cols }; if (x.rowIdx < origLen) touched.set(x.rowIdx, rows[x.rowIdx]); } }
    else if (Array.isArray(a.rows)) rows = a.rows;
    const file = a.file || meta.data; if (file) { Object.assign(file, counts(rows)); file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = String(a.action || (op === "append" ? "append" : "edit")); if (a.dataCount !== undefined) file.dataCount = a.dataCount; }
    const next = current + 1; await tx`UPDATE file_meta SET data=${j(file)},seq=${next} WHERE file_id=${id}`;
    if (op === "append") {
      // surgical delta write — the old DELETE-all + per-row INSERT loop made a 1-cell append cost N+2 round trips (20s on big files)
      const upd = [...touched].map(([idx, r]) => ({ idx, d: r }));
      if (upd.length) await tx`UPDATE file_rows SET data=s.d FROM jsonb_to_recordset(${j(upd)}::jsonb) AS s(idx int,d jsonb) WHERE file_rows.file_id=${id} AND file_rows.idx=s.idx`;
      if (rows.length > origLen) await tx`INSERT INTO file_rows(file_id,idx,data) SELECT ${id},s.idx,s.d FROM jsonb_to_recordset(${j(rows.slice(origLen).map((r, i) => ({ idx: origLen + i, d: r })))}::jsonb) AS s(idx int,d jsonb)`;
    } else {
      await tx`DELETE FROM file_rows WHERE file_id=${id}`;
      if (rows.length) await bulkInsert(tx, id, rows);
    }
    await tx`INSERT INTO file_logs(file_id,ts,action,seq) VALUES(${id},${Date.now()},${String(a.action || (op === "append" ? "append" : "edit"))},${next})`; await tx`DELETE FROM file_logs WHERE file_id=${id} AND id NOT IN (SELECT id FROM file_logs WHERE file_id=${id} ORDER BY id DESC LIMIT 200)`;
    return { ok: true, seq: next, ...(op === "append" ? { file, rows: [...touched.values(), ...rows.slice(origLen)] } : Array.isArray(a.rows) ? { rows } : {}) };
  });
}

function poolFilters(a: any) { const u = Array.isArray(a.srcUids) ? a.srcUids.map(String).filter(Boolean) : a.srcUid ? [String(a.srcUid)] : []; const f = Array.isArray(a.srcFileIds) ? a.srcFileIds.map(String).filter(Boolean) : a.srcFileId ? [String(a.srcFileId)] : []; return { u, f }; }
function downloadShape(r: any) { const unit = r.unit_price == null ? price(r.pool_id) : Number(r.unit_price); const total = r.total == null ? +(unit * Number(r.claimed)).toFixed(2) : Number(r.total); return { id: r.id, poolId: r.pool_id, pool_id: r.pool_id, claimedBy: r.claimed_by, claimed_by: r.claimed_by, claimed: Number(r.claimed), filename: r.filename, rows: json(r.rows), keys: json(r.keys), reverted: !!r.reverted, ts: Number(r.ts), status: r.status || (r.reverted ? "REVERTED" : "CLAIMED"), unitPrice: unit, unit_price: r.unit_price == null ? null : Number(r.unit_price), total, mode: r.mode || null, srcUids: json(r.src_uids), srcFileIds: json(r.src_file_ids), selection: json(r.selection), firstActionAt: r.first_action_at == null ? null : Number(r.first_action_at), actionCount: Number(r.action_count || 0), settled: !!r.settled }; }

async function poolOp(password: string, op: string, a: any) {
  const p = String(a.pool || ""); if (["priceGet", "priceSet", "summary", "detail", "counts", "claim", "hold", "verifiedCounts", "userFiles", "poolUsers"].includes(op) && !pools.includes(p as Pool)) throw new Error("invalid pool");
  if (op === "priceGet") { const r: any = (await db`SELECT price FROM pool_settings WHERE password=${password} AND pool_id=${p}`)[0]; return { poolId: p, password, price: r ? Number(r.price) : price(p) }; }
  if (op === "priceSet") { const n = Number(a.price); if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("invalid price"); await db`INSERT INTO pool_settings(password,pool_id,price) VALUES(${password},${p},${n}) ON CONFLICT(password,pool_id) DO UPDATE SET price=EXCLUDED.price`; return { poolId: p, password, price: n }; }
  // single-pool membership: an account lives in at most one pool row (any password, any pool).
  // available/held/claimed anywhere → skip (held/claimed = taken; claimed is never reversible to other pools — sold accounts can never re-enter any pool).
  // dead rows are unconsumed husks — removed on re-feed so the account can be pooled again.
  // an existing AVAILABLE row gets its data refreshed from the newest feed (fresh wa_status/cookie edits); held/claimed stay frozen.
  // R1: set-based pool ingest — classify()/key()/liveRow() stay in JS exactly as-is;
  // one tx with a single sorted-hash lock sweep, bulk DELETEs (row_key = ANY($)),
  // one bulk INSERT via jsonb_to_recordset, one bulk UPDATE for re-fed available
  // rows, one batched pool_rejects upsert. Response stays { added }.
  if (op === "add") return db.begin(async (tx: any) => {
    // feed/archive race: feeds are fire-and-forget while the archive wipe is
    // awaited, so a feed INSERT landing after the wipe would resurrect pool
    // rows for an archived file — refuse the feed and mop up available husks.
    if (a.srcFileId) {
      const f: any = (await tx`SELECT archived FROM file_index WHERE file_id=${String(a.srcFileId)}`)[0];
      if (f && f.archived) {
        await tx`DELETE FROM pool_rows WHERE password=${password} AND src_file_id=${String(a.srcFileId)} AND state='available'`;
        return { added: 0, blocked: 0 };
      }
    }
    const pp = preset(a.preset ?? a.poolKind ?? a.filePreset ?? a.file?.preset ?? a.file?.poolKind);
    const cand = new Map<string, { pool: Pool; data: Row }>(); // last classifiable row wins per key (was: insert then refresh)
    const rej = new Map<string, boolean>(); // sequential net effect of the old per-row reject DELETE/INSERT
    for (const r of a.rows as Row[]) {
      const pool = classify(r, pp), k = key(r);
      if (!pool || !k) { if (!pool && k && (pp === "combo" || pp === "page") && liveRow(r)) rej.set(k, true); continue; }
      cand.set(k, { pool, data: r }); rej.set(k, false);
    }
    const keys = [...cand.keys()];
    const bad = [...rej].filter(([, v]) => v).map(([k]) => k);
    if (!keys.length && !bad.length) return { added: 0, blocked: 0 };
    const now = Date.now(), srcUid = a.srcUid || null, srcFileId = a.srcFileId || null;
    // permanent blocklist: sold or died-on-hold accounts never re-enter any pool
    let denied: string[] = [];
    if (keys.length) {
      const hit: any[] = await tx`SELECT row_key FROM pool_blocked WHERE row_key = ANY(${keys})`;
      denied = hit.map((r: any) => String(r.row_key));
      if (denied.length) {
        for (const k of denied) cand.delete(k);
        keys.splice(0, keys.length, ...cand.keys());
        await tx`DELETE FROM pool_rows WHERE password=${password} AND row_key = ANY(${denied}) AND state='available'`;
        console.log(`[pool] blocked ${denied.length} already-sold/dead account(s) from ${password}/${pp} feed`);
      }
    }
    // re-uploaded rows instantly count as verified again: fill blank
    // wa_status from the per-owner WA cache (wa:{srcUid}:{cuser}, fresh +
    // eligible only) — never overwrite an explicit value already on the row.
    if (srcUid && cand.size) {
      const need = [...cand].filter(([, v]) => !String((v.data as any)?.wa_status ?? (v.data as any)?.waStatus ?? "").trim());
      if (need.length) {
        const mkeys = [...new Set(need.map(([k]) => `wa:${srcUid}:${k}`))];
        const mrows: any[] = await tx`SELECT k,v FROM meta WHERE k IN ${tx(mkeys)}`;
        const mc = new Map(mrows.map((r: any) => [String(r.k), json(r.v)]));
        for (const [k, v] of need) {
          const ce: any = mc.get(`wa:${srcUid}:${k}`);
          if (!ce || ce.status !== "eligible" || (ce.ts && now - Number(ce.ts) > 86400000)) continue;
          const d = v.data as any;
          d.wa_status = "eligible";
          if (ce.banReason != null) d.wa_ban_reason = ce.banReason;
          if (ce.pageName != null) d.wa_page_name = ce.pageName;
          if (ce.linkedNumber != null) d.wa_linked_number = ce.linkedNumber;
        }
      }
    }
    if (keys.length) await tx`SELECT pg_advisory_xact_lock(x.h) FROM (SELECT DISTINCT hashtext(u.k) AS h FROM unnest(${keys}::text[]) AS u(k)) x ORDER BY x.h`;
    if (keys.length && srcFileId && pp) {
      const byPool = new Map<string, string[]>();
      for (const [k, v] of cand) (byPool.get(v.pool) || byPool.set(v.pool, []).get(v.pool)!).push(k);
      for (const [pool, ks] of byPool) await tx`DELETE FROM pool_rows WHERE password=${password} AND pool_id<>${pool} AND row_key = ANY(${ks}) AND src_file_id=${srcFileId} AND state='available'`;
    }
    const put: { pool: string; k: string; d: Row }[] = [], touch: typeof put = [];
    if (keys.length) {
      await tx`DELETE FROM pool_rows WHERE row_key = ANY(${keys}) AND state='dead'`;
      await tx`DELETE FROM pool_rejects WHERE row_key = ANY(${keys})`;
      const same: any[] = await tx`SELECT pool_id,row_key,state,data FROM pool_rows WHERE password=${password} AND row_key = ANY(${keys})`;
      const busy: any[] = await tx`SELECT DISTINCT row_key FROM pool_rows WHERE row_key = ANY(${keys}) AND state IN ('available','held','claimed')`;
      const mine = new Map(same.map((r: any) => [`${r.pool_id} ${r.row_key}`, r.state]));
      const blocked = new Set(busy.map((r: any) => String(r.row_key)));
      for (const [k, v] of cand) {
        const st = mine.get(`${v.pool} ${k}`);
        if (st) { if (st === "available") touch.push({ pool: v.pool, k, d: v.data }); continue; } // held/claimed stay frozen
        if (!blocked.has(k)) put.push({ pool: v.pool, k, d: v.data }); // available/held/claimed anywhere blocks
      }
      // re-feed must not blank known eligibility: a touch whose incoming row
      // lost wa_status keeps the stored eligible flags instead.
      if (touch.length) {
        const stored = new Map(same.map((r: any) => [`${r.pool_id} ${r.row_key}`, json(r.data)]));
        for (const t of touch) {
          const d = t.d as any;
          if (String(d?.wa_status ?? d?.waStatus ?? "").trim()) continue;
          const sd: any = stored.get(`${t.pool} ${t.k}`);
          if (String(sd?.wa_status ?? sd?.waStatus ?? "").toLowerCase() !== "eligible") continue;
          d.wa_status = "eligible";
          if (d.wa_ban_reason == null && sd.wa_ban_reason != null) d.wa_ban_reason = sd.wa_ban_reason;
          if (d.wa_page_name == null && sd.wa_page_name != null) d.wa_page_name = sd.wa_page_name;
          if (d.wa_linked_number == null && sd.wa_linked_number != null) d.wa_linked_number = sd.wa_linked_number;
        }
      }
      if (put.length) await tx`INSERT INTO pool_rows(password,pool_id,row_key,data,src_uid,src_file_id,inserted_at) SELECT ${password},s.pool,s.k,s.d,${srcUid},${srcFileId},${now} FROM jsonb_to_recordset(${j(put.map((r) => ({ pool: r.pool, k: r.k, d: r.d })))}::jsonb) AS s(pool text,k text,d jsonb)`;
      if (touch.length) await tx`UPDATE pool_rows p SET data=s.d FROM jsonb_to_recordset(${j(touch.map((r) => ({ pool: r.pool, k: r.k, d: r.d })))}::jsonb) AS s(pool text,k text,d jsonb) WHERE p.password=${password} AND p.pool_id=s.pool AND p.row_key=s.k AND p.state='available'`;
    }
    if (bad.length) { const rp = pp === "combo" ? "cookies_2fa" : "page"; await tx`INSERT INTO pool_rejects(password,pool_id,row_key,ts) SELECT ${password},s.pool,s.k,s.ts FROM jsonb_to_recordset(${j(bad.map((k) => ({ pool: rp, k, ts: now })))}::jsonb) AS s(pool text,k text,ts bigint) ON CONFLICT (password,pool_id,row_key) DO NOTHING`; }
    return { added: put.length, blocked: denied.length };
  });
  if (op === "diag") {
    // cross-password trace for one account key (uid or c_user): every pool row
    // in any state, reject records, blocklist entry, and past takes. Admin diagnostic — read-only.
    const k = String(a.key || "").trim().slice(0, 64);
    if (!k) throw new Error("key required");
    const rows: any[] = await db`SELECT password,pool_id,state,src_uid,src_file_id,inserted_at::float8 AS inserted_at,claimed_by,hold_id FROM pool_rows WHERE row_key=${k} ORDER BY password,pool_id`;
    const rejects: any[] = await db`SELECT password,pool_id,ts::float8 AS ts FROM pool_rejects WHERE row_key=${k} ORDER BY password,pool_id`;
    const blocked: any[] = await db`SELECT reason,password,pool_id,src_uid,hold_id,ts::float8 AS ts FROM pool_blocked WHERE row_key=${k}`;
    const dls: any[] = await db`SELECT id,password,pool_id,status,claimed_by,claimed,ts::float8 AS ts FROM downloads WHERE keys ? ${k} ORDER BY ts DESC LIMIT 10`;
    const fids = [...new Set(rows.map((r: any) => String(r.src_file_id || "")).filter(Boolean))];
    const files: any[] = fids.length ? await db`SELECT file_id,owner_id,data->>'name' AS name FROM file_index WHERE file_id = ANY(${fids})` : [];
    // locate the account in live files: exact row state + server-side classification,
    // so "nowhere in pools" resolves to a concrete reason (pool off, not live, no key match…)
    const fr: any[] = await db`SELECT r.file_id AS file_id,r.idx AS idx,r.data AS data,f.owner_id AS owner_id,f.archived AS archived,f.data AS fdata FROM file_rows r JOIN file_index f ON f.file_id=r.file_id WHERE r.data->>'uid'=${k} OR substring(r.data->>'cookies' from 'c_user=([0-9]+)')=${k} ORDER BY r.file_id,r.idx LIMIT 20`;
    const found = fr.map((x: any) => {
      const d = json(x.data) as Row, f = json(x.fdata) as any;
      const pp = preset(f?.preset ?? f?.poolKind);
      const kk = key(d);
      return {
        fileId: String(x.file_id), idx: Number(x.idx), ownerId: String(x.owner_id), archived: !!x.archived,
        fileName: f?.name ?? null, password: String(f?.password ?? ""), preset: pp, poolEnabled: f?.poolEnabled !== false,
        uid: String((d as any).uid ?? ""), status: String((d as any).status ?? ""), has2fa: real2fa(d),
        wa: String((d as any).wa_status ?? (d as any).waStatus ?? ""), key: kk, live: liveRow(d), pool: classify(d, pp),
      };
    });
    return { key: k, rows, rejects, blocked, downloads: dls, files: files.map((f: any) => ({ fileId: f.file_id, ownerId: f.owner_id, name: f.name })), found };
  }
  if (op === "counts") { const r: any[] = await db`SELECT pool_id,COUNT(*) n FROM pool_rows WHERE password=${password} AND state='available' GROUP BY pool_id`; return Object.fromEntries(pools.map((x) => [x, Number(r.find((y) => y.pool_id === x)?.n || 0)])); }
  if (op === "summary") { const r: any = (await db`SELECT COUNT(*) FILTER (WHERE state='available') available,COUNT(*) FILTER (WHERE state='claimed') claimed,COUNT(DISTINCT src_uid) users,(SELECT COUNT(*) FROM pool_rejects WHERE password=${password} AND pool_id=${p}) invalid FROM pool_rows WHERE password=${password} AND pool_id=${p} AND (src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pool_rows.src_file_id AND archived=false))`)[0]; return { available: Number(r.available), claimed: Number(r.claimed), users: Number(r.users), invalid: Number(r.invalid) }; }
  if (op === "detail") return (await db`SELECT row_key,data,state,claimed_by,claimed_at::float8 AS claimed_at,src_uid,src_file_id,inserted_at::float8 AS inserted_at,hold_id FROM pool_rows WHERE password=${password} AND pool_id=${p} AND (src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pool_rows.src_file_id AND archived=false)) ORDER BY inserted_at,row_key LIMIT 5000`).map(rowOut);
  if (op === "rows") {
    if (!pools.includes(p as Pool)) throw new Error("invalid pool");
    if (a.verifiedOnly && a.unverifiedOnly) throw new Error("verifiedOnly and unverifiedOnly are mutually exclusive");
    if ((a.verifiedOnly || a.unverifiedOnly) && p !== "page") throw new Error("verified filters only for page pool");
    const limit = Math.min(1000, Math.max(1, Number(a.limit) || 100)), offset = Math.max(0, Number(a.offset) || 0);
    const user = String(a.userId || ""), file = String(a.fileId || "");
    const eligibleFilter = a.verifiedOnly ? db`AND lower(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible'` : a.unverifiedOnly ? db`AND lower(COALESCE(data->>'wa_status', data->>'waStatus', '')) <> 'eligible'` : db``;
    const sourceFilter = db`${user ? db`AND src_uid=${user}` : db``} ${file ? db`AND src_file_id=${file}` : db``}`;
    const where = db`FROM pool_rows WHERE password=${password} AND pool_id=${p} AND state='available' AND (src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pool_rows.src_file_id AND archived=false)) ${sourceFilter} ${eligibleFilter}`;
    const totalRow: any = (await db`SELECT COUNT(*) AS total ${where}`)[0];
    const rows = await db`SELECT row_key,data,state,claimed_by,claimed_at::float8 AS claimed_at,src_uid,src_file_id,inserted_at::float8 AS inserted_at,hold_id ${where} ORDER BY inserted_at,row_key LIMIT ${limit} OFFSET ${offset}`;
    return { total: Number(totalRow.total), rows: rows.map(rowOut), offset, limit };
  }
  if (op === "userFiles") { const rows: any[] = await db`SELECT src_uid,src_file_id,state,COUNT(*) n FROM pool_rows WHERE password=${password} AND pool_id=${p} AND src_uid IS NOT NULL AND state<>'dead' AND (src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pool_rows.src_file_id AND archived=false)) GROUP BY src_uid,src_file_id,state`; const fids = [...new Set(rows.map((r: any) => r.src_file_id).filter(Boolean))] as string[]; const metas: any[] = fids.length ? await db`SELECT file_id,data->>'name' AS name,COALESCE((data->>'createdAt')::float8,0) AS created_at,COALESCE(data->>'preset',data->>'poolKind') AS preset FROM file_index WHERE file_id IN ${db(fids)} AND archived=false` : []; const fm = new Map(metas.map((m: any) => [m.file_id, m])); const users = new Map<string, any>(); let noSrcAvail = 0; for (const r of rows) { if (r.state === "available" && !r.src_uid) noSrcAvail += Number(r.n); const u = users.get(r.src_uid) || { userId: r.src_uid, files: [], totalAvailable: 0, totalClaimed: 0 }; const m = r.src_file_id ? fm.get(r.src_file_id) : null; const f = u.files.find((x: any) => x.fileId === (r.src_file_id || "_unknown")) || { fileId: r.src_file_id || "_unknown", name: m?.name || null, createdAt: m ? Number(m.created_at) || 0 : 0, preset: m?.preset || null, available: 0, claimed: 0 }; f[r.state] = Number(r.n); if (!u.files.includes(f)) u.files.push(f); u.totalAvailable += r.state === "available" ? Number(r.n) : 0; u.totalClaimed += r.state === "claimed" ? Number(r.n) : 0; users.set(r.src_uid, u); } return { users: [...users.values()], noSrcAvail }; }
  if (op === "verifiedCounts") { const total: any = (await db`SELECT COUNT(*) n, COUNT(*) FILTER (WHERE LOWER(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible') v FROM pool_rows WHERE password=${password} AND pool_id=${p} AND state='available' AND (src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pool_rows.src_file_id AND archived=false))`)[0]; const totalN = Number(total.n), verified = Number(total.v); return { pool: p, verified, unverified: totalN - verified, totalAvailable: totalN, ...(p === "page" ? { totalCookies2faAvailable: totalN, unverifiedScanned: totalN } : {}), truncated: false, scanCap: totalN }; }
  if (op === "downloads" || op === "holds") { const where = op === "holds" ? a.status ? db`AND status=${String(a.status).toUpperCase() === "PENDING" ? "HOLD" : String(a.status).toUpperCase()}` : db`AND status IN ('HOLD','APPROVED')` : db``; const rows = await db`SELECT * FROM downloads WHERE password=${password} ${where} ORDER BY ts DESC LIMIT 50`; const out = rows.map(downloadShape); return op === "holds" ? { holds: out, downloads: out } : { downloads: out }; }
  if (op === "download" || op === "downloadDetail") { const r: any = (await db`SELECT * FROM downloads WHERE password=${password} AND id=${a.id}`)[0]; if (!r) return null; const out = downloadShape(r); if (op === "download") return out;     const keys = (json(r.keys) || []) as string[]; if (!keys.length) return { ...out, groups: [] }; const grouped: any[] = await db`SELECT src_uid AS "srcUid",src_file_id AS "srcFileId",COUNT(*)::int AS count FROM pool_rows WHERE password=${password} AND pool_id=${r.pool_id} AND row_key IN ${db(keys)} GROUP BY src_uid,src_file_id`; const groups: any[] = grouped.map((g: any) => ({ srcUid: g.srcUid ?? null, srcFileId: g.srcFileId ?? null, count: Number(g.count) })); const missing = keys.length - groups.reduce((s: number, g: any) => s + g.count, 0); if (missing > 0) groups.push({ srcUid: null, srcFileId: null, count: missing }); const fids = [...new Set(groups.map((g: any) => g.srcFileId).filter(Boolean))] as string[]; const metas: any[] = fids.length ? await db`SELECT file_id,data->>'name' AS name,COALESCE((data->>'createdAt')::float8,0) AS created_at,COALESCE(data->>'preset',data->>'poolKind') AS preset FROM file_index WHERE file_id IN ${db(fids)}` : []; const fm = new Map(metas.map((m: any) => [m.file_id, m])); for (const g of groups) { const m: any = g.srcFileId ? fm.get(g.srcFileId) : null; if (m) { g.filename = m.name || null; g.createdAt = Number(m.created_at) || 0; g.preset = m.preset || null; } } return { ...out, groups }; }
  if (op === "downloadDelete") { const r: any = (await db`SELECT status,reverted FROM downloads WHERE password=${password} AND id=${a.id}`)[0]; if (!r) throw new Error("not found"); if (!r.reverted && !["REVERTED", "REJECTED"].includes(r.status)) throw new Error("active record cannot be deleted"); await db`DELETE FROM downloads WHERE password=${password} AND id=${a.id}`; return { ok: true }; }
  // ponytail: downloads.id is a global PK — cross-password reads in ONE query, no 2x fan-out
  if (op === "holdsAll" || op === "downloadsAll") { const where = op === "holdsAll" ? (a.status ? db`WHERE status=${String(a.status).toUpperCase() === "PENDING" ? "HOLD" : String(a.status).toUpperCase()}` : db`WHERE status IN ('HOLD','APPROVED')`) : db``; const rows: any[] = await db`SELECT * FROM downloads ${where} ORDER BY ts DESC LIMIT 50`; const out = rows.map((r: any) => ({ ...downloadShape(r), password: r.password })); return op === "holdsAll" ? { holds: out, downloads: out } : { downloads: out }; }
  if (op === "downloadAny") { const r: any = (await db`SELECT * FROM downloads WHERE id=${String(a.id || "")}`)[0]; if (!r) return null; return { ...downloadShape(r), password: r.password }; }
  if (op === "summaryAll") { const rows: any[] = await db`SELECT COALESCE(p.password, r.password) password,COALESCE(p.pool_id, r.pool_id) pool,COALESCE(p.available, 0) available,COALESCE(p.claimed, 0) claimed,COALESCE(p.users, 0) users,COALESCE(r.invalid, 0) invalid FROM (SELECT password,pool_id,COUNT(*) FILTER (WHERE state='available') available,COUNT(*) FILTER (WHERE state='claimed') claimed,COUNT(DISTINCT src_uid) users FROM pool_rows GROUP BY password,pool_id) p FULL OUTER JOIN (SELECT password,pool_id,COUNT(*) invalid FROM pool_rejects GROUP BY password,pool_id) r ON r.password=p.password AND r.pool_id=p.pool_id`; return rows.map((x: any) => ({ password: x.password, pool: x.pool, available: Number(x.available), claimed: Number(x.claimed), users: Number(x.users), invalid: Number(x.invalid) })); }
  if (op === "poolUsers") { const rows: any[] = await db`SELECT pr.src_uid,COUNT(*) FILTER (WHERE pr.state='available') available,COUNT(*) FILTER (WHERE pr.state='claimed') claimed,MAX(u.name) AS name,MAX(u.username) AS username,MAX(u.photo_url) AS photo_url FROM pool_rows pr LEFT JOIN users u ON u.user_id=pr.src_uid WHERE pr.password=${password} AND pr.pool_id=${p} AND NULLIF(BTRIM(pr.src_uid), '') IS NOT NULL AND (pr.src_file_id IS NULL OR EXISTS (SELECT 1 FROM file_index WHERE file_id=pr.src_file_id AND archived=false)) GROUP BY pr.src_uid`; return rows.map((r: any) => ({ userId: r.src_uid, name: r.name || null, displayName: r.name || r.src_uid, username: r.username || null, photoUrl: r.photo_url || null, firstName: null, lastName: null, isAdmin: false, available: Number(r.available), claimed: Number(r.claimed) })); }
  if (op === "claim" || op === "hold") return allocate(password, op, p, a);
  if (["holdApprove", "holdReject", "revertDownload"].includes(op)) return transition(password, op, a);
  if (op === "removeAvailable") { const keys = [...new Set((a.keys || []).map(String).filter(Boolean))] as string[]; if (!keys.length) return { ok: true }; await db`DELETE FROM pool_rows WHERE password=${password} AND pool_id=${a.pool} AND row_key = ANY(${keys}) AND state='available' AND src_file_id=${a.srcFileId ?? ""}`; return { ok: true }; }
  if (op === "heldCheck") { const keys = [...new Set((Array.isArray(a.keys) ? a.keys : []).filter((k: any) => typeof k === "string" && k))] as string[]; if (!keys.length) return { held: 0 }; const r: any = (await db`SELECT COUNT(*) n FROM pool_rows WHERE password=${password} AND state='held' AND row_key IN ${db(keys)}`)[0]; return { held: Number(r.n) }; }
  // delete-time helpers, scoped to ONE file via src_file_id (no key list, so a
  // hold on the same account from another file never blocks or wipes this one)
  if (op === "filePoolState") { const fid = String(a.srcFileId || ""); if (!fid) return { held: 0, claimed: 0 }; const r: any = (await db`SELECT COUNT(*) FILTER (WHERE state='held') held,COUNT(*) FILTER (WHERE state='claimed') claimed FROM pool_rows WHERE password=${password} AND src_file_id=${fid}`)[0]; return { held: Number(r.held || 0), claimed: Number(r.claimed || 0) }; }
  if (op === "removeFileRows") { const fid = String(a.srcFileId || ""); if (!fid) return { removed: 0 }; const r: any = await db`DELETE FROM pool_rows WHERE password=${password} AND src_file_id=${fid}`; return { removed: Number(r.count || 0) }; }
  if (op === "markDead") { const keys = [...new Set((Array.isArray(a.dead) ? a.dead : []).map(String))].slice(0, 500) as string[]; if (!keys.length) return { dead: 0 }; const pool = typeof a.pool === "string" && a.pool ? String(a.pool) : null; const r: any = password === "global" ? (pool ? await db`UPDATE pool_rows SET state='dead' WHERE state='available' AND pool_id=${pool} AND row_key IN ${db(keys)}` : await db`UPDATE pool_rows SET state='dead' WHERE state='available' AND row_key IN ${db(keys)}`) : (pool ? await db`UPDATE pool_rows SET state='dead' WHERE state='available' AND password=${password} AND pool_id=${pool} AND row_key IN ${db(keys)}` : await db`UPDATE pool_rows SET state='dead' WHERE state='available' AND password=${password} AND row_key IN ${db(keys)}`); return { dead: Number(r.count || 0) }; }
  if (op === "holdState") { const keys = [...new Set((Array.isArray(a.keys) ? a.keys : []).filter((k: any) => typeof k === "string" && k))] as string[]; if (!keys.length) return { map: {} }; const rows: any[] = await db`SELECT row_key,bool_or(state='held') hold,bool_or(state='claimed' AND hold_id IS NOT NULL) approved,bool_or(state='dead') dead FROM pool_rows WHERE password=${password} AND row_key IN ${db(keys)} GROUP BY row_key`; return { map: Object.fromEntries(rows.map((r: any) => [r.row_key, { hold: !!r.hold, approved: !!r.approved, dead: !!r.dead }])) }; }
  if (op === "liveStatesByDownload") { const id = String(a.id || ""); if (!id) return {}; const d: any = (await db`SELECT keys FROM downloads WHERE password=${password} AND id=${id}`)[0]; const keys = (json(d?.keys) || []) as string[]; if (!keys.length) return {}; const rows: any[] = await db`SELECT src_file_id,row_key,bool_or(state='held') AS hold,bool_or(state='claimed' AND hold_id IS NOT NULL) AS approved,bool_or(state='dead') AS dead FROM pool_rows WHERE password=${password} AND row_key IN ${db(keys)} GROUP BY src_file_id,row_key`; return groupLiveStates(rows.map((r: any) => ({ src_file_id: r.src_file_id, row_key: r.row_key, hold: !!r.hold, approved: !!r.approved, dead: !!r.dead }))); }
  if (op === "liveStatesByKeys") { const keys = [...new Set((Array.isArray(a.keys) ? a.keys : []).filter((k: any) => typeof k === "string" && k && k.length <= 64))].slice(0, 500) as string[]; if (!keys.length) return []; const scope = password === "global" ? db`TRUE` : db`password=${password}`; return await db`SELECT password,src_file_id,row_key,bool_or(state='held') AS hold,bool_or(state='claimed' AND hold_id IS NOT NULL) AS approved,bool_or(state='dead') AS dead FROM pool_rows WHERE ${scope} AND row_key IN ${db(keys)} GROUP BY password,src_file_id,row_key`; }
  if (op === "downloadRows") { const r: any = (await db`SELECT * FROM downloads WHERE password=${password} AND id=${a.id}`)[0]; if (!r) return null; let keys = (json(r.keys) || []) as string[]; if ((a.srcUid || a.srcFileId) && keys.length) { const match: any[] = await db`SELECT row_key FROM pool_rows WHERE password=${password} AND pool_id=${r.pool_id} AND row_key IN ${db(keys)} AND ${a.srcUid ? db`src_uid=${String(a.srcUid)}` : db`TRUE`} AND ${a.srcFileId ? db`src_file_id=${String(a.srcFileId)}` : db`TRUE`}`; const set = new Set(match.map((m: any) => m.row_key)); keys = keys.filter((k: string) => set.has(k)); } const kset = new Set(keys); return { rows: ((json(r.rows) || []) as Row[]).filter((row) => kset.has(key(row))), keys, status: r.status, filename: r.filename }; }
  throw new Error(`unknown operation: ${op}`);
}

async function allocate(password: string, op: string, pool: string, a: any) {
  const want = a.count === "all" ? 10000 : Math.min(10000, Math.max(1, Number(a.count) || 1)); if (a.verifiedOnly && a.unverifiedOnly) throw new Error("verifiedOnly and unverifiedOnly are mutually exclusive"); if ((a.verifiedOnly || a.unverifiedOnly) && pool !== "page") throw new Error("verified filters only for page pool");
  // page pool is verified-only: unverified rows can never be taken
  if (pool === "page") { if (a.unverifiedOnly) throw new Error("page pool is verified-only"); a.verifiedOnly = true; }
  if (op === "hold" && a.mode === "pick" && !((a.srcUids || []).length || (a.srcFileIds || []).length || a.srcUid || a.srcFileId)) throw new Error("pick mode requires srcUids or srcFileIds");
  return db.begin(async (tx: any) => {
    const id = String(a.downloadId || a.holdId || crypto.randomUUID().replaceAll("-", "").slice(0, 12)), now = Date.now(), state = op === "hold" ? "held" : "claimed", status = op === "hold" ? "HOLD" : "CLAIMED";
    const off = await poolComboOff(password, pool);
    const unit = off ? 0 : Number(((await tx`SELECT price FROM pool_settings WHERE password=${password} AND pool_id=${pool}`)[0]?.price ?? price(pool)));
    const { u, f } = poolFilters(a);
    // eligibility pushed into SQL (was: fetch up to 5000 + JS filter) and select+update folded into one CTE (was: 2 round trips)
    const elig = a.verifiedOnly ? tx`AND LOWER(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible'` : a.unverifiedOnly ? tx`AND LOWER(COALESCE(data->>'wa_status', data->>'waStatus', '')) <> 'eligible'` : tx``;
    const src = !u.length && f.length === 1 ? tx`AND src_file_id=${f[0]}` : u.length && f.length ? tx`AND src_uid IN ${db(u)} AND src_file_id IN ${db(f)}` : u.length ? tx`AND src_uid IN ${db(u)}` : f.length ? tx`AND src_file_id IN ${db(f)}` : tx``;
    const rows: any[] = await tx`WITH selected AS (SELECT row_key FROM pool_rows WHERE password=${password} AND pool_id=${pool} AND state='available' ${src} ${elig} ORDER BY inserted_at,row_key LIMIT ${want} FOR UPDATE SKIP LOCKED) UPDATE pool_rows p SET state=${state},hold_id=${op === "hold" ? id : null},claimed_by=${a.uid},claimed_at=${now} FROM selected s WHERE p.password=${password} AND p.pool_id=${pool} AND p.row_key=s.row_key AND p.state='available' RETURNING p.row_key,p.data,p.src_uid`;
    if (!rows.length) return op === "hold" ? { claimed: 0, held: 0, count: 0, rows: [], holdId: null, downloadId: null, filename: null, status: "HOLD", unitPrice: price(pool), total: 0, mode: a.mode || "fifo" } : { claimed: 0, rows: [], downloadId: null, filename: a.filename || null, status: null, unitPrice: price(pool), total: 0, mode: "fifo" };
    const data = rows.map((r: any) => json(r.data)), keys = rows.map((r: any) => r.row_key);   const filename = String(a.filename || `${pool}_${id.slice(-4)}.xlsx`); await tx`INSERT INTO downloads(id,password,pool_id,claimed_by,claimed,filename,keys,rows,reverted,ts,status,unit_price,total,mode,src_uids,src_file_ids,selection) VALUES(${id},${password},${pool},${a.uid},${rows.length},${filename},${j(keys)},${j(data)},false,${now},${status},${unit},${+(unit * rows.length).toFixed(2)},${a.mode || "fifo"},${j(a.srcUids || (a.srcUid ? [String(a.srcUid)] : null))},${j(a.srcFileIds || (a.srcFileId ? [String(a.srcFileId)] : null))},${j({ verifiedOnly: !!a.verifiedOnly, unverifiedOnly: !!a.unverifiedOnly })}) ON CONFLICT(id) DO NOTHING`; if (op !== "hold" && keys.length) await tx`INSERT INTO pool_blocked(row_key,reason,password,pool_id,src_uid,hold_id,ts) SELECT s.k,'sold',${password},${pool},s.u,${id},${now} FROM jsonb_to_recordset(${j(rows.map((r: any) => ({ k: String(r.row_key), u: r.src_uid ? String(r.src_uid) : null })))}::jsonb) AS s(k text,u text) ON CONFLICT(row_key) DO NOTHING`; return op === "hold" ? { claimed: rows.length, held: rows.length, count: rows.length, rows: data, holdId: id, downloadId: id, filename, status, unitPrice: unit, total: +(unit * rows.length).toFixed(2), mode: a.mode || "fifo", srcUids: a.srcUids || null, srcFileIds: a.srcFileIds || null } : { claimed: rows.length, rows: data, downloadId: id, filename, status, unitPrice: unit, total: +(unit * rows.length).toFixed(2), mode: "fifo" }; });
}
async function transition(password: string, op: string, a: any) {
  return db.begin(async (tx: any) => {
    const d: any = (await tx`SELECT * FROM downloads WHERE password=${password} AND id=${a.id} FOR UPDATE`)[0];
    if (!d) throw new Error("not found");
    const keys = (json(d.keys) || []) as string[], now = Date.now();
    const unit = Number(d.unit_price ?? price(d.pool_id));
    if (op === "revertDownload") {
      if (d.status === "REVERTED") return { ok: true, id: d.id, status: "REVERTED" };
      // Finality — same rule as approve/reject flips: a settled hold, two
      // actions, or a closed 5-minute window means the decision stands and
      // owners keep settled payouts. Without this, Delete on an old approved
      // hold clawed back money and freed rows at any age.
      const racts = Number(d.action_count || 0), rfirstAt = Number(d.first_action_at || 0);
      if (d.settled || racts >= 2 || (racts >= 1 && now >= rfirstAt + REVERT_WINDOW)) throw new Error("decision is final - revert window closed");
      if (!["HOLD", "CLAIMED", "APPROVED"].includes(d.status)) throw new Error("not revertable");
      if (!keys.length) { await tx`UPDATE downloads SET reverted=true,status='REVERTED' WHERE password=${password} AND id=${d.id}`; return { ok: true, reverted: 0, id: d.id, status: "REVERTED" }; }
      const revertedRows: any[] = d.status === "HOLD"
        ? await tx`UPDATE pool_rows SET state='available',hold_id=NULL,claimed_by=NULL,claimed_at=NULL WHERE password=${password} AND pool_id=${d.pool_id} AND state='held' AND hold_id=${d.id} AND row_key IN ${db(keys)} RETURNING src_uid`
        : await tx`UPDATE pool_rows SET state='available',hold_id=NULL,claimed_by=NULL,claimed_at=NULL WHERE password=${password} AND pool_id=${d.pool_id} AND state IN ('held','claimed') AND (hold_id IS NULL OR hold_id=${d.id}) AND row_key IN ${db(keys)} RETURNING src_uid`;
      const reverted = revertedRows.length;
      const debit = new Map<string, number>();
      if (d.status === "APPROVED") for (const row of revertedRows) { if (row.src_uid) debit.set(String(row.src_uid), (debit.get(String(row.src_uid)) || 0) + unit); }
      for (const [uid, amount] of debit) {
        const updated: any[] = await tx`UPDATE wallets SET balance=balance-${amount} WHERE user_id=${uid} AND balance>=${amount} RETURNING balance`;
        if (!updated.length) throw new Error("insufficient wallet balance for revert");
        const r: any = updated[0];
        await tx`INSERT INTO wallet_transactions(id,user_id,type,amount,balance_after,description,meta,created_at) VALUES(${crypto.randomUUID()},${uid},'DEBIT',${amount},${Number(r.balance)},${`Hold returned - ${poolLabel(d.pool_id)}`},${j({ pool_id: d.pool_id, download_id: d.id })},${now})`;
      }
      await tx`UPDATE downloads SET reverted=true,status='REVERTED' WHERE password=${password} AND id=${d.id}`;
      return { ok: true, reverted, id: d.id, status: "REVERTED" };
    }
    if (op === "holdApprove") {
      const actions = Number(d.action_count || 0), firstAt = Number(d.first_action_at || 0);
      if (d.settled || actions >= 2 || (actions === 1 && now >= firstAt + REVERT_WINDOW)) throw new Error("decision is final - revert window closed");
      if (d.status === "APPROVED") throw new Error("already approved");
      if (d.status !== "HOLD" && d.status !== "REJECTED") throw new Error("not a hold");
      let approved = 0;
      if (keys.length) {
        // re-approving a REJECTED hold re-claims rows still free; scoped to this password/pool + hold keys only.
        const rows: any[] = await tx`UPDATE pool_rows SET state='claimed',hold_id=${d.id},claimed_by=${d.claimed_by || a.uid},claimed_at=${now} WHERE password=${password} AND pool_id=${d.pool_id} AND row_key IN ${db(keys)} AND ((state='held' AND hold_id=${d.id}) OR state='available') RETURNING row_key,src_uid`;
        approved = rows.length;
        if (rows.length) await tx`INSERT INTO pool_blocked(row_key,reason,password,pool_id,src_uid,hold_id,ts) SELECT s.k,'sold',${password},${d.pool_id},s.u,${d.id},${now} FROM jsonb_to_recordset(${j(rows.map((r: any) => ({ k: String(r.row_key), u: r.src_uid ? String(r.src_uid) : null })))}::jsonb) AS s(k text,u text) ON CONFLICT(row_key) DO NOTHING`;
      }
      // dead rows (worker-marked) stay 'dead' — consumed unpaid
      const deadRows: any[] = await tx`SELECT COUNT(*) n FROM pool_rows WHERE password=${password} AND pool_id=${d.pool_id} AND state='dead' AND hold_id=${d.id}`;
      const dead = Number(deadRows[0]?.n || 0);
      // wallets are credited once at settlement (first_action_at + 5min), not here
      await tx`UPDATE downloads SET status='APPROVED',reverted=false,first_action_at=${firstAt || now},action_count=${actions + 1} WHERE password=${password} AND id=${d.id}`;
      return { ok: true, approved, dead, id: d.id, status: "APPROVED", actionCount: actions + 1, settleAt: (firstAt || now) + REVERT_WINDOW };
    }
    // holdReject — one flip within the 5-minute window; wallets settle after the window closes
    if (d.settled || Number(d.action_count || 0) >= 2 || (Number(d.action_count || 0) === 1 && now >= Number(d.first_action_at || 0) + REVERT_WINDOW)) throw new Error("decision is final - revert window closed");
    if (d.status !== "HOLD" && d.status !== "APPROVED") throw new Error(d.status === "REJECTED" ? "already rejected" : "not a hold");
    let rejected = 0;
    if (keys.length) {
      const rows: any[] = await tx`UPDATE pool_rows SET state='available',hold_id=NULL,claimed_by=NULL,claimed_at=NULL WHERE password=${password} AND pool_id=${d.pool_id} AND hold_id=${d.id} AND state IN ('held','claimed') AND row_key IN ${db(keys)} RETURNING src_uid`;
      rejected = rows.length;
    }
    const firstAt = Number(d.first_action_at || 0);
    await tx`UPDATE downloads SET reverted=true,status='REJECTED',first_action_at=${firstAt || now},action_count=${Number(d.action_count || 0) + 1} WHERE password=${password} AND id=${d.id}`;
    return { ok: true, rejected, reverted: rejected, id: d.id, status: "REJECTED", actionCount: Number(d.action_count || 0) + 1, settleAt: (firstAt || now) + REVERT_WINDOW };
  });
}

/** Ops that mutate pool tables (pool_rows/pool_rejects/pool_blocked/downloads)
 *  or file/user indexes — the rpc read cache (do.ts) must be evicted AFTER the
 *  write commits, synchronously: a void eviction re-opens the exact stale-read
 *  race the routing suite caught (global pool reads served pre-feed data). */
const POOL_WRITE_OPS = new Set(["add", "claim", "hold", "holdApprove", "holdReject", "revertDownload", "markDead", "removeAvailable", "removeFileRows"]);
const INDEX_WRITE_OPS = new Set(["ensureUser", "register", "archive", "batchArchive", "purge", "batchPurge", "deleteUser", "ban"]);

export async function repository(namespace: "index" | "files" | "pools", name: string, op: string, args: Record<string, unknown>) {
  const out = await (namespace === "index" ? indexOp(op, args) : namespace === "files" ? fileOp(name, op, args) : poolOp(name, op, args));
  // ponytail: live pool counts fan out AFTER the write commits, fire-and-void
  // (fail-open bridge) so API latency is unaffected — single-replica deploy
  // (no numReplicas in railway.toml), so in-process rooms only, no relay.
  if (namespace === "pools" && POOL_WRITE_OPS.has(op)) {
    await redisDelPrefix("ss:rpc:pools:");
    void publishPoolCounts(name === "global" ? undefined : name, typeof args.pool === "string" ? args.pool : undefined);
  } else if (namespace === "index" && INDEX_WRITE_OPS.has(op)) await redisDelPrefix("ss:rpc:index:");
  return out;
}
