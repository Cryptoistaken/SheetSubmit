import { Archive, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import { fileTypeDef } from "@/lib/types";
import type { ArchiveFile } from "@/lib/types";

import EmptyState from "./EmptyState";

export default function ArchiveView() {
  const [archived, setArchived] = useState<ArchiveFile[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const showToast = useToast();
  const confirm = useConfirm();

  const load = useCallback(() => {
    api
      .getArchive()
      .then(setArchived)
      .catch(() => setArchived([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selectionMode = selected.size > 0;

  const handleCardSelect = (id: string) => {
    setSelected((prev) => {
      if (prev.size === 0) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const restoreOne = async (id: string) => {
    try {
      await api.restoreFile(id);
    } catch {
      showToast("Restore failed");
      return;
    }
    showToast("File restored");
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    load();
  };

  const deleteOne = async (id: string) => {
    const ok = await confirm("Permanently delete this file?", "Delete Forever");
    if (!ok) return;
    try {
      await api.permanentDelete(id);
    } catch {
      showToast("Delete failed");
      return;
    }
    showToast("Permanently deleted");
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    load();
  };

  const selectAll = () => {
    if (archived) setSelected(new Set(archived.map((f) => f.id)));
  };

  const unselectAll = () => setSelected(new Set());

  const restoreSelected = async () => {
    const ids = Array.from(selected);
    const ok = await confirm(
      "Restore " + ids.length + " file" + (ids.length > 1 ? "s" : "") + "?",
      "Restore",
    );
    if (!ok) return;
    try {
      await api.batchRestore(ids);
    } catch {
      showToast("Restore failed");
      return;
    }
    setSelected(new Set());
    load();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " restored");
  };

  const deleteSelected = async () => {
    const ids = Array.from(selected);
    const ok = await confirm(
      "Permanently delete " + ids.length + " file" + (ids.length > 1 ? "s" : "") + "?",
      "Delete Forever",
    );
    if (!ok) return;
    try {
      await api.batchDelete(ids);
    } catch {
      showToast("Delete failed");
      return;
    }
    setSelected(new Set());
    load();
    showToast(ids.length + " file" + (ids.length > 1 ? "s" : "") + " permanently deleted");
  };

  if (archived === null) return null;

  return (
    <>
      {archived.length === 0 ? (
        <EmptyState title="No archived files" sub="Deleted files appear here for 30 days" />
      ) : (
        <div className="files-grid">
          {archived.map((f) => {
            const daysLeft = Math.max(
              0,
              30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000),
            );
            return (
              <div
                key={f.id}
                className={`file-card${selected.has(f.id) ? " selected" : ""}`}
                role="button"
                tabIndex={0}
                style={{ userSelect: "none", WebkitUserSelect: "none", touchAction: "manipulation" } as React.CSSProperties}
                onClick={() => handleCardSelect(f.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleCardSelect(f.id);
                  }
                }}
              >
                <div className="file-card-icon" style={{ opacity: 0.5 }}>
                  <Archive size={16} />
                </div>
                <div className="file-card-name" style={{ opacity: 0.7 }}>
                  {f.name}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginTop: 2 }}>
                  <span className="file-type-badge t-fb">{fileTypeDef(f.type).badge}</span>
                  {(() => { const pw = (f as ArchiveFile).password ?? "dgddigital"; const isCust = pw !== "dgddigital" && pw !== "L0VE@12345"; const lbl = pw === "dgddigital" ? "dgd" : pw === "L0VE@12345" ? "L0VE" : pw.slice(0, 8); const st: React.CSSProperties = isCust ? { background: "var(--fb-bg)", color: "var(--fb)" } : pw === "L0VE@12345" ? { background: "#fffbeb", color: "#b45309", border: "1px solid #fde68a" } : { background: "var(--bg3)", color: "var(--text2)" }; return <span className="file-type-badge" style={{ ...st, fontSize: 10, padding: "2px 6px" } as React.CSSProperties} title={pw}>{lbl}</span>; })()}
                  <span className="file-card-meta">{daysLeft} days left</span>
                </div>
                <div className="file-card-actions">
                  <button
                    className="file-card-btn archive-restore"
                    title="Restore"
                    aria-label="Restore"
                    onClick={(e) => {
                      e.stopPropagation();
                      restoreOne(f.id);
                    }}
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    className="file-card-btn archive-del"
                    title="Delete permanently"
                    aria-label="Delete permanently"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteOne(f.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className={`sel-bar${selectionMode ? " open" : ""}`}>
        <span className="sel-bar-count">{selected.size} selected</span>
        <div className="sel-bar-actions">
          <button className="sel-btn" onClick={selectAll}>
            Select All
          </button>
          <button className="sel-btn" onClick={unselectAll}>
            Unselect All
          </button>
          <button className="sel-btn" onClick={restoreSelected}>
            Restore
          </button>
          <button className="sel-btn danger" onClick={deleteSelected}>
            Delete
          </button>
        </div>
      </div>
    </>
  );
}
