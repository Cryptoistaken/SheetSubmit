import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/api";
import { useConfirm } from "@/lib/confirm";
import { useToast } from "@/lib/toast";
import type { ArchiveFile } from "@/lib/types";

import EmptyState from "./EmptyState";
import FileCard from "./FileCard";

export default function ArchiveView({
  selected,
  setSelected,
  view = "grid",
}: {
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  view?: "grid" | "list";
}) {
  const [archived, setArchived] = useState<ArchiveFile[] | null>(null);
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
      showToast("Could not restore file. Try again.");
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
    const ok = await confirm("Permanently delete this file?", "Delete forever");
    if (!ok) return;
    try {
      await api.permanentDelete(id);
    } catch {
      showToast("Could not delete file. Try again.");
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

  // Worker caps: batch-delete ≤20 ids, batch-restore ≤40 (files.ts) — chunk to fit.
  const chunk = <T,>(arr: T[], n: number) =>
    arr.length <= n ? [arr] : Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

  const runBatched = async (
    ids: string[],
    cap: number,
    op: (batch: string[]) => Promise<number>,
  ): Promise<{ done: number; failed: number }> => {
    const results = await Promise.allSettled(chunk(ids, cap).map((b) => op(b)));
    const done = results.reduce((s, r) => s + (r.status === "fulfilled" ? r.value : 0), 0);
    return { done, failed: results.filter((r) => r.status === "rejected").length };
  };

  const plural = (n: number) => n + " file" + (n !== 1 ? "s" : "");

  const restoreSelected = async () => {
    const ids = Array.from(selected);
    const ok = await confirm("Restore " + plural(ids.length) + "?", "Restore");
    if (!ok) return;
    const { done, failed } = await runBatched(ids, 40, async (b) => {
      await api.batchRestore(b);
      return b.length;
    });
    setSelected(new Set());
    load();
    showToast(failed ? "Could not restore some files. Try again." : plural(done) + " restored");
  };

  const deleteSelected = async () => {
    const ids = Array.from(selected);
    const ok = await confirm(
      "Permanently delete " + plural(ids.length) + "?",
      "Delete forever",
    );
    if (!ok) return;
    const { done, failed } = await runBatched(ids, 20, async (b) => (await api.batchDelete(b)).deleted);
    setSelected(new Set());
    load();
    showToast(failed ? "Could not delete some files. Try again." : plural(done) + " permanently deleted");
  };

  if (archived === null) {
    return (
      <div role="status" aria-live="polite" aria-busy="true" style={{ padding: 24, textAlign: "center", color: "var(--text3)", fontSize: 13 }}>
        Loading…
      </div>
    );
  }

  return (
    <>
      {archived.length === 0 ? (
        <EmptyState title="No archived files" sub="Archived files appear here for 30 days" />
      ) : (
        <div className={view === "list" ? "files-list" : "files-grid"}>
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
                list={view === "list"}
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
      {selectionMode &&
        createPortal(
          <div className="home-tabs">
            {selected.size > 2 ? (
              <button className="home-tab" onClick={unselectAll}>Unselect all</button>
            ) : null}
            <button className="home-tab sel-primary" onClick={() => void restoreSelected()}>Restore ({selected.size})</button>
            <button className="home-tab sel-danger" onClick={() => void deleteSelected()}>Delete forever ({selected.size})</button>
            <button className="home-tab" onClick={selectAll}>Select all ({archived?.length ?? 0})</button>
          </div>,
          document.getElementById("homeTabBar")!,
        )}
    </>
  );
}
