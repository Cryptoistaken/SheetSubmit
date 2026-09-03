// User-file helpers — ported from the old server.
import type { ColumnDef, Row, StoredFile } from "../lib/shared";
import { genFileId } from "../lib/ids";
import { getJSON, key, redis, setJSON } from "./redis";

export async function getUserFiles(userId: string): Promise<StoredFile[]> {
  return (await getJSON<StoredFile[]>("files:" + userId)) || [];
}

export async function findUserFile(
  userId: string,
  fileId: string,
): Promise<{ files: StoredFile[]; idx: number; file: StoredFile | null }> {
  const files = await getUserFiles(userId);
  const idx = files.findIndex((f) => f.id === fileId);
  return { files, idx, file: idx !== -1 ? files[idx] : null };
}

// Optimistic-lock update of the per-user files list. WATCH + MULTI: if another
// writer touches the key between our read and write, exec returns null and we
// retry. Returns the mutator result, or null if it could not commit in time.
export async function updateUserFilesAtomic<T>(
  userId: string,
  mutator: (files: StoredFile[]) => T,
): Promise<T | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await redis.watch(key("files:" + userId));
    const raw = await redis.get(key("files:" + userId));
    let files: StoredFile[] = [];
    if (raw) {
      try {
        files = JSON.parse(raw) as StoredFile[];
      } catch {
        files = [];
      }
    }
    const result = mutator(files);
    const res = await redis.multi().set(key("files:" + userId), JSON.stringify(files)).exec();
    if (res !== null) return result;
  }
  try {
    await redis.unwatch();
  } catch {
    // ignore
  }
  return null;
}

// Clone rows from a materialized version into a brand-new file for the user.
// Mirrors the shape POST /api/files accepts ({id, name, type} + extras).
export async function createForkFile(
  srcFile: StoredFile | null,
  rows: Row[],
  ownerId: string,
): Promise<StoredFile> {
  const type = (srcFile && srcFile.type) || "fb_cookie";
  const newId = genFileId();
  const file: StoredFile = {
    id: newId,
    name: "Fork of " + ((srcFile && srcFile.name) || "File"),
    type,
    userId: ownerId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    rowCount: Array.isArray(rows) ? rows.length : 0,
    columns: (srcFile && srcFile.columns) || null,
  };
  await updateUserFilesAtomic(ownerId, (files) => {
    files.unshift(file);
    return files;
  });
  await setJSON("rows:" + newId, rows || []);
  await redis.del(key("undo:" + newId));
  await redis.del(key("redo:" + newId));
  return file;
}

export function countDataRows(rows: Row[], columns?: ColumnDef[] | null): number {
  if (!rows || !rows.length) return 0;
  const keys = columns ? columns.map((c) => c.key) : null;
  return rows.filter((row) => {
    if (keys) return keys.some((k) => row[k]);
    return Object.values(row).some((v) => v);
  }).length;
}

// Cross-file duplicates dedup key (per file type).
export function getDedupKey(type: string, row: Row): string | null {
  if (type === "fb_cookie") {
    return row.uid || (row.cookies ? (row.cookies.match(/c_user=(\d+)/) || [])[1] : null) || null;
  }
  return null;
}
