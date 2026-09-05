import type {
  AdminUser,
  ArchiveFile,
  CrossDupResult,
  ColumnDef,
  FileType,
  HistoryResult,
  Row,
  SheetFile,
  User,
} from "./types";
import { wsCall, wsWaitOpen } from "./ws";
import { captureMock, isCapture } from "./mock";

const RUNTIME_BASE = (window.APP_CONFIG?.apiBase ?? import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
declare global {
  interface Window {
    APP_CONFIG?: { apiBase?: string; wsBase?: string };
  }
}

const BASE = RUNTIME_BASE + "/api";
export const API_BASE = BASE;

export function normalizeUser(raw: any): User {
  const parts = String(raw?.name || "").split(" ").filter(Boolean);
  return {
    ...raw,
    id: String(raw?.id ?? raw?.user_id ?? ""),
    firstName: raw?.firstName ?? parts[0] ?? "",
    lastName: raw?.lastName ?? parts.slice(1).join(" ") ?? "",
  } as User;
}

async function requestBlob(path: string): Promise<Blob> {
  const res = await fetch(BASE + path, { credentials: "include" });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ?? JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.blob();
}

async function request<T>(path: string, init?: RequestInit, opts?: { keepalive?: boolean }): Promise<T> {
  const controller = new AbortController();
  const res = await fetch(BASE + path, {
    ...init,
    keepalive: opts?.keepalive,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
    signal: controller.signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error ?? JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  return res.json() as Promise<T>;
}

function wsDebug(op: string, transport: "ws" | "http", detail?: unknown) {
  try {
    if (localStorage.getItem("ss_ws_debug") === "1") console.debug(`[transport:${transport}] ${op}`, detail ?? "");
  } catch {}
}

async function call<T>(op: string, args: object | undefined, httpFn: () => Promise<T>, opts?: { keepalive?: boolean }): Promise<T> {
  if (isCapture) {
    const mocked = captureMock(op);
    if (mocked === undefined) throw new Error(`boneyard: no mock for ${op}`);
    return mocked as T;
  }
  if (opts?.keepalive) {
    wsDebug(op, "http", "keepalive");
    return httpFn();
  }
  if (!(await wsWaitOpen())) {
    wsDebug(op, "ws", "not open");
    throw new Error(`ws not open: ${op}`);
  }
  try {
    const result = await wsCall<T>(op, args);
    wsDebug(op, "ws");
    return result;
  } catch (error) {
    wsDebug(op, "ws", error);
    throw error;
  }
}

interface PersistPayload {
  rows?: Row[];
  dataCount?: number;
  action?: string;
  logs?: unknown[];
  undo?: unknown[];
  redo?: unknown[];
  userId?: string;
}

export interface AppendOp {
  rowIdx: number;
  cols: Record<string, string>;
}

export interface AppendPayload {
  base: number;
  ops: AppendOp[];
  newLogs?: unknown[];
  undoNew?: unknown[];
  redoNew?: unknown[];
  dataCount?: number;
  action?: string;
}

export interface PoolSummary {
  id: string;
  label: string;
  badge: string;
  cols: string[];
  filename: string;
  password: string;
  available: number;
  claimed: number;
  users: number;
}
export interface PoolUser {
  userId: string;
  displayName: string;
  username?: string | null;
  photoUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isAdmin?: boolean;
  available: number;
  claimed: number;
}
export interface PoolDetail {
  pool: { id: string; label: string; badge: string; cols: string[]; filename: string; rule?: string };
  password: string;
  totals: { available: number; claimed: number; users: number };
  users: PoolUser[];
}
export interface PoolRowsResult {
  password: string;
  poolId: string;
  total: number;
  offset: number;
  limit: number;
  rows: Record<string, unknown>[];
}
export type PoolClaimResult = { password: string; poolId: string; claimed: number; rows: unknown[]; downloadId?: string; filename?: string };
export type PoolClaimResultWithMeta = PoolClaimResult;
export interface PoolUserFile {
  userId: string;
  files: { fileId: string; available: number; claimed: number }[];
  totalAvailable: number;
  totalClaimed: number;
}
export interface PoolUserFilesResult {
  users: PoolUserFile[];
  noSrcAvail: number;
}
export interface VerifiedCounts {
  pool: string;
  verified: number;
  unverified: number;
  totalAvailable: number;
  truncated: boolean;
  scanCap: number;
}
export interface DownloadDetailGroup {
  srcUid: string | null;
  srcFileId: string | null;
  count: number;
}
export interface DownloadDetail {
  id: string;
  at: number;
  ts: number;
  poolId: string;
  password: string;
  claimed: number;
  claimedBy?: string | null;
  filename: string;
  reverted: boolean;
  rows: Record<string, unknown>[];
  keys: string[];
  groups: DownloadDetailGroup[];
}

export const api = {
  wsTicket: () => request<{ ticket: string }>("/ws/ticket"),
  getFiles: () => call<SheetFile[]>("files.list", {}, () => request<SheetFile[]>("/files")),
  getFileFull: (id: string) =>
    call<{ file: SheetFile; rows: Row[]; logs: unknown[]; undo: unknown[]; redo: unknown[]; seq?: number }>("file.full", { id }, () => request<{ file: SheetFile; rows: Row[]; logs: unknown[]; undo: unknown[]; redo: unknown[]; seq?: number }>(`/files/${id}/full`)),
  createFile: (data: { id: string; name: string; type: FileType; preset?: string; poolKind?: string; password?: string; poolEnabled?: boolean; rows?: Row[]; dataCount?: number; columns?: ColumnDef[] }) =>
    call<SheetFile>("file.create", { body: data }, () => request<SheetFile>("/files", { method: "POST", body: JSON.stringify(data) })),
  updateFile: (id: string, data: Record<string, unknown>) =>
    call<SheetFile>("file.update", { id, data }, () => request<SheetFile>(`/files/${id}`, { method: "PUT", body: JSON.stringify(data) })),
  deleteFile: (id: string) => call<{ ok: boolean }>("file.delete", { id }, () => request<{ ok: boolean }>(`/files/${id}`, { method: "DELETE" })),
  getRows: (id: string) => call<Row[]>("file.rows", { id }, () => request<Row[]>(`/files/${id}/rows`)),
  persist: (id: string, data: PersistPayload, opts?: { keepalive?: boolean }) =>
    call<{ ok: boolean; seq?: number; file?: SheetFile }>("file.persist", { id, payload: data }, () => request<{ ok: boolean; seq?: number; file?: SheetFile }>(`/files/${id}/persist`, { method: "PUT", body: JSON.stringify(data) }, opts), opts),
  append: (id: string, data: AppendPayload, opts?: { keepalive?: boolean }) =>
    call<{ ok: boolean; seq: number; file?: SheetFile }>("file.append", { id, payload: data }, () => request<{ ok: boolean; seq: number; file?: SheetFile }>(`/files/${id}/append`, { method: "PUT", body: JSON.stringify(data) }, opts), opts),
  health: () => call<{ ok: boolean; ts: number; version: string }>("health", {}, () => request<{ ok: boolean; ts: number; version: string }>("/health")),
  getArchive: () => call<ArchiveFile[]>("archive.list", {}, () => request<ArchiveFile[]>("/archive")),
  restoreFile: (id: string) => call<{ ok: boolean }>("archive.restore", { id }, () => request<{ ok: boolean }>(`/archive/${id}/restore`, { method: "POST" })),
  permanentDelete: (id: string) => call<{ ok: boolean }>("archive.delete", { id }, () => request<{ ok: boolean }>(`/archive/${id}`, { method: "DELETE" })),
  batchRestore: (ids: string[]) =>
    call<{ restored: number }>("archive.batchRestore", { ids }, () => request<{ restored: number }>("/archive/batch-restore", { method: "POST", body: JSON.stringify({ ids }) })),
  batchDelete: (ids: string[]) =>
    call<{ deleted: number }>("archive.batchDelete", { ids }, () => request<{ deleted: number }>("/archive/batch-delete", { method: "POST", body: JSON.stringify({ ids }) })),
  getCrossDups: (fileId?: string) =>
    call<CrossDupResult>("crossdups", { fileId }, () => request<CrossDupResult>(`/cross-dups${fileId ? `?fileId=${fileId}` : ""}`)),
  pageCheck: (cookie: string) =>
    request<{ eligible?: boolean; error?: string | null; banReason?: string | null; pageName?: string | null; linkedNumber?: string | null }>("/fb/page-check", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  waCheck: (cookie: string) =>
    request<{ eligible?: boolean; error?: string | null; banReason?: string | null; linkedNumber?: string | null }>("/fb/wa-check", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    }),
  fbCheck: (uids: string[]) =>
    request<{ valid: string[]; dead: string[]; uncertain: string[] }>("/fb/check", {
      method: "POST",
      body: JSON.stringify({ uids }),
    }),
  getWaCache: (uids: string[]) =>
    call<{ cache: Record<string, unknown> }>("wa.cache", { uids }, () => request<{ cache: Record<string, unknown> }>(`/wa/cache?uids=${encodeURIComponent(uids.join(","))}`)),

  adminStats: () => call<{ totalUsers: number; totalFiles: number }>("admin.stats", {}, () => request<{ totalUsers: number; totalFiles: number }>("/admin/stats")),
  adminUsers: () => call<AdminUser[]>("admin.users", {}, () => request<AdminUser[]>("/admin/users")),
  adminSearchUsers: (q: string) => call<AdminUser[]>("admin.users.search", { q }, () => request<AdminUser[]>(`/admin/users/search?q=${encodeURIComponent(q)}`)),
  adminUser: (userId: string) => call<AdminUser>("admin.user", { userId }, () => request<AdminUser>(`/admin/user/${userId}`)),
  adminUserArchive: (userId: string) => call<ArchiveFile[]>("admin.user.archive", { userId }, () => request<ArchiveFile[]>(`/admin/user/${userId}/archive`)),
  adminRestoreArchived: (userId: string, fileId: string) =>
    call<{ ok: boolean }>("admin.user.archive.restore", { userId, fileId }, () => request<{ ok: boolean }>(`/admin/user/${userId}/archive/${fileId}/restore`, { method: "POST" })),
  adminDeleteArchived: (userId: string, fileId: string) =>
    call<{ ok: boolean }>("admin.user.archive.delete", { userId, fileId }, () => request<{ ok: boolean }>(`/admin/user/${userId}/archive/${fileId}`, { method: "DELETE" })),
  adminFile: (fileId: string) => call<SheetFile>("admin.file", { fileId }, () => request<SheetFile>(`/admin/file/${fileId}`)),
  adminUpdateFile: (fileId: string, data: Record<string, unknown>) =>
    call<SheetFile>("admin.file.update", { fileId, data }, () => request<SheetFile>(`/admin/file/${fileId}`, { method: "PUT", body: JSON.stringify(data) })),
  adminDeleteFile: (fileId: string) => call<{ ok: boolean }>("admin.file.delete", { fileId }, () => request<{ ok: boolean }>(`/admin/file/${fileId}`, { method: "DELETE" })),
  adminFileRows: (fileId: string) => call<Row[]>("admin.file.rows", { fileId }, () => request<Row[]>(`/admin/file/${fileId}/rows`)),
  adminPersist: (fileId: string, data: PersistPayload) =>
    call<{ ok: boolean }>("admin.file.persist", { fileId, payload: data }, () => request<{ ok: boolean }>(`/admin/file/${fileId}/persist`, { method: "PUT", body: JSON.stringify(data) })),
  adminFileLogs: (fileId: string) => call<unknown[]>("admin.file.logs", { fileId }, () => request<unknown[]>(`/admin/file/${fileId}/logs`)),
  adminUndo: (fileId: string) => call<HistoryResult>("admin.file.undo", { fileId }, () => request<HistoryResult>(`/admin/file/${fileId}/undo`)),

  adminDeleteUser: (userId: string) => call<{ ok: boolean }>("admin.user.delete", { userId }, () => request<{ ok: boolean }>(`/admin/user/${userId}`, { method: "DELETE" })),
  adminBanUser: (userId: string) => call<{ ok: boolean }>("admin.ban", { userId }, () => request<{ ok: boolean }>(`/admin/user/${userId}/ban`, { method: "POST" })),
  adminUnbanUser: (userId: string) => call<{ ok: boolean }>("admin.unban", { userId }, () => request<{ ok: boolean }>(`/admin/user/${userId}/unban`, { method: "POST" })),

  getPools: () => call<{ pools: PoolSummary[] }>("pools.list", {}, () => request<{ pools: PoolSummary[] }>("/pools")),
  getPoolDetail: (password: string, poolId: string): Promise<PoolDetail> => {
    const enc = (s: string) => encodeURIComponent(s);
    const httpFn = async () => {
      try {
        return await request<PoolDetail>(`/pools/${enc(password)}/${enc(poolId)}`);
      } catch (e) {
        if (password === "dgddigital" && String(e).includes("404")) {
          return request<PoolDetail>(`/pools/${enc(poolId)}`);
        }
        throw e;
      }
    };
    return call<PoolDetail>("pool.detail", { password, poolId }, httpFn);
  },
  getPoolRows: (password: string, poolId: string, opts?: { userId?: string; limit?: number; offset?: number }): Promise<PoolRowsResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const q = new URLSearchParams();
    if (opts?.userId) q.set("userId", opts.userId);
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.offset) q.set("offset", String(opts.offset));
    const qs = q.toString() ? `?${q}` : "";
    const httpFn = async () => {
      try {
        return await request<PoolRowsResult>(`/pools/${enc(password)}/${enc(poolId)}/rows${qs}`);
      } catch (e) {
        if (password === "dgddigital" && String(e).includes("404")) {
          return request<PoolRowsResult>(`/pools/${enc(poolId)}/rows${qs}`);
        }
        throw e;
      }
    };
    return call<PoolRowsResult>("pool.rows", { password, poolId, ...opts }, httpFn);
  },
  claimPool: (password: string, poolId: string, body: { count: number | "all"; userId?: string; srcUid?: string | null; srcFileId?: string | null; verifiedOnly?: boolean; unverifiedOnly?: boolean }): Promise<PoolClaimResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const payload: Record<string, unknown> = { ...body };
    if (body.srcUid) { payload.srcUid = body.srcUid; payload.claimForUser = body.srcUid; }
    if (body.srcFileId) payload.srcFileId = body.srcFileId;
    const httpFn = async () => {
      try {
        return await request<PoolClaimResult>(`/pools/${enc(password)}/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(payload) });
      } catch (e) {
        if (password === "dgddigital" && String(e).includes("404")) {
          return request<PoolClaimResult>(`/pools/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(payload) });
        }
        throw e;
      }
    };
    return call<PoolClaimResult>("pool.claim", { password, poolId, ...body }, httpFn);
  },
  getPoolLedger: (password: string, poolId: string): Promise<{ ledger: unknown[] }> => {
    const enc = (s: string) => encodeURIComponent(s);
    const httpFn = async () => {
      try {
        return await request<{ ledger: unknown[] }>(`/pools/${enc(password)}/${enc(poolId)}/ledger`);
      } catch (e) {
        if (password === "dgddigital" && String(e).includes("404")) {
          return request<{ ledger: unknown[] }>(`/pools/${enc(poolId)}/ledger`);
        }
        throw e;
      }
    };
    return call<{ ledger: unknown[] }>("pool.ledger", { password, poolId }, httpFn);
  },
  getDownloads: () => call<unknown[]>("pool.downloads", {}, () => request<unknown[]>("/pools/downloads")),
  getUserFiles: (password: string, poolId: string): Promise<PoolUserFilesResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const httpFn = async () => {
      try {
        return await request<PoolUserFilesResult>(`/pools/${enc(password)}/${enc(poolId)}/user-files`);
      } catch (e) {
        if (password === "dgddigital" && String(e).includes("404")) {
          return request<PoolUserFilesResult>(`/pools/${enc(poolId)}/user-files`);
        }
        throw e;
      }
    };
    return call<PoolUserFilesResult>("pool.userFiles", { password, poolId }, httpFn);
  },
  getVerifiedCounts: (password: string, poolId: string) => {
    const enc = (s: string) => encodeURIComponent(s);
    return call<VerifiedCounts>("pool.verifiedCounts", { password, poolId }, () => request<VerifiedCounts>(`/pools/${enc(password)}/${enc(poolId)}/verified-counts`));
  },
  getDownloadDetail: (id: string) => call<DownloadDetail>("pool.downloadDetail", { id }, () => request<DownloadDetail>(`/pools/downloads/${encodeURIComponent(id)}/detail`)),
  getDownloadBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  revertDownload: (id: string) => call<{ ok: boolean; reverted: number }>("pool.revertDownload", { id }, () => request<{ ok: boolean; reverted: number }>(`/pools/downloads/${encodeURIComponent(id)}/revert`, { method: "POST" })),
  downloadHistory: () => call<{ downloads: unknown[] } | unknown[]>("pool.downloads", {}, () => request<{ downloads: unknown[] } | unknown[]>("/pools/downloads" as string) as Promise<{ downloads: unknown[] } | unknown[]>),
  redownload: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadById: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadByIdBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),

  me: async (): Promise<{ user: User | null; expired: boolean }> => {
    const res = await fetch(BASE + "/auth/me", { credentials: "include" });
    if (res.status === 401) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      return { user: null, expired: body?.error === "session_expired" };
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const raw = (await res.json()) as any;
    if (!raw) return { user: null, expired: false };
    return { user: normalizeUser(raw), expired: false };
  },
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  botInfo: () => request<{ username: string }>("/bot/info"),
  claimDeviceSession: (token: string, turnstileToken?: string | null) =>
    request<{ ok: boolean }>("/auth/device/claim", { method: "POST", body: JSON.stringify({ token, turnstile: turnstileToken || undefined }) }),
};
