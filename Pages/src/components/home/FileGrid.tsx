import type { SheetFile } from "@/lib/types";

import EmptyState from "./EmptyState";
import FileCard from "./FileCard";

interface FileGridProps {
  files: SheetFile[];
  crossDupCounts: Record<string, number>;
  selectedIds: Set<string>;
  selectionMode: boolean;
  view?: "grid" | "list";
  onOpen: (id: string) => void;
  onDownload: (file: SheetFile) => void;
  onRename: (file: SheetFile) => void;
  onDelete: (file: SheetFile) => void;
  onToggleSelect: (id: string) => void;
}

export default function FileGrid({
  files,
  crossDupCounts,
  selectedIds,
  selectionMode,
  view = "grid",
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onToggleSelect,
}: FileGridProps) {
  if (files.length === 0) {
    return <EmptyState title="No files yet" sub="Tap the + button to create your first file" />;
  }
  const sorted = [...files].sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
  return (
    <div className={view === "list" ? "files-list" : "files-grid"}>
      {sorted.map((f, i) => (
        <FileCard
          key={f.id}
          file={f}
          recent={i === 0}
          list={view === "list"}
          crossDupCount={crossDupCounts[f.id]}
          selected={selectedIds.has(f.id)}
          selectionMode={selectionMode}
          onOpen={() => onOpen(f.id)}
          onDownload={() => onDownload(f)}
          onRename={() => onRename(f)}
          onDelete={() => onDelete(f)}
          onToggleSelect={() => onToggleSelect(f.id)}
        />
      ))}
    </div>
  );
}
