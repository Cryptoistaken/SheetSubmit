import { useEffect, useState } from "react";

import { offlineSync } from "@/offline/sync";

const POLL_MS = 5000;

export default function OfflineBanner() {
  const [online, setOnline] = useState(() => offlineSync.isOnline());
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    const unsub = offlineSync.subscribe(() => {
      setOnline(offlineSync.isOnline());
    });
    return unsub;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      offlineSync
        .pendingCount()
        .then((n) => {
          setPending(n);
          if (n > 0) {
            if (!timer) timer = setInterval(poll, POLL_MS);
          } else if (timer) {
            clearInterval(timer);
            timer = null;
          }
        })
        .catch(() => {});
    };
    poll();
    return () => {
      if (timer) clearInterval(timer);
    };
  }, []);

  if (online && pending === 0) return null;

  const syncNow = async () => {
    setSyncing(true);
    try {
      await offlineSync.flush();
      setPending(await offlineSync.pendingCount().catch(() => 0));
    } finally {
      setSyncing(false);
    }
  };

  if (!online) {
    return (
      <div className="offline-banner offline">
        <span className="offline-banner-dot" />
        <span>Offline — changes saved locally</span>
      </div>
    );
  }

  return (
    <div className="offline-banner syncing">
      <span className="offline-banner-dot" />
      <span>
        Syncing… {pending} change{pending === 1 ? "" : "s"} saved offline
      </span>
      <button
        className="btn btn-sm"
        disabled={syncing}
        onClick={() => void syncNow()}
      >
        {syncing ? "Syncing…" : "Sync now"}
      </button>
    </div>
  );
}