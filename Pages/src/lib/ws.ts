import { create } from "zustand";

type WsStatus = "off" | "connecting" | "open" | "closed";

interface WsState {
  status: WsStatus;
  setStatus: (s: WsStatus) => void;
}

export const useWsStore = create<WsState>()((set) => ({
  status: "off",
  setStatus: (status) => set({ status }),
}));

let socket: WebSocket | null = null;
let nextId = 1;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Map<string, Set<(data: unknown) => void>>();

function emit(ev: string, data: unknown) {
  const set = listeners.get(ev);
  if (!set) return;
  for (const fn of set) {
    try { fn(data); } catch {}
  }
}

function wsUrl(ticket: string) {
  const raw = (window as unknown as { APP_CONFIG?: { wsBase?: string } }).APP_CONFIG?.wsBase ?? "";
  const base = raw ? raw.replace(/^http/, "ws") : "";
  return base + "/ws?t=" + ticket;
}

function clearHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function startHeartbeat() {
  clearHeartbeat();
  heartbeatTimer = setInterval(() => {
    wsCall("ping").catch(() => {
      try { socket?.close(); } catch {}
    });
  }, 30000);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const base = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  const jitter = base * (0.8 + Math.random() * 0.4);
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void wsConnect();
  }, jitter);
}

export function wsConnect(): Promise<void> {
  const st = useWsStore.getState().status;
  if (st === "open" || st === "connecting") return Promise.resolve();
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return Promise.resolve();

  useWsStore.getState().setStatus("connecting");

  return (async () => {
    let ticket: string;
    try {
      const base = ((window as unknown as { APP_CONFIG?: { apiBase?: string } }).APP_CONFIG?.apiBase ?? "").replace(/\/+$/, "") + "/api";
      const res = await fetch(base + "/ws/ticket", { credentials: "include" });
      if (!res.ok) {
        useWsStore.getState().setStatus("off");
        if (res.status === 401) emit("authError", {});
        else scheduleReconnect();
        return;
      }
      const j = (await res.json()) as { ticket: string };
      ticket = j.ticket;
      if (!ticket) throw new Error("no ticket");
    } catch {
      useWsStore.getState().setStatus("off");
      scheduleReconnect();
      return;
    }

    if (useWsStore.getState().status !== "connecting") return;

    try {
      const ws = new WebSocket(wsUrl(ticket));
      socket = ws;

      ws.onopen = () => {
        if (socket !== ws) return;
        reconnectAttempt = 0;
        useWsStore.getState().setStatus("open");
        startHeartbeat();
      };

      ws.onmessage = (ev) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(ev.data as string); } catch { return; }
        if ("id" in msg && typeof msg.id === "number") {
          const id = msg.id as number;
          const p = pending.get(id);
          if (!p) return;
          clearTimeout(p.timer);
          pending.delete(id);
          if (msg.ok) p.resolve(msg.data);
          else p.reject(new Error(String(msg.error ?? "error")));
          return;
        }
        if ("ev" in msg && typeof msg.ev === "string") {
          emit(msg.ev as string, msg.data);
        }
      };

      const onCloseOrError = () => {
        if (socket !== ws) return;
        socket = null;
        clearHeartbeat();
        for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("ws closed")); }
        pending.clear();
        if (useWsStore.getState().status === "off") return;
        useWsStore.getState().setStatus("closed");
        scheduleReconnect();
      };

      ws.onclose = onCloseOrError;
      ws.onerror = onCloseOrError;
    } catch {
      useWsStore.getState().setStatus("closed");
      scheduleReconnect();
    }
  })();
}

export function wsDisconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  clearHeartbeat();
  reconnectAttempt = 0;
  if (socket) { try { socket.close(); } catch {} socket = null; }
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("ws closed")); }
  pending.clear();
  useWsStore.getState().setStatus("off");
}

export function wsCall<T>(op: string, args?: object, timeoutMs = 15000): Promise<T> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("ws closed"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout: ${op}`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    try {
      socket!.send(JSON.stringify({ id, op, args }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      reject(e as Error);
    }
  });
}

export function wsOn(ev: string, fn: (data: unknown) => void): () => void {
  let set = listeners.get(ev);
  if (!set) { set = new Set(); listeners.set(ev, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) listeners.delete(ev); };
}
