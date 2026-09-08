import { Hono } from "hono";
import type { Env, Row, SheetFile, FilePreset } from "../lib/shared";
import { requireAuth } from "../lib/session";
import { rpc } from "../lib/do";
import { classify as poolForRowWithPreset } from "../lib/pg";
import { checkRate, ipKey } from "../lib/rateLimit";

export const files = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
const fileId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
async function owned(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && !found.archived ? JSON.parse(found.data) as SheetFile : null; }
async function ownedArchived(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && found.archived ? JSON.parse(found.data) as SheetFile : null; }
const poolId = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
const normalizePreset = (v: unknown): FilePreset | undefined => { const s = String(v || "").toLowerCase(); if (s === "cookie") return "cookie"; if (s === "combo" || s === "2fa") return "combo"; if (s === "page") return "page"; return undefined; };
export const ldCounts = (rows: Row[]) => {
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
function resolvePreset(file: SheetFile): FilePreset | null {
  const p = normalizePreset((file as any).preset ?? (file as any).poolKind);
  if (p) return p;
  const name = String(file.name || "").toLowerCase();
  const hasCol = Array.isArray(file.columns) ? file.columns.some((c: any) => c.key === "twofakey") : null;
  if (hasCol === false) return "cookie";
  if (hasCol === true) {
    if (name.startsWith("page")) return "page";
    if (name.startsWith("2fa") || name.startsWith("combo")) return "combo";
    return "combo";
  }
  if (name.startsWith("cookie")) return "cookie";
  if (name.startsWith("2fa") || name.startsWith("combo")) return "combo";
  if (name.startsWith("page")) return "page";
  return null;
}
files.use("/*", requireAuth);
files.get("/", async (c) => c.json(await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid") })));
 files.post("/", async (c) => {
  if (!checkRate(ipKey(c, "files.create"), 20, 60000)) return c.json({ error: "rate limited" }, 429);
  const body = await c.req.json<Partial<SheetFile> & { rows?: Row[]; dataCount?: number }>(); const rows = Array.isArray(body.rows) ? body.rows : []; const rawPreset = (body as any).preset ?? (body as any).poolKind; let preset = normalizePreset(rawPreset); if (!preset) { const tmp: SheetFile = { id: "", name: String(body.name || "Untitled"), type: "fb_cookie", columns: Array.isArray(body.columns) ? body.columns as any : undefined } as SheetFile; preset = resolvePreset(tmp) ?? undefined; } const file: SheetFile = { id: fileId(), name: String(body.name || "Untitled"), type: body.type === "fb_cookie" ? "fb_cookie" : "fb_cookie", ...(preset ? { preset, poolKind: preset } : {}), password: String(body.password || "dgddigital"), poolEnabled: body.poolEnabled !== false, ...(Array.isArray(body.columns) ? { columns: body.columns } : {}), createdAt: Date.now(), updatedAt: Date.now(), rowCount: rows.length, dataCount: body.dataCount ?? 0, lastAction: "created" }; Object.assign(file, ldCounts(rows)); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); await rpc(c.env.FILES, file.id, "init", { file, rows }); if (rows.length) void feedPools(c.env, file, rows, c.get("uid")); return c.json(file); });
files.put("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<Record<string, unknown>>(); for (const k of ["name", "type", "columns", "password", "poolEnabled", "preset", "poolKind"]) if (k in body) (file as any)[k] = body[k]; if ("poolKind" in body && !("preset" in body)) (file as any).preset = (file as any).poolKind; const np = normalizePreset((file as any).preset ?? (file as any).poolKind); if (np) { (file as any).preset = np; (file as any).poolKind = np; } file.updatedAt = Date.now(); file.lastAction = "renamed"; await rpc(c.env.FILES, file.id, "save", { file }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); return c.json(file); });
 files.delete("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const oldRows = await rpc(c.env.FILES, file.id, "rows").catch(() => [] as Row[]) as Row[]; const held = await heldInRows(c, file, oldRows); if (held) return c.json(heldBlock(held), 409); file.deletedAt = Date.now(); file.lastAction = "archived"; await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: true, file }); return c.json({ ok: true }); });
files.get("/:id/rows", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const rows = await rpc(c.env.FILES, file.id, "rows") as Row[]; return c.json(await decorateHoldState(c.env, file.password, rows)); });
 files.get("/:id/full", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const full = await rpc(c.env.FILES, file.id, "full") as { rows: Row[]; seq: number }; return c.json({ file, rows: await decorateHoldState(c.env, file.password, full.rows), logs: [], undo: [], redo: [], seq: full.seq ?? 0 }); });
/** Overlay pool state onto rows so the owner's sheet colors them: _hold (amber), _approved (green), _dead (red). */
export async function decorateHoldState(env: Env, password: string | undefined, rows: Row[]): Promise<Row[]> {
  if (!password || !rows.length) return rows;
  const keys = [...new Set(rows.map((r) => poolId(r)).filter(Boolean))] as string[];
  if (!keys.length) return rows;
  const r: any = await rpc(env.POOLS, password, "holdState", { keys }).catch(() => null);
  const map = r?.map ?? {};
  for (const row of rows) {
    const s = map[poolId(row)] as { hold?: boolean; approved?: boolean; dead?: boolean } | undefined;
    if (!s) continue;
    if (s.dead) (row as any)._dead = true;
    else if (s.hold) (row as any)._hold = true;
    else if (s.approved) (row as any)._approved = true;
  }
  return rows;
}
async function feedPools(env: Env, file: SheetFile, rows: Row[], uid: string) { if (file.poolEnabled === false || !file.password) return; const preset = resolvePreset(file); await rpc(env.POOLS, file.password, "add", { rows, uid, srcUid: uid, srcFileId: file.id, preset, poolKind: preset }).catch((e: any) => console.error("pool feed failed", e?.message ?? e)); }
files.put("/:id/persist", async (c) => {
  if (!checkRate(ipKey(c, "files.persist"), 30, 60000)) return c.json({ error: "rate limited" }, 429);
  const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ rows?: Row[]; action?: string; dataCount?: number }>(); const rows = body.rows || []; const oldRows = await rpc(c.env.FILES, file.id, "rows").catch(() => [] as Row[]) as Row[]; const newKeys = new Set(rows.map((r) => poolId(r)).filter(Boolean)); const removed = oldRows.filter((r) => { const k = poolId(r); return k && !newKeys.has(k); }); const removedHeld = removed.length ? await heldInRows(c, file, removed) : 0; if (removedHeld) return c.json(heldBlock(removedHeld), 409); Object.assign(file, ldCounts(rows)); if (body.dataCount !== undefined) file.dataCount = body.dataCount; file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = "modified"; const saved = await rpc(c.env.FILES, file.id, "save", { file, rows, action: body.action || "edit" }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); void feedPools(c.env, file, rows, c.get("uid")); return c.json({ ok: true, seq: saved.seq, file }); });
files.put("/:id/append", async (c) => {
  if (!checkRate(ipKey(c, "files.append"), 30, 60000)) return c.json({ error: "rate limited" }, 429);
  const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ base: number; ops: { rowIdx: number; cols: Record<string, string> }[]; dataCount?: number; action?: string }>(); if (!Number.isInteger(body.base) || !Array.isArray(body.ops) || body.ops.length > 10000) return c.json({ error: "invalid append payload" }, 400);
  let saved: any; try { saved = await rpc(c.env.FILES, file.id, "append", { base: body.base, ops: body.ops, file, action: body.action || "append", dataCount: body.dataCount }); } catch (e: any) { if (String(e?.message ?? e).includes("409") || String(e?.message ?? e).includes("version conflict")) return c.json({ error: "version conflict" }, 409); throw e; }
  if (saved?.error) return c.json({ error: saved.error }, 400);
  const updated = saved.file ?? file; await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file: updated });
  const feedRows: Row[] = saved.rows ?? []; if (feedRows.length) void feedPools(c.env, updated, feedRows, c.get("uid")); else { const rows = await rpc(c.env.FILES, file.id, "rows").catch(() => [] as Row[]) as Row[]; if (rows.length) void feedPools(c.env, updated, rows, c.get("uid")); }
  return c.json({ ok: true, seq: saved.seq, file: updated }); });

