import { api } from "@/lib/api";
import { dedupKeyForRow } from "@/stores/sheetStore";
import type { Row } from "@/lib/types";

export interface VersionRows {
  rows: Row[];
  keys: Set<string>;
  ok: boolean;
}

const MAX_FILES = 3;
const MAX_VERSIONS_PER_FILE = 50;

const cache = new Map<string, Map<number, VersionRows>>();

function trimCache(): void {
  while (cache.size > MAX_FILES) {
    const oldestFile = cache.keys().next().value as string | undefined;
    if (oldestFile === undefined) break;
    cache.delete(oldestFile);
  }
}

export function getCachedVersionRows(fileId: string, v: number): VersionRows | null {
  return cache.get(fileId)?.get(v) ?? null;
}

/** Per-file cached version row load. Never rejects; errors degrade to empty. */
export async function getVersionRows(
  fileId: string,
  v: number,
  admin = false,
): Promise<VersionRows> {
  let byFile = cache.get(fileId);
  if (!byFile) {
    byFile = new Map();
    cache.set(fileId, byFile);
  }
  const hit = byFile.get(v);
  if (hit) return hit;
  try {
    const data = admin
      ? await api.adminGetVersion(fileId, v)
      : await api.getVersion(fileId, v);
    const rows = (data?.rows ?? []) as Row[];
    const keys = new Set<string>();
    rows.forEach((r) => {
      const k = dedupKeyForRow(r);
      if (k) keys.add(String(k));
    });
    const rec: VersionRows = { rows, keys, ok: !!data?.rows };
    byFile.set(v, rec);
    if (byFile.size > MAX_VERSIONS_PER_FILE) {
      const oldestVersion = byFile.keys().next().value as number | undefined;
      if (oldestVersion !== undefined) byFile.delete(oldestVersion);
    }
    trimCache();
    return rec;
  } catch (e) {
    console.error("[Versions] load v" + v + " error:", e);
    return { rows: [], keys: new Set(), ok: false };
  }
}
