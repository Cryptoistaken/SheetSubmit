import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, MoreHorizontal, RotateCcw } from "lucide-react";
import { useNavigate } from "react-router";
import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { dedupKeyForRow, useSheetStore } from "@/stores/sheetStore";
import { getCachedVersionRows, getVersionRows } from "@/stores/versionCache";
import type { VersionMeta } from "@/lib/types";

const PAGE_SIZE = 50;
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const ACTION_LABELS: Record<string, string> = {
  edit: "Edit",
  replace: "Replace",
  append: "Append",
  merge: "Merge",
  restore: "Restore",
  check: "Check",
  sync: "Sync",
  import: "Import",
};

function fmtVersionTime(ts: number): string {
  const d = new Date(ts);
  const diff = Date.now() - ts;
  let rel: string;
  if (diff < 60000) rel = "just now";
  else if (diff < 3600000) rel = Math.floor(diff / 60000) + " min ago";
  else if (diff < 86400000) rel = Math.floor(diff / 3600000) + " hr ago";
  else
    rel =
      Math.floor(diff / 86400000) +
      " day" +
      (Math.floor(diff / 86400000) > 1 ? "s" : "") +
      " ago";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getDate() +
    " " +
    MONTHS[d.getMonth()] +
    " " +
    d.getFullYear() +
    ", " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    "  (" +
    rel +
    ")"
  );
}

function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
}

function fmtDayHeader(ts: number): string {
  const d = new Date(ts);
  return WEEK[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
}

function computeSummary(rec: VersionMeta, prev: VersionMeta | null, fileId: string): string {
  if (!prev) {
    return (
      "Created file with " +
      rec.rowCount +
      " row" +
      (rec.rowCount === 1 ? "" : "s")
    );
  }
  const cur = getCachedVersionRows(fileId, rec.v);
  const old = getCachedVersionRows(fileId, prev.v);
  if (cur && old && cur.keys.size && old.keys.size) {
    let added = 0;
    let removed = 0;
    cur.keys.forEach((k) => {
      if (!old.keys.has(k)) added++;
    });
    old.keys.forEach((k) => {
      if (!cur.keys.has(k)) removed++;
    });
    let waChanged = 0;
    const oldByKey = new Map<string, unknown>();
    old.rows.forEach((r) => {
      const k = dedupKeyForRow(r);
      if (k !== null && k !== undefined) oldByKey.set(String(k), r);
    });
    cur.rows.forEach((r) => {
      const k = dedupKeyForRow(r);
      if (k === null || k === undefined) return;
      const o = oldByKey.get(String(k)) as { wa_status?: string } | undefined;
      if (o && (o.wa_status || "") !== (r.wa_status || "")) waChanged++;
    });
    const delta = (rec.rowCount ?? 0) - (prev.rowCount ?? 0);
    const parts: string[] = [];
    if (added) {
      parts.push(
        "Added " +
          added +
          " row" +
          (added === 1 ? "" : "s") +
          " (" +
          added +
          " new uid" +
          (added === 1 ? "" : "s") +
          ")",
      );
    }
    if (removed) {
      parts.push("Removed " + removed + " row" + (removed === 1 ? "" : "s"));
    }
    if (waChanged) {
      parts.push(
        "Changed wa_status on " + waChanged + " row" + (waChanged === 1 ? "" : "s"),
      );
    }
    if (!parts.length) {
      if (delta !== 0) {
        return "Full replace " + prev.rowCount + "→" + rec.rowCount + " rows";
      }
      return "Same rows (" + rec.rowCount + ")";
    }
    return parts.join(", ");
  }
  if (rec.rowCount !== prev.rowCount) {
    const d = (rec.rowCount ?? 0) - (prev.rowCount ?? 0);
    if (d > 0) return "+" + d + " rows";
    return d + " rows";
  }
  return "Same row count (" + rec.rowCount + " rows)";
}

function statCounts(
  rec: VersionMeta,
  prev: VersionMeta | null,
  fileId: string,
): { added: number; removed: number } {
  if (!prev) {
    return { added: rec.rowCount ?? 0, removed: 0 };
  }
  const cur = getCachedVersionRows(fileId, rec.v);
  const old = getCachedVersionRows(fileId, prev.v);
  if (cur && old && cur.keys.size && old.keys.size) {
    let added = 0;
    let removed = 0;
    cur.keys.forEach((k) => {
      if (!old.keys.has(k)) added++;
    });
    old.keys.forEach((k) => {
      if (!cur.keys.has(k)) removed++;
    });
    return { added, removed };
  }
  const delta = (rec.rowCount ?? 0) - (prev.rowCount ?? 0);
  return { added: Math.max(delta, 0), removed: Math.max(-delta, 0) };
}

interface ItemProps {
  rec: VersionMeta;
  prev: VersionMeta | null;
  fileId: string;
  summary: string;
  stats: { added: number; removed: number };
  renaming: { v: number; name: string } | null;
  onViewDiff: () => void;
  onRestore: () => void;
  onStartRename: () => void;
  onRenameChange: (name: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}

function VersionItem(props: ItemProps) {
  const { rec, summary, stats, renaming } = props;
  const isRenaming = renaming?.v === rec.v;
  const actionLabel = ACTION_LABELS[rec.action] ?? rec.action;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className="version-item">
      <div className="version-head">
        <div className="version-main">
          {rec.name && !isRenaming ? (
            <div className="version-name-row">
              <span className="version-name">{rec.name}</span>
              <button
                className="version-rename-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onStartRename();
                }}
              >
                Rename
              </button>
            </div>
          ) : null}
          {isRenaming ? (
            <div className="version-name-row">
              <input
                className="version-name-input"
                value={renaming.name}
                placeholder="Version name"
                aria-label="Version name"
                autoFocus
                onChange={(e) => props.onRenameChange(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") {
                    e.preventDefault();
                    props.onRenameCommit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    props.onRenameCancel();
                  }
                }}
                onBlur={props.onRenameCommit}
              />
            </div>
          ) : null}
          <div className="version-time">
            {fmtVersionTime(rec.ts)}
            <span className="version-action"> · {actionLabel}</span>
          </div>
        </div>
        <div className="version-side">
          <div className="version-chips">
            <span className="vstat-chip add">+{stats.added}</span>
            {stats.removed > 0 ? (
              <span className="vstat-chip del">−{stats.removed}</span>
            ) : null}
          </div>
          <div className="version-kebab-wrap" ref={menuRef}>
            <button
              className="version-kebab"
              aria-label="Version actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((o) => !o);
              }}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen ? (
              <div className="version-kebab-menu" role="menu">
                <button
                  className="version-menu-item"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    props.onViewDiff();
                  }}
                >
                  <Eye size={14} />
                  View diff
                </button>
                <button
                  className="version-menu-item danger"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                    props.onRestore();
                  }}
                >
                  <RotateCcw size={14} />
                  Restore
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <div className="version-summary">{summary}</div>
    </div>
  );
}

