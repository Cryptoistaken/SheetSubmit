import type {
  AdminUser,
  ArchiveFile,
  CrossDupResult,
  FileType,
  HistoryResult,
  Row,
  SheetFile,
  User,
  VersionMeta,
} from "./types";

// Base URL of the backend API. The static server injects it at container start via
// /config.js (window.APP_CONFIG.apiBase ← VITE_API_BASE env var on the web service),
// so no URL is baked into the build. Falls back to a build-time VITE_API_BASE (for
// anyone building manually), then to relative /api (local dev → vite proxy).
const RUNTIME_BASE = (window.APP_CONFIG?.apiBase ?? import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
// Runtime config injected by the static server via /config.js (see server.js).
declare global {
  interface Window {
    APP_CONFIG?: { apiBase?: string };
  }
}

const BASE = RUNTIME_BASE + "/api";
export const API_BASE = BASE;

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

interface VersionResult {
  v: number;
  rows: Row[];
  action: string | null;
  ts: number | null;
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

export const api = {
  // ── Files ──
  getFiles: () => request<SheetFile[]>("/files"),
  getFileFull: (id: string) =>
    request<{ file: SheetFile; rows: Row[]; logs: unknown[]; undo: unknown[]; redo: unknown[]; seq?: number }>(
      `/files/${id}/full`,
    ),
  createFile: (data: { id: string; name: string; type: FileType; password?: string; poolEnabled?: boolean }) =>
    request<SheetFile>("/files", { method: "POST", body: JSON.stringify(data) }),
  updateFile: (id: string, data: Record<string, unknown>) =>
    request<SheetFile>(`/files/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteFile: (id: string) => request<{ ok: boolean }>(`/files/${id}`, { method: "DELETE" }),
  getRows: (id: string) => request<Row[]>(`/files/${id}/rows`),
  persist: (id: string, data: PersistPayload, opts?: { keepalive?: boolean }) =>
    request<{ ok: boolean; seq?: number; file?: SheetFile }>(`/files/${id}/persist`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, opts),
  append: (id: string, data: AppendPayload, opts?: { keepalive?: boolean }) =>
    request<{ ok: boolean; seq: number; file?: SheetFile }>(`/files/${id}/append`, {
      method: "PUT",
      body: JSON.stringify(data),
    }, opts),
  health: () => request<{ status: string }>("/health"),
  getArchive: () => request<ArchiveFile[]>("/archive"),
  restoreFile: (id: string) => request<{ ok: boolean }>(`/archive/${id}/restore`, { method: "POST" }),
  permanentDelete: (id: string) => request<{ ok: boolean }>(`/archive/${id}`, { method: "DELETE" }),
  batchRestore: (ids: string[]) =>
    request<{ restored: number }>("/archive/batch-restore", { method: "POST", body: JSON.stringify({ ids }) }),
  batchDelete: (ids: string[]) =>
    request<{ deleted: number }>("/archive/batch-delete", { method: "POST", body: JSON.stringify({ ids }) }),
  getCrossDups: (fileId?: string) =>
    request<CrossDupResult>(`/cross-dups${fileId ? `?fileId=${fileId}` : ""}`),
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
    request<{ cache: Record<string, unknown> }>(`/wa/cache?uids=${encodeURIComponent(uids.join(","))}`),

  // ── Admin ──
  adminStats: () => request<{ totalUsers: number; totalFiles: number }>("/admin/stats"),
  adminUsers: () => request<AdminUser[]>("/admin/users"),
  adminSearchUsers: (q: string) => request<AdminUser[]>(`/admin/users/search?q=${encodeURIComponent(q)}`),
  adminUser: (userId: string) => request<AdminUser>(`/admin/user/${userId}`),
  adminUserArchive: (userId: string) => request<ArchiveFile[]>(`/admin/user/${userId}/archive`),
  adminRestoreArchived: (userId: string, fileId: string) =>
    request<{ ok: boolean }>(`/admin/user/${userId}/archive/${fileId}/restore`, { method: "POST" }),
  adminDeleteArchived: (userId: string, fileId: string) =>
    request<{ ok: boolean }>(`/admin/user/${userId}/archive/${fileId}`, { method: "DELETE" }),
  adminFile: (fileId: string) => request<SheetFile>(`/admin/file/${fileId}`),
  adminUpdateFile: (fileId: string, data: Record<string, unknown>) =>
    request<SheetFile>(`/admin/file/${fileId}`, { method: "PUT", body: JSON.stringify(data) }),
  adminDeleteFile: (fileId: string) => request<{ ok: boolean }>(`/admin/file/${fileId}`, { method: "DELETE" }),
  adminFileRows: (fileId: string) => request<Row[]>(`/admin/file/${fileId}/rows`),
  adminPersist: (fileId: string, data: PersistPayload) =>
    request<{ ok: boolean }>(`/admin/file/${fileId}/persist`, { method: "PUT", body: JSON.stringify(data) }),
  adminFileLogs: (fileId: string) => request<unknown[]>(`/admin/file/${fileId}/logs`),
  adminUndo: (fileId: string) => request<HistoryResult>(`/admin/file/${fileId}/undo`),

  // ── Version history ──
  getHistory: (id: string) => request<VersionMeta[]>(`/files/${id}/history`),
  getVersion: (id: string, v: number) => request<VersionResult>(`/files/${id}/history/${v}`),
  restoreVersion: (id: string, v: number) =>
    request<{ ok: boolean; v: number; rows: Row[] }>(`/files/${id}/history/${v}/restore`, { method: "POST" }),
  adminGetHistory: (fileId: string) => request<VersionMeta[]>(`/admin/file/${fileId}/history`),
  adminGetVersion: (fileId: string, v: number) =>
    request<VersionResult>(`/admin/file/${fileId}/history/${v}`),
  adminRestoreVersion: (fileId: string, v: number) =>
    request<{ ok: boolean; v: number; rows: Row[] }>(`/admin/file/${fileId}/history/${v}/restore`, {
      method: "POST",
    }),
  nameVersion: (id: string, v: number, name: string) =>
    request<{ ok: boolean; meta: VersionMeta[] }>(`/files/${id}/history/${v}/name`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  adminNameVersion: (fileId: string, v: number, name: string) =>
    request<{ ok: boolean; meta: VersionMeta[] }>(`/admin/file/${fileId}/history/${v}/name`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  adminForkVersion: (fileId: string, v: number) =>
    request<{ ok: boolean; file: SheetFile; rows: Row[] }>(`/admin/file/${fileId}/history/${v}/fork`, {
      method: "POST",
    }),
  adminDeleteUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}`, { method: "DELETE" }),
  adminBanUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}/ban`, { method: "POST" }),
  adminUnbanUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}/unban`, { method: "POST" }),

  // ── Pools (admin-only, password-scoped with legacy alias for dgddigital) ──
  getPools: () => request<{ pools: PoolSummary[] }>("/pools"),
  getPoolDetail: async (password: string, poolId: string): Promise<PoolDetail> => {
    const enc = (s: string) => encodeURIComponent(s);
    try {
      return await request<PoolDetail>(`/pools/${enc(password)}/${enc(poolId)}`);
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<PoolDetail>(`/pools/${enc(poolId)}`);
      }
      throw e;
    }
  },
  getPoolRows: async (password: string, poolId: string, opts?: { userId?: string; limit?: number; offset?: number }): Promise<PoolRowsResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const q = new URLSearchParams();
    if (opts?.userId) q.set("userId", opts.userId);
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.offset) q.set("offset", String(opts.offset));
    const qs = q.toString() ? `?${q}` : "";
    try {
      return await request<PoolRowsResult>(`/pools/${enc(password)}/${enc(poolId)}/rows${qs}`);
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<PoolRowsResult>(`/pools/${enc(poolId)}/rows${qs}`);
      }
      throw e;
    }
  },
  claimPool: async (password: string, poolId: string, body: { count: number | "all"; userId?: string }): Promise<PoolClaimResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    try {
      return await request<PoolClaimResult>(`/pools/${enc(password)}/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(body) });
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<PoolClaimResult>(`/pools/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(body) });
      }
      throw e;
    }
  },
  getPoolLedger: async (password: string, poolId: string): Promise<{ ledger: unknown[] }> => {
    const enc = (s: string) => encodeURIComponent(s);
    try {
      return await request<{ ledger: unknown[] }>(`/pools/${enc(password)}/${enc(poolId)}/ledger`);
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<{ ledger: unknown[] }>(`/pools/${enc(poolId)}/ledger`);
      }
      throw e;
    }
  },
  getDownloads: () => request<unknown[]>("/pools/downloads"),
  getDownloadBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  revertDownload: (id: string) => request<{ ok: boolean; reverted: number }>(`/pools/downloads/${encodeURIComponent(id)}/revert`, { method: "POST" }),
  // aliases for spec compatibility
  downloadHistory: () => request<{ downloads: unknown[] } | unknown[]>("/pools/downloads" as string) as Promise<{ downloads: unknown[] } | unknown[]>,
  redownload: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadById: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadByIdBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),

  // ── Auth & bot (not in old api.js; used directly by the UI) ──
  me: () => request<User | null>("/auth/me"),
  logout: () => request<{ ok: boolean }>("/auth/logout"),
  botInfo: () => request<{ username: string }>("/bot/info"),
  claimDeviceSession: (token: string) =>
    request<{ ok: boolean }>(`/auth/device/claim?token=${encodeURIComponent(token)}`),
};
