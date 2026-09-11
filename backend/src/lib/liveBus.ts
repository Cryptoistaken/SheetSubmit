// In-process fan-out for live row-state pushes: one room per fileId.
// Slice 2 adds Redis relay on top (publish → rooms + channel, subscribe →
// rooms) without changing this interface.
export interface LiveFlag { hold?: boolean; approved?: boolean; dead?: boolean }
export type LiveStates = Record<string, LiveFlag>;
type Sink = (msg: string) => void;

const rooms = new Map<string, Set<Sink>>();

export function joinLive(fileId: string, sink: Sink): () => void {
  let set = rooms.get(fileId);
  if (!set) {
    set = new Set();
    rooms.set(fileId, set);
  }
  set.add(sink);
  return () => {
    set.delete(sink);
    if (!set.size) rooms.delete(fileId);
  };
}

export function publishLive(fileId: string, states: LiveStates): void {
  publishRoom(fileId, { states });
}

/** Raw fan-out to any room (pool-count rooms carry their own envelope). */
export function publishRoom(room: string, payload: unknown): void {
  const sinks = rooms.get(room);
  if (!sinks || !sinks.size) return;
  const msg = JSON.stringify(payload);
  for (const sink of [...sinks]) {
    try {
      sink(msg);
    } catch {
      // a broken sink unsubscribes on stream cancel; never fail a publish
    }
  }
}
