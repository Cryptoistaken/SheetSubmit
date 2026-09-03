// Admin routes — ported from the old server (API contract unchanged).
import { Router } from "express";
import { BACKEND_PUBLIC_URL } from "../config/env";
import type { Row, StoredFile } from "../lib/shared";
import { MUTABLE_FILE_FIELDS } from "../lib/shared";
import { createForkFile, updateUserFilesAtomic } from "../services/files";
import {
  delHistoryKeys,
  deleteFilesHistory,
  getHistoryMeta,
  histMetaKey,
  materializeVersion,
  pruneHistory,
  snapshotHistory,
} from "../services/history";
import { delKey, getJSON, key, redis, setJSON } from "../services/redis";
import {
  findAllUserIds,
  findFileAcrossUsers,
  invalidateBanCache,
  invalidateSession,
  isAdmin,
  migrateListKey,
  requireAdmin,
  requireAuth,
} from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";

export const adminRouter = Router();

// ── Stats ──
adminRouter.get("/stats", requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  try {
    const userIds = await findAllUserIds();
    const totalUsers = userIds.length;
    let totalFiles = 0;
    if (userIds.length > 0) {
      const p = redis.pipeline();
      userIds.forEach((id) => p.get(key("files:" + id)));
      const results = (await p.exec()) || [];
      results.forEach((r) => {
        if (r[1]) {
          try {
            const files = JSON.parse(r[1] as string);
            if (Array.isArray(files)) totalFiles += files.length;
          } catch {
            // ignore
          }
        }
      });
    }
    res.json({ totalUsers, totalFiles });
  } catch (e) {
    console.error("[Admin Stats] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to get stats" });
  }
}));

// ── Users ──
adminRouter.get("/users", requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  try {
    const userIds = await findAllUserIds();
    const users: Record<string, any>[] = [];
    if (userIds.length > 0) {
      const p = redis.pipeline();
      userIds.forEach((id) => {
        p.get(key("user:" + id));
        p.get(key("files:" + id));
        p.get(key("archive:" + id));
        p.get(key("ban:" + id));
      });
      const results = (await p.exec()) || [];
      for (let i = 0; i < userIds.length; i++) {
        const userData = results[i * 4][1];
        if (!userData) continue;
        let user: Record<string, any>;
        try {
          user = JSON.parse(userData as string);
        } catch (e) {
          console.log("[Admin Users] parse error for", userIds[i]);
          continue;
        }
        const filesData = results[i * 4 + 1][1];
        const files = filesData ? (() => {
          try {
            return JSON.parse(filesData as string);
          } catch {
            return [];
          }
        })() : [];
        const archivedData = results[i * 4 + 2][1];
        const archived = archivedData ? (() => {
          try {
            return JSON.parse(archivedData as string);
          } catch {
            return [];
          }
        })() : [];
        const banData = results[i * 4 + 3][1];
        user.fileCount = files.length;
        user.archivedCount = archived.length;
        user.banned = !!banData;
        user.isAdmin = isAdmin(String(user.id));
        user.photoUrl = user.fileId ? (BACKEND_PUBLIC_URL || "") + "/api/auth/photo/" + user.id : null;
        users.push(user);
      }
    }
    users.sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
    console.log("[Admin Users] returning " + users.length + " users");
    res.json(users);
  } catch (e) {
    console.error("[Admin Users] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to get users" });
  }
}));

