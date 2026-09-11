import { describe, expect, it } from "bun:test";

// Live client seam (slice 3): ticket URL building, message delivery,
// reconnect backoff and polling fallback — all through injected fakes.
// EventSource/fetch/clock are system boundaries (mocking.md); the client
// takes them as dependencies.
import { createLiveClient, poolRowKey, type LiveStates } from "../live";

describe("poolRowKey", () => {
  it("prefers uid", () => {
    expect(poolRowKey({ uid: "11", cookies: "c_user=22;" } as never)).toBe("11");
  });

  it("falls back to c_user", () => {
    expect(poolRowKey({ uid: "", cookies: "xs=1; c_user=22;" } as never)).toBe("22");
  });

  it("is empty without identity", () => {
    expect(poolRowKey({ uid: "", cookies: "" } as never)).toBe("");
  });
});

interface FakeSource {
  url: string;
  closed: boolean;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close: () => void;
}

interface Scheduled {
  ms: number;
  fn: () => void;
  cancelled: boolean;
}

function setup() {
  const sources: FakeSource[] = [];
  const timers: Scheduled[] = [];
  const tickets: string[] = [];
  const delivered: LiveStates[] = [];
  const polls: number[] = [];
  let pollResult: LiveStates | null = null;
  const client = createLiveClient({
    base: "https://api.example",
    fileId: "f1",
    getTicket: async () => {
      const t = `T${tickets.length + 1}`;
      tickets.push(t);
      return t;
    },
    onStates: (s) => delivered.push(s),
    createSource: (url: string) => {
      const src: FakeSource = {
        url,
        closed: false,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => {
          src.closed = true;
        },
      };
      sources.push(src);
      return src;
    },
    pollStates: async () => {
      polls.push(1);
      return pollResult;
    },
    schedule: (fn: () => void, ms: number) => {
      const t: Scheduled = { ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
  });
  const pending = () => timers.filter((t) => !t.cancelled);
  const runAll = () => {
    for (const t of pending()) {
      t.cancelled = true;
      t.fn();
    }
  };
  return { sources, timers, tickets, delivered, polls, pending, runAll, client, setPoll: (s: LiveStates | null) => { pollResult = s; } };
}

const tick = () => Bun.sleep(0);

describe("createLiveClient", () => {
  it("opens the ticket stream URL", async () => {
    const s = setup();
    await tick();
    expect(s.tickets).toEqual(["T1"]);
    expect(s.sources.length).toBe(1);
    expect(s.sources[0].url).toBe("https://api.example/api/files/f1/live?ticket=T1");
    s.client.close();
  });

  it("delivers parsed states", async () => {
    const s = setup();
    await tick();
    s.sources[0].onmessage!({ data: JSON.stringify({ states: { k1: { hold: true } } }) });
    expect(s.delivered).toEqual([{ k1: { hold: true } }]);
    s.client.close();
  });

  it("ignores malformed messages", async () => {
    const s = setup();
    await tick();
    s.sources[0].onmessage!({ data: "not-json" });
    s.sources[0].onmessage!({ data: JSON.stringify({ nope: 1 }) });
    expect(s.delivered).toEqual([]);
    s.client.close();
  });

  it("reconnects with backoff on fresh tickets", async () => {
    const s = setup();
    await tick();
    s.sources[0].onerror!({});
    expect(s.pending().map((t) => t.ms)).toEqual([1000]);
    s.runAll();
    await tick();
    expect(s.tickets).toEqual(["T1", "T2"]);
    expect(s.sources.length).toBe(2);
    s.sources[1].onerror!({});
    expect(s.pending().map((t) => t.ms)).toEqual([2000]);
    s.client.close();
  });

  it("closes the broken source before reconnecting (no ghost connection)", async () => {
    const s = setup();
    await tick();
    s.sources[0].onerror!({});
    // the dead source must die now — otherwise its native ~3s auto-retry
    // (same single-use ticket) overlaps the manual reconnect below
    expect(s.sources[0].closed).toBe(true);
    expect(s.pending().map((t) => t.ms)).toEqual([1000]);
    s.runAll();
    await tick();
    expect(s.tickets).toEqual(["T1", "T2"]);
    expect(s.sources.length).toBe(2);
    expect(s.sources.filter((x) => !x.closed).length).toBe(1);
    s.client.close();
  });

  it("a clean open resets the backoff", async () => {
    const s = setup();
    await tick();
    s.sources[0].onerror!({});
    s.runAll();
    await tick();
    s.sources[1].onopen!();
    s.sources[1].onerror!({});
    expect(s.pending().map((t) => t.ms)).toEqual([1000]);
    s.client.close();
  });

  it("falls back to polling after repeated failures", async () => {
    const s = setup();
    await tick();
    for (let i = 0; i < 3; i++) {
      s.sources[s.sources.length - 1].onerror!({});
      s.runAll();
      await tick();
    }
    // two reconnects, then poll mode: no fourth source, first poll fired
    expect(s.sources.length).toBe(3);
    expect(s.polls.length).toBe(1);
    // stale source errors are ignored once polling
    s.sources[2].onerror!({});
    expect(s.pending().map((t) => t.ms)).toEqual([15000]);
    s.setPoll({ k9: { dead: true } });
    s.runAll();
    await tick();
    expect(s.delivered).toEqual([{ k9: { dead: true } }]);
    expect(s.polls.length).toBe(2);
    s.client.close();
  });

  it("close stops sources, timers and retries", async () => {
    const s = setup();
    await tick();
    s.sources[0].onerror!({});
    s.client.close();
    expect(s.sources[0].closed).toBe(true);
    expect(s.pending()).toEqual([]);
    s.runAll();
    await tick();
    expect(s.sources.length).toBe(1);
    expect(s.polls).toEqual([]);
  });
});
