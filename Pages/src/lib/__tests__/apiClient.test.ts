import { beforeEach, describe, expect, it, mock } from "bun:test";

// api seam: the request contract every caller depends on — URL prefix,
// credentials, JSON bodies, error text, and connection status. `fetch` is the
// system boundary (stubbed); everything else is the real module. api.ts reads
// `window` at load, so a minimal shim precedes the import (plain web host,
// no proxy pin, no Android bridge → BASE "/api").
//
// Sibling suites mock "@/lib/api" via process-global mock.module, and test
// files load concurrently — a bare import here can bind their mock instead
// of the real module (mock.module is global AND sticky: mock.restore()
// does not clear it, verified by probe). The "?real" query gives this file
// a private module identity that no sibling mock key can match, so this
// always binds the real record and can never poison siblings either.
// (Non-literal specifier keeps tsc from resolving it; the type assertion
// restores full typing.)
(globalThis as Record<string, unknown>).window = {};

const { api, normalizeUser, useConnStore } = (await import(
  "../api" + "?real"
)) as typeof import("../api");

interface SeenCall {
  url: string;
  init: RequestInit;
}

let seen: SeenCall[] = [];
let next: () => Promise<Response> = () =>
  Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));

function okJson(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

beforeEach(() => {
  seen = [];
  next = () => Promise.resolve(okJson({ ok: true }));
  (globalThis as Record<string, unknown>).fetch = mock(async (url: unknown, init: unknown) => {
    seen.push({ url: String(url), init: (init ?? {}) as RequestInit });
    return next();
  });
  useConnStore.setState({ status: "connecting" });
});

describe("request contract", () => {
  it("GETs under /api with cookies included and no content-type", async () => {
    next = () => Promise.resolve(okJson([{ id: "f1" }]));
    const res = await api.getFiles();
    expect(res).toEqual([{ id: "f1" }]);
    expect(seen.length).toBe(1);
    expect(seen[0].url).toBe("/api/files");
    expect(seen[0].init.credentials).toBe("include");
    expect(seen[0].init.headers).toEqual({});
    expect(useConnStore.getState().status).toBe("ok");
  });

  it("POSTs JSON bodies with the JSON content-type", async () => {
    await api.fbCheck(["1", "2"]);
    expect(seen[0].url).toBe("/api/fb/check");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(seen[0].init.body))).toEqual({ uids: ["1", "2"] });
  });

  it("maps error JSON to '<status> <text> - <detail>'", async () => {
    next = () => Promise.resolve(new Response(JSON.stringify({ error: "version conflict" }), { status: 409, statusText: "Conflict" }));
    const err = await api.persist("f1", { rows: [] }).catch((e: Error) => e);
    expect(err.message).toBe("409 Conflict - version conflict");
    expect(useConnStore.getState().status).toBe("err");
  });

  it("falls back to the raw body when the error is not JSON", async () => {
    next = () => Promise.resolve(new Response("boom", { status: 500, statusText: "Server Error" }));
    const err = await api.health().catch((e: Error) => e);
    expect(err.message).toContain("500");
    expect(err.message).toContain("boom");
  });

  it("omits the detail suffix when the error body is empty", async () => {
    next = () => Promise.resolve(new Response("", { status: 404, statusText: "Not Found" }));
    const err = await api.getFiles().catch((e: Error) => e);
    expect(err.message).toBe("404 Not Found");
  });

  it("marks the connection down and rethrows on network failure", async () => {
    const boom = new Error("network down");
    next = () => Promise.reject(boom);
    const err = await api.getFiles().catch((e: Error) => e);
    expect(err).toBe(boom);
    expect(useConnStore.getState().status).toBe("err");
  });

  it("encodes query params and snapshot index bodies", async () => {
    await api.adminSearchUsers("a b&c");
    expect(seen[0].url).toBe("/api/admin/users/search?q=a%20b%26c");
    await api.restoreSnapshot("f1", 2);
    expect(seen[1].url).toBe("/api/files/f1/restore-snapshot");
    expect(JSON.parse(String(seen[1].init.body))).toEqual({ index: 2 });
    await api.restoreSnapshot("f1");
    expect(JSON.parse(String(seen[2].init.body))).toEqual({});
  });
});

describe("normalizeUser", () => {
  it("splits the display name and stringifies the id", () => {
    expect(normalizeUser({ id: 7, name: "Ada Lovelace" })).toMatchObject({
      id: "7",
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("falls back to user_id and empty names", () => {
    expect(normalizeUser({ user_id: 9 })).toMatchObject({ id: "9", firstName: "", lastName: "" });
  });

  it("keeps explicit first/last names over the split", () => {
    expect(normalizeUser({ id: "1", name: "A B", firstName: "X", lastName: "Y" })).toMatchObject({
      firstName: "X",
      lastName: "Y",
    });
  });
});
