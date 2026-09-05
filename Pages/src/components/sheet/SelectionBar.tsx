import { useConfirm } from "@/lib/confirm";
import { useSheetStore } from "@/stores/sheetStore";

export default function SelectionBar() {
  const selectionMode = useSheetStore((s) => s.selectionMode);
  const selectedItems = useSheetStore((s) => s.selectedItems);
  const size = selectedItems.size;
  const confirm = useConfirm();

  if (!selectionMode || size === 0) return null;

  return (
    <div className="sel-bar open" role="toolbar" aria-label="Selection actions">
      <span className="sel-bar-count" role="status" aria-live="polite" aria-atomic="true">{size} selected</span>
      <div className="sel-bar-actions">
        <button
          className="sel-btn"
          aria-label="Copy selected cells"
          onClick={() => void useSheetStore.getState().copySelected()}
        >
          Copy
        </button>
        <button
          className="sel-btn danger"
          aria-label="Clear selected cells"
          onClick={async () => {
            const ok = await confirm("Clear selected cells? This can be undone.", "Clear");
            if (!ok) return;
            useSheetStore.getState().deleteSelected();
          }}
        >
          Clear
        </button>
        <button
          className="sel-btn"
          aria-label="Select all cells"
          onClick={() => useSheetStore.getState().selectAllCells()}
        >
          Select all
        </button>
        <button
          className="sel-btn"
          aria-label="Unselect all cells"
          onClick={() => useSheetStore.getState().unselectAll()}
        >
          Unselect all
        </button>
      </div>
    </div>
  );
}
