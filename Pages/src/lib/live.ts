import type { Row } from "./types";

// Live row-state client (slice 3): ticket stream with polling fallback.
// EventSource/fetch/clock are injected so tests own the boundaries.
export interface LiveFlag {
  hold?: boolean;
  approved?: boolean;
  dead?: boolean;
}
export type LiveStates = Record<string, LiveFlag>;

/** Pool identity of a row — mirrors backend shared.poolRowKey exactly. */
export function poolRowKey(r: Row): string {
  const row = r as Record<string, unknown>;
  return String(row.uid || (String(row.cookies || "").match(/c_user=(\d+)/)?.[1] || ""));
}

export interface LiveSource {
  close(): void;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
}

export interface LiveTimer {
  cancel: () => void;
}

export interface LiveClientOpts {
  base: string;
  fileId?: string;
  getTicket: () => Promise<string>;
  onStates?: (states: LiveStates) => void;
  onEvent?: (msg: unknown) => void;
  createSource?: (url: string) => LiveSource;
  pollStates?: () => Promise<LiveStates | null>;
  pollEvent?: () => Promise<unknown | null>;
  buildUrl?: (ticket: string) => string;
  schedule?: (fn: () => void, ms: number) => LiveTimer;
  maxFailures?: number;
}

export interface LiveClient {
  close(): void;
}

const POLL_MS = 15_000;
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 30_000);

export function createLiveClient(opts: LiveClientOpts): LiveClient {
  const {
    base,
    fileId,
    getTicket,
    onStates,
    onEvent,
    createSource = (url: string) => new EventSource(url) as unknown as LiveSource,
    pollStates,
    pollEvent,
    buildUrl = (ticket: string) => `${base}/api/files/${fileId}/live?ticket=${encodeURIComponent(ticket)}`,
    schedule = (fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      return { cancel: () => clearTimeout(t) };
    },
    maxFailures = 3,
  } = opts;
  let closed = false;
  let polling = false;
  let attempts = 0;
  let source: LiveSource | null = null;
  let timer: LiveTimer | null = null;

  const later = (fn: () => void, ms: number) => {
    if (timer) timer.cancel();
    timer = schedule(() => {
      timer = null;
      if (!closed) fn();
    }, ms);
  };

  const applyMessage = (data: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (onEvent) {
      try {
        onEvent(msg);
      } catch {}
    }
    if (!onStates) return;
    const states = (msg as { states?: unknown })?.states;
    if (states && typeof states === "object") onStates(states as LiveStates);
  };

  const pollNow = () => {
    if (closed || (!pollStates && !pollEvent)) return;
    const run = pollEvent
      ? pollEvent().then((msg) => {
          if (closed) return;
          if (msg != null && onEvent) {
            try {
              onEvent(msg);
            } catch {}
          }
        })
      : pollStates!().then((states) => {
          if (closed) return;
          if (states && onStates) onStates(states);
        });
    void run.then(
      () => {
        if (!closed) later(pollNow, POLL_MS);
      },
      () => {
        if (!closed) later(pollNow, POLL_MS);
      },
    );
  };

  const failed = () => {
    if (closed || polling) return;
    attempts++;
    if (attempts < maxFailures) {
      // Kill the broken source first: a left-open EventSource auto-retries
      // the same (single-use, now dead) ticket after ~3s, overlapping the
      // manual reconnect below with a ghost connection.
      if (source) {
        try {
          source.close();
        } catch {}
        source = null;
      }
      later(connect, backoffMs(attempts));
    } else {
      polling = true;
      if (source) {
        try {
          source.close();
        } catch {}
        source = null;
      }
      pollNow();
    }
  };

  const connect = () => {
    if (closed || polling) return;
    let ticket: string;
    void getTicket().then(
      (t) => {
        if (closed || polling) return;
        ticket = t;
        let next: LiveSource;
        try {
          next = createSource(buildUrl(ticket));
        } catch {
          failed();
          return;
        }
        if (source) {
          try {
            source.close();
          } catch {}
        }
        source = next;
        source.onopen = () => {
          attempts = 0;
        };
        source.onmessage = (ev) => applyMessage(String(ev.data));
        source.onerror = () => failed();
      },
      () => failed(),
    );
  };

  connect();

  return {
    close: () => {
      closed = true;
      if (timer) timer.cancel();
      timer = null;
      if (source) {
        try {
          source.close();
        } catch {}
        source = null;
      }
    },
  };
}
