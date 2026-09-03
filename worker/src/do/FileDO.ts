import type { Row, SheetFile } from "../lib/shared";
export class FileDO {
  constructor(private readonly state: DurableObjectState) { state.blockConcurrencyWhile(async () => { const s = state.storage.sql; s.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY,v TEXT NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS rows (idx INTEGER PRIMARY KEY,data TEXT NOT NULL)"); s.exec("INSERT OR IGNORE INTO meta(k,v) VALUES('seq','0')"); s.exec("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, action TEXT, seq INTEGER)"); }); }
  private rows() { return this.state.storage.sql.exec("SELECT idx,data FROM rows ORDER BY idx").toArray().map((r: any) => JSON.parse(r.data)) as Row[]; }
  private seq(): number { const r: any = this.state.storage.sql.exec("SELECT v FROM meta WHERE k='seq'").toArray()[0]; return r ? Number(r.v) : 0; }
  async fetch(req: Request): Promise<Response> { const { op, args = {} } = await req.json() as { op: string; args?: any }; const s = this.state.storage.sql; switch (op) {
     case "init": s.exec("DELETE FROM meta; DELETE FROM rows; DELETE FROM logs"); s.exec("INSERT INTO meta(k,v) VALUES('file',?)", JSON.stringify(args.file)); s.exec("INSERT INTO meta(k,v) VALUES('seq','0')"); (args.rows || []).forEach((r: Row, i: number) => s.exec("INSERT INTO rows(idx,data) VALUES(?,?)", i, JSON.stringify(r))); return Response.json({ ok: true });
    case "meta": { const r: any = s.exec("SELECT v FROM meta WHERE k='file'").toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
    case "seq": return Response.json({ seq: this.seq() });
    case "rows": return Response.json(this.rows());
     case "save": { const newSeq = this.seq() + 1; s.exec("UPDATE meta SET v=? WHERE k='seq'", String(newSeq)); s.exec("DELETE FROM rows"); (args.rows as Row[]).forEach((r, i) => s.exec("INSERT INTO rows(idx,data) VALUES(?,?)", i, JSON.stringify(r))); if (args.file) s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('file',?)", JSON.stringify(args.file)); s.exec("INSERT INTO logs(ts,action,seq) VALUES(?,?,?)", Date.now(), String(args.action || "edit"), newSeq); s.exec("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 200)"); return Response.json({ ok: true, seq: newSeq, rows: args.rows }); }
    case "getLogs": return Response.json(s.exec("SELECT id, ts, action, seq FROM logs ORDER BY id DESC LIMIT 200").toArray());
    case "wipe": { const rows = this.rows(); s.exec("DELETE FROM meta; DELETE FROM rows; DELETE FROM logs"); return Response.json({ ok: true, rows }); }
    default: return Response.json({ error: "unknown operation" }, { status: 400 });
  } }
}
