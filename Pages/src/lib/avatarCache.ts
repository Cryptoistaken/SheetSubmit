import { useEffect, useState } from "react";

interface AvatarRecord {
  userId: string;
  hash: string;
  blob: Blob;
  ts: number;
}

const DB = "sheet-submit";
const STORE = "avatars";
const MAX_AGE = 7 * 24 * 3600 * 1000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "userId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getCached(userId: string): Promise<AvatarRecord | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(userId);
      req.onsuccess = () => resolve((req.result as AvatarRecord) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function putCached(rec: AvatarRecord): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // private mode etc — caching is best-effort
  }
}

async function sha256(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cached-first avatar URL: paints the stored bytes instantly, then swaps
 *  to the network image only if its hash actually changed. */
export function useAvatarUrl(
  userId: string | undefined,
  photoUrl: string | null | undefined,
): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!userId || !photoUrl) {
      setSrc(null);
      return;
    }
    let live = true;
    let objUrl: string | null = null;
    const show = (blob: Blob) => {
      if (objUrl) URL.revokeObjectURL(objUrl);
      objUrl = URL.createObjectURL(blob);
      if (live) setSrc(objUrl);
    };
    void getCached(userId).then((c) => {
      if (!live) return;
      if (c && Date.now() - c.ts < MAX_AGE) show(c.blob);
      else setSrc(photoUrl);
      fetch(photoUrl)
        .then(async (r) => {
          if (!r.ok) return;
          const blob = await r.blob();
          const hash = await sha256(blob);
          if (!live) return;
          if (!c || c.hash !== hash) {
            await putCached({ userId, hash, blob, ts: Date.now() });
            show(blob);
          }
        })
        .catch(() => {});
    });
    return () => {
      live = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [userId, photoUrl]);

  return src;
}
