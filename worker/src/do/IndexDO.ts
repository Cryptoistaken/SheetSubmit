import type { Env, SheetFile } from "../lib/shared";
type Op = { op: string; args?: any };
export class IndexDO {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) { state.blockConcurrencyWhile(async () => { const s = state.storage.sql; s.exec("CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, name TEXT, username TEXT, photo_url TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS file_index (file_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, exp INTEGER NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); }); }
  async fetch(req: Request) { const { op, args = {} } = await req.json() as Op; const s = this.state.storage.sql; switch (op) {
    case "ensureUser": s.exec("INSERT INTO users(user_id,name,username,photo_url,created_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,username=excluded.username,photo_url=excluded.photo_url", args.id, args.name || "", args.username || "", args.photoUrl || null, Date.now()); return Response.json({ ok: true });
    case "user": return Response.json(s.exec("SELECT * FROM users WHERE user_id=?", args.id).toArray()[0] || null);
    case "users": return Response.json(s.exec("SELECT * FROM users ORDER BY created_at DESC").toArray());
    case "ban": s.exec("UPDATE users SET banned=? WHERE user_id=?", args.banned ? 1 : 0, args.id); return Response.json({ ok: true });
    case "register": s.exec("INSERT OR REPLACE INTO file_index(file_id,owner_id,archived,data) VALUES(?,?,?,?)", args.file.id, args.uid, 0, JSON.stringify(args.file)); return Response.json({ ok: true });
    case "file": return Response.json(s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", args.id).toArray()[0] || null);
    case "files": { const where = args.archived === "all" ? "" : args.archived === 1 ? " AND archived=1" : " AND archived=0"; return Response.json(s.exec(`SELECT data FROM file_index WHERE owner_id=?${where}`, args.uid).toArray().map((r: any) => JSON.parse(r.data))); }
    case "archive": s.exec("UPDATE file_index SET archived=?,data=? WHERE file_id=?", args.archived ? 1 : 0, JSON.stringify(args.file), args.id); return Response.json({ ok: true });
    case "batchArchive": for (const file of args.files as SheetFile[]) s.exec("UPDATE file_index SET archived=0,data=? WHERE file_id=?", JSON.stringify(file), file.id); return Response.json({ ok: true });
    case "purge": s.exec("DELETE FROM file_index WHERE file_id=?", args.id); return Response.json({ ok: true });
    case "batchPurge": for (const id of args.ids as string[]) s.exec("DELETE FROM file_index WHERE file_id=?", id); return Response.json({ ok: true });
    case "deleteUser": s.exec("DELETE FROM users WHERE user_id=?", args.id); s.exec("DELETE FROM file_index WHERE owner_id=?", args.id); return Response.json({ ok: true });
    case "adminUsers": { const rows = s.exec("SELECT * FROM users ORDER BY created_at DESC").toArray() as any[]; const counts = s.exec("SELECT owner_id, SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) fc, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) ac FROM file_index GROUP BY owner_id").toArray() as any[]; const byOwner = new Map(counts.map((r: any) => [r.owner_id, { fc: Number(r.fc), ac: Number(r.ac) }])); return Response.json(rows.map((u) => ({ ...u, fileCount: byOwner.get(u.user_id)?.fc || 0, archivedCount: byOwner.get(u.user_id)?.ac || 0 }))); }
    case "metaSet": s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", args.k, JSON.stringify(args.v)); return Response.json({ ok: true });
    case "metaGet": { const r: any = s.exec("SELECT v FROM meta WHERE k=?", args.k).toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
    case "metaDel": s.exec("DELETE FROM meta WHERE k=?", args.k); return Response.json({ ok: true });
    case "allFiles": return Response.json(s.exec("SELECT data,owner_id FROM file_index").toArray());
    case "stats": return Response.json({ totalUsers: Number(s.exec("SELECT COUNT(*) n FROM users").toArray()[0].n), totalFiles: Number(s.exec("SELECT COUNT(*) n FROM file_index WHERE archived=0").toArray()[0].n) });
    case "session": s.exec("INSERT OR REPLACE INTO sessions(token,user_id,exp) VALUES(?,?,?)", args.token, args.uid, args.exp); return Response.json({ ok: true });
    case "getSession": return Response.json(s.exec("SELECT * FROM sessions WHERE token=? AND exp>?", args.token, Date.now()).toArray()[0] || null);
    case "deleteSession": s.exec("DELETE FROM sessions WHERE token=?", args.token); return Response.json({ ok: true });
    case "deviceSet": s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `device:${args.did}`, JSON.stringify({ chatId: args.chatId })); return Response.json({ ok: true });
    case "deviceGet": { const r: any = s.exec("SELECT v FROM meta WHERE k=?", `device:${args.did}`).toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
    case "deviceDelete": s.exec("DELETE FROM meta WHERE k=?", `device:${args.did}`); return Response.json({ ok: true });
    case "deviceByChat": { const r: any = s.exec("SELECT k,v FROM meta WHERE k LIKE 'device:%'").toArray().find((x: any) => JSON.parse(x.v).chatId === String(args.chatId)); return Response.json(r ? { did: r.k.slice(7) } : null); }
    default: return Response.json({ error: "unknown operation" }, { status: 400 });
  } }
}
