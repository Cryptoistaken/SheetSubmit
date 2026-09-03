import { Hono } from "hono";
import type { Env, Row, SheetFile } from "../lib/shared";
import { requireAuth } from "../lib/session";
import { rpc } from "../lib/do";

export const files = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
const fileId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 12);
async function owned(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && !found.archived ? JSON.parse(found.data) as SheetFile : null; }
async function ownedArchived(c: any, id: string) { const found = await rpc(c.env.INDEX, "global", "file", { id }); return found && found.owner_id === c.get("uid") && found.archived ? JSON.parse(found.data) as SheetFile : null; }
const poolId = (r: Row) => String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
files.use("/*", requireAuth);
files.get("/", async (c) => c.json(await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid") })));
files.post("/", async (c) => { const body = await c.req.json<Partial<SheetFile> & { rows?: Row[]; dataCount?: number }>(); const rows = Array.isArray(body.rows) ? body.rows : []; const file: SheetFile = { id: fileId(), name: String(body.name || "Untitled"), type: body.type === "fb_cookie" ? "fb_cookie" : "fb_cookie", password: String(body.password || "dgddigital"), poolEnabled: body.poolEnabled !== false, createdAt: Date.now(), updatedAt: Date.now(), rowCount: rows.length, dataCount: body.dataCount ?? 0 }; await Promise.all([rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }), rpc(c.env.FILES, file.id, "init", { file, rows })]); if (rows.length) c.executionCtx.waitUntil(feedPools(c.env, file, rows, c.get("uid"))); return c.json(file); });
files.put("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<Record<string, unknown>>(); for (const k of ["name", "type", "columns", "password", "poolEnabled"]) if (k in body) (file as any)[k] = body[k]; file.updatedAt = Date.now(); await rpc(c.env.FILES, file.id, "save", { file, rows: await rpc(c.env.FILES, file.id, "rows") }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); return c.json(file); });
files.delete("/:id", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); file.deletedAt = Date.now(); await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: true, file }); return c.json({ ok: true }); });
files.get("/:id/rows", async (c) => { const file = await owned(c, c.req.param("id")); return file ? c.json(await rpc(c.env.FILES, file.id, "rows")) : c.json({ error: "file not found" }, 404); });
files.get("/:id/full", async (c) => { const file = await owned(c, c.req.param("id")); return file ? c.json({ file, rows: await rpc(c.env.FILES, file.id, "rows"), logs: [], undo: [], redo: [], seq: (await rpc(c.env.FILES, file.id, "seq")).seq ?? 0 }) : c.json({ error: "file not found" }, 404); });
async function feedPools(env: Env, file: SheetFile, rows: Row[], uid: string) { if (file.poolEnabled === false || !file.password) return; await rpc(env.POOLS, file.password, "add", { rows, uid }).catch(() => {}); }
files.put("/:id/persist", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ rows?: Row[]; action?: string; dataCount?: number }>(); const rows = body.rows || []; if (body.dataCount !== undefined) file.dataCount = body.dataCount; file.rowCount = rows.length; file.updatedAt = Date.now(); const saved = await rpc(c.env.FILES, file.id, "save", { file, rows, action: body.action || "edit" }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); c.executionCtx.waitUntil(feedPools(c.env, file, rows, c.get("uid"))); return c.json({ ok: true, seq: saved.seq, file }); });
files.put("/:id/append", async (c) => { const file = await owned(c, c.req.param("id")); if (!file) return c.json({ error: "file not found" }, 404); const body = await c.req.json<{ base: number; ops: { rowIdx: number; cols: Record<string, string> }[]; dataCount?: number; action?: string }>(); if (!Number.isInteger(body.base) || !Array.isArray(body.ops) || body.ops.length > 10000) return c.json({ error: "invalid append payload" }, 400); const rows = await rpc(c.env.FILES, file.id, "rows") as Row[]; if (body.base !== (await rpc(c.env.FILES, file.id, "seq")).seq) return c.json({ error: "version conflict" }, 409); for (const op of body.ops) { while (rows.length <= op.rowIdx) rows.push({}); rows[op.rowIdx] = { ...rows[op.rowIdx], ...op.cols }; } file.rowCount = rows.length; file.updatedAt = Date.now(); const saved = await rpc(c.env.FILES, file.id, "save", { file, rows, action: body.action || "append" }); await rpc(c.env.INDEX, "global", "register", { uid: c.get("uid"), file }); c.executionCtx.waitUntil(feedPools(c.env, file, rows, c.get("uid"))); return c.json({ ok: true, seq: saved.seq, file }); });

