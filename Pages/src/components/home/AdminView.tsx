import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { useAuth } from "@/contexts/AuthContext";
import { useProfileCache } from "@/stores/profileCache";
import { VerifiedIcon } from "@/components/icons/FileTypeIcons";
import { fileTypeDef } from "@/lib/types";
import type { AdminUser, ArchiveFile, SheetFile } from "@/lib/types";
import { downloadXlsx } from "@/lib/xlsx";
import ProfileAvatar from "@/components/profile/ProfileAvatar";
import EmptyState from "./EmptyState";
import PageSkeleton, { Skeleton } from "@/components/ui/page-skeleton";
import FileCard from "./FileCard";
import SearchInput from "@/components/ui/search-input";

function userName(u: { name?: string; firstName?: string; lastName?: string; username?: string }): string {
  return u.name?.trim() || ((u.firstName ?? "") + " " + (u.lastName ?? "")).trim() || (u.username ? "@" + u.username : "") || "Unknown";
}

export default function AdminView({ initialUserId, view = "grid" }: { initialUserId?: string; view?: "grid" | "list" }) {
  const showToast = useToast();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const navigate = useNavigate();

  const [stats, setStats] = useState<{ totalUsers: number; totalFiles: number } | null>(null);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [detailUser, setDetailUser] = useState<AdminUser | null>(null);
  const [detailArchived, setDetailArchived] = useState<ArchiveFile[]>([]);
  const [search, setSearch] = useState("");
  const [renameFileId, setRenameFileId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [userFileTab, setUserFileTab] = useState<"files" | "archive">("files");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadList = useCallback(async () => {
    const [s, u] = await Promise.all([api.adminStats(), api.adminUsers()]);
    setStats(s);
    setUsers(u);
    useProfileCache.getState().setProfiles(u as unknown[]);
  }, []);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const showList = useCallback(() => {
    // Use navigate to keep browser history correct: detail -> list.
    // If we arrived via direct /admin/user/:id link, this returns to /admin.
    if (detailUser) navigate("/admin");
    else navigate("/admin");
  }, [navigate, detailUser]);

  const showDetail = useCallback((userId: string) => {
    // Push route — HomePage's initialUserId + useEffect will load detail.
    // This makes UI Back and system back (browser) both return to /admin list.
    navigate(`/admin/user/${userId}`);
  }, [navigate]);

  // Deep-link sync: /admin/user/:id opens that user's detail; /admin resets to list.
  // Fetch detail directly here (not via showDetail's navigate) to avoid loop.
  useEffect(() => {
    if (initialUserId) {
      void (async () => {
        try {
          const [u, a] = await Promise.all([api.adminUser(initialUserId), api.adminUserArchive(initialUserId)]);
          setDetailUser(u);
          setDetailArchived(a);
          useProfileCache.getState().setProfiles([u as unknown]);
        } catch {
          // user not found — back to list
          navigate("/admin");
        }
      })();
    } else {
      setDetailUser(null);
      setDetailArchived([]);
      loadList();
    }
  }, [initialUserId, loadList, navigate]);

  const onSearch = (q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      const query = q.trim();
      if (query) {
        try {
          setUsers(await api.adminSearchUsers(query));
        } catch {
          showToast("Could not search users. Try again.");
          loadList();
        }
      } else {
        loadList();
      }
    }, 300);
  };

  const deleteUser = async () => {
    if (!detailUser) return;
    const ok = await confirm("Permanently delete this user and all their files?", "Delete User");
    if (!ok) return;
    try {
      await api.adminDeleteUser(detailUser.id);
    } catch {
      showToast("Could not delete user. Try again.");
      return;
    }
    showToast("User deleted");
    showList();
  };

  const banUser = async () => {
    if (!detailUser) return;
    const ok = await confirm("Ban this user?", "Ban");
    if (!ok) return;
    try {
      await api.adminBanUser(detailUser.id);
    } catch {
      showToast("Could not ban user. Try again.");
      return;
    }
    setDetailUser({ ...detailUser, banned: true });
    showToast("User banned");
    loadList();
  };

  const unbanUser = async () => {
    if (!detailUser) return;
    const ok = await confirm("Unban this user?", "Unban");
    if (!ok) return;
    try {
      await api.adminUnbanUser(detailUser.id);
    } catch {
      showToast("Could not unban user. Try again.");
      return;
    }
    setDetailUser({ ...detailUser, banned: false });
    showToast("User unbanned");
    loadList();
  };

  const removeFile = async (fileId: string) => {
    const ok = await confirm("Move this file to archive?", "Archive");
    if (!ok) return;
    try {
      await api.adminDeleteFile(fileId);
    } catch {
      showToast("Could not archive file. Try again.");
      return;
    }
    showToast("File archived");
    if (detailUser) showDetail(detailUser.id);
  };

  const downloadFile = async (file: SheetFile) => {
    const rows = await api.adminFileRows(file.id);
    if (!rows || !rows.length) {
      showToast("No data to download. Check file contents.");
      return;
    }
    try {
      await downloadXlsx(rows, fileTypeDef(file.type).columns, file.name);
      showToast("Downloaded");
    } catch {
      showToast("Could not download file. Check your connection.");
    }
  };

  const openRename = (fileId: string, name: string) => {
    setRenameFileId(fileId);
    setRenameName(name);
  };

  const commitRename = async () => {
    const name = renameName.trim();
    if (!name) {
      showToast("Name is required. Enter a file name.");
      return;
    }
    if (!renameFileId) return;
    try {
      await api.adminUpdateFile(renameFileId, { name });
    } catch {
      showToast("Could not rename file. Try again.");
      return;
    }
    setRenameFileId(null);
    showToast("Renamed");
    if (detailUser) showDetail(detailUser.id);
  };

  const restoreArchived = async (fileId: string) => {
    if (!detailUser) return;
    try {
      await api.adminRestoreArchived(detailUser.id, fileId);
    } catch {
      showToast("Could not restore file. Try again.");
      return;
    }
    showToast("File restored");
    showDetail(detailUser.id);
  };

  const deleteArchived = async (fileId: string) => {
    if (!detailUser) return;
    const ok = await confirm("Permanently delete this file?", "Delete forever");
    if (!ok) return;
    try {
      await api.adminDeleteArchived(detailUser.id, fileId);
    } catch {
      showToast("Could not delete file. Try again.");
      return;
    }
    showToast("Permanently deleted");
    showDetail(detailUser.id);
  };

  if (initialUserId && !detailUser && users === null) {
    return <PageSkeleton variant="admin-detail" />;
  }

  if (detailUser) {
    const files = detailUser.files ?? [];
    return (
      <>
        <button className="btn btn-ghost admin-back-btn" onClick={showList}>
          <ArrowLeft size={14} />
          Back to users
        </button>
        <div className="admin-user-header">
          <div className="admin-detail-header">
            <div style={{ position: "relative", flexShrink: 0 }}>
              <ProfileAvatar
                userId={detailUser.id}
                photoUrl={detailUser.photoUrl}
                fallback={userName(detailUser).charAt(0).toUpperCase()}
                className="admin-detail-avatar admin-user-avatar-placeholder"
              />
              {detailUser.isAdmin ? (
                <span title="Verified" style={{ position: "absolute", right: -4, bottom: -4, width: 18, height: 18, display: "grid", placeItems: "center", color: "#1d9bf0", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))" }}><VerifiedIcon size={18} /></span>
              ) : null}
            </div>
            <div className="admin-detail-info">
              <div className="admin-detail-name" dir="auto" style={{ unicodeBidi: "isolate" }}>{userName(detailUser)}</div>
              <div className="admin-detail-meta">
                {detailUser.username ? "@" + detailUser.username : "ID: " + detailUser.id}
              </div>
              <div className="admin-detail-meta">
                Joined{" "}
                {detailUser.createdAt
                  ? new Date(detailUser.createdAt).toLocaleDateString()
                  : "—"}
              </div>
              <div className="admin-detail-meta">
                {detailUser.fileCount || 0} files, {detailUser.archivedCount || 0} archived
              </div>
            </div>
            <div className="admin-detail-actions">
                {!detailUser.isAdmin && detailUser.id !== me?.id ? (
                <>
                  {detailUser.banned ? (
                    <button className="btn btn-sm" onClick={unbanUser}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><title>ban</title><path fill="currentColor" d="M12 2c5.5 0 10 4.5 10 10s-4.5 10-10 10S2 17.5 2 12S6.5 2 12 2m0 2c-1.9 0-3.6.6-4.9 1.7l11.2 11.2c1-1.4 1.7-3.1 1.7-4.9c0-4.4-3.6-8-8-8m4.9 14.3L5.7 7.1C4.6 8.4 4 10.1 4 12c0 4.4 3.6 8 8 8c1.9 0 3.6-.6 4.9-1.7" /></svg>
                      Unban User
                    </button>
                  ) : (
                    <button className="btn btn-danger btn-sm" onClick={banUser}>
                      <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><title>ban</title><path fill="currentColor" d="M12 2c5.5 0 10 4.5 10 10s-4.5 10-10 10S2 17.5 2 12S6.5 2 12 2m0 2c-1.9 0-3.6.6-4.9 1.7l11.2 11.2c1-1.4 1.7-3.1 1.7-4.9c0-4.4-3.6-8-8-8m4.9 14.3L5.7 7.1C4.6 8.4 4 10.1 4 12c0 4.4 3.6 8 8 8c1.9 0 3.6-.6 4.9-1.7" /></svg>
                      Ban User
                    </button>
                  )}
                  <button className="btn btn-danger btn-sm" onClick={deleteUser}>
                    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><title>delete</title><path fill="currentColor" d="M7 21q-.825 0-1.412-.587T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413T17 21zm2-4h2V8H9zm4 0h2V8h-2z" /></svg>
                    Delete User
                  </button>
                </>
              ) : detailUser.isAdmin ? (
                <span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 600 }}>Admin — no delete/ban</span>
              ) : null}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <div className="pool-switch">
            <button className={userFileTab === "files" ? "active" : ""} aria-expanded={userFileTab === "files"} onClick={() => setUserFileTab("files")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512" aria-hidden="true" className="dark:hidden"><linearGradient id="SVGnuJMQSqw" x1="256" x2="256" y1="506.703" y2="5.298" gradientUnits="userSpaceOnUse"><stop offset="0" /><stop offset=".5" stop-opacity=".75" /><stop offset="1" stop-opacity=".5" /></linearGradient><path fill="url(#SVGnuJMQSqw)" d="M503.2 146.5L256 5.3L8.8 146.5V196l30.9 17.6l-30.9 17.7v49.4l30.9 17.7L8.8 316v49.5L256 506.7l247.2-141.2V316l-30.9-17.6l30.9-17.7v-49.4l-30.9-17.7l30.9-17.6z" /><path d="M508.5 196v-49.4c0-1.9-1-3.7-2.7-4.6L258.6.7c-1.6-.9-3.6-.9-5.3 0L6.2 141.9c-1.7.9-2.7 2.7-2.7 4.6V196c0 1.9 1 3.7 2.7 4.6l22.8 13l-22.8 13.1c-1.7.9-2.7 2.7-2.7 4.6v49.4c0 1.9 1 3.7 2.7 4.6L29 298.4l-22.8 13c-1.7.9-2.7 2.7-2.7 4.6v49.4c0 1.9 1 3.7 2.7 4.6l247.2 141.2c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7L505.8 370c1.6-.9 2.7-2.7 2.7-4.6V316c0-1.9-1-3.7-2.7-4.6l-22.8-13l22.8-13.1c1.6-.9 2.7-2.7 2.7-4.6v-49.4c0-1.9-1-3.7-2.7-4.6L483 213.6l22.8-13.1c1.6-.9 2.7-2.6 2.7-4.5M256 11.4l236.5 135.1L256 281.7L19.5 146.5zm241.9 351L256 500.6L14.1 362.4v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2zm-5.4-46.4L256 451.2L19.5 316l20.2-11.6l213.6 122.1c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l213.6-122.1zm5.4-38.4L256 415.9L14.1 277.6v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2zm-5.4-46.3L256 366.4L19.5 231.3l20.2-11.6l213.6 122.1c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l213.6-122.1zm5.4-38.4L256 331.1L14.1 192.9v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2z" /></svg>
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512" aria-hidden="true" className="hidden dark:inline"><title>databasement-light</title><linearGradient id="SVGvA5iYcsQ" x1="256" x2="256" y1="506.703" y2="5.298" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" /><stop offset=".5" stop-color="#fff" stop-opacity=".75" /><stop offset="1" stop-color="#fff" stop-opacity=".5" /></linearGradient><path fill="url(#SVGvA5iYcsQ)" d="M503.2 146.5L256 5.3L8.8 146.5V196l30.9 17.6l-30.9 17.7v49.4l30.9 17.7L8.8 316v49.5L256 506.7l247.2-141.2V316l-30.9-17.6l30.9-17.7v-49.4l-30.9-17.7l30.9-17.6z" /><path fill="#fff" d="M508.5 196v-49.4c0-1.9-1-3.7-2.7-4.6L258.6.7c-1.6-.9-3.6-.9-5.3 0L6.2 141.9c-1.7.9-2.7 2.7-2.7 4.6V196c0 1.9 1 3.7 2.7 4.6l22.8 13l-22.8 13.1c-1.7.9-2.7 2.7-2.7 4.6v49.4c0 1.9 1 3.7 2.7 4.6L29 298.4l-22.8 13c-1.7.9-2.7 2.7-2.7 4.6v49.4c0 1.9 1 3.7 2.7 4.6l247.2 141.2c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7L505.8 370c1.6-.9 2.7-2.7 2.7-4.6V316c0-1.9-1-3.7-2.7-4.6l-22.8-13l22.8-13.1c1.6-.9 2.7-2.7 2.7-4.6v-49.4c0-1.9-1-3.7-2.7-4.6L483 213.6l22.8-13.1c1.6-.9 2.7-2.6 2.7-4.5M256 11.4l236.5 135.1L256 281.7L19.5 146.5zm241.9 351L256 500.6L14.1 362.4v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2zm-5.4-46.4L256 451.2L19.5 316l20.2-11.6l213.6 122.1c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l213.6-122.1zm5.4-38.4L256 415.9L14.1 277.6v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2zm-5.4-46.3L256 366.4L19.5 231.3l20.2-11.6l213.6 122.1c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l213.6-122.1zm5.4-38.4L256 331.1L14.1 192.9v-37.2l239.2 136.7c.8.5 1.7.7 2.6.7s1.8-.2 2.6-.7l239.2-136.7v37.2z" /></svg>
              Files <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 11, opacity: .7 }}>{files.length}</span></button>
            <button className={userFileTab === "archive" ? "active" : ""} aria-expanded={userFileTab === "archive"} onClick={() => setUserFileTab("archive")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512" aria-hidden="true" className="dark:hidden"><title>opnsense-dark</title><path d="M112 0v112h288v288h112V160.2L352.4 0zm288 512V400H112V112H0v240.4L160.2 512z" /></svg>
              <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 512 512" aria-hidden="true" className="hidden dark:inline"><title>opnsense</title><path fill="#de3c07" d="M512 160.2V400H400V112H112V0h240.4zM112 112H0v240.4L160.2 512H400V400H112z" /></svg>
              Archive <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 11, opacity: .7 }}>{detailArchived.length}</span></button>
          </div>
        </div>

        {userFileTab === "files" ? (
          files.length === 0 ? (
            <EmptyState title="No files" sub="This user has no files yet" />
          ) : (
            <div className={view === "list" ? "files-list" : "files-grid"}>
              {files.map((f) => (
                <FileCard
                  key={f.id}
                  file={f}
                  list={view === "list"}
                  selectable={false}
                  onOpen={() => navigate(`/admin/user/${detailUser.id}/file/${f.id}`)}
                  onDownload={() => void downloadFile(f)}
                  onRename={() => openRename(f.id, f.name)}
                  onDelete={() => void removeFile(f.id)}
                  onToggleSelect={() => {}}
                />
              ))}
            </div>
          )
        ) : detailArchived.length === 0 ? (
          <EmptyState title="No archived files" sub="Archived files appear here for 30 days" />
        ) : (
          <div className={view === "list" ? "files-list" : "files-grid"}>
            {detailArchived.map((f) => {
              const daysLeft = Math.max(
                0,
                30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000),
              );
              return (
                <FileCard
                  key={f.id}
                  file={f}
                  list={view === "list"}
                  selectable={false}
                  disableOpen
                  daysLeft={daysLeft}
                  onRestore={() => void restoreArchived(f.id)}
                  onDelete={() => void deleteArchived(f.id)}
                  onToggleSelect={() => {}}
                />
              );
            })}
          </div>
        )}

        <div
          className={`modal-overlay${renameFileId ? " open" : ""}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setRenameFileId(null);
          }}
        >
          <div className="modal-box" role="dialog" aria-modal="true" aria-label="Rename file">
            <div className="modal-title">Rename file</div>
            <input
              className="modal-input"
              type="text"
              aria-label="File name"
              value={renameName}
              autoFocus
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === "Escape") {
                  setRenameFileId(null);
                }
              }}
            />
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={() => setRenameFileId(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={commitRename}>
                Rename
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (users === null) return <PageSkeleton variant="admin" />;

  return (
      <>
      <div className="admin-stats">
        <div className="admin-stat-card" aria-busy={stats === null}>
          <div className="admin-stat-value">{stats ? stats.totalUsers : "—"}</div>
          <div className="admin-stat-label">Total Users</div>
        </div>
        <div className="admin-stat-card" aria-busy={stats === null}>
          <div className="admin-stat-value">{stats ? stats.totalFiles : "—"}</div>
          <div className="admin-stat-label">Total Files</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 500 }}>{users === null ? <Skeleton className="h-4 w-20" /> : `${users.length} users`}</div>
        <SearchInput
            placeholder="Search users..."
            aria-label="Search users"
            autoComplete="off"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            containerStyle={{ width: 240, maxWidth: "48vw", marginLeft: "auto" }}
        />
      </div>
      <div className="admin-user-list">
        {users === null
          ? (
              <PageSkeleton variant="admin" />
            )
          : users.length === 0
            ? (
                <EmptyState title="No users found" sub={search.trim() ? "Try a different search" : "No users yet"} />
              )
            : users.map((u) => {
                const name = userName(u);
                const joined = u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "";
                return (
                  <div
                    key={u.id}
                    className="admin-user-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => showDetail(u.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        showDetail(u.id);
                      }
                    }}
                  >
                    <div className="admin-user-avatar-wrap" style={{ position: "relative" }}>
                      <ProfileAvatar
                        userId={u.id}
                        photoUrl={u.photoUrl}
                        fallback={name.charAt(0).toUpperCase()}
                        className="admin-user-avatar admin-user-avatar-placeholder"
                      />
                      {u.isAdmin ? (
                        <span title="Verified" style={{ position: "absolute", right: -4, bottom: -4, width: 18, height: 18, display: "grid", placeItems: "center", color: "#1d9bf0", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.15))" }}><VerifiedIcon size={18} /></span>
                      ) : null}
                    </div>
                    <div className="admin-user-info">
                      <div className="admin-user-name" dir="auto" style={{ unicodeBidi: "isolate" }}>
                        <span dir="auto" style={{ unicodeBidi: "isolate" }}>{name}</span>
                        {u.banned ? (
                          <span
                            style={{
                              marginLeft: 6,
                              fontSize: 10,
                              fontWeight: 700,
                              color: "var(--red)",
                              background: "var(--red-bg)",
                              padding: "2px 6px",
                              borderRadius: 4,
                            }}
                          >
                            BANNED
                          </span>
                        ) : null}
                      </div>
                      <div className="admin-user-username">
                        {u.username ? "@" + u.username : "ID: " + u.id}
                      </div>
                    </div>
                    <div className="admin-user-meta">
                      <div className="admin-user-stat">
                        <span className="admin-user-stat-val">{u.fileCount || 0}</span> files
                      </div>
                      <div className="admin-user-stat">
                        <span className="admin-user-stat-val">{joined}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
      </div>
      </>
  );
}