adminRouter.get("/users/search", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    const userIds = await findAllUserIds();
    const users: Record<string, any>[] = [];
    if (userIds.length > 0) {
      const p = redis.pipeline();
      userIds.forEach((id) => {
        p.get(key("user:" + id));
        p.get(key("files:" + id));
        p.get(key("ban:" + id));
      });
      const results = (await p.exec()) || [];
      for (let i = 0; i < userIds.length; i++) {
        const userData = results[i * 3][1];
        if (!userData) continue;
        let user: Record<string, any>;
        try {
          user = JSON.parse(userData as string);
        } catch {
          continue;
        }
        if (q) {
          const name = ((user.firstName || "") + " " + (user.lastName || "")).toLowerCase();
          const uname = (user.username || "").toLowerCase();
          const uid = String(user.id);
          if (name.indexOf(q) === -1 && uname.indexOf(q) === -1 && uid.indexOf(q) === -1) continue;
        }
        const filesData = results[i * 3 + 1][1];
        const files = filesData ? (() => {
          try {
            return JSON.parse(filesData as string);
          } catch {
            return [];
          }
        })() : [];
        const banData = results[i * 3 + 2][1];
        user.fileCount = files.length;
        user.banned = !!banData;
        user.isAdmin = isAdmin(String(user.id));
        user.photoUrl = user.fileId ? (BACKEND_PUBLIC_URL || "") + "/api/auth/photo/" + user.id : null;
        users.push(user);
      }
    }
    users.sort((a, b) => (b.lastLogin || 0) - (a.lastLogin || 0));
    res.json(users);
  } catch (e) {
    console.error("[Admin Search] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to search users" });
  }
}));

adminRouter.get("/user/:userId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const user = await getJSON<Record<string, any>>("user:" + req.params.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  const files = (await getJSON<StoredFile[]>("files:" + req.params.userId)) || [];
  const archived = (await getJSON<StoredFile[]>("archive:" + req.params.userId)) || [];
  user.photoUrl = user.fileId ? (BACKEND_PUBLIC_URL || "") + "/api/auth/photo/" + user.id : null;
  user.fileCount = files.length;
  user.archivedCount = archived.length;
  user.banned = !!(await getJSON("ban:" + req.params.userId));
  user.isAdmin = isAdmin(String(user.id));
  user.files = files;
  res.json(user);
}));

adminRouter.get("/user/:userId/archive", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const archived = (await getJSON<StoredFile[]>("archive:" + req.params.userId)) || [];
  res.json(archived);
}));

adminRouter.post("/user/:userId/archive/:fileId/restore", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const archived = (await getJSON<StoredFile[]>("archive:" + req.params.userId)) || [];
  const idx = archived.findIndex((f) => f.id === req.params.fileId);
  if (idx === -1) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const file = archived.splice(idx, 1)[0];
  delete file.deletedAt;
  const restored = await updateUserFilesAtomic(req.params.userId, (files) => {
    files.unshift(file);
    return files;
  });
  if (restored === null) {
    archived.splice(idx, 0, file);
    res.status(409).json({ error: "Conflict restoring file" });
    return;
  }
  await setJSON("archive:" + req.params.userId, archived);
  res.json({ ok: true });
}));

adminRouter.delete("/user/:userId/archive/:fileId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const archived = (await getJSON<StoredFile[]>("archive:" + req.params.userId)) || [];
  const idx = archived.findIndex((f) => f.id === req.params.fileId);
  if (idx === -1) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const file = archived.splice(idx, 1)[0];
  await setJSON("archive:" + req.params.userId, archived);
  const { removeFileRowsFromPools } = await import("../services/pools");
  void removeFileRowsFromPools(file as unknown as import("../lib/shared").StoredFile, req.params.userId).catch(()=>{});
  await redis.pipeline()
    .del(key("rows:" + file.id))
    .del(key("undo:" + file.id))
    .del(key("redo:" + file.id))
    .del(key("sync:" + file.id))
    .del(key("logs:" + file.id))
    .exec();
  await delHistoryKeys(file.id);
  res.json({ ok: true });
}));

// ── Cross-user file ops ──
adminRouter.get("/file/:fileId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    res.json(found.file);
  } catch (e) {
    console.error("[Admin Get File] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to get file" });
  }
}));

adminRouter.put("/file/:fileId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const updates = req.body as Record<string, unknown>;
    const updated = await updateUserFilesAtomic(found.userId, (files) => {
      const idx = files.findIndex((f) => f.id === req.params.fileId);
      if (idx === -1) return null;
      const target = files[idx] as Record<string, unknown>;
      MUTABLE_FILE_FIELDS.forEach((k) => {
        if (updates[k] !== undefined) target[k] = updates[k];
      });
      files[idx].updatedAt = Date.now();
      return files[idx];
    });
    if (updated === null) { res.status(500).json({ error: "Conflict saving files" }); return; }
    res.json(updated);
  } catch (e) {
    console.error("[Admin Update File] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to update file" });
  }
}));

