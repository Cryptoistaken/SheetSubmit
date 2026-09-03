import { create } from "zustand";

interface BubbleState {
  on: boolean;
  pickMode: boolean;
  setOn: (on: boolean) => void;
  setPickMode: (pickMode: boolean) => void;
}

export const useBubbleStore = create<BubbleState>()((set) => ({
  on: false,
  pickMode: false,
  setOn: (on) => set({ on }),
  setPickMode: (pickMode) => set({ pickMode }),
}));