import { useEffect } from "react";
import { useSheetStore } from "@/stores/sheetStore";

export function usePersist(): void {
  useEffect(() => {
    const flush = () => {
      void useSheetStore.getState().flushPersist(undefined, true);
    };
    const onVis = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
}