adminRouter.delete("/file/:fileId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const file = await updateUserFilesAtomic(found.userId, (files) => {
      const idx = files.findIndex((f) => f.id === req.params.fileId);
      if (idx === -1) return null;
      return files.splice(idx, 1)[0];
    });
    if (file === null) {
      res.status(500).json({ error: "Conflict saving files" });
      return;
    }
    file.deletedAt = Date.now();
    const archived = (await getJSON<StoredFile[]>("archive:" + found.userId)) || [];
    archived.unshift(file);
    await setJSON("archive:" + found.userId, archived);
    res.json({ ok: true });
  } catch (e) {
    console.error("[Admin Delete File] error:", (e as Error).message);
    res.status(500).json({ error: "Failed to delete file" });
  }
}));

adminRouter.get("/file/:fileId/rows", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const rows = await getJSON<Row[]>("rows:" + req.params.fileId);
  res.json(rows || []);
}));

adminRouter.get("/file/:fileId/undo", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const found = await findFileAcrossUsers(req.params.fileId);
  if (!found) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  const parseList = (arr: string[]): unknown[] =>
    arr.map((l) => {
      try { return JSON.parse(l); } catch { return l; }
    });
  const undoKey = key("undo:" + req.params.fileId);
  const redoKey = key("redo:" + req.params.fileId);
  await migrateListKey(undoKey);
  await migrateListKey(redoKey);
  res.json({
    undo: parseList(await redis.lrange(undoKey, 0, -1)),
    redo: parseList(await redis.lrange(redoKey, 0, -1)),
  });
}));

adminRouter.get("/file/:fileId/history", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const meta = await getHistoryMeta(req.params.fileId);
    console.log("[Hist] admin list file=" + req.params.fileId + " versions=" + meta.length);
    res.json(meta);
  } catch (e) {
    console.error("[Hist] admin list error file=" + req.params.fileId + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to read history" });
  }
}));

adminRouter.get("/file/:fileId/history/:v", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.fileId, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const meta = await getHistoryMeta(req.params.fileId);
    const rec = meta.find((m) => m.v === v);
    console.log("[Hist] admin materialize file=" + req.params.fileId + " v" + v + " rows=" + rows.length);
    res.json({ v, rows, action: rec ? rec.action : null, ts: rec ? rec.ts : null });
  } catch (e) {
    console.error("[Hist] admin materialize error file=" + req.params.fileId + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to read version" });
  }
}));

adminRouter.post("/file/:fileId/history/:v/restore", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.fileId, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const curRows = await getJSON<Row[]>("rows:" + req.params.fileId);
    const snapV = await snapshotHistory(req.params.fileId, "restore", curRows || []);
    if (snapV === null) {
      res.status(500).json({ error: "Failed to snapshot current state before restore" });
      return;
    }
    await setJSON("rows:" + req.params.fileId, rows);
    if (found.userId) {
      const bumped = await updateUserFilesAtomic(found.userId, (files) => {
        const idx = files.findIndex((f) => f.id === req.params.fileId);
        if (idx === -1) return null;
        files[idx].updatedAt = Date.now();
        return files[idx];
      });
      if (bumped === null) { res.status(500).json({ error: "Conflict saving files" }); return; }
    }
    console.log("[Hist] admin restore file=" + req.params.fileId + " v" + v + " rows=" + rows.length);
    res.json({ ok: true, v, rows });
  } catch (e) {
    console.error("[Hist] admin restore error file=" + req.params.fileId + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to restore version" });
  }
}));

adminRouter.post("/file/:fileId/history/:v/name", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const meta = (await getJSON<{ v: number; name: string | null }[]>(histMetaKey(req.params.fileId))) || [];
    let rec: { v: number; name: string | null } | null = null;
    for (let i = 0; i < meta.length; i++) {
      if (meta[i].v === v) {
        rec = meta[i];
        break;
      }
    }
    if (!rec) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    rec.name = String((req.body as { name?: unknown }).name || "");
    await setJSON(histMetaKey(req.params.fileId), meta);
    console.log("[Hist] admin name file=" + req.params.fileId + " v" + v + " name=\"" + rec.name + "\"");
    res.json({ ok: true, meta });
  } catch (e) {
    console.error("[Hist] admin name error file=" + req.params.fileId + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to name version" });
  }
}));

