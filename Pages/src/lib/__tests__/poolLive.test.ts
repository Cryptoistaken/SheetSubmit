import { describe, expect, it } from "bun:test";

// Pool live counts seam (PoolsView): counts-only payloads patch badges,
// totals, verified split and users[] with no full load(). Transport reuses
// createLiveClient semantics (ghost-connection fix, backoff, 15s poll
// fallback) via createPoolLiveClient; identity (password+pool) drops
// stale-pool messages after a pool switch.
import { createPoolLiveClient, parsePoolLiveEvent } from "../poolLive";

describe("parsePoolLiveEvent", () => {
  it("patches counts without a full load", () => {
    let loads = 0;
    const load = () => { loads++; };
    const patch = parsePoolLiveEvent("dgddigital", "cookies_only", {
      password: "dgddigital",
      pool: "cookies_only",
      available: 12,
      claimed: 3,
      users: 2,
      pools: [{ id: "cookies_only", available: 12 }],
    });
    expect(patch).not.toBeNull();
    expect(patch!.totals).toEqual({ available: 12, claimed: 3, users: 2 });
    expect(patch!.badges).toEqual([{ id: "cookies_only", available: 12 }]);
    expect(loads).toBe(0);
  });

  it("carries the page verified split", () => {
    const patch = parsePoolLiveEvent("dgddigital", "page", {
      password: "dgddigital",
      pool: "page",
      available: 7,
      claimed: 1,
      users: 2,
      verified: 5,
      unverified: 2,
      totalAvailable: 7,
    });
    expect(patch!.verified).toEqual({ verified: 5, unverified: 2, totalAvailable: 7 });
  });

  it("takes users[] where present", () => {
    const patch = parsePoolLiveEvent("dgddigital", "cookies_only", {
      password: "dgddigital",
      pool: "cookies_only",
      available: 1,
      claimed: 0,
      users: [{ userId: "u1", available: 1, claimed: 0 }],
    });
    expect(patch!.usersList).toEqual([{ userId: "u1", available: 1, claimed: 0 }]);
  });

  it("ignores unknown fields forward-compatibly", () => {
    const patch = parsePoolLiveEvent("dgddigital", "cookies_only", {
      password: "dgddigital",
      pool: "cookies_only",
      available: 4,
      claimed: 0,
      users: 1,
      futureField: { nested: [1, 2, 3] },
      anotherOne: "x",
    });
    expect(patch!.totals).toEqual({ available: 4, claimed: 0, users: 1 });
  });

  it("ignores malformed messages", () => {
    expect(parsePoolLiveEvent("dgddigital", "cookies_only", null)).toBeNull();
    expect(parsePoolLiveEvent("dgddigital", "cookies_only", "not-json")).toBeNull();
    expect(parsePoolLiveEvent("dgddigital", "cookies_only", [{ available: 1 }])).toBeNull();
    expect(parsePoolLiveEvent("dgddigital", "cookies_only", { nope: 1 })).toBeNull();
  });

  it("keeps valid fields when some counts are invalid", () => {
    const patch = parsePoolLiveEvent("dgddigital", "cookies_only", {
      password: "dgddigital",
      pool: "cookies_only",
      available: -1,
      claimed: Number.NaN,
      users: 2,
    });
    // corrupt fields are dropped (caller keeps previous), valid ones patch
    expect(patch!.totals).toEqual({ users: 2 });
  });

  it("ignores stale-pool messages after a switch", () => {
    expect(parsePoolLiveEvent("dgddigital", "page", {
      password: "dgddigital", pool: "cookies_only", available: 5, claimed: 0, users: 1,
    })).toBeNull();
    expect(parsePoolLiveEvent("dgddigital", "cookies_only", {
      password: "L0VE@12345", pool: "cookies_only", available: 5, claimed: 0, users: 1,
    })).toBeNull();
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
  const patches: unknown[] = [];
  const polls: number[] = [];
  let loads = 0;
  let pollResult: unknown = null;
  const client = createPoolLiveClient({
    base: "https://api.example",
    password: "dgddigital",
    pool: "cookies_only",
    getTicket: async () => {
      const t = `T${tickets.length + 1}`;
      tickets.push(t);
      return t;
    },
    onPatch: (p) => { patches.push(p); },
    pollState: async () => {
      polls.push(1);
      return pollResult;
    },
    createSource: (url: string) => {
      const src: FakeSource = {
        url,
        closed: false,
        onopen: null,
        onmessage: null,
        onerror: null,
        close: () => { src.closed = true; },
      };
      sources.push(src);
      return src;
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
  return {
    sources, timers, tickets, patches, polls, pending, runAll, client,
    setPoll: (s: unknown) => { pollResult = s; },
    load: () => { loads++; },
    loads: () => loads,
  };
}

const tick = () => Bun.sleep(0);

const counts = (over: Record<string, unknown> = {}) => ({
  password: "dgddigital",
  pool: "cookies_only",
  available: 12,
  claimed: 3,
  users: 2,
  ...over,
});

describe("createPoolLiveClient", () => {
  it("opens the ticket stream URL per password+pool", async () => {
    const s = setup();
    await tick();
    expect(s.tickets).toEqual(["T1"]);
    expect(s.sources.length).toBe(1);
    expect(s.sources[0].url).toBe("https://api.example/api/pools/dgddigital/cookies_only/live?ticket=T1");
    s.client.close();
  });

  it("patches counts on message without a full load", async () => {
    const s = setup();
    await tick();
    s.sources[0].onmessage!({ data: JSON.stringify(counts()) });
    expect(s.patches.length).toBe(1);
    expect(s.loads()).toBe(0);
    s.client.close();
  });

  it("ignores stale-pool messages after a switch", async () => {
    const s = setup();
    await tick();
    s.sources[0].onmessage!({ data: JSON.stringify(counts({ pool: "page", available: 99 })) });
    expect(s.patches).toEqual([]);
    s.sources[0].onmessage!({ data: JSON.stringify(counts()) });
    expect(s.patches.length).toBe(1);
    s.client.close();
  });

  it("closes the broken source before reconnecting (no ghost connection)", async () => {
    const s = setup();
    await tick();
    s.sources[0].onerror!({});
    expect(s.sources[0].closed).toBe(true);
    expect(s.pending().map((t) => t.ms)).toEqual([1000]);
    s.runAll();
    await tick();
    expect(s.tickets).toEqual(["T1", "T2"]);
    expect(s.sources.length).toBe(2);
    expect(s.sources.filter((x) => !x.closed).length).toBe(1);
    s.client.close();
  });

  it("falls back to 15s polling after repeated failures", async () => {
    const s = setup();
    await tick();
    for (let i = 0; i < 3; i++) {
      s.sources[s.sources.length - 1].onerror!({});
      s.runAll();
      await tick();
    }
    expect(s.sources.length).toBe(3);
    expect(s.polls.length).toBe(1);
    s.setPoll(counts({ available: 9 }));
    s.runAll();
    await tick();
    expect(s.patches.length).toBe(1);
    expect(s.polls.length).toBe(2);
    expect(s.pending().map((t) => t.ms)).toEqual([15000]);
    s.client.close();
  });

  it("close kills source and timer", async () => {
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
