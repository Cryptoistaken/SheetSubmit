import type { AdminUser, ArchiveFile, CrossDupResult, Row, SheetFile, User } from "./types";
import type { PoolDetail, PoolSummary, PoolUserFilesResult, VerifiedCounts } from "./api";

// Boneyard capture mode (`bunx boneyard-js build` / the vite plugin): the CLI
// sets window.__BONEYARD_BUILD before page load. The app then renders with the
// mock data below so skeletons snapshot the real loaded layout instead of the
// login screen. Never active in production.
export const isCapture =
  typeof window !== "undefined" &&
  (window as unknown as { __BONEYARD_BUILD?: boolean }).__BONEYARD_BUILD === true;

const DAY = 86_400_000;
const t = Date.now();

export const captureUser: User = {
  id: "987654321",
  name: "Alex Tester",
  firstName: "Alex",
  lastName: "Tester",
  username: "alextester",
  isAdmin: true,
  createdAt: t - 30 * DAY,
  fileCount: 5,
  archivedCount: 3,
};

const files: SheetFile[] = [
  { id: "f1", name: "Cookie 05 Sep 09:12", type: "fb_cookie", preset: "cookie", poolKind: "cookie", password: "dgddigital", poolEnabled: true, rowCount: 42, dataCount: 42, liveCount: 38, deadCount: 2, dupCount: 2, lastAction: "modified", createdAt: t - 2 * DAY, updatedAt: t - 3_600_000 },
  { id: "f2", name: "2fa 05 Sep 09:15", type: "fb_cookie", preset: "combo", poolKind: "combo", password: "dgddigital", poolEnabled: true, rowCount: 30, dataCount: 30, liveCount: 28, deadCount: 1, dupCount: 0, lastAction: "modified", createdAt: t - 2 * DAY, updatedAt: t - 7_200_000 },
  { id: "f3", name: "Page 05 Sep 09:20", type: "fb_cookie", preset: "page", poolKind: "page", password: "L0VE@12345", poolEnabled: false, rowCount: 18, dataCount: 18, pageCount: 12, dupCount: 0, lastAction: "modified", createdAt: t - 3 * DAY, updatedAt: t - 26_000_000 },
  { id: "f4", name: "Cookie 04 Sep 21:40", type: "fb_cookie", preset: "cookie", poolKind: "cookie", password: "dgddigital", poolEnabled: true, rowCount: 55, dataCount: 55, liveCount: 50, deadCount: 3, dupCount: 0, lastAction: "modified", createdAt: t - 4 * DAY, updatedAt: t - 50_000_000 },
  { id: "f5", name: "2fa 04 Sep 18:03", type: "fb_cookie", preset: "combo", poolKind: "combo", password: "L0VE@12345", poolEnabled: true, rowCount: 24, dataCount: 24, liveCount: 22, deadCount: 0, dupCount: 1, lastAction: "modified", createdAt: t - 5 * DAY, updatedAt: t - 80_000_000 },
];

const crossDups: CrossDupResult = {
  counts: { f1: 2, f2: 0, f3: 0, f4: 0, f5: 1 },
  dups: {
    "100000000000012": [{ fileId: "f1", fileName: files[0].name, rowIdx: 3 }],
    "100000000000042": [{ fileId: "f1", fileName: files[0].name, rowIdx: 7 }, { fileId: "f5", fileName: files[4].name, rowIdx: 2 }],
  },
};

const archive: ArchiveFile[] = [
  { id: "a1", name: "Cookie 01 Sep 10:11", type: "fb_cookie", preset: "cookie", poolKind: "cookie", password: "dgddigital", dataCount: 12, deletedAt: t - 2 * DAY, updatedAt: t - 2 * DAY },
  { id: "a2", name: "2fa 20 Aug 15:30", type: "fb_cookie", preset: "combo", poolKind: "combo", password: "L0VE@12345", dataCount: 8, deletedAt: t - 25 * DAY, updatedAt: t - 25 * DAY },
  { id: "a3", name: "Page 18 Aug 09:00", type: "fb_cookie", preset: "page", poolKind: "page", password: "dgddigital", dataCount: 20, deletedAt: t - 5 * DAY, updatedAt: t - 5 * DAY },
];

const pools: PoolSummary[] = [
  { id: "cookies_only", label: "Cookies", badge: "Cookies", cols: ["cookies"], filename: "cookies_pool.xlsx", password: "dgddigital", available: 124, claimed: 89, users: 3 },
  { id: "cookies_2fa", label: "2FA", badge: "2FA", cols: ["cookies", "twofakey"], filename: "2fa_pool.xlsx", password: "dgddigital", available: 61, claimed: 44, users: 2 },
  { id: "page", label: "Page", badge: "Page", cols: ["cookies", "twofakey"], filename: "page_pool.xlsx", password: "dgddigital", available: 33, claimed: 12, users: 1 },
];