export default function VersionHistory({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const fileId = useSheetStore((s) => s.fileId);
  const adminMode = useSheetStore((s) => s.adminMode);
  const adminOwnerId = useSheetStore((s) => s.adminOwnerId);
  const restoreVersion = useSheetStore((s) => s.restoreVersion);
  const confirm = useConfirm();
  const showToast = useToast();
  const navigate = useNavigate();

  const [meta, setMeta] = useState<VersionMeta[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(1);
  const [groupsOpen, setGroupsOpen] = useState<Record<string, boolean>>({});
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ v: number; name: string } | null>(null);
  const renamingDone = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !fileId) return;
    setMeta(null);
    setLoadError(false);
    setPage(1);
    setGroupsOpen({});
    setSummaries({});
    setRenaming(null);
    renamingDone.current = false;
    const list = adminMode ? api.adminGetHistory(fileId) : api.getHistory(fileId);
    list
      .then((m) => setMeta(m ?? []))
      .catch(() => {
        setLoadError(true);
        setMeta([]);
      });
  }, [open, fileId, adminMode]);

  const pageItems = useMemo(() => {
    if (!meta || !meta.length) return [];
    const start = (page - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, meta.length);
    const items: { rec: VersionMeta; prev: VersionMeta | null }[] = [];
    for (let i = start; i < end; i++) {
      items.push({ rec: meta[i], prev: meta[i + 1] ?? null });
    }
    return items;
  }, [meta, page]);

  const groups = useMemo(() => {
    const out: {
      key: string;
      label: string;
      items: { rec: VersionMeta; prev: VersionMeta | null }[];
    }[] = [];
    pageItems.forEach((it) => {
      const key = dayKeyOf(it.rec.ts);
      let g = out.find((x) => x.key === key);
      if (!g) {
        g = { key, label: fmtDayHeader(it.rec.ts), items: [] };
        out.push(g);
      }
      g.items.push(it);
    });
    return out;
  }, [pageItems]);

  useEffect(() => {
    if (!fileId || !meta?.length) return;
    const upd: Record<string, string> = {};
    pageItems.forEach((it) => {
      upd["v" + it.rec.v] = computeSummary(it.rec, it.prev, fileId);
    });
    setSummaries(upd);
    let cursor = 0;
    const workers = Math.min(4, pageItems.length);
    const runWorker = async () => {
      while (cursor < pageItems.length) {
        const idx = cursor++;
        const it = pageItems[idx];
        await getVersionRows(fileId, it.rec.v, adminMode);
        setSummaries((old) => ({
          ...old,
          ["v" + it.rec.v]: computeSummary(it.rec, it.prev, fileId),
        }));
      }
    };
    for (let w = 0; w < workers; w++) void runWorker();
  }, [fileId, meta, pageItems, adminMode]);

  useEffect(() => {
    if (!open) return;
    boxRef.current?.focus();
  }, [open]);

  if (!open || !fileId) return null;

  const total = meta?.length ?? 0;
  const pages = total ? Math.ceil(total / PAGE_SIZE) : 1;
  const from = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, total);

  const startRename = (rec: VersionMeta) => {
    renamingDone.current = false;
    setRenaming({ v: rec.v, name: rec.name ?? "" });
  };
  const commitRename = () => {
    if (renamingDone.current) return;
    const r = renaming;
    if (!r) return;
    renamingDone.current = true;
    const req = adminMode
      ? api.adminNameVersion(fileId, r.v, r.name)
      : api.nameVersion(fileId, r.v, r.name);
    req
      .then((res) => {
        showToast(r.name ? "Version renamed" : "Version name cleared");
        if (res?.meta) setMeta(res.meta);
        setRenaming(null);
      })
      .catch(() => {
        showToast("Rename failed");
        setRenaming(null);
      });
  };
  const cancelRename = () => {
    if (renamingDone.current) return;
    renamingDone.current = true;
    setRenaming(null);
  };

  const restore = async (rec: VersionMeta) => {
    const ok = await confirm(
      "Restore version from " +
        fmtVersionTime(rec.ts).split("  (")[0] +
        "? Current rows will be replaced.",
      "Restore",
    );
    if (!ok) return;
    if (await restoreVersion(rec.v)) onClose();
  };

  const viewDiff = (rec: VersionMeta) => {
    onClose();
    if (adminMode) {
      navigate(`/admin/user/${adminOwnerId ?? ""}/file/${fileId}/version/${rec.v}`);
    } else {
      navigate("/file/" + fileId + "/version/" + rec.v);
    }
  };

  return (
    <div
      className="modal-overlay open"
      id="versionOverlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="Version history"
        ref={boxRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="modal-title">Version history</div>
        <div className="version-list">
          {meta === null ? (
            <div className="version-empty">Loading…</div>
          ) : loadError ? (
            <div className="version-empty">Could not load history</div>
          ) : total === 0 ? (
            <div className="version-empty">
              No versions yet - actions like replace, append, merge, check and sync
              are saved here.
            </div>
          ) : (
            <>
              <div className="version-pager">
                <span className="version-pager-info">
                  {"Page " +
                    page +
                    " of " +
                    pages +
                    " · " +
                    from +
                    "-" +
                    to +
                    " of " +
                    total}
                </span>
                <span className="version-pager-btns">
                  <button
                    className="version-page-btn"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    ← Prev
                  </button>
                  <button
                    className="version-page-btn"
                    disabled={page >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    Next →
                  </button>
                </span>
              </div>
              {groups.map((g) => (
                <div
                  key={g.key}
                  className={
                    "version-day-group" +
                    (groupsOpen[g.key] !== false ? " open" : "")
                  }
                >
                  <div
                    className="version-day"
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      setGroupsOpen((old) => ({
                        ...old,
                        [g.key]: old[g.key] !== false ? false : true,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setGroupsOpen((old) => ({
                          ...old,
                          [g.key]: old[g.key] !== false ? false : true,
                        }));
                      }
                    }}
                  >
                    <span className="version-day-label">{g.label}</span>
                    <span className="version-day-count">
                      {g.items.length === 1
                        ? "1 version"
                        : g.items.length + " versions"}
                    </span>
                  </div>
                  {g.items.map((it) => (
                    <VersionItem
                      key={it.rec.v}
                      rec={it.rec}
                      prev={it.prev}
                      fileId={fileId}
                      summary={
                        summaries["v" + it.rec.v] ??
                        computeSummary(it.rec, it.prev, fileId)
                      }
                      stats={statCounts(it.rec, it.prev, fileId)}
                      renaming={renaming}
                      onViewDiff={() => viewDiff(it.rec)}
                      onRestore={() => void restore(it.rec)}
                      onStartRename={() => startRename(it.rec)}
                      onRenameChange={(name) =>
                        setRenaming((r) => (r ? { v: r.v, name } : r))
                      }
                      onRenameCommit={commitRename}
                      onRenameCancel={cancelRename}
                    />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
