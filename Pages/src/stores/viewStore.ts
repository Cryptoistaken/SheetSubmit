import { create } from "zustand";

// File-grid view mode (grid / list). Shared between the floating toggle
// (regular users) and the sidebar footer toggle (admins) so both stay in sync.
export type FileViewMode = "grid" | "list";

const KEY = "ss_fileView";

function load(): FileViewMode {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

interface ViewState {
  view: FileViewMode;
  setViewMode: (v: FileViewMode) => void;
}

export const useViewStore = create<ViewState>()((set) => ({
  view: load(),
  setViewMode: (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      // ignore
    }
    set({ view: v });
  },
}));
