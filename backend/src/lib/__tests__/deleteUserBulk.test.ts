import { afterAll, describe, expect, it } from "bun:test";

// R4 delete-user bulk: the whole purge runs in ONE deleteUser tx (snapshots +
// tombstones + pool rows + file_index + users), no per-file wipe fan-out.
// Runs against a REAL database — skipped without DATABASE_URL (CI provides
// Postgres for the e2e job schema; unit CI runs without DB).
import type { repository as repoFn } from "../pg";

const hasDb = !!process.env.DATABASE_URL;
const mod = hasDb ? await import("../pg") : null;
const repository: typeof repoFn = mod
  ? mod.repository
  : (async () => { throw new Error("no DATABASE_URL"); });

const run = Date.now().toString(36);
const UID = `du-${run}-victim`;
const OTHER = `du-${run}-other`;
const F1 = `du-${run}-f1`;
const F2 = `du-${run}-f2`;
const FO = `du-${run}-fo`;
const PWD = `du-${run}-pwd`;
const K1 = `du-${run}-k1`;
const K2 = `du-${run}-k2`;
const KO = `du-${run}-ko`;

async function seed() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  const now = Date.now();
  try {
    await sql`INSERT INTO users(user_id,name,username) VALUES(${UID},'Victim','victim'),(${OTHER},'Other','other') ON CONFLICT(user_id) DO NOTHING`;
    await sql`INSERT INTO file_index(file_id,owner_id,archived,data) VALUES
      (${F1},${UID},false,${{ id: F1, name: "Victim file 1" } as any}),
      (${F2},${UID},false,${{ id: F2, name: "Victim file 2" } as any}),
      (${FO},${OTHER},false,${{ id: FO, name: "Other file" } as any})
      ON CONFLICT(file_id) DO NOTHING`;
    await sql`INSERT INTO file_meta(file_id,data,seq) VALUES
      (${F1},${{ id: F1, name: "Victim file 1" } as any},4),
      (${F2},${{ id: F2, name: "Victim file 2" } as any},1),
      (${FO},${{ id: FO, name: "Other file" } as any},2)
      ON CONFLICT(file_id) DO NOTHING`;
    await sql`INSERT INTO file_rows(file_id,idx,data) VALUES
      (${F1},0,${{ uid: "u1" } as any}),(${F1},1,${{ uid: "u2" } as any}),(${F1},2,${{ uid: "u3" } as any}),
      (${F2},0,${{ uid: "u4" } as any}),
      (${FO},0,${{ uid: "u9" } as any})
      ON CONFLICT(file_id,idx) DO NOTHING`;
    await sql`INSERT INTO file_logs(file_id,ts,action,seq) VALUES
      (${F1},${now - 2},${"edit"},3),(${F1},${now - 1},${"edit"},4),
      (${FO},${now - 1},${"edit"},2)`;
    await sql`INSERT INTO meta(k,v) VALUES
      (${`filesnap:${F1}`},${{ snaps: [{ rows: [{ uid: "u1" }], seq: 3, ts: now }] } as any}),
      (${`filesnap:${F2}`},${{ snaps: [] } as any}),
      (${`filesnap:${FO}`},${{ snaps: [] } as any})
      ON CONFLICT(k) DO NOTHING`;
    await sql`INSERT INTO pool_rows(password,pool_id,row_key,data,state,src_uid,src_file_id,inserted_at,hold_id) VALUES
      (${PWD},'cookies_2fa',${K1},${{} as any},'available',${UID},${F1},${now},NULL),
      (${PWD},'page',${K2},${{} as any},'available',${UID},NULL,${now},NULL),
      (${PWD},'cookies_2fa',${KO},${{} as any},'available',${OTHER},${FO},${now},NULL)
      ON CONFLICT(password,pool_id,row_key) DO NOTHING`;
    await sql`INSERT INTO sessions(token,user_id,exp) VALUES(${`tok-${UID}`},${UID},${now + 3600000}),(${`tok-${OTHER}`},${OTHER},${now + 3600000}) ON CONFLICT(token) DO NOTHING`;
  } finally {
    await sql.end();
  }
}

