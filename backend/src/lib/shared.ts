export type FileType = "fb_cookie";
export type FilePreset = "cookie" | "combo" | "page";
export type Row = Record<string, string | null | undefined>;
export interface ColumnDef { key: string; label: string; width: number }
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
}
