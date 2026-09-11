import { Hono } from "hono";
import type { Env, Row, SheetFile } from "../lib/shared";
import { poolRowKey } from "../lib/shared";
import { isAdmin, requireAuth } from "../lib/session";
import { rpc } from "../lib/do";
import { consumeLiveTicket, consumePoolLiveTicket, mintLiveTicket, mintPoolLiveTicket, poolRoom } from "../lib/live";
import { joinLive } from "../lib/liveBus";
import { poolCountsSnapshot } from "../lib/livePublish";
import { decorateHoldState } from "./files";

// Live row-state pushes (slice 1: transport). The stream carries no session —
// access is granted by a one-time ticket minted below after the same
// owner-or-admin check the sheet open paths use.
export const live = new Hono<{ Bindings: Env; Variables: { uid: string } }>();

// Owner (non-archived) or admin — the same rule the sheet open paths use.
async function liveFile(c: any, id: string): Promise<SheetFile | null> {
  const found: any = await rpc(c.env.INDEX, "global", "file", { id }).catch(() => null);
  if (!found) return null;
  const uid = c.get("uid");
  if (found.owner_id === uid && !found.archived) return JSON.parse(found.data) as SheetFile;
  if (isAdmin(c.env, uid)) return JSON.parse(found.data) as SheetFile;
  return null;
}

live.post("/files/:id/live-ticket", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  const file = await liveFile(c, id);
  if (!file) return c.json({ error: "file not found" }, 404);
  return c.json({ ticket: mintLiveTicket(id) });
});

// Lightweight overlay for reconnect resync + polling fallback: key → flags
// only (never cell values, so applying it cannot clobber local edits).
live.get("/files/:id/live-state", requireAuth, async (c) => {
  const id = c.req.param("id");
  if (!id || id.length > 128) return c.json({ error: "invalid id" }, 400);
  const file = await liveFile(c, id);
  if (!file) return c.json({ error: "file not found" }, 404);
  const rows = (await rpc(c.env.FILES, id, "rows").catch(() => null)) as Row[] | null;
  if (!rows) return c.json({ error: "could not read file rows" }, 503);
  const overlayed = await decorateHoldState(c.env, (file as SheetFile & { password?: string }).password, rows);
  const states: Record<string, { hold?: boolean; approved?: boolean; dead?: boolean }> = {};
  for (const r of overlayed) {
    const k = poolRowKey(r);
    if (!k) continue;
    const f = r as Record<string, unknown>;
    const s: { hold?: boolean; approved?: boolean; dead?: boolean } = {};
    if (f._hold) s.hold = true;
    if (f._approved) s.approved = true;
    if (f._dead) s.dead = true;
    states[k] = s;
  }
  return c.json({ states });
});

live.get("/files/:id/live", async (c) => {
  const id = c.req.param("id");
  const ticket = c.req.query("ticket") || "";
  const fileId = ticket ? consumeLiveTicket(ticket) : null;
  if (!fileId || fileId !== id) return c.json({ error: "invalid ticket" }, 401);
  return streamRoom(c, id);
});

// Live pool counts (admin-only ticket, ticket-authed stream — same shape as
// the file stream above, rooms keyed pool:{password}:{poolId}).
const POOL_IDS = ["cookies_only", "cookies_2fa", "page"] as const;

live.post("/pools/:password/:pool/live-ticket", requireAuth, async (c) => {
  if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403);
  const pwd = c.req.param("password"), pid = c.req.param("pool") || "";
  if (!pwd || pwd.length > 64 || !(POOL_IDS as readonly string[]).includes(pid)) return c.json({ error: "invalid pool" }, 400);
  return c.json({ ticket: mintPoolLiveTicket(`${pwd}:${pid}`) });
});

live.get("/pools/:password/:pool/live", async (c) => {
  const pwd = c.req.param("password"), pid = c.req.param("pool") || "";
  const ticket = c.req.query("ticket") || "";
  const key = ticket ? consumePoolLiveTicket(ticket) : null;
  if (!key || key !== `${pwd}:${pid}`) return c.json({ error: "invalid ticket" }, 401);
  return streamRoom(c, poolRoom(pwd, pid));
});

// Counts snapshot for the 15s poll fallback (same shape the stream pushes,
// so the client patches in place). Heals worker-side drift: wa/page sweeps
// write pool_rows directly and only move the page verified split.
live.get("/pools/:password/:pool/live-state", requireAuth, async (c) => {
  if (!isAdmin(c.env, c.get("uid"))) return c.json({ error: "admin access required" }, 403);
  const pwd = c.req.param("password"), pid = c.req.param("pool") || "";
  if (!pwd || pwd.length > 64 || !(POOL_IDS as readonly string[]).includes(pid)) return c.json({ error: "invalid pool" }, 400);
  const snap = await poolCountsSnapshot(pwd, pid).catch(() => null);
  if (!snap) return c.json({ error: "pool not found" }, 404);
  return c.json(snap);
});

// Shared ticket-stream transport: :connected + 25s :ping over a room fan-out.
function streamRoom(c: any, room: string) {
  const enc = new TextEncoder();
  let leave: () => void = () => {};
  let beat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (msg: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${msg}\n\n`));
        } catch {
          // closed stream — cancel() unsubscribes
        }
      };
      leave = joinLive(room, send);
      try {
        controller.enqueue(enc.encode(`:connected\n\n`));
      } catch {}
      beat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(`:ping\n\n`));
        } catch {}
      }, 25_000);
      const unref = (beat as unknown as { unref?: () => void })?.unref;
      if (typeof unref === "function") unref.call(beat);
    },
    cancel() {
      if (beat) {
        try {
          clearInterval(beat);
        } catch {}
        beat = null;
      }
      leave();
    },
  });
  // ponytail: c.body (not raw Response) — a raw Response drops the CORS
  // headers the /api/* middleware set via c.header(), so cross-origin
  // EventSource streams failed with no ACAO and reconnected forever.
  return c.body(stream, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}