async function cleanup() {
  const { default: postgres } = await import("postgres");
  const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
  try {
    await sql`DELETE FROM pool_rows WHERE password=${PWD}`;
    await sql`DELETE FROM meta WHERE k IN (${`filesnap:${F1}`},${`filesnap:${F2}`},${`filesnap:${FO}`},${`filetomb:${F1}`},${`filetomb:${F2}`},${`filetomb:${FO}`})`;
    await sql`DELETE FROM users WHERE user_id IN (${UID},${OTHER})`;
  } finally {
    await sql.end();
  }
}

async function q(sql: any, s: string, p: any[] = []) {
  return sql.unsafe(s, p);
}

describe.skipIf(!hasDb)("deleteUser bulk", () => {
  afterAll(cleanup, 30_000);

  it("purges the user in one tx and leaves others untouched", async () => {
    await cleanup();
    await seed();
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      const r = (await repository("index", "global", "deleteUser", { id: UID })) as { ok: boolean };
      expect(r).toEqual({ ok: true });

      // victim gone everywhere
      expect((await q(sql, `SELECT 1 FROM users WHERE user_id=$1`, [UID])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM file_index WHERE owner_id=$1`, [UID])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM file_rows WHERE file_id IN ($1,$2)`, [F1, F2])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM file_meta WHERE file_id IN ($1,$2)`, [F1, F2])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM file_logs WHERE file_id IN ($1,$2)`, [F1, F2])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM pool_rows WHERE src_uid=$1 OR src_file_id IN ($2,$3)`, [UID, F1, F2])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM sessions WHERE user_id=$1`, [UID])).length).toBe(0);
      expect((await q(sql, `SELECT 1 FROM meta WHERE k IN ($1,$2)`, [`filesnap:${F1}`, `filesnap:${F2}`])).length).toBe(0);

      // tombstones mirror the wipe shape (name/ownerUid/purgedAt/rowCount/seq/logs)
      const t1: any[] = await q(sql, `SELECT v FROM meta WHERE k=$1`, [`filetomb:${F1}`]);
      expect(t1.length).toBe(1);
      const v1 = typeof t1[0].v === "string" ? JSON.parse(t1[0].v) : t1[0].v;
      expect(v1.id).toBe(F1);
      expect(v1.name).toBe("Victim file 1");
      expect(v1.ownerUid).toBe(UID);
      expect(typeof v1.purgedAt).toBe("number");
      expect(v1.rowCount).toBe(3);
      expect(v1.seq).toBe(4);
      expect(v1.logs.length).toBe(2);
      expect(v1.logs[0].seq).toBe(4); // newest-first, like wipe's ORDER BY id DESC
      const t2: any[] = await q(sql, `SELECT v FROM meta WHERE k=$1`, [`filetomb:${F2}`]);
      expect(t2.length).toBe(1);
      const v2 = typeof t2[0].v === "string" ? JSON.parse(t2[0].v) : t2[0].v;
      expect(v2.rowCount).toBe(1);
      expect(v2.logs).toEqual([]);

      // other user's data untouched
      expect((await q(sql, `SELECT 1 FROM users WHERE user_id=$1`, [OTHER])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM file_index WHERE file_id=$1`, [FO])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM file_rows WHERE file_id=$1`, [FO])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM file_meta WHERE file_id=$1`, [FO])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM file_logs WHERE file_id=$1`, [FO])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM pool_rows WHERE row_key=$1`, [KO])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM sessions WHERE user_id=$1`, [OTHER])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM meta WHERE k=$1`, [`filesnap:${FO}`])).length).toBe(1);
    } finally {
      await sql.end();
    }
  }, 30_000);

  it("is a no-op on a missing user (idempotent)", async () => {
    const r = (await repository("index", "global", "deleteUser", { id: UID })) as { ok: boolean };
    expect(r).toEqual({ ok: true });
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      // re-run changed nothing for the surviving user
      expect((await q(sql, `SELECT 1 FROM users WHERE user_id=$1`, [OTHER])).length).toBe(1);
      expect((await q(sql, `SELECT 1 FROM pool_rows WHERE row_key=$1`, [KO])).length).toBe(1);
    } finally {
      await sql.end();
    }
  }, 30_000);
});
