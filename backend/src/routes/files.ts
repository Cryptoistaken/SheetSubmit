import { Hono } from "hono";
import type { Env, Row, SheetFile, FilePreset } from "../lib/shared";
import { FILE_ROW_LIMIT } from "../lib/shared";
import { selectFeedRows } from "../lib/shared";
import { requireAuth, isAdmin } from "../lib/session";
import { rpc } from "../lib/do";
import { classify as poolForRowWithPreset } from "../lib/pg";

export const files = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
const fileId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
async function owned(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && !found.archived ? JSON.parse(found.data) as SheetFile : null; }
async function ownedArchived(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && found.archived ? JSON.parse(found.data) as SheetFile : null; }
const poolId = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
const normalizePreset = (v: unknown): FilePreset | undefined => { const s = String(v || "").toLowerCase(); if (s === "cookie") return "cookie"; if (s === "combo" || s === "2fa") return "combo"; if (s === "page") return "page"; return undefined; };
export function applyFileMeta(file: SheetFile, body: Record<string, unknown>): string | null { if ("type" in body) { if (body.type !== "fb_cookie") return "invalid file type"; (file as any).type = "fb_cookie"; } if ("name" in body) (file as any).name = String(body.name).slice(0, 128); if ("columns" in body) { const cols = body.columns; const ok = Array.isArray(cols) && cols.length <= 100 && (cols as unknown[]).every((e: any) => !!e && typeof e === "object" && !Array.isArray(e) && typeof e.key === "string" && e.key.length > 0 && e.key.length <= 64 && (e.label === undefined || (typeof e.label === "string" && e.label.length <= 64))); if (!ok) return "invalid columns"; (file as any).columns = cols; } if ("password" in body) { if (typeof body.password !== "string") return "invalid password"; const npw = (body.password as string).slice(0, 64); const prev = (file as any).password; if (prev && prev !== npw) return "password change not allowed - create a new file instead (pool rows are keyed by password)"; (file as any).password = npw; } if ("preset" in body || "poolKind" in body) { if ("preset" in body) { const p = normalizePreset(body.preset); if (!p) return "invalid preset"; (file as any).preset = p; } if ("poolKind" in body) { const p = normalizePreset(body.poolKind); if (!p) return "invalid preset"; (file as any).poolKind = p; if (!("preset" in body)) (file as any).preset = (file as any).poolKind; } } else { const np = normalizePreset((file as any).preset ?? (file as any).poolKind); if (np) { (file as any).preset = np; (file as any).poolKind = np; } } if ("poolEnabled" in body) { if (typeof body.poolEnabled !== "boolean") return "invalid poolEnabled"; (file as any).poolEnabled = body.poolEnabled; } return null; }
export const ldCounts = (rows: Row[]) => {
  let live = 0, dead = 0, page = 0;
  const keys = new Map<string, number>();
  for (const r of rows) {
    const s = String(r.status || "").toLowerCase();
    if (s === "good") live++; else if (s === "bad") dead++;
    if (String((r as any).check_status ?? (r as any).wa_status ?? "").toLowerCase() === "eligible") page++;
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
  const body = await c.req.json<Partial<SheetFile> & { rows?: Row[]; dataCount?: number }>(); const rows = Array.isArray(body.rows) ? body.rows : []; if (rows.length > FILE_ROW_LIMIT) return c.json({ error: "too many rows (max 500 per file)" }, 400); const name = String(body.name || "Untitled").slice(0, 128); if (Array.isArray(body.columns) && body.columns.length > 100) return c.json({ error: "too many columns" }, 400); const rawPreset = (body as any).preset ?? (body as any).poolKind; let preset = normalizePreset(rawPreset); if (!preset) { const tmp: SheetFile = { id: "", name, type: "fb_cookie", columns: Array.isArray(body.columns) ? body.columns as any : undefined } as SheetFile; preset = resolvePreset(tmp) ?? undefined; } const _pw = String(body.password || "dgddigital").slice(0, 64); const _pp = preset === "cookie" ? "cookies_only" : preset === "combo" ? "cookies_2fa" : "page"; const _fl: any = await rpc(c.env.INDEX, "global", "poolFlagsGet", {}).catch(() => null); if (_fl && _fl.combos?.[`${_pw}:${_pp}`] === false) return c.json({ error: "This file type or password is disabled by admin." }, 400); const file: SheetFile = { id: fileId(), name, type: body.type === "fb_cookie" ? "fb_cookie" : "fb_cookie", ...(preset ? { preset, poolKind: preset } : {}), password: String(body.password || "dgddigital").slice(0, 64), poolEnabled: true, ...(Array.isArray(body.columns) ? { columns: body.columns } : {}), createdAt: Date.now(), updatedAt: Date.now(), rowCount: rows.length, dataCount: body.dataCount ?? 0, lastAction: "created" }; Object.assign(file, ldCounts(rows)); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); await rpc(c.env.FILES, file.id, "init", { file, rows }); if (rows.length) await feedPools(c.env, file, rows, c.get("uid")); return c.json(file); });
