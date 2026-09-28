import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { BACKUP_TABLES, copyAll } from "../backup";

// Regression: the standby sync died on every run since migration 008 added
// STORED generated columns. `SELECT *` picks them up and the INSERT then hands
// Postgres a value for a column it is required to compute, which aborts the
// whole transaction — so the standby silently froze at whatever it last had.
//
// Runs against a real second database, because the failure is a Postgres
// restriction (a generated column rejecting an explicit value) that no amount
// of mocking would reproduce.
const url = process.env.DATABASE_URL;
const hasDb = !!url;
const BACKUP_DB = "sheetsubmit_test_standby";
const STAMP = Date.now().toString(36);

const sqlOf = (u: string) => postgres(u, { max: 1, connect_timeout: 10, idle_timeout: 5 });
const standbyUrl = () =>
  (url as string).replace(/\/[^/?]*(\?|$)/, `/${BACKUP_DB}$1`);

describe.skipIf(!hasDb)("backup standby copy", () => {
  let primary: ReturnType<typeof postgres>;
  let standby: ReturnType<typeof postgres>;
  const admin = sqlOf(url as string);

  beforeAll(async () => {
    primary = sqlOf(url as string);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${BACKUP_DB}`);
    await admin.unsafe(`CREATE DATABASE ${BACKUP_DB}`);
    standby = sqlOf(standbyUrl());
    // Same bootstrap the real standby gets, so it carries the same generated
    // columns and indexes.
    await standby.unsafe(await Bun.file(new URL("../../../sql/001_initial.sql", import.meta.url)).text());
  }, 60_000);

  afterAll(async () => {
    await primary?.end();
    await standby?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${BACKUP_DB}`);
    await admin.end();
  }, 60_000);

  it("copies rows into tables that carry generated columns", async () => {
    const uid = `usr-bk-${STAMP}`;
    const rk = `rk-${STAMP}`;
    await primary`INSERT INTO users (user_id, name, username) VALUES (${uid}, 'bk', ${uid})`;
    await primary`INSERT INTO file_index (file_id, owner_id, data) VALUES (${`f-${STAMP}`}, ${uid}, ${{ name: "f.xlsx" }})`;
    // data carries no `uid`, so the generated row_key must come from c_user.
    // JSON objects go in directly — pre-stringifying makes postgres.js encode
    // them again, landing a JSON *string* scalar in a jsonb column, where
    // data->>'cookies' is NULL and both generated columns read false.
    await primary`INSERT INTO file_rows (file_id, idx, data) VALUES (${`f-${STAMP}`}, 0, ${{ cookies: "c_user=555123" }})`;
    await primary`INSERT INTO pool_rows (password, pool_id, row_key, data, inserted_at, src_uid, src_file_id)
                  VALUES ('p', 'cookies_only', ${rk}, ${{ check_status: "eligible" }}, ${Date.now()}, ${uid}, ${`f-${STAMP}`})`;
    // Everything is keyed on STAMP: the primary database is not reset between
    // runs (only the standby is), so fixed keys would collide on the second.

    // This is the call that threw "cannot insert a non-DEFAULT value into
    // column row_key" on every production sync.
    await copyAll(primary, standby);
  }, 60_000);

  it("recomputes generated columns on the standby instead of copying them", async () => {
    const row: any[] = await standby`SELECT row_key FROM file_rows WHERE file_id = ${`f-${STAMP}`}`;
    expect(row.length).toBe(1);
    // The expression is COALESCE(uid, substring(cookies from 'c_user=([0-9]+)'))
    expect(row[0].row_key).toBe("555123");

    const pr: any[] = await standby`SELECT wa_eligible FROM pool_rows WHERE row_key = ${`rk-${STAMP}`}`;
    expect(pr.length).toBe(1);
    expect(pr[0].wa_eligible).toBe(true);
  }, 30_000);

  it("carries every table across, parents included", async () => {
    for (const t of BACKUP_TABLES) {
      const a: any[] = await primary.unsafe(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      const b: any[] = await standby.unsafe(`SELECT COUNT(*)::int AS n FROM "${t}"`);
      expect(b[0].n, `row count drift in ${t}`).toBe(a[0].n);
    }
  }, 60_000);

  it("preserves identity ids rather than renumbering them", async () => {
    const fid = `f-${STAMP}`;
    await primary`INSERT INTO file_logs (file_id, ts, action) VALUES (${fid}, 1, 'x')`;
    await copyAll(primary, standby);
    const a: any[] = await primary`SELECT id FROM file_logs WHERE file_id = ${fid}`;
    const b: any[] = await standby`SELECT id FROM file_logs WHERE file_id = ${fid}`;
    expect(b[0].id).toBe(a[0].id);
  }, 60_000);
});
