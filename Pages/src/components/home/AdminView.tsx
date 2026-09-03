import { Archive, ArrowLeft, Download, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { useAuth } from "@/contexts/AuthContext";
import { fileTypeDef } from "@/lib/types";
import type { AdminUser, ArchiveFile, SheetFile } from "@/lib/types";
import { downloadXlsx } from "@/lib/xlsx";

function userName(u: { firstName?: string; lastName?: string }): string {
  return ((u.firstName ?? "") + " " + (u.lastName ?? "")).trim() || "Unknown";
}

export default function AdminView({ initialUserId }: { initialUserId?: string }) {
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
          showToast("Search failed");
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
      showToast("Delete failed");
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
      showToast("Ban failed");
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
      showToast("Unban failed");
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
      showToast("Failed to archive file");
      return;
    }
    showToast("File archived");
    if (detailUser) showDetail(detailUser.id);
  };

  const downloadFile = async (file: SheetFile) => {
    const rows = await api.adminFileRows(file.id);
    if (!rows || !rows.length) {
      showToast("No data");
      return;
    }
    try {
      await downloadXlsx(rows, fileTypeDef(file.type).columns, file.name);
      showToast("Downloaded");
    } catch {
      showToast("Download failed");
    }
  };

  const openRename = (fileId: string, name: string) => {
    setRenameFileId(fileId);
    setRenameName(name);
  };

  const commitRename = async () => {
    const name = renameName.trim();
    if (!name) {
      showToast("Name cannot be empty");
      return;
    }
    if (!renameFileId) return;
    try {
      await api.adminUpdateFile(renameFileId, { name });
    } catch {
      showToast("Rename failed");
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
      showToast("Restore failed");
      return;
    }
    showToast("File restored");
    showDetail(detailUser.id);
  };

  const deleteArchived = async (fileId: string) => {
    if (!detailUser) return;
    const ok = await confirm("Permanently delete this file?", "Delete Forever");
    if (!ok) return;
    try {
      await api.adminDeleteArchived(detailUser.id, fileId);
    } catch {
      showToast("Delete failed");
      return;
    }
    showToast("Permanently deleted");
    showDetail(detailUser.id);
  };

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
              {detailUser.photoUrl ? (
                <img className="admin-detail-avatar" src={detailUser.photoUrl} alt="" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
              ) : (
                <div className="admin-detail-avatar admin-user-avatar-placeholder">
                  {userName(detailUser).charAt(0).toUpperCase()}
                </div>
              )}
              {detailUser.isAdmin ? (
                <span title="Admin" style={{ position: "absolute", right: -3, bottom: -3, width: 14, height: 14, borderRadius: "50%", background: "var(--blue)", border: "2px solid var(--bg)", display: "grid", placeItems: "center", color: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,.15)" }}><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M5 13l4 4L19 7" /></svg></span>
              ) : null}
            </div>
            <div className="admin-detail-info">
              <div className="admin-detail-name">{userName(detailUser)}</div>
              <div className="admin-detail-meta">
                {detailUser.username ? "@" + detailUser.username : "ID: " + detailUser.id}
              </div>
              <div className="admin-detail-meta">
                Last login:{" "}
                {detailUser.lastLogin
                  ? new Date(detailUser.lastLogin).toLocaleString()
                  : "Never"}
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
                      Unban User
                    </button>
                  ) : (
                    <button className="btn btn-danger btn-sm" onClick={banUser}>
                      Ban User
                    </button>
                  )}
                  <button className="btn btn-danger btn-sm" onClick={deleteUser}>
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
            <button className={userFileTab === "files" ? "active" : ""} onClick={() => setUserFileTab("files")}>Files <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 11, opacity: .7 }}>{files.length}</span></button>
            <button className={userFileTab === "archive" ? "active" : ""} onClick={() => setUserFileTab("archive")}>Archive <span style={{ marginLeft: 6, fontFamily: "var(--mono)", fontSize: 11, opacity: .7 }}>{detailArchived.length}</span></button>
          </div>
        </div>

        <div className="admin-file-list">
          {(userFileTab === "files" ? files : detailArchived).length === 0 && userFileTab === "files" ? <div style={{ gridColumn: "1/-1", padding: 16, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No files</div> : null}
          {(userFileTab === "archive" && detailArchived.length === 0) ? <div style={{ gridColumn: "1/-1", padding: 16, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>No archived files</div> : null}
          {(userFileTab === "files" ? files : []).map((f) => {
            const count = f.dataCount ?? f.rowCount ?? 0;
            return (
              <div
                key={f.id}
                className="file-card"
                role="button"
                tabIndex={0}
                title={"Open " + f.name}
                onClick={() => navigate(`/admin/user/${detailUser.id}/file/${f.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/admin/user/${detailUser.id}/file/${f.id}`);
                  }
                }}
              >
                <div className="file-card-icon">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5" />
                    <path d="M8.5 8.5v.01" />
                    <path d="M16 15.5v.01" />
                    <path d="M12 12v.01" />
                    <path d="M11 17v.01" />
                    <path d="M7 14v.01" />
                  </svg>
                </div>
                <div className="file-card-name">{f.name}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                  <span className="file-type-badge t-fb">{fileTypeDef(f.type).label}</span>
                  {(() => { const pw = (f as SheetFile).password ?? "dgddigital"; const isCust = pw !== "dgddigital" && pw !== "L0VE@12345"; const lbl = pw === "dgddigital" ? "dgd" : pw === "L0VE@12345" ? "L0VE" : pw.slice(0, 8); const st: React.CSSProperties = isCust ? { background: "var(--fb-bg)", color: "var(--fb)" } : pw === "L0VE@12345" ? { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" } : { background: "var(--bg3)", color: "var(--text2)" }; return <span className="file-type-badge" style={{ ...st, fontSize: 10, padding: "2px 6px" } as React.CSSProperties} title={pw}>{lbl}</span>; })()}
                  <span className="file-card-meta">
                    {count} row{count !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="file-card-actions">
                  <button
                    className="file-card-btn admin-file-dl"
                    title="Download"
                    aria-label="Download"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadFile(f);
                    }}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    className="file-card-btn admin-file-rename"
                    title="Rename"
                    aria-label="Rename"
                    onClick={(e) => {
                      e.stopPropagation();
                      openRename(f.id, f.name);
                    }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    className="file-card-btn admin-file-del file-card-del"
                    title="Delete"
                    aria-label="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(f.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          {userFileTab === "archive" ? detailArchived.map((f) => {
                const daysLeft = Math.max(
                  0,
                  30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000),
                );
                return (
                  <div key={f.id} className="file-card" style={{ opacity: 0.85 }}>
                    <div className="file-card-icon" style={{ opacity: 0.5 }}>
                      <Archive size={16} />
                    </div>
                    <div className="file-card-name">{f.name}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                      <span className="file-type-badge t-fb">{fileTypeDef(f.type).label}</span>
                      {(() => { const pw = (f as SheetFile).password ?? "dgddigital"; const isCust = pw !== "dgddigital" && pw !== "L0VE@12345"; const lbl = pw === "dgddigital" ? "dgd" : pw === "L0VE@12345" ? "L0VE" : pw.slice(0, 8); const st: React.CSSProperties = isCust ? { background: "var(--fb-bg)", color: "var(--fb)" } : pw === "L0VE@12345" ? { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" } : { background: "var(--bg3)", color: "var(--text2)" }; return <span className="file-type-badge" style={{ ...st, fontSize: 10, padding: "2px 6px" } as React.CSSProperties} title={pw}>{lbl}</span>; })()}
                      <span className="file-card-meta">{daysLeft} days left</span>
                    </div>
                    <div className="file-card-actions">
                      <button
                        className="file-card-btn admin-archive-restore"
                        title="Restore"
                        aria-label="Restore"
                        onClick={(e) => {
                          e.stopPropagation();
                          restoreArchived(f.id);
                        }}
                      >
                        <RotateCcw size={14} />
                      </button>
                      <button
                        className="file-card-btn admin-archive-del file-card-del"
                        title="Delete permanently"
                        aria-label="Delete permanently"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteArchived(f.id);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              }) : null}
        </div>

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

  return (
    <>
      <div className="admin-stats">
        <div className="admin-stat-card">
          <div className="admin-stat-value">{stats?.totalUsers ?? 0}</div>
          <div className="admin-stat-label">Total Users</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-value">{stats?.totalFiles ?? 0}</div>
          <div className="admin-stat-label">Total Files</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--text3)", fontWeight: 500 }}>{users ? `${users.length} users` : ""}</div>
        <label style={{ position: "relative", display: "inline-flex", alignItems: "center", marginLeft: "auto" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ position: "absolute", left: 10, color: "var(--text3)", pointerEvents: "none" }}><circle cx="11" cy="11" r="7" /><path d="M20 20L16 16" /></svg>
          <input
            type="text"
            className="admin-search-input"
            placeholder="Search users..."
            aria-label="Search users"
            autoComplete="off"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            style={{ width: 240, maxWidth: "48vw", paddingLeft: 32 }}
          />
        </label>
      </div>
      <div className="admin-user-list">
        {users === null
          ? null
          : users.length === 0
            ? (
                <div className="empty-state">
                  <div className="empty-state-title">No users found</div>
                </div>
              )
            : users.map((u) => {
                const name = userName(u);
                const lastLogin = u.lastLogin
                  ? new Date(u.lastLogin).toLocaleDateString()
                  : "Never";
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
                      {u.photoUrl ? (
                        <img className="admin-user-avatar" src={u.photoUrl} alt="" loading="lazy" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="admin-user-avatar admin-user-avatar-placeholder">
                          {name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      {u.isAdmin ? (
                        <span title="Admin" style={{ position: "absolute", right: -3, bottom: -3, width: 14, height: 14, borderRadius: "50%", background: "var(--blue)", border: "2px solid var(--bg)", display: "grid", placeItems: "center", color: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,.15)" }}><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><path d="M5 13l4 4L19 7" /></svg></span>
                      ) : null}
                    </div>
                    <div className="admin-user-info">
                      <div className="admin-user-name">
                        {name}
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
                        <span className="admin-user-stat-val">{lastLogin}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
      </div>
    </>
  );
}
