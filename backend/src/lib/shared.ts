export type FileType = "fb_cookie";
export type FilePreset = "cookie" | "combo" | "page";
export type Row = Record<string, string | null | undefined>;
export interface ColumnDef { key: string; label: string; width: number }

/** Structural-save guard: a client that loaded seq `base` must not overwrite a
 * newer server seq. Missing/non-integer base means "no guard" (old clients). */
export function isPersistConflict(base: unknown, current: number): boolean {
  return Number.isInteger(base) && (base as number) !== current;
}

/** Hard cap: rows per file. Files per user are uncapped. */
export const FILE_ROW_LIMIT = 500;
/** Rolling pre-save snapshots kept per file (Fix #8). */
export const FILE_SNAPSHOT_LIMIT = 3;

export interface FileSnapshot {
  rows: Row[];
  seq: number;
  ts: number;
}

/** Prepend a snapshot, newest-first, capped at `max` (pure, unit-tested). */
export function pushSnapshot(snaps: FileSnapshot[], snap: FileSnapshot, max: number = FILE_SNAPSHOT_LIMIT): FileSnapshot[] {
  return [snap, ...snaps.filter((s) => s && Array.isArray(s.rows))].slice(0, Math.max(1, max));
}

/** Pool identity of a row (mirrors pg key()). */
export function poolRowKey(r: Row): string {
  return String(r.uid || (String(r.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
}

/** Pool-relevant content signature — the only fields pool copies depend on. */
export function poolFeedSig(r: Row): string {
  return JSON.stringify([r.cookies ?? "", r.twofakey ?? "", r.uid ?? "", r.check_status ?? r.wa_status ?? "", r.status ?? ""]);
}

/** Subset of newRows the pool actually needs: new keys + changed content.
 * Lets persist feed touched rows only instead of re-feeding whole files. */
export function selectFeedRows(oldRows: Row[], newRows: Row[]): Row[] {
  const old = new Map<string, string>();
  for (const r of oldRows) {
    const k = poolRowKey(r);
    if (k && !old.has(k)) old.set(k, poolFeedSig(r));
  }
  return newRows.filter((r) => {
    const k = poolRowKey(r);
    return !!k && old.get(k) !== poolFeedSig(r);
  });
}
export interface SheetFile { id: string; name: string; type: FileType; preset?: FilePreset; poolKind?: FilePreset; rowCount?: number; dataCount?: number; createdAt?: number; updatedAt?: number; deletedAt?: number; userId?: string; columns?: ColumnDef[] | null; password?: string; poolEnabled?: boolean; [key: string]: unknown }

export interface Env {
  INDEX: "index";
  FILES: "files";
  POOLS: "pools";
  DATABASE_URL: string;
  SESSION_SECRET?: string;
  TG_BOT_TOKEN?: string;
  ADMIN_IDS?: string;
  TG_WEBHOOK_SECRET?: string;
  BACKEND_URL?: string;
  FRONTEND_URL?: string;
  WORKER_URL?: string;
  CHECK_URL?: string;
  ALLOW_TEST_AUTH?: string;
  TELEGRAM_LOGIN_CLIENT_ID?: string;
  REDIS_URL?: string;
  AGENT_TOKEN?: string;
  ALLOW_AGENT_ACCESS?: string;
}
