import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import type { ArchiveFile } from "@/lib/types";

import EmptyState from "./EmptyState";
import FileCard from "./FileCard";

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
          {[...archived].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)).map((f, i) => {
            const daysLeft = Math.max(
              0,
              30 - Math.floor((Date.now() - (f.deletedAt || 0)) / 86400000),
            );
            return (
              <FileCard
                key={f.id}
                file={f}
                recent={i === 0}
                selected={selected.has(f.id)}
                selectionMode={selectionMode}
                disableOpen
                daysLeft={daysLeft}
                onRestore={() => restoreOne(f.id)}
                onDelete={() => deleteOne(f.id)}
                onToggleSelect={() => handleCardSelect(f.id)}
              />
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
