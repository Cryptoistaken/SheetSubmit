import { useConfirm } from "@/lib/confirm";
import { useSheetStore } from "@/stores/sheetStore";

export default function SelectionBar() {
  const selectionMode = useSheetStore((s) => s.selectionMode);
  const selectedItems = useSheetStore((s) => s.selectedItems);
  const size = selectedItems.size;
  const confirm = useConfirm();

  if (!selectionMode || size === 0) return null;

  return (
    <div className="sel-bar open">
      <span className="sel-bar-count">{size} selected</span>
      <div className="sel-bar-actions">
        <button
          className="sel-btn danger"
          onClick={async () => {
            const ok = await confirm("Delete selected cells? This can be undone.");
            if (!ok) return;
            useSheetStore.getState().deleteSelected();
          }}
        >
          Delete
        </button>
        <button
          className="sel-btn"
          onClick={() => void useSheetStore.getState().copySelected()}
        >
          Copy
        </button>
        <button
          className="sel-btn"
          onClick={() => useSheetStore.getState().selectAllCells()}
        >
          Select All
        </button>
        <button
          className="sel-btn"
          onClick={() => useSheetStore.getState().unselectAll()}
        >
          Unselect All
        </button>
      </div>
    </div>
  );
}
