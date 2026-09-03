import type { SheetFile } from "@/lib/types";

import EmptyState from "./EmptyState";
import FileCard from "./FileCard";

interface FileGridProps {
  files: SheetFile[];
  crossDupCounts: Record<string, number>;
  selectedIds: Set<string>;
  selectionMode: boolean;
  onOpen: (id: string) => void;
  onDownload: (file: SheetFile) => void;
  onRename: (file: SheetFile) => void;
  onDelete: (file: SheetFile) => void;
  onToggleSelect: (id: string) => void;
  onHoldSelect: (id: string) => void;
}

export default function FileGrid({
  files,
  crossDupCounts,
  selectedIds,
  selectionMode,
  onOpen,
  onDownload,
  onRename,
  onDelete,
  onToggleSelect,
  onHoldSelect,
}: FileGridProps) {
  if (files.length === 0) {
    return <EmptyState title="No files yet" sub="Tap the + button to create your first file" />;
  }
  return (
    <div className="files-grid">
      {files.map((f) => (
        <FileCard
          key={f.id}
          file={f}
          crossDupCount={crossDupCounts[f.id]}
          selected={selectedIds.has(f.id)}
          selectionMode={selectionMode}
          onOpen={() => onOpen(f.id)}
          onDownload={() => onDownload(f)}
          onRename={() => onRename(f)}
          onDelete={() => onDelete(f)}
          onToggleSelect={() => onToggleSelect(f.id)}
          onHoldSelect={() => onHoldSelect(f.id)}
        />
      ))}
    </div>
  );
}
