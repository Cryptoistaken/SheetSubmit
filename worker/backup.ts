// Standby-copy backup, worker side — self-contained (worker's build context
// has no /backend, so the small table list is duplicated from
// backend/src/lib/backup.ts). Sync is strictly primary -> standby and never
// propagates an empty primary. Unset BACKUP_DATABASE_URL = no-op.
import postgres from "postgres";

const TABLES = [
  "users",
  "file_index",
  "sessions",
  "meta",
  "wallets",
  "withdrawals",
  "downloads",
  "pool_settings",
  "file_meta",
  "file_rows",
  "file_logs",
  "wallet_transactions",
  "pool_rows",
  "pool_rejects",
  "pool_blocked",
];

const CHUNK = 500;

let standby: ReturnType<typeof postgres> | null | undefined;

function standbyDb() {
  if (standby !== undefined) return standby;
  const url = Bun.env.BACKUP_DATABASE_URL || "";
  standby = url
    ? postgres(url, { max: 1, idle_timeout: 20, connect_timeout: 10 })
    : null;
  return standby;
}

export async function syncToBackup(
  primary: ReturnType<typeof postgres>,
): Promise<string> {
  const sb = standbyDb();
  if (!sb) return "backup-off";
  let have = 0;
  try {
    const r: any[] = await primary.unsafe('SELECT COUNT(*)::int AS n FROM "users"');
    have = r[0]?.n ?? 0;
  } catch {
    return "backup-primary-unreachable";
  }
  if (!have) return "backup-primary-empty-skip";
  try {
    await sb.begin(async (tx: any) => {
      await tx.unsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
      for (const t of TABLES) {
        const rows: any[] = await primary.unsafe(`SELECT * FROM "${t}"`);
        if (!rows.length) continue;
        const cols = Object.keys(rows[0]);
        const colList = cols.map((c) => `"${c}"`).join(",");
        for (let i = 0; i < rows.length; i += CHUNK) {
          const chunk = rows.slice(i, i + CHUNK);
          const vals: unknown[] = [];
          const groups = chunk.map((r, ri) => {
            const ph = cols.map((c, ci) => {
              vals.push(r[c]);
              return `$${ri * cols.length + ci + 1}`;
            });
            return `(${ph.join(",")})`;
          });
          await tx.unsafe(
            `INSERT INTO "${t}" (${colList}) VALUES ${groups.join(",")}`,
            vals as any[],
          );
        }
      }
    });
  } catch (e) {
    return `backup-sync-failed:${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
  return "backup-synced";
}