// ── Archive (mounted at /api/archive) ──
export const archive = new Hono<{ Bindings: Env; Variables: { uid: string } }>();
archive.use("/*", requireAuth);
// ponytail: permanently deleted rows stay in pools if claimed (matches backend taken-block); available rows are removed
async function removePoolRows(env: Env, password: string, rows: Row[], uid: string) { const byPool = new Map<string, Set<string>>(); rows.forEach((row) => { const pool = row.twofakey || row["2fa key"] ? (String(row.wa_status || row.waStatus || "") === "eligible" ? "page" : "cookies_2fa") : "cookies_only"; const key = poolId(row); if (key) (byPool.get(pool) || byPool.set(pool, new Set()).get(pool)!).add(key); }); await Promise.all([...byPool].map(([pool, keys]) => rpc(env.POOLS, password, "removeAvailable", { pool, keys: [...keys], uid }).catch(() => {}))); }
async function purgeFile(env: Env, file: SheetFile, uid: string) { const wiped = await rpc(env.FILES, file.id, "wipe").catch(() => ({ rows: [] as Row[] })); await rpc(env.INDEX, "global", "purge", { id: file.id }); if (file.password) await removePoolRows(env, file.password, wiped.rows as Row[], uid); }
archive.get("/", async (c) => c.json(await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 })));
archive.post("/:id/restore", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); delete (file as any).deletedAt; await rpc(c.env.INDEX, "global", "archive", { id: file.id, archived: false, file }); return c.json({ ok: true }); });
archive.post("/batch-restore", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 40) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const files = archived.filter((f) => ids.includes(f.id)); files.forEach((f) => delete (f as any).deletedAt); if (files.length) await rpc(c.env.INDEX, "global", "batchArchive", { files }); return c.json({ restored: files.length }); });
archive.delete("/:id", async (c) => { const file = await ownedArchived(c, c.req.param("id")); if (!file) return c.json({ error: "not found" }, 404); await purgeFile(c.env, file, c.get("uid")); return c.json({ ok: true }); });
archive.post("/batch-delete", async (c) => { const body = await c.req.json<{ ids?: unknown }>().catch(() => ({ ids: undefined })); const ids = [...new Set(Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [])]; if (!ids.length) return c.json({ error: "no ids" }, 400); if (ids.length > 20) return c.json({ error: "too many ids" }, 400); const archived = await rpc(c.env.INDEX, "global", "files", { uid: c.get("uid"), archived: 1 }) as SheetFile[]; const owned = archived.filter((f) => ids.includes(f.id)); if (!owned.length) return c.json({ deleted: 0 }); const wiped = await Promise.all(owned.map((f) => rpc(c.env.FILES, f.id, "wipe").catch(() => ({ rows: [] as Row[] })))); await rpc(c.env.INDEX, "global", "batchPurge", { ids: owned.map((f) => f.id) }); await Promise.all(owned.map((f, i) => f.password ? removePoolRows(c.env, f.password, wiped[i].rows as Row[], c.get("uid")) : Promise.resolve())); return c.json({ deleted: owned.length }); });

// ── Cross-file duplicates (mounted at /api/cross-dups) ──
// ponytail: O(n·rows) scan with one rpc per file; 50-subrequest cap ≈ 45 files/user
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
  const byType: Record<string, SheetFile[]> = {};
  for (const f of files) { (byType[f.type] ||= []).push(f); }
  const selected = Object.entries(byType).filter(([typeKey, tf]) => (!targetType || typeKey === targetType) && tf.length > 1).flatMap(([, tf]) => tf);
  if (selected.length > 40) return c.json({ error: "too many files" }, 400);
  for (const typeKey in byType) {
    if (targetType && typeKey !== targetType) continue;
    const tf = byType[typeKey];
    if (tf.length < 2) continue;
    const uidMap: Record<string, { fileId: string; fileName: string; rowIdx: number }[]> = {};
    const rowsByFile = await Promise.all(tf.map((f) => rpc(c.env.FILES, f.id, "rows") as Promise<Row[]>));
    rowsByFile.forEach((rows, i) => rows.forEach((row, ri) => { const dk = poolId(row); if (!dk) return; (uidMap[dk] ||= []).push({ fileId: tf[i].id, fileName: tf[i].name, rowIdx: ri }); }));
    for (const dk in uidMap) {
      if (uidMap[dk].length > 1) { allDups[dk] = uidMap[dk]; for (const e of uidMap[dk]) counts[e.fileId]++; }
    }
  }
  if (fileId) { const filtered: typeof allDups = {}; for (const dk in allDups) if (allDups[dk].some((e) => e.fileId === fileId)) filtered[dk] = allDups[dk]; return c.json({ counts, dups: filtered }); }
  return c.json({ counts, dups: {} });
});

export { owned };
