import { useSheetStore } from "@/stores/sheetStore";

export function useUndoRedo(): {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
} {
  const canUndo = useSheetStore((s) => s.undoStack.length > 0);
  const canRedo = useSheetStore((s) => s.redoStack.length > 0);
  const undo = useSheetStore((s) => s.undo);
  const redo = useSheetStore((s) => s.redo);
  return { canUndo, canRedo, undo, redo };
}
