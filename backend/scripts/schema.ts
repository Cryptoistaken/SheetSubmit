import { SQL } from "bun";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sql = new SQL({
  url,
  max: 1,
  idleTimeout: 10,
  connectionTimeout: 10,
});

try {
  await sql`SET statement_timeout = '30s'`;
  const command = process.argv[2] || "bootstrap";
  if (command === "bootstrap") {
   await sql.unsafe(await Bun.file("sql/001_initial.sql").text());
    console.log("schema bootstrap complete");
  } else if (command === "verify") {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
         'schema_migrations', 'users', 'file_index', 'sessions', 'meta', 'wallets', 'withdrawals',
        'file_meta', 'file_rows', 'file_logs', 'pool_settings', 'pool_rows',
        'pool_ledger', 'downloads', 'wallet_transactions'
      )
    `;
     const indexes = await sql<{ indexname: string }[]>`
       SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
       AND indexname IN ('file_index_owner_archived_idx', 'file_logs_recent_idx', 'pool_rows_fifo_idx', 'pool_rows_source_idx', 'pool_rows_hold_idx', 'pool_rows_held_idx', 'pool_ledger_recent_idx', 'downloads_status_recent_idx', 'wallet_tx_user_idx')
     `;
     const migration = await sql<{ version: number }[]>`SELECT version FROM schema_migrations WHERE version=1`;
      if (tables.length !== 15 || indexes.length !== 10 || migration.length !== 1) throw new Error("schema verification failed");
    console.log(`schema verified: ${tables.length} tables, ${indexes.length} indexes`);
  } else {
    throw new Error(`unknown schema command: ${command}`);
  }
} finally {
   await sql.close();
}
