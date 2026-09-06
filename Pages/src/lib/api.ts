import { create } from "zustand";
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

const RUNTIME_BASE = (window.APP_CONFIG?.apiBase ?? import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");
declare global {
  interface Window {
    APP_CONFIG?: { apiBase?: string };
  }
}

const BASE = RUNTIME_BASE + "/api";
export const API_BASE = BASE;

export type ConnStatus = "connecting" | "ok" | "err";
export const useConnStore = create<{ status: ConnStatus }>()(() => ({ status: "connecting" }));
function markConn(res: Response) { useConnStore.setState({ status: "ok" }); return res; }

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
  let res: Response;
  try {
    res = await fetch(BASE + path, { credentials: "include" }).then(markConn);
  } catch (e) {
    useConnStore.setState({ status: "err" });
    throw e;
  }
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
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      keepalive: opts?.keepalive,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...init?.headers },
      signal: controller.signal,
    }).then(markConn);
  } catch (e) {
    useConnStore.setState({ status: "err" });
    throw e;
  }
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
export type HoldResult = { password: string; poolId: string; claimed: number; held: number; count: number; rows: unknown[]; holdId: string; downloadId: string; filename: string; status: string; mode: string; srcUids?: string[] | null; srcFileIds?: string[] | null };
export interface HoldRecord {
  id: string;
  at: number;
  ts?: number;
  poolId: string;
  password: string;
  claimed: number;
  held?: number;
  filename: string;
  status: string;
  mode?: string | null;
  srcUids?: string[] | null;
  srcFileIds?: string[] | null;
  selection?: unknown;
  claimedBy?: string | null;
  reverted?: boolean;
}
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
export interface PoolPrice { poolId: string; password: string | null; price: number }

