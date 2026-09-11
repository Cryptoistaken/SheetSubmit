import { rpc } from "./do";
import { LIVE_KEY_CAP, groupLiveStates, type LiveRowState } from "./live";
import { publishLive, type LiveStates } from "./liveBus";

// DB → rooms bridge: after a mutation, resolve fresh per-file key states and
// fan them out. Fail-open by design — a live push must never break the
// mutation it follows.
function emitGrouped(map: Record<string, LiveStates> | null | undefined): number {
  let n = 0;
  for (const [fileId, states] of Object.entries(map || {})) {
    if (!fileId || !states || !Object.keys(states).length) continue;
    publishLive(fileId, states);
    n++;
  }
  return n;
}

/** Fresh states for one download's keys (hold / approve / reject / revert / fresh hold). */
export async function publishDownloadStates(password: string, downloadId: string): Promise<number> {
  if (!downloadId) return 0;
  try {
    const map = (await rpc("pools", password, "liveStatesByDownload", { id: downloadId })) as Record<string, LiveStates>;
    return emitGrouped(map);
  } catch {
    return 0;
  }
}

/** Fresh states for bare keys across passwords (markDead, worker relay). */
export async function publishKeyStates(keys: string[]): Promise<number> {
  const clean = [...new Set(keys.filter((k) => typeof k === "string" && !!k))].slice(0, LIVE_KEY_CAP);
  if (!clean.length) return 0;
  try {
    const rows = (await rpc("pools", "global", "liveStatesByKeys", { keys: clean })) as (LiveRowState & { password?: string })[];
    return emitGrouped(groupLiveStates(rows || []));
  } catch {
    return 0;
  }
}
