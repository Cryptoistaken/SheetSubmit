import type { Env, SheetFile, Row } from "../lib/shared";
import { isAdmin } from "../lib/session";
import { rpc } from "../lib/do";
type Op = { op: string; args?: any };
const WA_TTL = 86400000;
const waCacheKey = (uid: string, cuser: string) => `wa:${uid}:${cuser}`;
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
  let dup = 0;
  keys.forEach((c) => { if (c > 1) dup += c; });
  return { liveCount: live, deadCount: dead, pageCount: page, dupCount: dup };
};
const normalizePreset = (v: unknown): any => { const s = String(v || "").toLowerCase(); if (s === "cookie") return "cookie"; if (s === "combo" || s === "2fa") return "combo"; if (s === "page") return "page"; return undefined; };
const hasReal2FA = (r: Row) => { const v = String(r.twofakey ?? (r as any)["2fa key"] ?? "").trim(); return !!v && v !== "No_2Fa"; };
function resolvePreset(file: SheetFile): any {
  const p = normalizePreset((file as any).preset ?? (file as any).poolKind);
  if (p) return p;
  const name = String(file.name || "").toLowerCase();
  const hasCol = Array.isArray(file.columns) ? file.columns.some((c: any) => c.key === "twofakey") : null;
  if (hasCol === false) return "cookie";
  if (hasCol === true) { if (name.startsWith("page")) return "page"; if (name.startsWith("2fa") || name.startsWith("combo")) return "combo"; return "combo"; }
  if (name.startsWith("cookie")) return "cookie";
  if (name.startsWith("2fa") || name.startsWith("combo")) return "combo";
  if (name.startsWith("page")) return "page";
  return null;
}
const poolId = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
function poolForRowWithPreset(r: Row, preset: any): string | null {
  const c = String(r.cookies || "");
  if (!/c_user=\d+/.test(c) || !r.uid || ["bad", "dead"].includes(String(r.status || "").toLowerCase())) return null;
  const has2 = hasReal2FA(r);
  if (preset === "page") return has2 ? "page" : "cookies_only";
  if (preset === "combo") return has2 ? "cookies_2fa" : "cookies_only";
  if (preset === "cookie") return "cookies_only";
  if (String(r.wa_status || (r as any).waStatus || "") === "eligible" && has2) return "page";
  return has2 ? "cookies_2fa" : "cookies_only";
}
async function removePoolRows(env: Env, password: string, rows: Row[], uid: string, file?: SheetFile | null) {
  const preset = file ? resolvePreset(file) : null;
  const byPool = new Map<string, Set<string>>();
  rows.forEach((row) => { const pool = poolForRowWithPreset(row, preset); if (!pool) return; const key = poolId(row); if (key) (byPool.get(pool) || byPool.set(pool, new Set()).get(pool)!).add(key); });
  await Promise.all([...byPool].map(([pool, keys]) => rpc(env.POOLS, password, "removeAvailable", { pool, keys: [...keys], uid }).catch((e: any) => console.error("removeAvailable failed", pool, e?.message ?? e))));
}
const PASSWORDS = ["dgddigital", "L0VE@12345"];
const POOL_IDS = ["cookies_only", "cookies_2fa", "page"] as const;
const META: Record<string, { label: string; badge: string; cols: string[]; filename: string; rule: string }> = {
  cookies_only: { label: "Cookies", badge: "Cookies", cols: ["cookies"], filename: "cookies_pool.xlsx", rule: "cookies valid, 2FA empty" },
  cookies_2fa: { label: "2FA", badge: "2FA", cols: ["cookies", "twofakey"], filename: "2fa_pool.xlsx", rule: "cookies + 2FA key" },
  page: { label: "Page", badge: "Page", cols: ["cookies", "twofakey"], filename: "page_pool.xlsx", rule: 'cookies + 2FA + wa_status === "eligible"' },
};
const isPool = (v: string) => (POOL_IDS as readonly string[]).includes(v);
const summarize = (rows: any[]) => {
  const available = rows.filter((r) => r._state === "available").length;
  const claimedRows = rows.filter((r) => r._state === "claimed");
  const users = new Map<string, number>();
  for (const r of claimedRows) { const u = String(r._claimedBy || ""); if (u) users.set(u, (users.get(u) || 0) + 1); }
  return { available, claimed: claimedRows.length, users: [...users].map(([userId, claimed]) => ({ userId, displayName: userId, username: null, photoUrl: null, firstName: null, lastName: null, isAdmin: false, available: 0, claimed })) };
};
const DL_PASSWORDS = ["dgddigital", "L0VE@12345"];
const dlMeta = (m: any) => ({ id: m.id, at: m.ts, claimedBy: m.claimedBy, password: m.password, poolId: m.poolId || m.pool_id, claimed: m.claimed, filename: m.filename, reverted: !!m.reverted });
const photoUrl = (env: Env, uid: string) => `https://${env.WORKER_URL || ""}/api/auth/photo/${uid}`;
const shapeUser = (env: Env, u: any) => ({ id: String(u.user_id), name: u.name || "", username: u.username || "", photoUrl: photoUrl(env, String(u.user_id)), banned: !!u.banned, createdAt: u.created_at, fileCount: u.fileCount ?? 0, archivedCount: u.archivedCount ?? 0, isAdmin: isAdmin(env, String(u.user_id)) });
export class IndexDO {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) { state.blockConcurrencyWhile(async () => { const s = state.storage.sql; s.exec("CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, name TEXT, username TEXT, photo_url TEXT, banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS file_index (file_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, exp INTEGER NOT NULL)"); s.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)"); }); }
  async fetch(req: Request) {
    if ((req.headers.get("Upgrade") || "").toLowerCase() === "websocket") return this.wsUpgrade(req);
    let body: any; try { body = await req.json(); } catch { return Response.json({ error: "invalid json" }, { status: 400 }); }
    const op = body?.op; const args = body?.args ?? {};
    if (typeof op !== "string" || !op || op.length > 64) return Response.json({ error: "invalid op" }, { status: 400 });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return Response.json({ error: "invalid args" }, { status: 400 });
    const s = this.state.storage.sql; switch (op) {
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
    case "metaGetMany": { const keys = ((args.keys || []) as string[]).slice(0, 1000); const out: Record<string, any> = {}; if (keys.length) { const rows: any[] = s.exec(`SELECT k,v FROM meta WHERE k IN (${keys.map(() => "?").join(",")})`, ...keys).toArray(); for (const r of rows) out[r.k] = JSON.parse(r.v); } return Response.json(out); }
    case "metaDel": s.exec("DELETE FROM meta WHERE k=?", args.k); return Response.json({ ok: true });
    case "allFiles": return Response.json(s.exec("SELECT data,owner_id FROM file_index").toArray());
    case "stats": return Response.json({ totalUsers: Number(s.exec("SELECT COUNT(*) n FROM users").toArray()[0].n), totalFiles: Number(s.exec("SELECT COUNT(*) n FROM file_index WHERE archived=0").toArray()[0].n) });
    case "session": s.exec("INSERT OR REPLACE INTO sessions(token,user_id,exp) VALUES(?,?,?)", args.token, args.uid, args.exp); return Response.json({ ok: true });
    case "getSession": return Response.json(s.exec("SELECT * FROM sessions WHERE token=? AND exp>?", args.token, Date.now()).toArray()[0] || null);
    case "deleteSession": s.exec("DELETE FROM sessions WHERE token=?", args.token); return Response.json({ ok: true });
     case "deviceSet": { const current: any = s.exec("SELECT v FROM meta WHERE k=?", `device:${args.did}`).toArray()[0]; if (current) s.exec("DELETE FROM meta WHERE k=?", `deviceByChat:${JSON.parse(current.v).chatId}`); const previous: any = s.exec("SELECT v FROM meta WHERE k=?", `deviceByChat:${args.chatId}`).toArray()[0]; if (previous) s.exec("DELETE FROM meta WHERE k=?", `device:${JSON.parse(previous.v).did}`); s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `device:${args.did}`, JSON.stringify({ chatId: args.chatId })); s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `deviceByChat:${args.chatId}`, JSON.stringify({ did: args.did })); return Response.json({ ok: true }); }
    case "deviceGet": { const r: any = s.exec("SELECT v FROM meta WHERE k=?", `device:${args.did}`).toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
     case "deviceDelete": { const r: any = s.exec("SELECT v FROM meta WHERE k=?", `device:${args.did}`).toArray()[0]; if (r) s.exec("DELETE FROM meta WHERE k=?", `deviceByChat:${JSON.parse(r.v).chatId}`); s.exec("DELETE FROM meta WHERE k=?", `device:${args.did}`); return Response.json({ ok: true }); }
     case "deviceByChat": { const r: any = s.exec("SELECT v FROM meta WHERE k=?", `deviceByChat:${args.chatId}`).toArray()[0]; return Response.json(r ? JSON.parse(r.v) : null); }
     case "wsTicket": { const ticket = crypto.randomUUID().replaceAll("-", ""); s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `wsTicket:${ticket}`, JSON.stringify({ uid: args.uid ?? null, exp: Date.now() + 60000 })); return Response.json({ ticket }); }
    case "deviceSession": {
      const current: any = s.exec("SELECT v FROM meta WHERE k=?", `device:${args.did}`).toArray()[0]; if (current) s.exec("DELETE FROM meta WHERE k=?", `deviceByChat:${JSON.parse(current.v).chatId}`); const previous: any = s.exec("SELECT v FROM meta WHERE k=?", `deviceByChat:${args.chatId}`).toArray()[0]; if (previous) s.exec("DELETE FROM meta WHERE k=?", `device:${JSON.parse(previous.v).did}`); s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `device:${args.did}`, JSON.stringify({ chatId: args.chatId })); s.exec("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", `deviceByChat:${args.chatId}`, JSON.stringify({ did: args.did }));
      for (const ws of (this.state as any).getWebSockets() as WebSocket[]) { try { const att: any = (ws as any).deserializeAttachment() || {}; if (att.did === args.did) ws.send(JSON.stringify({ ev: "claimed", data: {} })); } catch {} }
      return Response.json({ ok: true });
    }
     default: return Response.json({ error: "unknown operation" }, { status: 400 });
   } }
  private wsUpgrade(req: Request): Response {
    const s = this.state.storage.sql;
    const ticket = new URL(req.url).searchParams.get("t") || "";
    const raw: any = s.exec("SELECT v FROM meta WHERE k=?", `wsTicket:${ticket}`).toArray()[0];
    if (!raw) return Response.json({ error: "invalid ticket" }, { status: 401 });
    s.exec("DELETE FROM meta WHERE k=?", `wsTicket:${ticket}`);
    const { uid, exp } = JSON.parse(raw.v) as { uid: string | null; exp: number };
    if (exp < Date.now()) return Response.json({ error: "invalid ticket" }, { status: 401 });
    const pair = new WebSocketPair();
    const version = req.headers.get("x-ws-version") || "";
    (this.state as any).acceptWebSocket(pair[1], [uid ?? "anon"]);
    (pair[1] as any).serializeAttachment({ uid: uid ?? null, did: null, version });
    try { pair[1].send(JSON.stringify({ ev: "health", data: { version } })); } catch {}
    return new Response(null, { status: 101, webSocket: pair[0] as any });
  }
  async webSocketMessage(ws: WebSocket, message: string) {
    let msg: any;
    try { msg = JSON.parse(typeof message === "string" ? message : String(message)); } catch { try { ws.send(JSON.stringify({ id: 0, ok: false, error: "bad message" })); } catch {} return; }
    const att: any = (() => { try { return (ws as any).deserializeAttachment() || {}; } catch { return {}; } })();
    const id = msg?.id;
    try {
      const data = await this.handleClientOp(ws, att, msg.op, msg.args ?? {});
      ws.send(JSON.stringify({ id, ok: true, data }));
    } catch (e: any) {
      ws.send(JSON.stringify({ id, ok: false, error: String(e?.message ?? e) }));
    }
  }
  webSocketClose(_ws: WebSocket) {}
  webSocketError(_ws: WebSocket) {}
  private async handleClientOp(ws: WebSocket, att: { uid: string | null; did: string | null; version?: string }, op: string, args: any): Promise<unknown> {
    const authed = !!att.uid;
    if (op !== "ping" && op !== "health" && op !== "claim.watch" && !authed) throw new Error("unauthorized");
    const s = this.state.storage.sql;
    const requireAdmin = () => { if (!isAdmin(this.env as any, att.uid!)) throw new Error("admin access required"); };
    switch (op) {
      case "ping": return { t: Date.now() };
      case "health": return { ok: true, ts: Date.now(), version: att.version || "" };
      case "claim.watch": {
        const did = String(args.did || "");
        if (!/^[A-Za-z0-9-]{8,64}$/.test(did)) throw new Error("bad did");
        (ws as any).serializeAttachment({ uid: att.uid ?? null, did, version: att.version || "" });
        return { ok: true };
      }
      case "files.list": return s.exec(`SELECT data FROM file_index WHERE owner_id=? AND archived=0`, att.uid!).toArray().map((r: any) => JSON.parse(r.data));
      case "file.full": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        const file = JSON.parse(row.data) as SheetFile; const full = await rpc(this.env.FILES, id, "full") as any; return { file, rows: full.rows, logs: [], undo: [], redo: [], seq: full.seq ?? 0 };
      }
      case "file.create": {
        const body: any = args.body || {};
        const rows: Row[] = Array.isArray(body.rows) ? body.rows : [];
        const rawPreset = body.preset ?? body.poolKind; let preset: any = normalizePreset(rawPreset);
        if (!preset) { const tmp: any = { id: "", name: String(body.name || "Untitled"), type: "fb_cookie", columns: Array.isArray(body.columns) ? body.columns : undefined }; preset = resolvePreset(tmp) ?? undefined; }
        const file: SheetFile = { id: crypto.randomUUID().replaceAll("-", "").slice(0, 12), name: String(body.name || "Untitled"), type: body.type === "fb_cookie" ? "fb_cookie" : "fb_cookie", ...(preset ? { preset, poolKind: preset } : {}), password: String(body.password || "dgddigital"), poolEnabled: body.poolEnabled !== false, ...(Array.isArray(body.columns) ? { columns: body.columns } : {}), createdAt: Date.now(), updatedAt: Date.now(), rowCount: rows.length, dataCount: body.dataCount ?? 0, lastAction: "created" } as any; Object.assign(file, ldCounts(rows));
        s.exec("INSERT OR REPLACE INTO file_index(file_id,owner_id,archived,data) VALUES(?,?,?,?)", file.id, att.uid!, 0, JSON.stringify(file));
        await rpc(this.env.FILES, file.id, "init", { file, rows });
        if (rows.length && (file as any).poolEnabled !== false && (file as any).password) { const preset2 = resolvePreset(file); await rpc(this.env.POOLS, (file as any).password, "add", { rows, uid: att.uid!, srcUid: att.uid!, srcFileId: file.id, preset: preset2, poolKind: preset2 }).catch((e: any) => console.error("pool add failed", e?.message ?? e)); }
        return file;
      }
      case "file.update": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        const file: any = JSON.parse(row.data); const body: any = args.data || {};
        for (const k of ["name", "type", "columns", "password", "poolEnabled", "preset", "poolKind"]) if (k in body) file[k] = body[k];
        if ("poolKind" in body && !("preset" in body)) file.preset = file.poolKind;
        const np = normalizePreset(file.preset ?? file.poolKind); if (np) { file.preset = np; file.poolKind = np; }
        file.updatedAt = Date.now(); file.lastAction = "renamed";
        const rows2 = await rpc(this.env.FILES, file.id, "rows") as Row[]; Object.assign(file, ldCounts(rows2));
        await rpc(this.env.FILES, file.id, "save", { file, rows: rows2 }); s.exec("INSERT OR REPLACE INTO file_index(file_id,owner_id,archived,data) VALUES(?,?,?,?)", file.id, att.uid!, 0, JSON.stringify(file));
        return file;
      }
      case "file.delete": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        const file: any = JSON.parse(row.data); file.deletedAt = Date.now(); file.lastAction = "archived"; s.exec("UPDATE file_index SET archived=?,data=? WHERE file_id=?", 1, JSON.stringify(file), id); return { ok: true };
      }
      case "file.rows": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        return await rpc(this.env.FILES, id, "rows");
      }
      case "file.persist": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        const file: any = JSON.parse(row.data); const payload: any = args.payload || {}; const rows: Row[] = payload.rows || []; Object.assign(file, ldCounts(rows)); if (payload.dataCount !== undefined) file.dataCount = payload.dataCount; file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = "modified";
        const saved: any = await rpc(this.env.FILES, id, "save", { file, rows, action: payload.action || "edit" }); s.exec("INSERT OR REPLACE INTO file_index(file_id,owner_id,archived,data) VALUES(?,?,?,?)", file.id, att.uid!, 0, JSON.stringify(file));
        if ((file as any).poolEnabled !== false && (file as any).password) { const preset = resolvePreset(file); await rpc(this.env.POOLS, file.password, "add", { rows, uid: att.uid!, srcUid: att.uid!, srcFileId: file.id, preset, poolKind: preset }).catch((e: any) => console.error("pool add failed", e?.message ?? e)); }
        return { ok: true, seq: saved.seq, file };
      }
      case "file.append": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || row.archived) throw new Error("file not found");
        const payload: any = args.payload || {}; if (!Number.isInteger(payload.base) || !Array.isArray(payload.ops) || payload.ops.length > 10000) throw new Error("invalid append payload");
        const file: any = JSON.parse(row.data);
        let saved: any;
        try { saved = await rpc(this.env.FILES, id, "append", { base: payload.base, ops: payload.ops, file, action: payload.action || "append", dataCount: payload.dataCount }); } catch (e: any) { if (String(e?.message ?? e).includes("409") || String(e?.message ?? e).includes("version conflict")) throw new Error("version conflict"); throw e; }
        if (saved?.error) throw new Error(saved.error);
        const updated = saved.file ?? file; s.exec("INSERT OR REPLACE INTO file_index(file_id,owner_id,archived,data) VALUES(?,?,?,?)", id, att.uid!, 0, JSON.stringify(updated));
        if ((updated as any).poolEnabled !== false && (updated as any).password) { const preset = resolvePreset(updated); const rows: Row[] = saved.rows ?? []; const feedRows = rows.length ? rows : await rpc(this.env.FILES, id, "rows").catch(() => []) as Row[]; await rpc(this.env.POOLS, (updated as any).password, "add", { rows: feedRows, uid: att.uid!, srcUid: att.uid!, srcFileId: id, preset, poolKind: preset }).catch((e: any) => console.error("pool add failed", e?.message ?? e)); }
        return { ok: true, seq: saved.seq, file: updated };
      }
      case "archive.list": return s.exec("SELECT data FROM file_index WHERE owner_id=? AND archived=1", att.uid!).toArray().map((r: any) => JSON.parse(r.data));
      case "archive.restore": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || !row.archived) throw new Error("not found");
        const file: any = JSON.parse(row.data); delete file.deletedAt; file.lastAction = "restored"; s.exec("UPDATE file_index SET archived=?,data=? WHERE file_id=?", 0, JSON.stringify(file), id); return { ok: true };
      }
      case "archive.delete": {
        const id = String(args.id || ""); const row: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", id).toArray()[0]; if (!row || row.owner_id !== att.uid! || !row.archived) throw new Error("not found");
        const file: any = JSON.parse(row.data); const wiped: any = await rpc(this.env.FILES, id, "wipe").catch(() => ({ rows: [] })); s.exec("DELETE FROM file_index WHERE file_id=?", id); if (file.password) await removePoolRows(this.env as any, file.password, wiped.rows as Row[], att.uid!, file); return { ok: true };
      }
      case "archive.batchRestore": {
        const ids: string[] = [...new Set(Array.isArray(args.ids) ? (args.ids as any[]).filter((x: any) => typeof x === "string") : [])] as string[]; if (!ids.length) throw new Error("no ids"); if (ids.length > 40) throw new Error("too many ids");
        const archived: any[] = s.exec("SELECT data FROM file_index WHERE owner_id=? AND archived=1", att.uid!).toArray().map((r: any) => JSON.parse(r.data)); const files = archived.filter((f) => ids.includes(f.id)); files.forEach((f) => { delete f.deletedAt; f.lastAction = "restored"; }); if (files.length) for (const file of files) s.exec("UPDATE file_index SET archived=0,data=? WHERE file_id=?", JSON.stringify(file), file.id); return { restored: files.length };
      }
      case "archive.batchDelete": {
        const ids: string[] = [...new Set(Array.isArray(args.ids) ? (args.ids as any[]).filter((x: any) => typeof x === "string") : [])] as string[]; if (!ids.length) throw new Error("no ids"); if (ids.length > 20) throw new Error("too many ids");
        const archived: SheetFile[] = s.exec("SELECT data FROM file_index WHERE owner_id=? AND archived=1", att.uid!).toArray().map((r: any) => JSON.parse(r.data)); const owned = archived.filter((f) => ids.includes(f.id)); if (!owned.length) return { deleted: 0 };
        const wiped = await Promise.all(owned.map((f) => rpc(this.env.FILES, f.id, "wipe").catch(() => ({ rows: [] as Row[] }))));
        for (const f of owned) s.exec("DELETE FROM file_index WHERE file_id=?", f.id);
        await Promise.all(owned.map((f, i) => f.password ? removePoolRows(this.env as any, f.password as string, (wiped[i] as any).rows as Row[], att.uid!, f) : Promise.resolve()));
        return { deleted: owned.length };
      }
      case "crossdups": {
        const fileIdQ = args.fileId ? String(args.fileId) : null;
        const files: SheetFile[] = s.exec("SELECT data FROM file_index WHERE owner_id=? AND archived=0", att.uid!).toArray().map((r: any) => JSON.parse(r.data));
        const targetType = fileIdQ ? files.find((f) => f.id === fileIdQ)?.type ?? null : null;
        const counts: Record<string, number> = {}; files.forEach((f) => { counts[f.id] = 0; });
        const allDups: Record<string, any> = {}; const byType: Record<string, SheetFile[]> = {};
        for (const f of files) (byType[f.type] ||= []).push(f);
        const selected = Object.entries(byType).filter(([typeKey, tf]) => (!targetType || typeKey === targetType) && tf.length > 1).flatMap(([, tf]) => tf);
        if (selected.length > 40) throw new Error("too many files");
        for (const typeKey in byType) {
          if (targetType && typeKey !== targetType) continue;
          const tf = byType[typeKey]; if (tf.length < 2) continue;
          const uidMap: Record<string, any[]> = {};
          const keysByFile = await Promise.all(tf.map((f) => rpc(this.env.FILES, f.id, "dupKeys", { limit: 10000 }) as Promise<{ k: string; i: number }[]>));
          keysByFile.forEach((keys, i) => keys.forEach(({ k, i: ri }) => { const dk = k; if (!dk) return; (uidMap[dk] ||= []).push({ fileId: tf[i].id, fileName: tf[i].name, rowIdx: ri }); }));
          for (const dk in uidMap) if (uidMap[dk].length > 1) { allDups[dk] = uidMap[dk]; for (const e of uidMap[dk]) counts[e.fileId]++; }
        }
        if (fileIdQ) { const filtered: any = {}; for (const dk in allDups) if (allDups[dk].some((e: any) => e.fileId === fileIdQ)) filtered[dk] = allDups[dk]; return { counts, dups: filtered }; }
        return { counts, dups: {} };
      }
      case "pools.list": {
        requireAdmin();
        const out = await Promise.all(PASSWORDS.flatMap((pwd) => POOL_IDS.map(async (pid) => {
          const st: any = await rpc(this.env.POOLS, pwd, "summary", { pool: pid }).catch(() => ({ available: 0, claimed: 0, users: 0 }));
          return { id: pid, ...META[pid], password: pwd, available: st.available, claimed: st.claimed, users: st.users };
        })));
        return { pools: out };
      }
      case "pool.detail": {
        requireAdmin(); const pwd = String(args.password || ""); const pid = String(args.poolId || args.pool || ""); if (!isPool(pid)) throw new Error("invalid poolId"); if (!pwd || pwd.length > 64) throw new Error("invalid password");
        const st: any = await rpc(this.env.POOLS, pwd, "summary", { pool: pid }).catch(() => ({ available: 0, claimed: 0, users: 0 }));
        const rows: any[] = await rpc(this.env.POOLS, pwd, "detail", { pool: pid }).catch(() => []) as any; const summ = summarize(rows);
        return { pool: { id: pid, ...META[pid] }, password: pwd, totals: { available: st.available, claimed: st.claimed, users: st.users }, users: summ.users };
      }
      case "pool.rows": {
        requireAdmin(); const pid = String(args.poolId || args.pool || ""); const pwd = String(args.password || ""); if (!isPool(pid)) throw new Error("invalid poolId"); if (!pwd || pwd.length > 64) throw new Error("invalid password");
        const limit = Math.min(1000, Math.max(1, Number(args.limit) || 100)); const offset = Math.max(0, Number(args.offset) || 0);
        const rawUser = String(args.userId || args.srcUid || ""); const rawFile = String(args.fileId || args.srcFileId || "");
        const verifiedOnly = !!args.verifiedOnly; const unverifiedOnly = !!args.unverifiedOnly;
        if (verifiedOnly && unverifiedOnly) throw new Error("verifiedOnly and unverifiedOnly are mutually exclusive");
        if ((verifiedOnly || unverifiedOnly) && pid !== "page") throw new Error("verified filters only for page pool");
        let rows: any[] = await rpc(this.env.POOLS, pwd, "detail", { pool: pid }) as any; rows = rows.filter((r) => r._state === "available");
        if (rawUser) rows = rows.filter((r) => String(r._srcUid || "") === rawUser);
        if (rawFile) rows = rows.filter((r) => String(r._srcFileId || "") === rawFile);
        if (verifiedOnly) rows = rows.filter((r) => String(r.wa_status || r.waStatus || "").toLowerCase() === "eligible");
        else if (unverifiedOnly) rows = rows.filter((r) => String(r.wa_status || r.waStatus || "").toLowerCase() !== "eligible");
        return { password: pwd, poolId: pid, total: rows.length, offset, limit, rows: rows.slice(offset, offset + limit) };
      }
      case "pool.ledger": { requireAdmin(); const pwd = String(args.password || ""); const pid = String(args.poolId || args.pool || ""); if (!isPool(pid)) throw new Error("invalid poolId"); return await rpc(this.env.POOLS, pwd, "ledger", { pool: pid }); }
      case "pool.claim": {
        requireAdmin(); const pid = String(args.poolId || args.pool || ""); const pwd = String(args.password || ""); if (!isPool(pid)) throw new Error("invalid poolId"); if (!pwd || pwd.length > 64) throw new Error("invalid password");
        const body: any = args.body || args; let count: any = body.count; if (count === undefined || count === null) count = 1; if (count !== "all" && (typeof count !== "number" || !Number.isFinite(count) || count < 1)) throw new Error("invalid count");
        if (typeof count === "number") count = Math.min(10000, Math.max(1, Math.floor(count)));
        const srcUidRaw = body.srcUid ?? body.claimForUser ?? body.userId ?? null; const srcFileIdRaw = body.srcFileId ?? body.fileId ?? null;
        if (srcUidRaw != null && (typeof srcUidRaw !== "string" || !srcUidRaw.trim() || srcUidRaw.length > 64)) throw new Error("invalid srcUid");
        if (srcFileIdRaw != null && (typeof srcFileIdRaw !== "string" || !srcFileIdRaw.trim() || srcFileIdRaw.length > 64)) throw new Error("invalid srcFileId");
        const verifiedOnly = !!body.verifiedOnly; const unverifiedOnly = !!body.unverifiedOnly;
        if (verifiedOnly && unverifiedOnly) throw new Error("verifiedOnly and unverifiedOnly are mutually exclusive");
        if ((verifiedOnly || unverifiedOnly) && pid !== "page") throw new Error("verified filters only for page pool");
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const filename = `${META[pid].label.toLowerCase().replace(/\s+/g, "_")}_${pwd.replace(/[^A-Za-z0-9_-]/g, "_")}_${new Date().toISOString().slice(0, 10)}_${id.slice(-4)}.xlsx`;
        const out: any = await rpc(this.env.POOLS, pwd, "claim", { pool: pid, uid: att.uid!, count, srcUid: srcUidRaw ? String(srcUidRaw) : null, srcFileId: srcFileIdRaw ? String(srcFileIdRaw) : null, claimForUser: srcUidRaw ? String(srcUidRaw) : null, verifiedOnly, unverifiedOnly, downloadId: id, filename });
        if (out?.error) throw new Error(out.error);
        return { password: pwd, poolId: pid, claimed: out.claimed, rows: out.rows, downloadId: out.downloadId, filename: out.filename };
      }
      case "pool.userFiles": { requireAdmin(); const pid = String(args.poolId || args.pool || ""); if (!isPool(pid)) throw new Error("invalid poolId"); return await rpc(this.env.POOLS, String(args.password || ""), "userFiles", { pool: pid }); }
      case "pool.verifiedCounts": { requireAdmin(); const pid = String(args.poolId || args.pool || ""); const pwd = String(args.password || ""); if (!isPool(pid)) throw new Error("invalid poolId"); if (!pwd || pwd.length > 64) throw new Error("invalid password"); return await rpc(this.env.POOLS, pwd, "verifiedCounts", { pool: pid }); }
      case "pool.downloads": { requireAdmin(); const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(this.env.POOLS, pwd, "downloads").catch(() => ({ downloads: [] })) as any)); const all = results.flatMap((r: any, i) => (r.downloads || []).map((d: any) => dlMeta({ ...d, password: DL_PASSWORDS[i] }))); all.sort((a, b) => b.at - a.at); return all.slice(0, 50); }
      case "pool.downloadDetail": {
        requireAdmin(); const id = String(args.id || ""); if (!id || id.length > 128) throw new Error("invalid id");
        const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(this.env.POOLS, pwd, "download", { id }).catch(() => null) as any));
        let d: any = null; for (let i = 0; i < results.length; i++) if (results[i]) { d = { ...results[i], password: DL_PASSWORDS[i] }; break; }
        if (!d) throw new Error("not found");
        const detail: any = await rpc(this.env.POOLS, d.password, "downloadDetail", { id: d.id }).catch(() => null); if (!detail) throw new Error("not found");
        return { ...dlMeta({ ...detail, password: d.password }), rows: detail.rows, keys: detail.keys, groups: detail.groups ?? [] };
      }
      case "pool.revertDownload": {
        requireAdmin(); const id = String(args.id || ""); const results = await Promise.all(DL_PASSWORDS.map((pwd) => rpc(this.env.POOLS, pwd, "download", { id }).catch(() => null) as any));
        let d: any = null; for (let i = 0; i < results.length; i++) if (results[i]) { d = { ...results[i], password: DL_PASSWORDS[i] }; break; }
        if (!d) throw new Error("not found"); return await rpc(this.env.POOLS, d.password, "revertDownload", { id: d.id, uid: att.uid! });
      }
      case "admin.stats": { requireAdmin(); return { totalUsers: Number(s.exec("SELECT COUNT(*) n FROM users").toArray()[0].n), totalFiles: Number(s.exec("SELECT COUNT(*) n FROM file_index WHERE archived=0").toArray()[0].n) }; }
      case "admin.users": { requireAdmin(); const rows = s.exec("SELECT * FROM users ORDER BY created_at DESC").toArray() as any[]; const counts = s.exec("SELECT owner_id, SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) fc, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) ac FROM file_index GROUP BY owner_id").toArray() as any[]; const byOwner = new Map(counts.map((r: any) => [r.owner_id, { fc: Number(r.fc), ac: Number(r.ac) }])); const users = rows.map((u) => ({ ...u, fileCount: byOwner.get(u.user_id)?.fc || 0, archivedCount: byOwner.get(u.user_id)?.ac || 0 })); return users.map((u) => shapeUser(this.env as any, u)); }
      case "admin.users.search": { requireAdmin(); const q = String(args.q || "").toLowerCase().trim(); const rows = s.exec("SELECT * FROM users ORDER BY created_at DESC").toArray() as any[]; const counts = s.exec("SELECT owner_id, SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) fc, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) ac FROM file_index GROUP BY owner_id").toArray() as any[]; const byOwner = new Map(counts.map((r: any) => [r.owner_id, { fc: Number(r.fc), ac: Number(r.ac) }])); const users = rows.map((u) => ({ ...u, fileCount: byOwner.get(u.user_id)?.fc || 0, archivedCount: byOwner.get(u.user_id)?.ac || 0 })); return users.filter((u) => !q || String(u.user_id).toLowerCase().includes(q) || String(u.name || "").toLowerCase().includes(q) || String(u.username || "").toLowerCase().includes(q)).map((u) => shapeUser(this.env as any, u)); }
      case "admin.user": { requireAdmin(); const uid = String(args.userId || ""); const rows = s.exec("SELECT * FROM users ORDER BY created_at DESC").toArray() as any[]; const counts = s.exec("SELECT owner_id, SUM(CASE WHEN archived=0 THEN 1 ELSE 0 END) fc, SUM(CASE WHEN archived=1 THEN 1 ELSE 0 END) ac FROM file_index GROUP BY owner_id").toArray() as any[]; const byOwner = new Map(counts.map((r: any) => [r.owner_id, { fc: Number(r.fc), ac: Number(r.ac) }])); const users = rows.map((u) => ({ ...u, fileCount: byOwner.get(u.user_id)?.fc || 0, archivedCount: byOwner.get(u.user_id)?.ac || 0 })); const u = users.find((x) => String(x.user_id) === uid); if (!u) throw new Error("user not found"); const files = s.exec("SELECT data FROM file_index WHERE owner_id=?", uid).toArray().map((r: any) => JSON.parse(r.data)); return { ...shapeUser(this.env as any, u), files }; }
      case "admin.user.archive": { requireAdmin(); const uid = String(args.userId || ""); return s.exec("SELECT data FROM file_index WHERE owner_id=? AND archived=1", uid).toArray().map((r: any) => JSON.parse(r.data)); }
      case "admin.user.archive.restore": { requireAdmin(); const uid = String(args.userId || ""); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found || found.owner_id !== uid || !found.archived) throw new Error("not found"); const file = JSON.parse(found.data); delete file.deletedAt; file.lastAction = "restored"; s.exec("UPDATE file_index SET archived=?,data=? WHERE file_id=?", 0, JSON.stringify(file), fid); return { ok: true }; }
      case "admin.user.archive.delete": { requireAdmin(); const uid = String(args.userId || ""); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data,owner_id,archived FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found || found.owner_id !== uid || !found.archived) throw new Error("not found"); s.exec("DELETE FROM file_index WHERE file_id=?", fid); await rpc(this.env.FILES, fid, "wipe").catch(() => {}); return { ok: true }; }
      case "admin.file": { requireAdmin(); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found) throw new Error("file not found"); return JSON.parse(found.data); }
      case "admin.file.update": {
        requireAdmin(); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data,owner_id FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found) throw new Error("file not found");
        const file: any = JSON.parse(found.data); const body: any = args.data || {}; for (const k of ["name", "type", "columns", "password", "poolEnabled"]) if (k in body) file[k] = body[k]; file.updatedAt = Date.now(); file.lastAction = "modified";
        await rpc(this.env.FILES, fid, "save", { file }); s.exec("UPDATE file_index SET data=? WHERE file_id=?", JSON.stringify(file), fid); return file;
      }
      case "admin.file.delete": { requireAdmin(); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found) throw new Error("file not found"); const file: any = JSON.parse(found.data); file.deletedAt = Date.now(); file.lastAction = "archived"; s.exec("UPDATE file_index SET archived=?,data=? WHERE file_id=?", 1, JSON.stringify(file), fid); return { ok: true }; }
      case "admin.file.rows": { requireAdmin(); return await rpc(this.env.FILES, String(args.fileId || ""), "rows"); }
      case "admin.file.persist": {
        requireAdmin(); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data,owner_id FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found) throw new Error("file not found");
        const file: any = JSON.parse(found.data); const payload: any = args.payload || {}; const rows: any[] = payload.rows || []; Object.assign(file, ldCounts(rows)); if (payload.dataCount !== undefined) file.dataCount = payload.dataCount; file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = "modified";
        const saved: any = await rpc(this.env.FILES, fid, "save", { file, rows, action: payload.action || "edit" }); s.exec("UPDATE file_index SET data=? WHERE file_id=?", JSON.stringify(file), fid); return { ok: true, seq: saved.seq, file };
      }
      case "admin.file.logs": { requireAdmin(); return await rpc(this.env.FILES, String(args.fileId || ""), "getLogs"); }
      case "admin.file.undo": { requireAdmin(); const fid = String(args.fileId || ""); const found: any = s.exec("SELECT data FROM file_index WHERE file_id=?", fid).toArray()[0]; if (!found) throw new Error("file not found"); return { undo: [], redo: [] }; }
      case "admin.user.delete": { requireAdmin(); const uid = String(args.userId || ""); const files: SheetFile[] = s.exec("SELECT data FROM file_index WHERE owner_id=?", uid).toArray().map((r: any) => JSON.parse(r.data)) as any; for (const f of files) await rpc(this.env.FILES, f.id, "wipe").catch(() => {}); s.exec("DELETE FROM users WHERE user_id=?", uid); s.exec("DELETE FROM file_index WHERE owner_id=?", uid); return { ok: true }; }
      case "admin.ban": { requireAdmin(); s.exec("UPDATE users SET banned=? WHERE user_id=?", 1, String(args.userId || "")); return { ok: true }; }
      case "admin.unban": { requireAdmin(); s.exec("UPDATE users SET banned=? WHERE user_id=?", 0, String(args.userId || "")); return { ok: true }; }
      case "wa.cache": {
        const uids: string[] = Array.isArray(args.uids) ? args.uids.map(String) : String(args.uids || "").split(",").map((s) => s.trim()).filter(Boolean);
        const limited = uids.filter(Boolean).slice(0, 1000);
        const uid = att.uid!;
        const keys = limited.map((u) => waCacheKey(uid, u));
        const raw: Record<string, any> = keys.length ? s.exec(`SELECT k,v FROM meta WHERE k IN (${keys.map(() => "?").join(",")})`, ...keys).toArray().reduce((acc: any, r: any) => { acc[r.k] = JSON.parse(r.v); return acc; }, {} as any) : {};
        const cache: Record<string, unknown> = {}; const stale: string[] = [];
        for (const u of limited) {
          const v = raw[waCacheKey(uid, u)];
          if (!v || v.status !== "eligible" || (v.ts && Date.now() - v.ts > WA_TTL)) { if (v) stale.push(u); continue; }
          cache[u] = { status: v.status ?? null, banReason: v.banReason ?? null, error: v.error ?? null, pageName: v.pageName ?? null, linkedNumber: v.linkedNumber ?? null, ts: v.ts ?? null };
        }
        for (const u of stale) s.exec("DELETE FROM meta WHERE k=?", waCacheKey(uid, u));
        return { cache };
      }
      default: throw new Error("unknown op");
    }
  }
}
