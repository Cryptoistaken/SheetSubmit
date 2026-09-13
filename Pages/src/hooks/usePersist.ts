import { useEffect } from "react";
import { useSheetStore } from "@/stores/sheetStore";

export function usePersist(): void {
  useEffect(() => {
    const commitAndFlush = () => {
      // An open editor holds text only in memory (draft): commit it into the
      // journal first, or a kill loses it — flush alone can't see it.
      useSheetStore.getState().commitQuickEdit();
      void useSheetStore.getState().flushPersist(undefined, true);
    };
    const flush = () => {
      commitAndFlush();
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") commitAndFlush();
      else {
        // back online / back in tab with pending edits → sync now.
        const st = useSheetStore.getState();
        if (st.isDirty || st.changeJournal.length || st.dirtyStructural) void st.flushPersist();
      }
    };
    const onOnline = () => {
      const st = useSheetStore.getState();
      if (st.isDirty || st.changeJournal.length || st.dirtyStructural) void st.flushPersist();
    };
    // Dumb retry pipe for the durable outbox: while edits are unsynced, poke
    // the flush every 5s (a no-op flush returns in microseconds when clean).
    const retry = setInterval(() => {
      const st = useSheetStore.getState();
      if (!st.fileId || !st.file) return;
      if (st.isDirty || st.changeJournal.length || st.dirtyStructural) void st.flushPersist();
    }, 5000);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(retry);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
}
