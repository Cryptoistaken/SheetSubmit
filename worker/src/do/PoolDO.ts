import type { Row } from "../lib/shared";
const pools = ["cookies_only", "cookies_2fa", "page"] as const;
type Pool = typeof pools[number];
const key = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
export function classifyRow(r: Row): Pool | null { const c = String(r.cookies || ""); if (!/c_user=\d+/.test(c) || !r.uid || ["bad", "dead"].includes(String(r.status || "").toLowerCase())) return null; const two = !!String(r.twofakey || r["2fa key"] || "").trim(); if (String(r.wa_status || r.waStatus || "") === "eligible" && two) return "page"; return two ? "cookies_2fa" : "cookies_only"; }
export class PoolDO {
  constructor(private readonly state: DurableObjectState) {
    state.blockConcurrencyWhile(async () => {
      const s = state.storage.sql;
      s.exec("CREATE TABLE IF NOT EXISTS pool_rows(pool_id TEXT NOT NULL, row_key TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'available', claimed_by TEXT, claimed_at INTEGER, PRIMARY KEY(pool_id,row_key)) WITHOUT ROWID");
      s.exec("CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,pool_id TEXT,row_key TEXT,user_id TEXT,action TEXT,ts INTEGER)");
      s.exec("CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY,pool_id TEXT NOT NULL,claimed_by TEXT,claimed INTEGER NOT NULL DEFAULT 0,filename TEXT,keys TEXT NOT NULL,rows TEXT NOT NULL DEFAULT '[]',reverted INTEGER NOT NULL DEFAULT 0,ts INTEGER NOT NULL)");
      // ponytail: safe ALTER — ignores if column already exists
      try { s.exec("ALTER TABLE pool_rows ADD COLUMN src_uid TEXT"); } catch {}
      try { s.exec("ALTER TABLE pool_rows ADD COLUMN src_file_id TEXT"); } catch {}
    });
  }
  async fetch(req: Request) {
    const { op, args = {} } = await req.json() as any;
    const s = this.state.storage.sql;
    switch (op) {
      case "add": {
        let added = 0;
        for (const row of args.rows as Row[]) {
          const p = classifyRow(row), k = key(row);
          if (!p || !k) continue;
          const before = s.exec("SELECT 1 FROM pool_rows WHERE pool_id=? AND row_key=?", p, k).toArray();
          if (!before.length) {
            s.exec("INSERT INTO pool_rows(pool_id,row_key,data,src_uid,src_file_id) VALUES(?,?,?,?,?)", p, k, JSON.stringify(row), args.srcUid || null, args.srcFileId || null);
            s.exec("INSERT INTO ledger(pool_id,row_key,user_id,action,ts) VALUES(?,?,?,?,?)", p, k, args.uid, "add", Date.now());
            added++;
          }
        }
        return Response.json({ added });
      }
      case "counts": return Response.json(Object.fromEntries(pools.map((p) => [p, Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available'", p).toArray()[0].n)])));
      case "detail": return Response.json(s.exec("SELECT row_key,data,state,claimed_by,claimed_at,src_uid,src_file_id FROM pool_rows WHERE pool_id=?", args.pool).toArray().map((r: any) => ({ ...JSON.parse(r.data), _key: r.row_key, _state: r.state, _claimedBy: r.claimed_by, _claimedAt: r.claimed_at, _srcUid: r.src_uid, _srcFileId: r.src_file_id })));
      case "claim": {
        const rows = s.exec("SELECT row_key,data FROM pool_rows WHERE pool_id=? AND state='available' LIMIT ?", args.pool, Math.min(10000, Number(args.count || 1))).toArray();
        rows.forEach((r: any) => {
          s.exec("UPDATE pool_rows SET state='claimed',claimed_by=?,claimed_at=? WHERE pool_id=? AND row_key=?", args.uid, Date.now(), args.pool, r.row_key);
          s.exec("INSERT INTO ledger(pool_id,row_key,user_id,action,ts) VALUES(?,?,?,?,?)", args.pool, r.row_key, args.uid, "claim", Date.now());
        });
        let downloadId: string | null = null;
        if (rows.length && args.downloadId) {
          s.exec("INSERT INTO downloads(id,pool_id,claimed_by,claimed,filename,keys,rows,ts) VALUES(?,?,?,?,?,?,?,?)", args.downloadId, args.pool, args.uid, rows.length, String(args.filename || "pool.xlsx"), JSON.stringify(rows.map((r: any) => r.row_key)), JSON.stringify(rows.map((r: any) => JSON.parse(r.data))), Date.now());
          downloadId = String(args.downloadId);
        }
        return Response.json({ claimed: rows.length, rows: rows.map((r: any) => JSON.parse(r.data)), downloadId, filename: args.filename || null });
      }
      case "userFiles": {
        const pool = args.pool as string;
        // Group available rows by src_uid → src_file_id
        const avail = s.exec("SELECT src_uid, src_file_id, COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available' AND src_uid IS NOT NULL GROUP BY src_uid, src_file_id", pool).toArray() as any[];
        // Group claimed rows by src_uid → src_file_id
        const claimed = s.exec("SELECT src_uid, src_file_id, COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='claimed' AND src_uid IS NOT NULL GROUP BY src_uid, src_file_id", pool).toArray() as any[];
        // Fallback: rows without src_uid — group by claimed_by as "unknown source"
        const noSrcAvail = Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available' AND src_uid IS NULL", pool).toArray()[0].n);
        const users = new Map<string, Map<string, { available: number; claimed: number }>>();
        for (const r of avail) {
          if (!users.has(r.src_uid)) users.set(r.src_uid, new Map());
          users.get(r.src_uid)!.set(r.src_file_id || "_unknown", { available: r.n, claimed: 0 });
        }
        for (const r of claimed) {
          if (!users.has(r.src_uid)) users.set(r.src_uid, new Map());
          const m = users.get(r.src_uid)!;
          const f = m.get(r.src_file_id || "_unknown") || { available: 0, claimed: 0 };
          f.claimed = r.n;
          m.set(r.src_file_id || "_unknown", f);
        }
        const result: any[] = [];
        for (const [uid, files] of users) {
          const fileList: any[] = [];
          let totalAvail = 0, totalClaimed = 0;
          for (const [fid, counts] of files) {
            fileList.push({ fileId: fid, available: counts.available, claimed: counts.claimed });
            totalAvail += counts.available;
            totalClaimed += counts.claimed;
          }
          result.push({ userId: uid, files: fileList, totalAvailable: totalAvail, totalClaimed: totalClaimed });
        }
        return Response.json({ users: result, noSrcAvail });
      }
      case "downloads": return Response.json({ downloads: s.exec("SELECT id,pool_id,claimed_by,claimed,filename,reverted,ts FROM downloads ORDER BY ts DESC LIMIT 50").toArray() });
      case "download": {
        const r: any = s.exec("SELECT * FROM downloads WHERE id=?", args.id).toArray()[0];
        return Response.json(r ? { id: r.id, poolId: r.pool_id, claimedBy: r.claimed_by, claimed: r.claimed, filename: r.filename, rows: JSON.parse(r.rows), reverted: !!r.reverted, ts: r.ts } : null);
      }
      case "revertDownload": {
        const d: any = s.exec("SELECT * FROM downloads WHERE id=?", args.id).toArray()[0];
        if (!d) return Response.json({ error: "not found" }, { status: 404 });
        if (d.reverted) return Response.json({ error: "already reverted" }, { status: 400 });
        const keys = JSON.parse(d.keys) as string[];
        for (const k of keys) {
          s.exec("UPDATE pool_rows SET state='available',claimed_by=NULL,claimed_at=NULL WHERE pool_id=? AND row_key=?", d.pool_id, k);
          s.exec("INSERT INTO ledger(pool_id,row_key,user_id,action,ts) VALUES(?,?,?,?,?)", d.pool_id, k, args.uid, "revert", Date.now());
        }
        s.exec("UPDATE downloads SET reverted=1 WHERE id=?", args.id);
        return Response.json({ ok: true, reverted: keys.length });
      }
      case "removeAvailable": {
        for (const k of (args.keys || []) as string[]) {
          if (!args.pool) continue;
          s.exec("DELETE FROM pool_rows WHERE pool_id=? AND row_key=? AND state='available'", args.pool, k);
          s.exec("INSERT INTO ledger(pool_id,row_key,user_id,action,ts) VALUES(?,?,?,?,?)", args.pool, k, args.uid || "", "remove", Date.now());
        }
        return Response.json({ ok: true });
      }
      case "ledger": return Response.json({ ledger: s.exec("SELECT * FROM ledger WHERE pool_id=? ORDER BY id DESC LIMIT 500", args.pool).toArray() });
      case "revert": {
        const r: any = s.exec("SELECT * FROM ledger WHERE id=?", args.id).toArray()[0];
        if (!r) return Response.json(null);
        s.exec("UPDATE pool_rows SET state='available',claimed_by=NULL,claimed_at=NULL WHERE pool_id=? AND row_key=?", r.pool_id, r.row_key);
        return Response.json({ ok: true });
      }
      default: return Response.json({ error: "unknown operation" }, { status: 400 });
    }
  }
}