files.put("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<Record<string, unknown>>(); if ("poolEnabled" in body && !isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403); const metaErr = applyFileMeta(file, body); if (metaErr) return c.json({ error: metaErr }, 400); file.updatedAt = Date.now(); file.lastAction = "renamed"; await rpc(c.env.FILES, file.id, "save", { file }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); if ((body as any).poolEnabled === false && (file as any).password) { try { const rows = await rpc(c.env.FILES, file.id, "rows").catch(() => [] as Row[]) as Row[]; await removePoolRows(c.env, (file as any).password, rows, c.get("uid"), file); } catch (e: any) { console.error("pool disable cleanup failed", file.id, e?.message ?? e); } } return c.json(file); });
 files.delete("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); let held = 0; try { held = (await filePoolCounts(c, file)).held; } catch { return c.json({ error: "could not verify hold state, refusing to delete" }, 503); } if (held) return c.json(heldBlock(held), 409); file.deletedAt = Date.now(); file.lastAction = "archived"; await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: true, file }); if (file.password) await removeFilePoolRows(c.env, file.password, file.id); return c.json({ ok: true }); });
files.get("/:id/rows", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const rows = await rpc(c.env.FILES, file.id, "rows") as Row[]; return c.json(await decorateHoldState(c.env, file.password, rows)); });
 files.get("/:id/full", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const full = await rpc(c.env.FILES, file.id, "full") as { rows: Row[]; seq: number }; return c.json({ file, rows: await decorateHoldState(c.env, file.password, full.rows), seq: full.seq ?? 0 }); });
/** Overlay flags for one row: dead rides along with hold/approved (a dead row
 * inside an approved hold keeps its red color AND the approved line — just
 * unpaid). Hold wins over approved when a key sits in both. */
export function applyHoldFlags(row: Row, s: { hold?: boolean; approved?: boolean; dead?: boolean } | undefined): void {
  if (!s) return;
  if (s.dead) (row as any)._dead = true;
  if (s.hold) (row as any)._hold = true;
  else if (s.approved) (row as any)._approved = true;
}
/** Overlay pool state onto rows so the owner's sheet colors them. */
export async function decorateHoldState(env: Env, password: string | undefined, rows: Row[]): Promise<Row[]> {
  if (!password || !rows.length) return rows;
  const keys = [...new Set(rows.map((r) => poolId(r)).filter(Boolean))] as string[];
  if (!keys.length) return rows;
  const r: any = await rpc(env.POOLS, password, "holdState", { keys }).catch(() => null);
  const map = r?.map ?? {};
  for (const row of rows) {
    applyHoldFlags(row, map[poolId(row)] as { hold?: boolean; approved?: boolean; dead?: boolean } | undefined);
  }
  return rows;
}
async function feedPools(env: Env, file: SheetFile, rows: Row[], uid: string) { if (file.poolEnabled === false || !file.password) return; const preset = resolvePreset(file); await rpc(env.POOLS, file.password, "add", { rows, uid, srcUid: uid, srcFileId: file.id, preset, poolKind: preset }).catch((e: any) => console.error("pool feed failed", e?.message ?? e)); }
export { feedPools };
files.put("/:id/persist", async (c) => {
  const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ rows?: Row[]; action?: string; dataCount?: number; base?: unknown }>(); const rows = body.rows || []; if (rows.length > FILE_ROW_LIMIT) return c.json({ error: "too many rows (max 500 per file)" }, 400); if (body.base !== undefined && !Number.isInteger(body.base)) return c.json({ error: "invalid base" }, 400); let oldRows: Row[]; try { oldRows = await rpc(c.env.FILES, file.id, "rows") as Row[]; } catch { return c.json({ error: "could not read file rows" }, 503); } const newKeys = new Set(rows.map((r) => poolId(r)).filter(Boolean)); const removed = oldRows.filter((r) => { const k = poolId(r); return k && !newKeys.has(k); }); let removedHeld = 0; if (removed.length) { try { removedHeld = await heldInRows(c, file, removed); } catch { return c.json({ error: "could not verify hold state" }, 503); } } if (removedHeld) return c.json(heldBlock(removedHeld), 409); Object.assign(file, ldCounts(rows)); if (body.dataCount !== undefined && Number.isInteger(body.dataCount) && body.dataCount >= 0 && body.dataCount <= rows.length) file.dataCount = body.dataCount; file.rowCount = rows.length; file.updatedAt = Date.now(); file.lastAction = "modified"; const act = typeof body.action === "string" ? body.action.replace(/[^a-z-]/gi, "").slice(0, 32) || "edit" : "edit"; const saved = await rpc(c.env.FILES, file.id, "save", { file, rows, action: act, base: body.base }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); const feed = act === "pool-enable" ? rows : selectFeedRows(oldRows, rows); if (feed.length) await feedPools(c.env, file, feed, c.get("uid")); return c.json({ ok: true, seq: saved.seq, file }); });
