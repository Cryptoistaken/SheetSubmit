import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = postgres(url, {
  max: 1,
  idle_timeout: 10,
  connect_timeout: 10,
});

try {
  await sql`SET statement_timeout = '30s'`;
  const command = process.argv[2] || "bootstrap";
  if (command === "bootstrap") {
    await sql.unsafe(await Bun.file(new URL("../sql/001_initial.sql", import.meta.url)).text());
    console.log("schema bootstrap complete");
  } else if (command === "verify") {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
         'schema_migrations', 'users', 'file_index', 'sessions', 'meta', 'wallets', 'withdrawals',
         'file_meta', 'file_rows', 'file_logs', 'pool_settings', 'pool_rows',
        'downloads', 'wallet_transactions', 'pool_rejects', 'pool_blocked'
      )
    `;
     const indexes = await sql<{ indexname: string }[]>`
       SELECT indexname FROM pg_indexes WHERE schemaname='public'
       AND indexname IN ('file_index_owner_archived_idx', 'sessions_exp_idx', 'withdrawals_status_idx', 'file_logs_recent_idx', 'pool_rows_fifo_idx', 'pool_rows_source_idx', 'pool_rows_eligible_fifo_idx', 'pool_rows_hold_idx', 'downloads_status_recent_idx', 'wallet_tx_user_idx', 'sessions_user_idx', 'meta_key_prefix_idx', 'file_rows_key_idx', 'pool_rows_held_idx', 'downloads_settle_idx', 'pool_rows_rowkey_idx', 'pool_blocked_ts_idx')
      `;
     const migration = await sql<{ version: number }[]>`SELECT version FROM schema_migrations WHERE version=1`;
       if (tables.length !== 16 || indexes.length !== 17 || migration.length !== 1) throw new Error(`schema verification failed: ${tables.length}/16 tables, ${indexes.length}/17 indexes, ${migration.length}/1 migrations`);
    console.log(`schema verified: ${tables.length} tables, ${indexes.length} indexes`);
  } else {
    throw new Error(`unknown schema command: ${command}`);
  }
} finally {
   await sql.end();
}
