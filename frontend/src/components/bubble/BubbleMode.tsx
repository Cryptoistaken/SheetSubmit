import { useEffect, useRef } from "react";

import QuickEditBar from "@/components/sheet/QuickEditBar";
import SheetGrid from "@/components/sheet/SheetGrid";
import { usePersist } from "@/hooks/usePersist";
import { toast } from "@/lib/toast";
import { useSheetStore } from "@/stores/sheetStore";

interface AndroidBridge {
  readClipboard?: () => string;
  writeClipboard?: (t: string) => void;
}

function getAndroid(): AndroidBridge | null {
  try {
    return (window as unknown as { Android?: AndroidBridge }).Android ?? null;
  } catch {
    return null;
  }
}

function readClipboardText(): Promise<string> {
  const android = getAndroid();
  if (android?.readClipboard) {
    try {
      return Promise.resolve(android.readClipboard() || "");
    } catch {
      // fall through
    }
  }
  return navigator.clipboard.readText().catch(() => "");
}

function looksLikeCookie(t: string): boolean {
  return (
    t.indexOf("c_user=") !== -1 && t.indexOf(";") !== -1 && t.indexOf("=") !== -1
  );
}

function looksLikeKey(t: string): boolean {
  const cleaned = (t || "").replace(/[\s\-]/g, "").toUpperCase();
  return cleaned.length >= 10 && /^[A-Z2-7]+$/.test(cleaned);
}

export default function BubbleMode({ fileId }: { fileId: string }) {
  const status = useSheetStore((s) => s.status);
  const fileType = useSheetStore((s) => s.file?.type);
  const automationRef = useRef<{ run: () => void } | null>(null);

  usePersist();

  useEffect(() => {
    document.body.classList.add("bubble-mode");
    return () => document.body.classList.remove("bubble-mode");
  }, []);

  useEffect(() => {
    void useSheetStore.getState().openFile(fileId);
    return () => {
      void useSheetStore.getState().closeFile();
    };
  }, [fileId]);

  // Bubble default: only cookies + 2FA key columns visible (uid hidden) unless
  // the user has explicitly saved a column preference for this file.
  useEffect(() => {
    if (status !== "ready") return;
    try {
      if (!localStorage.getItem(`ss_cols_${fileId}`)) {
        useSheetStore.setState({ visibleCols: new Set(["cookies", "twofakey"]) });
      }
    } catch {
      // ignore malformed storage
    }
  }, [status, fileId]);

  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      void useSheetStore.getState().refreshSheet();
    };
    const schedule = () => {
      timer = setTimeout(() => {
        check();
        schedule();
      }, 6000);
    };
    check();
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || fileType !== "fb_cookie") return;
    const st: {
      stopped: boolean;
      busy: boolean;
      retries: number;
      lastText: string | null;
      lastAt: number;
      timer: ReturnType<typeof setTimeout> | null;
    } = {
      stopped: false,
      busy: false,
      retries: 0,
      lastText: null,
      lastAt: 0,
      timer: null,
    };

    const run = () => {
      if (st.busy || st.stopped) return;
      const s = useSheetStore.getState();
      if (s.status !== "ready" || !s.fileId || s.file?.type !== "fb_cookie") {
        return;
      }
      void readClipboardText().then((raw) => {
        if (st.stopped) return;
        const t = (raw || "").trim();
        if (!t) {
          st.retries++;
          if (st.retries <= 6) {
            st.timer = setTimeout(run, 400);
          } else {
            st.retries = 0;
            toast("Nothing copied");
          }
          return;
        }
        st.retries = 0;
        const now = Date.now();
        if (st.lastText === t && now - st.lastAt < 15000) {
          toast(looksLikeCookie(t) ? "Duplicate cookie" : "Duplicate 2FA");
          return;
        }
        st.lastText = t;
        st.lastAt = now;
        st.busy = true;
        const finish = () => {
          st.busy = false;
        };
        if (looksLikeCookie(t)) {
          useSheetStore.getState().bubbleSaveCookie(t);
          finish();
        } else if (looksLikeKey(t)) {
          void useSheetStore.getState().bubbleSaveKey(t).finally(finish);
        } else {
          toast("No cookie or key");
          finish();
        }
      });
    };

    automationRef.current = { run };
    run();
    return () => {
      st.stopped = true;
      if (st.timer) clearTimeout(st.timer);
      automationRef.current = null;
    };
  }, [status, fileType]);

  useEffect(() => {
    const ss = (window as unknown as Record<string, unknown>).__ss as
      | Record<string, unknown>
      | undefined;
    const holder = ss ?? {};
    holder.bubbleSkipNo2FA = () => useSheetStore.getState().bubbleSkipNo2FA();
    holder.bubbleAutomate = () => automationRef.current?.run();
    (window as unknown as Record<string, unknown>).__ss = holder;
    return () => {
      const cur = (window as unknown as Record<string, unknown>).__ss as
        | Record<string, unknown>
        | undefined;
      if (cur) {
        delete cur.bubbleSkipNo2FA;
        delete cur.bubbleAutomate;
      }
    };
  }, []);

  useEffect(() => {
    if (status === "ready" && fileType && fileType !== "fb_cookie") {
      toast("Not a FB file");
    }
  }, [status, fileType]);

  if (status === "error") {
    return (
      <div className="home-pane">
        <div className="empty-state">
          <div className="empty-state-title">Failed to load bubble file</div>
        </div>
      </div>
    );
  }

  if (status === "loading" || status === "idle") {
    return <div className="flex h-dvh flex-col" />;
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="sheet-view">
        <SheetGrid />
        <QuickEditBar />
      </div>
    </div>
  );
}