// Restore the previous structural snapshot (Fix 5: one rolling copy in meta KV).
// Same hold-lock rule as persist: currently-held rows missing from the snapshot block.
files.post("/:id/restore-snapshot", async (c) => {
  const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404);
  let index = 0;
  try {
    const b = await c.req.json<{ index?: unknown }>().catch(() => ({} as { index?: unknown }));
    if (b.index !== undefined) {
      if (!Number.isInteger(b.index) || (b.index as number) < 0) return c.json({ error: "invalid index" }, 400);
      index = b.index as number;
    }
  } catch { return c.json({ error: "invalid body" }, 400); }
  let snap: { rows: Row[]; seq: number; ts: number } | null;
  try { snap = await rpc(c.env.FILES, file.id, "snapGet") as any; } catch { return c.json({ error: "could not read snapshot" }, 503); }
  if (!snap) return c.json({ error: "no snapshot - nothing to restore yet" }, 404);
  let curRows: Row[]; try { curRows = await rpc(c.env.FILES, file.id, "rows") as Row[]; } catch { return c.json({ error: "could not read file rows" }, 503); }
  const snapKeys = new Set(snap.rows.map((r) => poolId(r)).filter(Boolean));
  const removed = curRows.filter((r) => { const k = poolId(r); return k && !snapKeys.has(k); });
  if (removed.length) { let h = 0; try { h = await heldInRows(c, file, removed); } catch { return c.json({ error: "could not verify hold state" }, 503); } if (h) return c.json(heldBlock(h), 409); }
  let out: any; try { out = await rpc(c.env.FILES, file.id, "snapRestore", { index }); } catch (e: any) { const m = String(e?.message || ""); if (m.includes("no snapshot")) return c.json({ error: "no snapshot - nothing to restore yet" }, 404); throw e; }
  await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file: out.file });
  if ((out.file as SheetFile)?.password) await feedPools(c.env, out.file, out.rows, c.get("uid"));
  return c.json({ ok: true, seq: out.seq, rows: out.rows, file: out.file });
});
files.put("/:id/append", async (c) => {
  const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ base: number; ops: { rowIdx: number; cols: Record<string, string> }[]; dataCount?: number; action?: string }>(); if (!Number.isInteger(body.base) || !Array.isArray(body.ops) || body.ops.length > 10000) return c.json({ error: "invalid append payload" }, 400); const opsOk = (body.ops as any[]).every((op: any) => !!op && typeof op === "object" && !Array.isArray(op) && Number.isInteger(op.rowIdx) && op.rowIdx >= 0 && op.rowIdx < 500 && !!op.cols && typeof op.cols === "object" && !Array.isArray(op.cols) && Object.entries(op.cols).every(([k, v]) => typeof k === "string" && k.length >= 1 && k.length <= 64 && (typeof v === "string" ? v.length <= 50000 : typeof v === "number"))); if (!opsOk) return c.json({ error: "invalid append payload" }, 400);
  let saved: any; try { saved = await rpc(c.env.FILES, file.id, "append", { base: body.base, ops: body.ops, file, action: body.action || "append", dataCount: body.dataCount }); } catch (e: any) { if (String(e?.message ?? e).includes("409") || String(e?.message ?? e).includes("version conflict")) return c.json({ error: "version conflict" }, 409); throw e; }
  if (saved?.error) return c.json({ error: saved.error }, 400);
  const updated = saved.file ?? file; await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file: updated });
  await feedPools(c.env, updated, saved.rows ?? [], c.get("uid"));
  return c.json({ ok: true, seq: saved.seq, file: updated }); });