const poolDetail: PoolDetail = {
  pool: { id: "cookies_only", label: "Cookies", badge: "Cookies", cols: ["cookies"], filename: "cookies_pool.xlsx" },
  password: "dgddigital",
  totals: { available: 124, claimed: 89, users: 3 },
  users: [
    { userId: "987654321", displayName: "Alex Tester", username: "alextester", firstName: "Alex", lastName: "Tester", isAdmin: true, available: 50, claimed: 30 },
    { userId: "100000000000001", displayName: "Rahim Khan", username: "rahimk", firstName: "Rahim", lastName: "Khan", isAdmin: false, available: 44, claimed: 39 },
    { userId: "100000000000002", displayName: "Sara Ahmed", username: "saraah", firstName: "Sara", lastName: "Ahmed", isAdmin: false, available: 30, claimed: 20 },
  ],
};

const userFiles: PoolUserFilesResult = {
  users: [
    { userId: "987654321", files: [{ fileId: "f1", available: 30, claimed: 10 }, { fileId: "f4", available: 20, claimed: 20 }], totalAvailable: 50, totalClaimed: 30 },
    { userId: "100000000000001", files: [{ fileId: "f2", available: 44, claimed: 39 }], totalAvailable: 44, totalClaimed: 39 },
    { userId: "100000000000002", files: [{ fileId: "f3", available: 30, claimed: 20 }], totalAvailable: 30, totalClaimed: 20 },
  ],
  noSrcAvail: 0,
};

const downloads = [
  { id: "dl1", at: t - 3_600_000, ts: t - 3_600_000, poolId: "cookies_only", password: "dgddigital", claimed: 10, claimedBy: "987654321", filename: "cookies_pool.xlsx", reverted: false, rows: [{ cookies: "c_user=100000000000012;" }], keys: ["cookies"], groups: [{ srcUid: "100000000000012", srcFileId: "f1", count: 10 }] },
  { id: "dl2", at: t - DAY, ts: t - DAY, poolId: "cookies_2fa", password: "dgddigital", claimed: 50, claimedBy: "100000000000001", filename: "2fa_pool.xlsx", reverted: true, rows: [], keys: ["cookies", "twofakey"], groups: [] },
];

const verifiedCounts: VerifiedCounts = { pool: "page", verified: 9, unverified: 21, totalAvailable: 30, truncated: false, scanCap: 1000 };

const adminUsers: AdminUser[] = [
  { ...captureUser, fileCount: 5, archivedCount: 3, banned: false },
  { id: "100000000000001", name: "Rahim Khan", firstName: "Rahim", lastName: "Khan", username: "rahimk", isAdmin: false, banned: false, createdAt: t - 10 * DAY, fileCount: 2, archivedCount: 1 },
  { id: "100000000000002", name: "Sara Ahmed", firstName: "Sara", lastName: "Ahmed", username: "saraah", isAdmin: false, banned: true, createdAt: t - 5 * DAY, fileCount: 1, archivedCount: 0 },
];

const adminUserDetail: AdminUser = { ...adminUsers[1], files: [files[0], files[1]] };

const uid = (i: number) => `1000000000000${String(i).padStart(2, "0")}`;
const mkCookie = (id: string) => `c_user=${id}; xs=42%3A${id}dA%3A1%3A1; fr=0${id.slice(-4)}.Tiny.1.3; datr=${id.slice(-6)}`;
const mkTwofa = (i: number) => (i % 6 === 0 ? "No_2Fa" : `JBSWY3DPEHPK3PXP${String(i).padStart(2, "0")}`);

const smokeFile: SheetFile = {
  id: "smoke",
  name: "2fa 05 Sep 10:00",
  type: "fb_cookie",
  preset: "combo",
  poolKind: "combo",
  password: "dgddigital",
  poolEnabled: true,
  columns: [
    { key: "cookies", label: "cookies", width: 340 },
    { key: "twofakey", label: "2fa key", width: 200 },
    { key: "uid", label: "uid", width: 120 },
  ],
  rowCount: 24,
  dataCount: 24,
  createdAt: t - DAY,
  updatedAt: t,
};

const smokeRows: Row[] = Array.from({ length: 24 }, (_, i) => {
  const id = uid(i);
  return {
    cookies: mkCookie(id),
    uid: id,
    twofakey: mkTwofa(i),
    status: i % 4 === 1 ? "good" : i % 4 === 3 ? "bad" : "",
    wa_status: i % 5 === 0 ? "eligible" : "",
  };
});

const mocks: Record<string, unknown> = {
  "files.list": files,
  crossdups: crossDups,
  "archive.list": archive,
  "pools.list": { pools },
  "pool.detail": poolDetail,
  "pool.downloads": downloads,
  "pool.userFiles": userFiles,
  "pool.verifiedCounts": verifiedCounts,
  "admin.stats": { totalUsers: 3, totalFiles: 9 },
  "admin.users": adminUsers,
  "admin.user": adminUserDetail,
  "admin.user.archive": [archive[1]],
  "file.full": { file: smokeFile, rows: smokeRows, logs: [], undo: [], redo: [], seq: 5 },
  "file.rows": smokeRows,
  "admin.file": smokeFile,
  "admin.file.rows": smokeRows,
  "admin.file.logs": [],
  "admin.file.undo": { undo: [], redo: [] },
  "wa.cache": { cache: {} },
};

export function captureMock(op: string): unknown {
  return mocks[op];
}
