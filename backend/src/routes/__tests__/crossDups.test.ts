import { describe, expect, it, afterAll } from "bun:test";

// Cross-dups single-SQL rewrite (R2): one indexOp crossDups query replaces
// the per-file dupKeys fan-out. Response shape stays {counts, dups} exactly:
// counts init 0 for ALL user files; per-type groups, only types with >=2
// files; dup = key seen >1 times in its type group; ?fileId= filters dups to
// keys touching that file (counts NOT refiltered); without fileId dups is {}.
import { app } from "../../index";

describe.skipIf(!process.env.DATABASE_URL)("GET /api/cross-dups", () => {
  const SECRET = "test-secret";
  const ENV2 = { INDEX: "index", FILES: "files", POOLS: "pools", DATABASE_URL: process.env.DATABASE_URL as string, SESSION_SECRET: SECRET };
  const TAG = `cd${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const UID = `cdu-${TAG}`, OTHER = `cdo-${TAG}`;
  const FIDS: string[] = [];
  const F = (n: string, type = "fb_cookie") => {
    const id = `cdf-${TAG}-${n}`;
    FIDS.push(id);
    return { id, name: `xdup-${n}`, type, createdAt: Date.now(), updatedAt: Date.now() };
  };
  const row = (uid: string) => ({ uid, cookies: `c_user=${uid.slice(-8).replace(/\D/g, "") || "1"};`, status: "good" } as any);

  const cookieFor = async (uid: string) => {
    const { signSession } = await import("../../lib/session");
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "ensureUser", { id: uid, name: "t", username: "t" });
    const token = await signSession(uid, SECRET);
    await repository("index", "global", "session", { token, uid, exp: Date.now() + 300_000 });
    return `ss_session=${token}`;
  };

  const seed = async (uid: string, file: any, rows: any[]) => {
    const { repository } = await import("../../lib/pg");
    await repository("index", "global", "register", { uid, file });
    await repository("files", file.id, "init", { file, rows });
  };

  const get = async (cookie: string, qs = "") => {
    const res = await app.request(`/api/cross-dups${qs}`, { headers: { Cookie: cookie } }, ENV2);
    expect(res.status).toBe(200);
    return (await res.json()) as { counts: Record<string, number>; dups: Record<string, { fileId: string; fileName: string; rowIdx: number }[]> };
  };
  const norm = (entries: { fileId: string; fileName: string; rowIdx: number }[]) =>
    [...entries].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : a.rowIdx - b.rowIdx));

  let cookie = "";
  const FA = F("a"), FB = F("b"); // same-type pair sharing K1
  const K1 = `k1-${TAG}`;
  let done = false;
  const setup = async () => {
    if (done) return;
    done = true;
      cookie = await cookieFor(UID);
      await cookieFor(OTHER);
      await seed(UID, FA, [row(K1), row(`solo-a-${TAG}`)]);
      await seed(UID, FB, [row(K1), row(`solo-b-${TAG}`)]);
  };

  it("(a) dupe uid across 2 same-type files -> counts + dups for both", async () => {
    await setup();
    const body = await get(cookie, `?fileId=${FA.id}`);
    expect(Object.keys(body).sort()).toEqual(["counts", "dups"]);
    expect(body.counts).toEqual({ [FA.id]: 1, [FB.id]: 1 });
    expect(Object.keys(body.dups)).toEqual([K1]);
    expect(norm(body.dups[K1])).toEqual([
      { fileId: FA.id, fileName: FA.name, rowIdx: 0 },
      { fileId: FB.id, fileName: FB.name, rowIdx: 0 },
    ]);
  });

  it("(b) key in a single file only -> not a dup", async () => {
    await setup();
    const body = await get(cookie, `?fileId=${FA.id}`);
    expect(`solo-a-${TAG}` in body.dups).toBe(false);
    expect(`solo-b-${TAG}` in body.dups).toBe(false);
  });

  it("(f) single-file type with an internal duplicate -> not reported", async () => {
    await setup();
    const FS = F("s", "fb_singleton");
    const KS = `ks-${TAG}`;
    try {
      await seed(UID, FS, [row(KS), row(KS)]);
      const body = await get(cookie, `?fileId=${FS.id}`);
      expect(KS in body.dups).toBe(false);
      expect(body.counts[FS.id]).toBe(0);
    } finally {
      const { repository } = await import("../../lib/pg");
      await repository("index", "global", "purge", { id: FS.id }).catch(() => {});
      FIDS.splice(FIDS.indexOf(FS.id), 1);
    }
  });

  it("(c) same key across two DIFFERENT types -> not reported", async () => {
    await setup();
    const FX = F("x", "fb_cookie"), FY = F("y", "fb_other");
    const KX = `kx-${TAG}`;
    try {
      await seed(UID, FX, [row(KX)]);
      await seed(UID, FY, [row(KX)]);
      // FX joins the fb_cookie group (now 3 files) but KX appears once there;
      // FY is alone in fb_other -> KX must not appear anywhere.
      const body = await get(cookie, `?fileId=${FX.id}`);
      expect(KX in body.dups).toBe(false);
    } finally {
      const { repository } = await import("../../lib/pg");
      await repository("index", "global", "purge", { id: FX.id }).catch(() => {});
      await repository("index", "global", "purge", { id: FY.id }).catch(() => {});
      for (const id of [FX.id, FY.id]) { const i = FIDS.indexOf(id); if (i >= 0) FIDS.splice(i, 1); }
    }
  });

  it("(d) ?fileId= filters dups to touching keys, counts keep all", async () => {
    await setup();
    const FC = F("c");
    const K2 = `k2-${TAG}`;
    try {
      await seed(UID, FC, [row(K2)]);
      // K2 must live in FB too: re-init FB with K1 + K2 (init replaces rows).
      const { repository } = await import("../../lib/pg");
      await repository("files", FB.id, "init", { file: FB, rows: [row(K1), row(K2)] });
      const body = await get(cookie, `?fileId=${FA.id}`);
      expect(Object.keys(body.dups).sort()).toEqual([K1]); // K2 doesn't touch FA
      expect(body.counts).toEqual({ [FA.id]: 1, [FB.id]: 2, [FC.id]: 1 });
      const all = await get(cookie, `?fileId=${FB.id}`);
      expect(Object.keys(all.dups).sort()).toEqual([K1, K2]);
      expect(all.counts).toEqual({ [FA.id]: 1, [FB.id]: 2, [FC.id]: 1 });
    } finally {
      const { repository } = await import("../../lib/pg");
      await repository("index", "global", "purge", { id: FC.id }).catch(() => {});
      await repository("files", FB.id, "init", { file: FB, rows: [row(K1), row(`solo-b-${TAG}`)] });
      const i = FIDS.indexOf(FC.id); if (i >= 0) FIDS.splice(i, 1);
    }
  });

  it("without fileId -> dups is {} but counts still filled", async () => {
    await setup();
    const body = await get(cookie);
    expect(body.dups).toEqual({});
    expect(body.counts).toEqual({ [FA.id]: 1, [FB.id]: 1 });
  });

  it("(e) rows of another user are ignored", async () => {
    await setup();
    const OA = F("oa"), OB = F("ob");
    const KO = `ko-${TAG}`;
    const { repository } = await import("../../lib/pg");
    try {
      await seed(OTHER, OA, [row(KO)]);
      await seed(OTHER, OB, [row(KO)]);
      const mine = await get(cookie, `?fileId=${FA.id}`);
      expect(KO in mine.dups).toBe(false);
      const oc = await cookieFor(OTHER);
      const theirs = await app.request(`/api/cross-dups?fileId=${OA.id}`, { headers: { Cookie: oc } }, ENV2);
      expect(theirs.status).toBe(200);
      const tb = (await theirs.json()) as { counts: Record<string, number>; dups: Record<string, unknown> };
      expect(Object.keys(tb.dups)).toEqual([KO]);
      expect(tb.counts).toEqual({ [OA.id]: 1, [OB.id]: 1 });
    } finally {
      await repository("index", "global", "purge", { id: OA.id }).catch(() => {});
      await repository("index", "global", "purge", { id: OB.id }).catch(() => {});
      for (const id of [OA.id, OB.id]) { const i = FIDS.indexOf(id); if (i >= 0) FIDS.splice(i, 1); }
    }
  });

  afterAll(async () => {
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      await sql`DELETE FROM sessions WHERE user_id IN (${UID}, ${OTHER})`;
      await sql`DELETE FROM users WHERE user_id IN (${UID}, ${OTHER})`;
      if (FIDS.length) {
        await sql`DELETE FROM file_rows WHERE file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM file_meta WHERE file_id IN ${sql(FIDS)}`;
        await sql`DELETE FROM file_logs WHERE file_id IN ${sql(FIDS)}`;
      }
    } finally {
      await sql.end();
    }
    const { repository } = await import("../../lib/pg");
    for (const id of FIDS) await repository("index", "global", "purge", { id }).catch(() => {});
  });
});
