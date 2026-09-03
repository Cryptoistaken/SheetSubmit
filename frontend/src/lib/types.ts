/** File types supported by the app. */
export type FileType = "fb_cookie";

export interface ColumnDef {
  key: string;
  label: string;
  width: number;
}

export interface FileTypeDef {
  key: FileType;
  label: string;
  badge: string;
  icon: string;
  desc: string;
  columns: ColumnDef[];
}

export interface SheetFile {
  id: string;
  name: string;
  type: FileType;
  rowCount?: number;
  dataCount?: number;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number;
  password?: string;
  poolEnabled?: boolean;
}

/** A grid row — cookie cells are plain string keys.
 * Augmentations: _pool?: string; _taken?: boolean; _takenAt?: number; wa_status?: string */
export type Row = Record<string, any>;

export const FILE_TYPE_DEFS: Record<FileType, FileTypeDef> = {
  fb_cookie: {
    key: "fb_cookie",
    label: "Facebook",
    badge: "Facebook",
    icon: "FB",
    desc: "cookies, 2fa key & uid",
    columns: [
      { key: "cookies", label: "cookies", width: 340 },
      { key: "twofakey", label: "2fa key", width: 200 },
      { key: "uid", label: "uid", width: 120 },
    ],
  },
};

/** Safe FILE_TYPE_DEFS lookup — falls back to fb_cookie for missing/unknown
 * types (e.g. files created by older builds or direct API calls). */
export function fileTypeDef(type?: string): FileTypeDef {
  const t = type as FileType;
  return (type && t in FILE_TYPE_DEFS ? FILE_TYPE_DEFS[t] : FILE_TYPE_DEFS.fb_cookie);
}

/** Marker the bubble writes into the 2fa cell when the user long-press-skips
 * 2FA ("set empty by the bubble action"). Display-only — never exported. */
export const NO_2FA_MARK = "No_2Fa";

/** True when a column value is a bubble bookkeeping placeholder that must not
 * participate in duplicate detection — two accounts skipped as "No 2FA" are
 * not duplicates of each other, and must never block a real key from saving. */
export function isNo2FAMark(colKey: string, value: string | null | undefined): boolean {
  return colKey === "twofakey" && value === NO_2FA_MARK;
}

/** Value to write into a cell on export. Strips the bubble's No_2Fa marker so
 * skipped rows download with an empty 2fa cell. */
export function exportCellValue(colKey: string, value: string | null | undefined): string {
  if (!value) return "";
  if (colKey === "twofakey" && value === NO_2FA_MARK) return "";
  return value;
}

/** Authenticated Telegram user. */
export interface User {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string | null;
  isAdmin?: boolean;
  fileId?: string | null;
  lastLogin?: number;
  fileCount?: number;
  archivedCount?: number;
  files?: SheetFile[];
}

export interface CrossDupEntry {
  fileId: string;
  fileName: string;
  rowIdx: number;
}

export interface CrossDupResult {
  counts: Record<string, number>;
  dups?: Record<string, CrossDupEntry[]>;
}

export type ArchiveFile = SheetFile & { deletedAt?: number };

export interface VersionMeta {
  v: number;
  ts: number;
  action: string;
  name?: string | null;
  rowCount?: number;
  parentV?: number | null;
  type?: string;
  hash?: string;
}

export interface WaCacheEntry {
  status: string | null;
  banReason: string | null;
  error: string | null;
  pageName?: string | null;
  linkedNumber?: string | null;
  ts: number | null;
}

export interface HistoryResult {
  undo: unknown[];
  redo: unknown[];
}

export type AdminUser = User & {
  fileCount: number;
  archivedCount: number;
  banned?: boolean;
};