export const api = {
  getFiles: () => request<SheetFile[]>("/files"),
  getFileFull: (id: string) =>
    request<{ file: SheetFile; rows: Row[]; logs: unknown[]; undo: unknown[]; redo: unknown[]; seq?: number }>(`/files/${id}/full`),
  createFile: (data: { id: string; name: string; type: FileType; preset?: string; poolKind?: string; password?: string; poolEnabled?: boolean; rows?: Row[]; dataCount?: number; columns?: ColumnDef[] }) =>
    request<SheetFile>("/files", { method: "POST", body: JSON.stringify(data) }),
  updateFile: (id: string, data: Record<string, unknown>) =>
    request<SheetFile>(`/files/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteFile: (id: string) => request<{ ok: boolean }>(`/files/${id}`, { method: "DELETE" }),
  getRows: (id: string) => request<Row[]>(`/files/${id}/rows`),
  persist: (id: string, data: PersistPayload, opts?: { keepalive?: boolean }) =>
    request<{ ok: boolean; seq?: number; file?: SheetFile }>(`/files/${id}/persist`, { method: "PUT", body: JSON.stringify(data) }, opts),
  append: (id: string, data: AppendPayload, opts?: { keepalive?: boolean }) =>
    request<{ ok: boolean; seq: number; file?: SheetFile }>(`/files/${id}/append`, { method: "PUT", body: JSON.stringify(data) }, opts),
  health: () => request<{ ok: boolean; ts: number; version: string }>("/health"),
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

  adminDeleteUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}`, { method: "DELETE" }),
  adminBanUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}/ban`, { method: "POST" }),
  adminUnbanUser: (userId: string) => request<{ ok: boolean }>(`/admin/user/${userId}/unban`, { method: "POST" }),

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
  claimPool: async (password: string, poolId: string, body: { count: number | "all"; userId?: string; srcUid?: string | null; srcFileId?: string | null; verifiedOnly?: boolean; unverifiedOnly?: boolean }): Promise<PoolClaimResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const payload: Record<string, unknown> = { ...body };
    if (body.srcUid) { payload.srcUid = body.srcUid; payload.claimForUser = body.srcUid; }
    if (body.srcFileId) payload.srcFileId = body.srcFileId;
    try {
      return await request<PoolClaimResult>(`/pools/${enc(password)}/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<PoolClaimResult>(`/pools/${enc(poolId)}/claim`, { method: "POST", body: JSON.stringify(payload) });
      }
      throw e;
    }
  },
  holdPool: async (password: string, poolId: string, body: { count: number | "all"; mode: "fifo" | "pick"; srcUids?: string[]; srcFileIds?: string[]; srcUid?: string | null; srcFileId?: string | null; verifiedOnly?: boolean; unverifiedOnly?: boolean }): Promise<HoldResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    const payload: Record<string, unknown> = { ...body };
    if (body.srcUid) payload.srcUid = body.srcUid;
    if (body.srcFileId) payload.srcFileId = body.srcFileId;
    if (body.srcUids) payload.srcUids = body.srcUids;
    if (body.srcFileIds) payload.srcFileIds = body.srcFileIds;
    try {
      return await request<HoldResult>(`/pools/${enc(password)}/${enc(poolId)}/hold`, { method: "POST", body: JSON.stringify(payload) });
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<HoldResult>(`/pools/${enc(poolId)}/hold`, { method: "POST", body: JSON.stringify(payload) });
      }
      throw e;
    }
  },
  getHolds: (status?: string) => request<HoldRecord[]>(`/pools/holds${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  approveHold: (id: string) => request<{ ok: boolean; status: string }>(`/pools/holds/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  rejectHold: (id: string) => request<{ ok: boolean; status: string }>(`/pools/holds/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  returnHold: (id: string) => request<{ ok: boolean; status: string }>(`/pools/holds/${encodeURIComponent(id)}/return`, { method: "POST" }),
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
  getUserFiles: async (password: string, poolId: string): Promise<PoolUserFilesResult> => {
    const enc = (s: string) => encodeURIComponent(s);
    try {
      return await request<PoolUserFilesResult>(`/pools/${enc(password)}/${enc(poolId)}/user-files`);
    } catch (e) {
      if (password === "dgddigital" && String(e).includes("404")) {
        return request<PoolUserFilesResult>(`/pools/${enc(poolId)}/user-files`);
      }
      throw e;
    }
  },
  getVerifiedCounts: (password: string, poolId: string) => {
    const enc = (s: string) => encodeURIComponent(s);
    return request<VerifiedCounts>(`/pools/${enc(password)}/${enc(poolId)}/verified-counts`);
  },
  getDownloadDetail: (id: string) => request<DownloadDetail>(`/pools/downloads/${encodeURIComponent(id)}/detail`),
  getDownloadBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  revertDownload: (id: string) => request<{ ok: boolean; reverted: number }>(`/pools/downloads/${encodeURIComponent(id)}/revert`, { method: "POST" }),
  deleteDownload: (id: string) => request<{ ok: boolean }>(`/pools/downloads/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getPoolPrice: (password: string, poolId: string) => {
    const enc = (s: string) => encodeURIComponent(s);
    return request<PoolPrice>(`/pools/${enc(password)}/${enc(poolId)}/price`);
  },
  setPoolPrice: (password: string, poolId: string, price: number) => {
    const enc = (s: string) => encodeURIComponent(s);
    return request<PoolPrice>(`/pools/${enc(password)}/${enc(poolId)}/price`, { method: "PUT", body: JSON.stringify({ price }) });
  },
  downloadHistory: () => request<{ downloads: unknown[] } | unknown[]>("/pools/downloads" as string) as Promise<{ downloads: unknown[] } | unknown[]>,
  redownload: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadById: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),
  downloadByIdBlob: (id: string) => requestBlob(`/pools/downloads/${encodeURIComponent(id)}`),

  me: async (): Promise<{ user: User | null; expired: boolean }> => {
    let res: Response;
    try {
      res = await fetch(BASE + "/auth/me", { credentials: "include" }).then(markConn);
    } catch (e) {
      useConnStore.setState({ status: "err" });
      throw e;
    }
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
  telegramConfig: () => request<{ clientId: string }>("/auth/telegram/config"),
  verifyTelegramLogin: (id_token: string, turnstile?: string | null) =>
    request<{ ok: boolean }>("/auth/telegram/verify", { method: "POST", body: JSON.stringify({ id_token, turnstile: turnstile || undefined }) }),
  claimDeviceSession: (token: string, turnstileToken?: string | null) =>
    request<{ ok: boolean }>("/auth/device/claim", { method: "POST", body: JSON.stringify({ token, turnstile: turnstileToken || undefined }) }),
};