// ── Archive (mounted at /api/archive) ──
export const archive = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
archive.use("/*", requireAuth);
// ponytail: permanently deleted rows stay in pools if claimed (matches backend taken-block); available rows are removed
async function removePoolRows(env: Env, password: string, rows: Row[], uid: string, file?: SheetFile | null) { const preset = file ? resolvePreset(file) : null; const byPool = new Map<string, Set<string>>(); rows.forEach((row) => { const pool = poolForRowWithPreset(row, preset); if (!pool) return; const key = poolId(row); if (key) (byPool.get(pool) || byPool.set(pool, new Set()).get(pool)!).add(key); }); await Promise.all([...byPool].map(([pool, keys]) => rpc(env.POOLS, password, "removeAvailable", { pool, keys: [...keys], uid, srcFileId: file?.id }).catch((e: any) => console.error("removeAvailable failed", pool, e?.message ?? e)))); }
async function purgeFile(env: Env, file: SheetFile, uid: string) { const wiped = await rpc(env.FILES, file.id, "wipe").catch(() => ({ rows: [] as Row[] })); await rpc(env.INDEX, "global", "purge", { id: file.id }); if (file.password) await removePoolRows(env, file.password, wiped.rows as Row[], uid, file); }

/** Count of the given rows currently ON HOLD in the pool (held rows are locked to the owner). */
async function heldInRows(c: any, file: SheetFile, rows: Row[]): Promise<number> {
  if (!file.password || !rows.length) return 0;
  const keys = [...new Set(rows.map((r) => poolId(r)).filter(Boolean))] as string[];
  if (!keys.length) return 0;
  const r = await rpc(c.env.POOLS, file.password, "heldCheck", { keys }).catch(() => ({ held: 0 })) as { held?: number };
  return Number(r.held || 0);
}
const heldBlock = (n: number) => ({ error: `${n} row(s) of this file are on hold for approval and cannot be deleted until they are approved or returned` });
archive.get("/", async (c) => c.json(await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 })));
archive.post("/:id/restore", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); delete (file as any).deletedAt; file.lastAction = "restored"; await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: false, file }); return c.json({ ok: true }); });
archive.post("/batch-restore", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 40) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const files = archived.filter((f) => ids.includes(f.id)); files.forEach((f) => { delete (f as any).deletedAt; f.lastAction = "restored"; }); if (files.length) await rpc(c.env.INDEX, "global", "batchArchive", { files }); return c.json({ restored: files.length }); });
 archive.delete("/:id", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); const wipedRows = await rpc(c.env.FILES, file.id, "rows").catch(() => [] as Row[]) as Row[]; const held = await heldInRows(c, file, wipedRows); if (held) return c.json(heldBlock(held), 409); await purgeFile(c.env, file, c.get("uid")); return c.json({ ok: true }); });
 archive.post("/batch-delete", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 20) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const owned = archived.filter((f) => ids.includes(f.id)); if (!owned.length) return c.json({ deleted: 0 }); for (const f of owned) { const rows = await rpc(c.env.FILES, f.id, "rows").catch(() => [] as Row[]) as Row[]; const held = await heldInRows(c, f, rows); if (held) return c.json({ error: `${f.name}: ${heldBlock(held).error}` }, 409); } const wiped = await Promise.all(owned.map((f) => rpc(c.env.FILES, f.id, "wipe").catch(() => ({ rows: [] as Row[] })))); await rpc(c.env.INDEX, "global", "batchPurge", { ids: owned.map((f) => f.id) });   await Promise.all(owned.map((f, i) => f.password ? removePoolRows(c.env, f.password, wiped[i].rows as Row[], c.get("uid"), f) : Promise.resolve())); return c.json({ deleted: owned.length }); });

