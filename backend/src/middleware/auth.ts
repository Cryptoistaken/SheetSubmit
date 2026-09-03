// Auth middleware — ported from the old server. Session cookie `session=`,
// cached 5 min in-process; Redis keys identical (ss:session:, ss:user:).
import type { NextFunction, Request, Response } from "express";
import type { StoredFile } from "../lib/shared";
import { ADMIN_IDS } from "../config/env";
import { findUserFile } from "../services/files";
import { getJSON, redis } from "../services/redis";

const sessionCache = new Map<string, { userId: string; ts: number }>();
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const banCache = new Map<string, { banned: boolean; ts: number }>();
const BAN_CACHE_TTL = 15_000; // 15 seconds

// Migrated log keys cache
const _migratedLogKeys = new Set<string>();

export function isAdmin(userId: string | number): boolean {
  return ADMIN_IDS.indexOf(String(userId)) !== -1;
}

export function getSessionId(req: Request): string | null {
  const cookies = req.headers.cookie || "";
  const match = cookies.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  let userId: string | null = null;
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < SESSION_CACHE_TTL) {
    userId = cached.userId;
  } else {
    const session = await getJSON<{ userId: string | number }>("session:" + sessionId);
    if (!session) {
      res.status(401).json({ error: "Session expired" });
      return;
    }
    userId = String(session.userId);
    sessionCache.set(sessionId, { userId, ts: Date.now() });
    if (sessionCache.size > 1000) {
      const firstKey = sessionCache.keys().next().value;
      if (firstKey !== undefined) sessionCache.delete(firstKey);
    }
  }
  let banned = false;
  const banCached = banCache.get(userId);
  if (banCached && Date.now() - banCached.ts < BAN_CACHE_TTL) {
    banned = banCached.banned;
  } else {
    banned = !!(await getJSON("ban:" + userId));
    banCache.set(userId, { banned, ts: Date.now() });
    if (banCache.size > 1000) {
      const firstKey = banCache.keys().next().value;
      if (firstKey !== undefined) banCache.delete(firstKey);
    }
  }
  if (banned) {
    res.status(403).json({ error: "account banned" });
    return;
  }
  req.userId = userId;
  next();
}

// Ownership check: loads the file into req.file/req.files/req.fileIdx.
export async function requireFileAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const result = await findUserFile(userId, req.params.id);
  if (!result.file) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  req.file = result.file;
  req.files = result.files;
  req.fileIdx = result.idx;
  next();
}

// Drop a session from the in-process cache (used on logout).
export function invalidateSession(sessionId: string): void {
  sessionCache.delete(sessionId);
}

// Drop a user's ban status from the in-process cache (used on ban/unban).
export function invalidateBanCache(userId: string): void {
  banCache.delete(userId);
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isAdmin(req.userId || "")) {
    res.status(403).json({ error: "admin access required" });
    return;
  }
  next();
}

// Migrate a legacy string-typed key to a list (one-time per key). Applies to
// any list-backed key (logs/undo/redo). The key must already be prefixed.
export async function migrateListKey(listKey: string): Promise<void> {
  if (_migratedLogKeys.has(listKey)) return;
  const type = await redis.type(listKey);
  if (type === "string") {
    const old = await redis.get(listKey);
    if (old) {
      try {
        const parsed = JSON.parse(old);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const p = redis.pipeline();
          p.del(listKey);
          parsed.forEach((l) => p.rpush(listKey, JSON.stringify(l)));
          await p.exec();
        } else {
          await redis.del(listKey);
        }
      } catch {
        await redis.del(listKey);
      }
    }
  }
  if (_migratedLogKeys.size > 10000) {
    const firstKey = _migratedLogKeys.keys().next().value;
    if (firstKey !== undefined) _migratedLogKeys.delete(firstKey);
  }
  _migratedLogKeys.add(listKey);
}

// Migrate a legacy string-typed log key to a list (one-time per key).
export async function migrateLogKey(logKey: string): Promise<void> {
  await migrateListKey(logKey);
}

export async function findAllUserIds(): Promise<string[]> {
  return await redis.smembers("ss:userIds");
}

export async function findFileAcrossUsers(
  fileId: string,
): Promise<{ file: StoredFile; userId: string; files: StoredFile[]; idx: number } | null> {
  const ids = await findAllUserIds();
  if (ids.length === 0) return null;
  const p = redis.pipeline();
  ids.forEach((id) => p.get("ss:files:" + id));
  const results = (await p.exec()) || [];
  for (let i = 0; i < results.length; i++) {
    let files = results[i][1];
    if (!files) continue;
    try {
      files = JSON.parse(files as string);
    } catch {
      continue;
    }
    if (!Array.isArray(files)) continue;
    for (let j = 0; j < files.length; j++) {
      if (files[j].id === fileId) return { file: files[j], userId: ids[i], files, idx: j };
    }
  }
  return null;
}
