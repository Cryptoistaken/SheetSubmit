import type { LiveStates } from "./liveBus";

// One-time tickets gating the live row-state stream (GET /files/:id/live).
// The ticket is minted only after the normal session + owner-or-admin file
// check, so the stream itself carries no session — just ?ticket= (EventSource
// cannot set headers). Single-use, 60s TTL.
const TICKET_TTL_MS = 60_000;
const tickets = new Map<string, { fileId: string; exp: number }>();

export function mintLiveTicket(fileId: string, opts?: { now?: number }): string {
  const now = opts?.now ?? Date.now();
  if (tickets.size > 1000) for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
  const ticket = crypto.randomUUID().replaceAll("-", "");
  tickets.set(ticket, { fileId, exp: now + TICKET_TTL_MS });
  return ticket;
}

/** Returns the ticket's fileId on first valid use, else null (unknown, used, expired, or wrong clock). */
export function consumeLiveTicket(ticket: string, opts?: { now?: number }): string | null {
  const rec = tickets.get(ticket);
  if (!rec) return null;
  tickets.delete(ticket);
  if (rec.exp <= (opts?.now ?? Date.now())) return null;
  return rec.fileId;
}

// One-time tickets gating the pool-count stream
// (GET /pools/:password/:pool/live). Same 60s TTL single-use shape as file
// tickets, keyed by "password:pool" so a ticket never crosses pools.
const poolTickets = new Map<string, { poolKey: string; exp: number }>();

/** Room name for a pool's count pushes — prefixed so it never collides with fileId rooms. */
export const poolRoom = (password: string, pool: string) => `pool:${password}:${pool}`;

export function mintPoolLiveTicket(poolKey: string, opts?: { now?: number }): string {
  const now = opts?.now ?? Date.now();
  if (poolTickets.size > 1000) for (const [k, v] of poolTickets) if (v.exp <= now) poolTickets.delete(k);
  const ticket = crypto.randomUUID().replaceAll("-", "");
  poolTickets.set(ticket, { poolKey, exp: now + TICKET_TTL_MS });
  return ticket;
}

/** Returns the ticket's poolKey on first valid use, else null. */
export function consumePoolLiveTicket(ticket: string, opts?: { now?: number }): string | null {
  const rec = poolTickets.get(ticket);
  if (!rec) return null;
  poolTickets.delete(ticket);
  if (rec.exp <= (opts?.now ?? Date.now())) return null;
  return rec.poolKey;
}

export interface LiveRowState {
  src_file_id: string | null | undefined;
  row_key: string;
  hold: boolean;
  approved: boolean;
  dead: boolean;
}

/** Splits flat key-state rows per source file, emitting only set flags so an
 * all-false state explicitly clears. Rows without a source file are skipped. */
export function groupLiveStates(rows: LiveRowState[]): Record<string, LiveStates> {
  const out: Record<string, LiveStates> = {};
  for (const r of rows) {
    const fid = String(r.src_file_id || "");
    if (!fid || !r.row_key) continue;
    const st: LiveStates[string] = {};
    if (r.hold) st.hold = true;
    if (r.approved) st.approved = true;
    if (r.dead) st.dead = true;
    (out[fid] ??= {})[r.row_key] = st;
  }
  return out;
}

export const LIVE_KEY_CAP = 500;

/** Validates a worker→backend relay message (untrusted input): only the
 * dead-keys shape passes, keys capped and sanitized. */
export function parseLiveEvent(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as { type?: unknown; keys?: unknown };
  if (m.type !== "dead-keys" || !Array.isArray(m.keys)) return null;
  return m.keys
    .filter((k: unknown): k is string => typeof k === "string" && !!k && k.length <= 64)
    .slice(0, LIVE_KEY_CAP);
}
