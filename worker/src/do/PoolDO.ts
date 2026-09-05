import type { Row } from "../lib/shared";
const pools = ["cookies_only", "cookies_2fa", "page"] as const;
type Pool = typeof pools[number];
const key = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
const hasReal2FA = (r: Row) => { const v = String(r.twofakey ?? r["2fa key"] ?? "").trim(); return !!v && v !== "No_2Fa"; };
export function classifyRow(r: Row, preset?: string | null): Pool | null { const c = String(r.cookies || ""); if (!/c_user=\d+/.test(c) || !r.uid || ["bad", "dead"].includes(String(r.status || "").toLowerCase())) return null; const has2 = hasReal2FA(r); if (preset === "page") return has2 ? "page" : "cookies_only"; if (preset === "combo" || preset === "2fa") return has2 ? "cookies_2fa" : "cookies_only"; if (preset === "cookie") return "cookies_only"; const two = has2; if (String(r.wa_status || r.waStatus || "") === "eligible" && two) return "page"; return two ? "cookies_2fa" : "cookies_only"; }
const isEligible = (d: any) => String(d?.wa_status ?? d?.waStatus ?? "").toLowerCase() === "eligible";
const normalizePreset = (v: unknown): string | null => { const s = String(v || "").toLowerCase(); if (s === "cookie") return "cookie"; if (s === "combo" || s === "2fa") return "combo"; if (s === "page") return "page"; return null; };
export class PoolDO {
  constructor(private readonly state: DurableObjectState) {
    state.blockConcurrencyWhile(async () => {
      const s = state.storage.sql;
      s.exec("CREATE TABLE IF NOT EXISTS pool_rows(pool_id TEXT NOT NULL, row_key TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'available', claimed_by TEXT, claimed_at INTEGER, PRIMARY KEY(pool_id,row_key)) WITHOUT ROWID");
      s.exec("CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY AUTOINCREMENT,pool_id TEXT,row_key TEXT,user_id TEXT,action TEXT,ts INTEGER)");
      s.exec("CREATE TABLE IF NOT EXISTS downloads(id TEXT PRIMARY KEY,pool_id TEXT NOT NULL,claimed_by TEXT,claimed INTEGER NOT NULL DEFAULT 0,filename TEXT,keys TEXT NOT NULL,rows TEXT NOT NULL DEFAULT '[]',reverted INTEGER NOT NULL DEFAULT 0,ts INTEGER NOT NULL)");
      try { s.exec("ALTER TABLE pool_rows ADD COLUMN src_uid TEXT"); } catch {}
      try { s.exec("ALTER TABLE pool_rows ADD COLUMN src_file_id TEXT"); } catch {}
    });
  }
  async fetch(req: Request) {
    let body: any; try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
    const op = body?.op; const args = body?.args ?? {};
    if (typeof op !== "string" || !op || op.length > 64) return Response.json({ error: "invalid op" }, { status: 400 });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return Response.json({ error: "invalid args" }, { status: 400 });
    const s = this.state.storage.sql;
    switch (op) {
      case "add": {
        let added = 0;
        const preset = normalizePreset(args.preset ?? args.poolKind ?? args.filePreset ?? args.file?.preset ?? args.file?.poolKind);
        const srcFileId = args.srcFileId ? String(args.srcFileId) : null;
        for (const row of args.rows as Row[]) {
          const p = classifyRow(row, preset), k = key(row);
          if (!p || !k) continue;
          if (srcFileId && preset) {
            if (p === "page") s.exec("DELETE FROM pool_rows WHERE pool_id='cookies_2fa' AND row_key=? AND src_file_id=? AND state='available'", k, srcFileId);
            else if (p === "cookies_2fa") s.exec("DELETE FROM pool_rows WHERE pool_id='page' AND row_key=? AND src_file_id=? AND state='available'", k, srcFileId);
            else if (p === "cookies_only") {
              s.exec("DELETE FROM pool_rows WHERE pool_id='cookies_2fa' AND row_key=? AND src_file_id=? AND state='available'", k, srcFileId);
              s.exec("DELETE FROM pool_rows WHERE pool_id='page' AND row_key=? AND src_file_id=? AND state='available'", k, srcFileId);
            }
          }
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
      case "summary": {
        const pool = String(args.pool || "");
        if (!pools.includes(pool as Pool)) return Response.json({ error: "invalid pool" }, { status: 400 });
        const available = Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available'", pool).toArray()[0].n);
        const claimed = Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='claimed'", pool).toArray()[0].n);
        const users = Number(s.exec("SELECT COUNT(DISTINCT claimed_by) n FROM pool_rows WHERE pool_id=? AND state='claimed' AND claimed_by IS NOT NULL", pool).toArray()[0].n);
        return Response.json({ available, claimed, users });
      }
      case "detail": return Response.json(s.exec("SELECT row_key,data,state,claimed_by,claimed_at,src_uid,src_file_id FROM pool_rows WHERE pool_id=?", args.pool).toArray().map((r: any) => ({ ...JSON.parse(r.data), _key: r.row_key, _state: r.state, _claimedBy: r.claimed_by, _claimedAt: r.claimed_at, _srcUid: r.src_uid, _srcFileId: r.src_file_id })));
      case "claim": {
        const pool = String(args.pool || "");
        if (!pools.includes(pool as Pool)) return Response.json({ error: "invalid pool" }, { status: 400 });
        const want = args.count === "all" ? 10000 : Math.min(10000, Math.max(1, Number(args.count) || 1));
        const srcUid = args.srcUid != null ? String(args.srcUid) : args.claimForUser != null ? String(args.claimForUser) : args.userId != null ? String(args.userId) : null;
        const srcFileId = args.srcFileId != null ? String(args.srcFileId) : args.fileId != null ? String(args.fileId) : null;
        const verifiedOnly = !!args.verifiedOnly;
        const unverifiedOnly = !!args.unverifiedOnly;
        if (verifiedOnly && unverifiedOnly) return Response.json({ error: "verifiedOnly and unverifiedOnly are mutually exclusive" }, { status: 400 });
        if ((verifiedOnly || unverifiedOnly) && pool !== "page") return Response.json({ error: "verified filters only for page pool" }, { status: 400 });
        let rows: any[] = [];
        if (verifiedOnly || unverifiedOnly) {
          const SCAN_CAP = 5000;
          let q = "SELECT row_key,data FROM pool_rows WHERE pool_id=? AND state='available'";
          const qArgs: any[] = [pool];
          if (srcUid) { q += " AND src_uid=?"; qArgs.push(srcUid); }
          if (srcFileId) { q += " AND src_file_id=?"; qArgs.push(srcFileId); }
          q += " LIMIT ?";
          qArgs.push(SCAN_CAP);
          const candidates = s.exec(q, ...qArgs).toArray() as any[];
          const filtered = candidates.filter((r: any) => {
            try { const d = JSON.parse(r.data); const v = isEligible(d); return verifiedOnly ? v : !v; } catch { return !verifiedOnly; }
          }).slice(0, want);
          rows = filtered;
        } else {
          let q = "SELECT row_key,data FROM pool_rows WHERE pool_id=? AND state='available'";
          const qArgs: any[] = [pool];
          if (srcUid) { q += " AND src_uid=?"; qArgs.push(srcUid); }
          if (srcFileId) { q += " AND src_file_id=?"; qArgs.push(srcFileId); }
          q += " LIMIT ?";
          qArgs.push(want);
          rows = s.exec(q, ...qArgs).toArray() as any[];
        }
        rows.forEach((r: any) => {
          s.exec("UPDATE pool_rows SET state='claimed',claimed_by=?,claimed_at=? WHERE pool_id=? AND row_key=?", args.uid, Date.now(), pool, r.row_key);
          s.exec("INSERT INTO ledger(pool_id,row_key,user_id,action,ts) VALUES(?,?,?,?,?)", pool, r.row_key, args.uid, "claim", Date.now());
        });
        let downloadId: string | null = null;
        if (rows.length && args.downloadId) {
          s.exec("INSERT INTO downloads(id,pool_id,claimed_by,claimed,filename,keys,rows,ts) VALUES(?,?,?,?,?,?,?,?)", args.downloadId, pool, args.uid, rows.length, String(args.filename || "pool.xlsx"), JSON.stringify(rows.map((r: any) => r.row_key)), JSON.stringify(rows.map((r: any) => JSON.parse(r.data))), Date.now());
          downloadId = String(args.downloadId);
        }
        return Response.json({ claimed: rows.length, rows: rows.map((r: any) => JSON.parse(r.data)), downloadId, filename: args.filename || null });
      }
      case "verifiedCounts":
      case "pageCounts":
      case "pageVerifiedCounts": {
        const pool = String(args.pool || "");
        if (!pools.includes(pool as Pool)) return Response.json({ error: "invalid pool" }, { status: 400 });
        if (pool === "page") {
          const SCAN_CAP = 5000;
          const totalAvailable = Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id='page' AND state='available'").toArray()[0].n);
          const rows = s.exec("SELECT data FROM pool_rows WHERE pool_id='page' AND state='available' LIMIT ?", SCAN_CAP).toArray() as any[];
          let verified = 0;
          for (const r of rows) { try { const d = JSON.parse(r.data); if (isEligible(d)) verified++; } catch {} }
          const unverified = rows.length - verified;
          const truncated = totalAvailable > SCAN_CAP;
          return Response.json({ pool, verified, unverified, totalAvailable, totalCookies2faAvailable: totalAvailable, unverifiedScanned: rows.length, truncated, scanCap: SCAN_CAP });
        }
        const SCAN_CAP = 5000;
        const rows = s.exec("SELECT data FROM pool_rows WHERE pool_id=? AND state='available' LIMIT ?", pool, SCAN_CAP).toArray() as any[];
        let verified = 0;
        for (const r of rows) { try { const d = JSON.parse(r.data); if (isEligible(d)) verified++; } catch {} }
        const total = rows.length;
        const unverified = total - verified;
        const totalAvailable = Number(s.exec("SELECT COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available'", pool).toArray()[0].n);
        const truncated = totalAvailable > SCAN_CAP;
        return Response.json({ pool, verified, unverified, totalAvailable, truncated, scanCap: SCAN_CAP });
      }
      case "userFiles": {
        const pool = args.pool as string;
        const avail = s.exec("SELECT src_uid, src_file_id, COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='available' AND src_uid IS NOT NULL GROUP BY src_uid, src_file_id", pool).toArray() as any[];
        const claimed = s.exec("SELECT src_uid, src_file_id, COUNT(*) n FROM pool_rows WHERE pool_id=? AND state='claimed' AND src_uid IS NOT NULL GROUP BY src_uid, src_file_id", pool).toArray() as any[];
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
        return Response.json(r ? { id: r.id, poolId: r.pool_id, claimedBy: r.claimed_by, claimed: r.claimed, filename: r.filename, rows: JSON.parse(r.rows), keys: JSON.parse(r.keys), reverted: !!r.reverted, ts: r.ts } : null);
      }
      case "downloadDetail": {
        const id = String(args.id || "");
        if (!id) return Response.json({ error: "id required" }, { status: 400 });
        const r: any = s.exec("SELECT * FROM downloads WHERE id=?", id).toArray()[0];
        if (!r) return Response.json(null);
        const rows = JSON.parse(r.rows) as any[];
        const keys = JSON.parse(r.keys) as string[];
        const groups = new Map<string, { srcUid: string | null; srcFileId: string | null; count: number }>();
        for (const k of keys) {
          const prow: any = s.exec("SELECT src_uid, src_file_id FROM pool_rows WHERE pool_id=? AND row_key=?", r.pool_id, k).toArray()[0];
          const uid = prow?.src_uid ?? null;
          const fid = prow?.src_file_id ?? null;
          const gk = `${uid ?? "_null"}::${fid ?? "_null"}`;
          const g = groups.get(gk) || { srcUid: uid, srcFileId: fid, count: 0 };
          g.count++;
          groups.set(gk, g);
        }
        if (!groups.size && rows.length) {
          const byUid = new Map<string, number>();
          for (const row of rows) { const u = String(row.uid || ""); byUid.set(u, (byUid.get(u) || 0) + 1); }
          for (const [u, c] of byUid) groups.set(`uid:${u}`, { srcUid: u || null, srcFileId: null, count: c });
        }
        return Response.json({ id: r.id, poolId: r.pool_id, claimedBy: r.claimed_by, claimed: r.claimed, filename: r.filename, rows, keys, reverted: !!r.reverted, ts: r.ts, groups: [...groups.values()] });
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
