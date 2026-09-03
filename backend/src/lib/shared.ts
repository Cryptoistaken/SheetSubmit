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
}

/** File record as persisted in Redis — adds server-side fields on top of SheetFile. */
export interface StoredFile extends SheetFile {
  userId?: string;
  columns?: ColumnDef[] | null;
  password?: string;
  poolEnabled?: boolean;
  [k: string]: unknown;
}

/** A grid row — cookie cells are plain string keys. */
export type Row = Record<string, string | null | undefined>;

/** Fields a client may mutate on an existing file via PUT (mass-assignment whitelist). */
export const MUTABLE_FILE_FIELDS = ["name", "type", "columns", "password", "poolEnabled"] as const;

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