adminRouter.post("/file/:fileId/history/:v/fork", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const found = await findFileAcrossUsers(req.params.fileId);
    if (!found) {
      res.status(404).json({ error: "file not found" });
      return;
    }
    const v = parseInt(req.params.v, 10);
    if (isNaN(v)) {
      res.status(400).json({ error: "invalid version" });
      return;
    }
    const rows = await materializeVersion(req.params.fileId, v);
    if (rows === null) {
      res.status(404).json({ error: "version not found" });
      return;
    }
    const file = await createForkFile(found.file, rows, req.userId || "");
    console.log("[Hist] admin fork file=" + req.params.fileId + " v" + v + " → " + file.id + " rows=" + rows.length);
    res.json({ ok: true, file, rows });
  } catch (e) {
    console.error("[Hist] admin fork error file=" + req.params.fileId + ":", (e as Error).message);
    res.status(500).json({ error: "Failed to fork version" });
  }
}));

adminRouter.put("/file/:fileId/persist", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const found = await findFileAcrossUsers(req.params.fileId);
  if (!found) { res.status(404).json({ error: "file not found" }); return; }
  const body = req.body as {
    rows?: Row[];
    action?: string;
    logs?: unknown[];
    undo?: unknown[];
    redo?: unknown[];
    dataCount?: number;
    userId?: string;
  };
  await migrateListKey(key("undo:" + req.params.fileId));
  await migrateListKey(key("redo:" + req.params.fileId));
  const seqRaw = await redis.get(key("seq:" + req.params.fileId));
  const curSeq = seqRaw ? parseInt(seqRaw, 10) : 0;
  const newSeq = (isNaN(curSeq) ? 0 : curSeq) + 1;
  const pipeline = redis.pipeline();
  if (body.rows !== undefined) {
    if (body.action) {
      const curRows = await getJSON<Row[]>("rows:" + req.params.fileId);
      if (curRows === null || curRows.length === 0) {
        await snapshotHistory(req.params.fileId, body.action, body.rows);
      } else {
        await snapshotHistory(req.params.fileId, body.action, curRows);
      }
      void pruneHistory(req.params.fileId);
    }
    pipeline.set(key("rows:" + req.params.fileId), JSON.stringify(body.rows));
  }
  pipeline.set(key("seq:" + req.params.fileId), String(newSeq));
  pipeline.set(key("meta:dirty"), String(Date.now()));
  if (found.userId) pipeline.del(key("crossdups:" + found.userId));
  if (body.logs !== undefined) {
    const logKey = key("logs:" + req.params.fileId);
    pipeline.del(logKey);
    body.logs.forEach((l) => pipeline.rpush(logKey, JSON.stringify(l)));
  }
  if (body.undo !== undefined) {
    const undoKey = key("undo:" + req.params.fileId);
    pipeline.del(undoKey);
    body.undo.forEach((u) => pipeline.rpush(undoKey, JSON.stringify(u)));
    pipeline.ltrim(undoKey, -100, -1);
  }
  if (body.redo !== undefined) {
    const redoKey = key("redo:" + req.params.fileId);
    pipeline.del(redoKey);
    body.redo.forEach((r) => pipeline.rpush(redoKey, JSON.stringify(r)));
    pipeline.ltrim(redoKey, -100, -1);
  }
  try {
    const results = await pipeline.exec();
    if (!results) {
      console.error("[Admin Persist] pipeline error: exec returned null");
      res.status(500).json({ error: "Failed to persist" });
      return;
    }
    const failedCmd = results.find((r) => r[0] !== null);
    if (failedCmd) {
      console.error("[Admin Persist] pipeline command error:", failedCmd[0]);
      res.status(500).json({ error: "Failed to persist" });
      return;
    }
  } catch (e) {
    console.error("[Admin Persist] pipeline error:", (e as Error).message);
    res.status(500).json({ error: "Failed to persist" });
    return;
  }
  if (body.dataCount !== undefined && found.userId) {
    const updated = await updateUserFilesAtomic(found.userId, (files) => {
      const idx = files.findIndex((f) => f.id === req.params.fileId);
      if (idx === -1) return null;
      files[idx].dataCount = body.dataCount;
      files[idx].updatedAt = Date.now();
      return files[idx];
    });
    if (updated === null) { res.status(500).json({ error: "Conflict saving files" }); return; }
  }
  res.json({ ok: true, seq: newSeq });
}));