// ── Archive (mounted at /api/archive) ──
export const archive = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
archive.use("/*", requireAuth);
// delete-time pool wipe for ONE file: every pool row sourced from it goes
// (available, held, claimed, dead) — only held rows block the delete itself.
async function removeFilePoolRows(env: Env, password: string, fileId: string) { await rpc(env.POOLS, password, "removeFileRows", { srcFileId: fileId }).catch((e: any) => console.error("removeFileRows failed", fileId, e?.message ?? e)); }
// pool-disable path: removes available rows only (key-based, per pool)
async function removePoolRows(env: Env, password: string, rows: Row[], uid: string, file?: SheetFile | null) { const preset = file ? resolvePreset(file) : null; const byPool = new Map<string, Set<string>>(); rows.forEach((row) => { const pool = poolForRowWithPreset(row, preset); if (!pool) return; const key = poolId(row); if (key) (byPool.get(pool) || byPool.set(pool, new Set()).get(pool)!).add(key); }); await Promise.all([...byPool].map(([pool, keys]) => rpc(env.POOLS, password, "removeAvailable", { pool, keys: [...keys], uid, srcFileId: file?.id }).catch((e: any) => console.error("removeAvailable failed", pool, e?.message ?? e)))); }
export { removePoolRows };
export { removeFilePoolRows };
async function purgeFile(env: Env, file: SheetFile, uid: string) { try { await rpc(env.FILES, file.id, "wipe", { uid }); } catch (e: any) { console.error("purge wipe failed", file.id, e?.message ?? e); throw new Error("could not wipe file"); } await rpc(env.INDEX, "global", "purge", { id: file.id }); if (file.password) await removeFilePoolRows(env, file.password, file.id); }

/** Count of the given rows currently ON HOLD in the pool (held rows are locked to the owner). Throws on DB error (fail-closed). */
async function heldInRows(c: any, file: SheetFile, rows: Row[]): Promise<number> {
  if (!file.password || !rows.length) return 0;
  const keys = [...new Set(rows.map((r) => poolId(r)).filter(Boolean))] as string[];
  if (!keys.length) return 0;
  const r = await rpc(c.env.POOLS, file.password, "heldCheck", { keys }) as { held?: number };
  return Number(r.held || 0);
}
const heldBlock = (n: number) => ({ error: `${n} row(s) of this file are on hold for approval and cannot be deleted until they are approved or returned` });
export { heldInRows, heldBlock, poolId };