// ── Cross-file duplicates (mounted at /api/cross-dups) ──
// ponytail: bounded projection via FileDO dupKeys; 50-subrequest cap ≈ 40 files/user
export const crossDups = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
crossDups.use("/*", requireAuth);
crossDups.get("/", async (c) => {
  if (!checkRate(ipKey(c, "crossdups"), 20, 60000)) return c.json({ error: "rate limited" }, 429);
  const uid = c.get("uid");
  const files = await rpc(c.env.INDEX, "global", "files", { uid }) as SheetFile[];
  const fileId = c.req.query("fileId") || null;
  const targetType = fileId ? files.find((f) => f.id === fileId)?.type ?? null : null;
  const counts: Record<string, number> = {};
  files.forEach((f) => { counts[f.id] = 0; });
  const allDups: Record<string, { fileId: string; fileName: string; rowIdx: number }[]> = {};
  const byType: Record<string, SheetFile[]> = {};
  for (const f of files) { (byType[f.type] ||= []).push(f); }
  const selected = Object.entries(byType).filter(([typeKey, tf]) => (!targetType || typeKey === targetType) && tf.length > 1).flatMap(([, tf]) => tf);
  if (selected.length > 40) return c.json({ error: "too many files" }, 400);
  for (const typeKey in byType) {
    if (targetType && typeKey !== targetType) continue;
    const tf = byType[typeKey];
    if (tf.length < 2) continue;
    const uidMap: Record<string, { fileId: string; fileName: string; rowIdx: number }[]> = {};
    const keysByFile = await Promise.all(tf.map((f) => rpc(c.env.FILES, f.id, "dupKeys", { limit: 10000 }) as Promise<{ k: string; i: number }[]>));
    keysByFile.forEach((keys, i) => keys.forEach(({ k, i: ri }) => { const dk = k; if (!dk) return; (uidMap[dk] ||= []).push({ fileId: tf[i].id, fileName: tf[i].name, rowIdx: ri }); }));
    for (const dk in uidMap) {
      if (uidMap[dk].length > 1) { allDups[dk] = uidMap[dk]; for (const e of uidMap[dk]) counts[e.fileId]++; }
    }
  }
  if (fileId) { const filtered: typeof allDups = {}; for (const dk in allDups) if (allDups[dk].some((e) => e.fileId === fileId)) filtered[dk] = allDups[dk]; return c.json({ counts, dups: filtered }); }
  return c.json({ counts, dups: {} });
});

export { owned };