adminRouter.get("/file/:fileId/logs", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  try {
    const logKey = key("logs:" + req.params.fileId);
    const logs = await redis.lrange(logKey, 0, -1);
    const parsed: unknown[] = [];
    logs.forEach((l) => {
      try {
        parsed.push(JSON.parse(l));
      } catch {
        // skip malformed entries
      }
    });
    res.json(parsed);
  } catch (e) {
    console.error("[Logs] Error:", (e as Error).message);
    res.status(500).json({ error: "Failed to read logs" });
  }
}));

// ── User delete / update ──
adminRouter.delete("/user/:userId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (String(req.params.userId) === String(req.userId)) {
    res.status(400).json({ error: "cannot delete your own account" });
    return;
  }
  if (isAdmin(String(req.params.userId))) { res.status(403).json({ error: "cannot act on admin" }); return; }
  const user = await getJSON("user:" + req.params.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  const files = (await getJSON<StoredFile[]>("files:" + req.params.userId)) || [];
  const archived = (await getJSON<StoredFile[]>("archive:" + req.params.userId)) || [];
  const allFiles = files.concat(archived);
  const sessIds = await redis.smembers(key("userSessions:" + req.params.userId));
  const p = redis.pipeline();
  allFiles.forEach((f) => {
    p.del(key("rows:" + f.id));
    p.del(key("undo:" + f.id));
    p.del(key("redo:" + f.id));
    p.del(key("sync:" + f.id));
    p.del(key("logs:" + f.id));
  });
  p.del(key("files:" + req.params.userId));
  p.del(key("archive:" + req.params.userId));
  p.del(key("user:" + req.params.userId));
  p.srem("ss:userIds", String(req.params.userId));
  sessIds.forEach((sid) => {
    p.del(key("session:" + sid));
    invalidateSession(sid);
  });
  p.del(key("userSessions:" + req.params.userId));
  await p.exec();
  await deleteFilesHistory(allFiles.map((f) => f.id));
  res.json({ ok: true });
}));

adminRouter.put("/user/:userId", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (isAdmin(String(req.params.userId)) && String(req.params.userId) !== String(req.userId)) { res.status(403).json({ error: "cannot edit admin" }); return; }
  const user = await getJSON<Record<string, any>>("user:" + req.params.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  const updates = req.body as Record<string, unknown>;
  const USER_MUTABLE_FIELDS = ["firstName", "lastName", "username", "fileId", "lastLogin"] as const;
  USER_MUTABLE_FIELDS.forEach((k) => {
    if (updates[k] !== undefined) user[k] = updates[k];
  });
  await setJSON("user:" + req.params.userId, user);
  res.json(user);
}));

adminRouter.post("/user/:userId/ban", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (String(req.params.userId) === String(req.userId)) {
    res.status(400).json({ error: "cannot ban your own account" });
    return;
  }
  if (isAdmin(String(req.params.userId))) { res.status(403).json({ error: "cannot act on admin" }); return; }
  const user = await getJSON("user:" + req.params.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  await setJSON("ban:" + req.params.userId, { ts: Date.now() });
  invalidateBanCache(req.params.userId);
  res.json({ ok: true });
}));

adminRouter.post("/user/:userId/unban", requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const user = await getJSON("user:" + req.params.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  await delKey("ban:" + req.params.userId);
  invalidateBanCache(req.params.userId);
  res.json({ ok: true });
}));
