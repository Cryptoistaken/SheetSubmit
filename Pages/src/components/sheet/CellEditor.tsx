import { useRef } from "react";
import type { KeyboardEvent } from "react";

import { useSheetStore } from "@/stores/sheetStore";

export default function CellEditor() {
  const draft = useSheetStore((s) => s.draft);
  const inputRef = useRef<HTMLInputElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const store = useSheetStore.getState();
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        store.moveEdit(1, 0);
        break;
      case "Tab":
        e.preventDefault();
        store.moveEdit(0, e.shiftKey ? -1 : 1);
        break;
      case "ArrowDown":
        e.preventDefault();
        store.moveEdit(1, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        store.moveEdit(-1, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        store.moveEdit(0, 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        store.moveEdit(0, -1);
        break;
      case "Escape":
        e.preventDefault();
        store.cancelQuickEdit();
        break;
    }
  };

  return (
    <input
      ref={inputRef}
      className="qeb-input"
      type="text"
      aria-label="Cell value"
      placeholder="Enter cell value"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      value={draft}
      onChange={(e) => useSheetStore.getState().setDraft(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}
