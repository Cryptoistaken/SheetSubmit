export type FileType = "fb_cookie";
export type FilePreset = "cookie" | "combo" | "page";
export type Row = Record<string, string | null | undefined>;
export interface ColumnDef { key: string; label: string; width: number }
export interface SheetFile { id: string; name: string; type: FileType; preset?: FilePreset; poolKind?: FilePreset; rowCount?: number; dataCount?: number; createdAt?: number; updatedAt?: number; deletedAt?: number; userId?: string; columns?: ColumnDef[] | null; password?: string; poolEnabled?: boolean; [key: string]: unknown }
export const MUTABLE_FILE_FIELDS = ["name", "type", "columns", "password", "poolEnabled", "preset", "poolKind"] as const;
export const FILE_TYPE_DEFS = { fb_cookie: { key: "fb_cookie", label: "Facebook", badge: "Facebook", icon: "FB", desc: "cookies, 2fa key & uid", columns: [{ key: "cookies", label: "cookies", width: 340 }, { key: "twofakey", label: "2fa key", width: 200 }, { key: "uid", label: "uid", width: 120 }] } } as const;

export interface Env {
  INDEX: DurableObjectNamespace;
  FILES: DurableObjectNamespace;
  POOLS: DurableObjectNamespace;
  SESSION_SECRET?: string;
  TG_BOT_TOKEN?: string;
  ADMIN_IDS?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TG_WEBHOOK_SECRET?: string;
  WORKER_URL?: string;
  FRONTEND_URL?: string;
  HITOOLS_CHECK_URL?: string;
}