/** Pool counts scoped to ONE file (src_file_id) — deletes use this instead of the key-based heldCheck so a hold on the same account from another file never blocks. Throws on DB error (fail-closed). */
async function filePoolCounts(c: any, file: SheetFile): Promise<{ held: number; claimed: number }> {
  if (!file.password || !file.id) return { held: 0, claimed: 0 };
  const r = await rpc(c.env.POOLS, file.password, "filePoolState", { srcFileId: file.id }) as { held?: number; claimed?: number };
  return { held: Number(r.held || 0), claimed: Number(r.claimed || 0) };
}
export { filePoolCounts };
archive.get("/", async (c) => c.json(await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 })));
// Read-only archived view (no restore needed): rows + full sheet for the
// in-app archived viewer. No hold overlay — pool rows are wiped on archive.
archive.get("/:id/rows", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); let rows: Row[]; try { rows = await rpc(c.env.FILES, file.id, "rows") as Row[]; } catch { return c.json({ error: "could not read file rows" }, 503); } return c.json(rows); });
archive.get("/:id/full", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); let full: { rows: Row[]; seq: number }; try { full = await rpc(c.env.FILES, file.id, "full") as { rows: Row[]; seq: number }; } catch { return c.json({ error: "could not read file rows" }, 503); } return c.json({ file, rows: full.rows ?? [], seq: full.seq ?? 0 }); });
archive.post("/:id/restore", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); let rows: Row[]; try { rows = await rpc(c.env.FILES, file.id, "rows") as Row[]; } catch { return c.json({ error: "could not read file rows" }, 503); } delete (file as any).deletedAt; file.lastAction = "restored"; await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: false, file }); if (rows.length) await feedPools(c.env, file, rows, c.get("uid")); return c.json({ ok: true }); });
archive.post("/batch-restore", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 40) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const files = archived.filter((f) => ids.includes(f.id)); const rowSets: Row[][] = []; for (const f of files) { try { rowSets.push(await rpc(c.env.FILES, f.id, "rows") as Row[]); } catch { return c.json({ error: `could not read rows for ${f.name}` }, 503); } } files.forEach((f) => { delete (f as any).deletedAt; f.lastAction = "restored"; }); if (files.length) await rpc(c.env.INDEX, "global", "batchArchive", { files }); for (let i = 0; i < files.length; i++) { if (rowSets[i].length) await feedPools(c.env, files[i], rowSets[i], c.get("uid")); } return c.json({ restored: files.length }); });
  archive.delete("/:id", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); let held = 0; try { held = (await filePoolCounts(c, file)).held; } catch { return c.json({ error: "could not verify hold state, refusing to delete" }, 503); } if (held) return c.json(heldBlock(held), 409); try { await purgeFile(c.env, file, c.get("uid")); } catch { return c.json({ error: "could not delete file" }, 503); } return c.json({ ok: true }); });
   archive.post("/batch-delete", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 40) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const owned = archived.filter((f) => ids.includes(f.id)); if (!owned.length) return c.json({ deleted: 0 }); for (const f of owned) { let held = 0; try { held = (await filePoolCounts(c, f)).held; } catch { return c.json({ error: `${f.name}: could not verify hold state` }, 503); } if (held) return c.json({ error: `${f.name}: ${heldBlock(held).error}` }, 409); } for (const f of owned) { try { await rpc(c.env.FILES, f.id, "wipe", { uid: c.get("uid") }); } catch { return c.json({ error: `could not wipe ${f.name}` }, 503); } } await rpc(c.env.INDEX, "global", "batchPurge", { ids: owned.map((f) => f.id) });   await Promise.all(owned.map((f) => f.password ? removeFilePoolRows(c.env, f.password, f.id) : Promise.resolve())); return c.json({ deleted: owned.length }); });

// ── Cross-file duplicates (mounted at /api/cross-dups) ──
// ponytail: ONE indexOp crossDups query (R2) — per-type file counts +
// key groups in SQL, no per-file fan-out. Semantics match the old fan-out
// exactly: only non-archived files; per file type, only types with >=2 files
// (single-file types skipped even with internal dupes); dup = key seen >1
// times in its type group; counts init 0 for ALL user files; ?fileId= picks
// the target type from that file and filters dups to keys touching it
// (counts NOT refiltered); without fileId dups is {}; no file-count cap (single SQL op).
export const crossDups = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
crossDups.use("/*", requireAuth);
crossDups.get("/", async (c) => {
  const uid = c.get("uid");
  const files = await rpc(c.env.INDEX, "global", "files", { uid }) as SheetFile[];
  const fileId = c.req.query("fileId") || null;
  const targetType = fileId ? files.find((f) => f.id === fileId)?.type ?? null : null;
  const counts: Record<string, number> = {};
  files.forEach((f) => { counts[f.id] = 0; });
  const allDups: Record<string, { fileId: string; fileName: string; rowIdx: number }[]> = {};
  const groups = await rpc(c.env.INDEX, "global", "crossDups", { uid, type: targetType }) as { k: string; entries: { fileId: string; fileName: string; rowIdx: number }[] }[];
  for (const { k, entries } of groups) {
    if (!k || !Array.isArray(entries) || !entries.length) continue;
    allDups[k] = entries;
    for (const e of entries) counts[e.fileId]++;
  }
  if (fileId) { const filtered: typeof allDups = {}; for (const dk in allDups) if (allDups[dk].some((e) => e.fileId === fileId)) filtered[dk] = allDups[dk]; return c.json({ counts, dups: filtered }); }
  return c.json({ counts, dups: {} });
});

export { owned };
