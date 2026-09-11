import { useEffect } from "react";
import { api, apiBase } from "@/lib/api";
import { createLiveClient, type LiveClient } from "@/lib/live";
import { useSheetStore } from "@/stores/sheetStore";

// Live row-state pushes for the open file (owner + admin alike — SheetPage
// mounts this once). Ticket stream first, polling fallback when the stream
// cannot connect. Only overlay flags are ever applied, never cell values,
// and pushes for a previous file are ignored.
export function useLiveRows(): void {
  const fileId = useSheetStore((s) => s.fileId);
  const status = useSheetStore((s) => s.status);

  useEffect(() => {
    if (!fileId || status !== "ready") return;
    const id = fileId;
    const client: LiveClient = createLiveClient({
      base: apiBase(),
      fileId: id,
      getTicket: () => api.requestLiveTicket(id).then((r) => r.ticket),
      onStates: (states) => {
        const st = useSheetStore.getState();
        if (st.fileId === id) st.applyLiveStates(states);
      },
      pollStates: async () => {
        try {
          if (useSheetStore.getState().fileId !== id) return null;
          const r = await api.getLiveState(id);
          return r.states;
        } catch {
          return null;
        }
      },
    });
    return () => client.close();
  }, [fileId, status]);
}
