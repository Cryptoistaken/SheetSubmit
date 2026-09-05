import type { Row, SheetFile } from "../lib/shared";
const ldCounts = (rows: Row[]) => {
  let live = 0, dead = 0, page = 0;
  const keys = new Map<string, number>();
  for (const r of rows) {
    const s = String(r.status || "").toLowerCase();
    if (s === "good") live++; else if (s === "bad") dead++;
    if (String(r.wa_status || "").toLowerCase() === "eligible") page++;
    const k = String(r.uid || "").trim() || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] ?? "");
    if (k) keys.set(k, (keys.get(k) || 0) + 1);
  }
  let dup = 0; keys.forEach((c) => { if (c > 1) dup += c; });
  return { liveCount: live, deadCount: dead, pageCount: page, dupCount: dup };
};
export class FileDO {
  constructor(private readonly state: DurableObjectState) { state.blockConcurrencyWhile(async () => { const s = state.storage.sql; s.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY,v TEXT NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS rows (idx INTEGER PRIMARY KEY,data TEXT NOT NULL)"); s.exec("INSERT OR IGNORE INTO meta(k,v) VALUES('seq','0')"); s.exec("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT, seq INTEGER)"); }); }
  private rows() { return this.state.storage.sql.exec("SELECT idx,data FROM rows ORDER BY idx").toArray().map((r: any) => JSON.parse(r.data)) as Row[]; }
  private seq(): number { const r: any = this.state.storage.sql.exec("SELECT v FROM meta WHERE k='seq'").toArray()[0]; return r ? Number(r.v) : 0; }
  async fetch(req: Request): Promise<Response> {
    let body: any; try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
    const op = body?.op; const args = body?.args ?? {};
    if (typeof op !== "string" || !op || op.length > 64) return Response.json({ error: "invalid op" }, { status: 400 });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return Response.json({ error: "invalid args" }, { status: 400 });
    const s = this.state.storage.sql; switch (op) {
      case "init": s.exec("DELETE FROM meta; DELETE FROM rows; DELETE FROM logs"); s.exec("INSERT INTO meta(k,v) VALUES('file',?)", JSON.stringify(args.file)); s.exec("INSERT INTO meta(k,v) VALUES('seq','0')"); (args.rows || []).forEach((r: Row, i: number) => s.exec("INSERT INTO rows(idx,data) VALUES(?,?)", i, JSON.stringify(r))); return Response.json({ ok: true });
      case "meta": { const r: any = s.exec("SELECT v FROM meta WHERE k='file'").toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
      case "seq": return Response.json({ seq: this.seq() });
      case "rows": return Response.json(this.rows());
      case "full": return Response.json({ rows: this.rows(), seq: this.seq() });
      case "counts": return Response.json(ldCounts(this.rows()));
      case "keys":
      case "dupKeys":
      case "projection": {
        const limit = Math.min(10000, Math.max(1, Number(args.limit) || 10000));
        const all = this.rows();
        const out: { k: string; i: number }[] = [];
        for (let i = 0; i < all.length && out.length < limit; i++) { const r: any = all[i]; const k = String(r.uid || "").trim() || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] ?? ""); if (k) out.push({ k, i }); }
        return Response.json(out);
      }
      case "append": {
        const base = args.base; const ops = args.ops;
        if (!Number.isInteger(base) || !Array.isArray(ops) || ops.length > 10000) return Response.json({ error: "invalid append payload" }, { status: 400 });
        for (const o of ops) { if (!o || typeof o.rowIdx !== "number" || !Number.isInteger(o.rowIdx) || o.rowIdx < 0 || o.rowIdx > 100000 || typeof o.cols !== "object" || o.cols === null || Array.isArray(o.cols)) return Response.json({ error: "invalid op" }, { status: 400 }); }
        const cur = this.seq(); if (cur !== base) return Response.json({ error: "version conflict" }, { status: 409 });
        let rows = this.rows();
        for (const o of ops as { rowIdx: number; cols: Record<string, string> }[]) { while (rows.length <= o.rowIdx) rows.push({}); rows[o.rowIdx] = { ...rows[o.rowIdx], ...o.cols }; }
        let file: any = args.file ?? null; if (!file) { const r: any = s.exec("SELECT v FROM meta WHERE k='file'").toArray()[0]; file = r ? JSON.parse(r.v) : null; }
        if (file) { Object.assign(file, ldCounts(rows)); file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = String(args.action || "append"); if (args.dataCount !== undefined) file.dataCount = args.dataCount; }
        const newSeq = cur + 1; s.exec("UPDATE meta SET v=? WHERE k='seq'", String(newSeq)); s.exec("DELETE FROM rows"); rows.forEach((r, i) => s.exec("INSERT INTO rows(idx,data) VALUES(?,?)", i, JSON.stringify(r))); if (file) s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('file',?)", JSON.stringify(file)); s.exec("INSERT INTO logs(ts,action,seq) VALUES(?,?,?)", Date.now(), String(args.action || "append"), newSeq); s.exec("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)"); return Response.json({ ok: true, seq: newSeq, file, rows });
      }
      case "save": { const newSeq = this.seq() + 1; s.exec("UPDATE meta SET v=? WHERE k='seq'", String(newSeq)); if (Array.isArray(args.rows)) { s.exec("DELETE FROM rows"); (args.rows as Row[]).forEach((r, i) => s.exec("INSERT INTO rows(idx,data) VALUES(?,?)", i, JSON.stringify(r))); } if (args.file) s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('file',?)", JSON.stringify(args.file)); s.exec("INSERT INTO logs(ts,action,seq) VALUES(?,?,?)", Date.now(), String(args.action || "edit"), newSeq); s.exec("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)"); return Response.json({ ok: true, seq: newSeq, ...(Array.isArray(args.rows) ? { rows: args.rows } : {}) }); }
      case "getLogs": return Response.json(s.exec("SELECT id, ts, action, seq FROM logs ORDER BY id DESC LIMIT 200").toArray());
      case "wipe": { const rows = this.rows(); s.exec("DELETE FROM meta; DELETE FROM rows; DELETE FROM logs"); return Response.json({ ok: true, rows }); }
      default: return Response.json({ error: "unknown operation" }, { status: 400 });
    }
  }
}
