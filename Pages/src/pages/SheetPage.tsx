import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { Skeleton } from "boneyard-js/react";

import QuickEditBar from "@/components/sheet/QuickEditBar";
import SelectionBar from "@/components/sheet/SelectionBar";
import SheetGrid from "@/components/sheet/SheetGrid";
import { useConfirm } from "@/lib/confirm";
import { usePersist } from "@/hooks/usePersist";
import { useSheetStore } from "@/stores/sheetStore";

export default function SheetPage() {
  const params = useParams();
  const navigate = useNavigate();
  const status = useSheetStore((s) => s.status);
  const fileName = useSheetStore((s) => s.file?.name);
  const fileId = params.fileId ?? params.id;
  const ownerId = params.userId;
  const confirm = useConfirm();

  usePersist();

  // File name in the tab so several open sheets stay distinguishable.
  useEffect(() => {
    document.title = fileName ? `${fileName} — SheetSubmit` : "SheetSubmit";
    return () => {
      document.title = "SheetSubmit";
    };
  }, [fileName]);

  useEffect(() => {
    if (!fileId) return;
    if (ownerId) void useSheetStore.getState().openFileAdmin(fileId, ownerId);
    else void useSheetStore.getState().openFile(fileId);
    return () => {
      void useSheetStore.getState().closeFile();
    };
  }, [fileId, ownerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const store = useSheetStore.getState();
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (e.key === "Escape") {
        // Inputs (cell editor, modals) handle Escape themselves; do not yank
        // selection state out from under an open edit.
        if (typing) return;
        useSheetStore.getState().exitSelectionMode();
        return;
      }
      if (typing || !store.isDesktop) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (store.selectionMode) {
          e.preventDefault();
          void confirm("Delete selected cells? This can be undone.").then((ok) => {
            if (ok) useSheetStore.getState().deleteSelected();
          });
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        store.selectAllCells();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        if (store.selectionMode) {
          e.preventDefault();
          void store.copySelected();
        }
        return;
      }
      if (!store.selectionMode && store.file) {
        const visible = store.columns.filter((c) => store.visibleCols.has(c.key));
        if (visible.length && store.rows.length) {
          const cur = store.selectedCell;
          let nextRow = cur?.rowIdx ?? 0;
          let nextCol =
            cur?.colIdx && visible.some((c) => c.key === cur.colIdx)
              ? cur.colIdx
              : visible[0].key;
          const colIdx = visible.findIndex((c) => c.key === nextCol);
          let moved = false;
          if (e.key === "ArrowUp") {
            e.preventDefault();
            moved = true;
            nextRow = Math.max(nextRow - 1, 0);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            moved = true;
            nextRow = Math.min(nextRow + 1, store.rows.length - 1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            moved = true;
            if (colIdx > 0) nextCol = visible[colIdx - 1].key;
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            moved = true;
            if (colIdx < visible.length - 1) nextCol = visible[colIdx + 1].key;
          } else if (e.key === "Enter") {
            if (cur && !store.inlineEdit) {
              e.preventDefault();
              store.openInlineEdit(cur.rowIdx, cur.colIdx);
            }
            return;
          }
          if (moved) store.focusCell(nextRow, nextCol);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirm]);

  if (status === "error") {
    return (
      <div className="home-pane">
        <div className="empty-state">
          <div className="empty-state-title">Could not open file</div>
          <button
            className="btn btn-ghost"
            onClick={() => navigate(ownerId ? `/admin/user/${ownerId}` : "/")}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <Skeleton
      name="sheet-grid"
      loading={status === "loading" || status === "idle"}
      transition={300}
      color="#ececec"
      darkColor="#262626"
      fallback={
        <div className="home-pane">
          <div className="empty-state">
            <div className="empty-state-title">Loading…</div>
          </div>
        </div>
      }
    >
      <div className="sheet-view">
        <SheetGrid />
        <QuickEditBar />
        <SelectionBar />
      </div>
    </Skeleton>
  );
}
