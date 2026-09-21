import postgres from "postgres";

// Standby-copy backup: DATABASE_URL (Neon) is primary, BACKUP_DATABASE_URL
// (Aiven Postgres) holds a live copy.
// Sync is strictly primary -> backup on an interval; the reverse happens
// only once at boot when the primary is empty (fresh redeploy refill).
// Unset BACKUP_DATABASE_URL (or equal to DATABASE_URL) = feature off,
// today's behavior unchanged. Same-URL is a no-op so a self-copy can
// never TRUNCATE the live DB onto itself.

// Parents first: only users + file_index are REFERENCES targets.
export const BACKUP_TABLES = [
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

let primary: ReturnType<typeof postgres> | null = null;
let standby: ReturnType<typeof postgres> | null | undefined;

function primaryDb() {
  if (!primary) {
    primary = postgres(Bun.env.DATABASE_URL || "", {
      max: 2,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return primary;
}

function standbyDb() {
  if (standby !== undefined) return standby;
  const url = Bun.env.BACKUP_DATABASE_URL || "";
  // Same-URL = self-copy would TRUNCATE the live DB onto itself: stay off.
  if (!url || url === (Bun.env.DATABASE_URL || "")) {
    standby = null;
    return standby;
  }
  standby = postgres(url, { max: 2, idle_timeout: 20, connect_timeout: 10 });
  return standby;
}

async function userCount(db: ReturnType<typeof postgres>): Promise<number> {
  const r: any[] = await db.unsafe('SELECT COUNT(*)::int AS n FROM "users"');
  return r[0]?.n ?? 0;
}

async function copyAll(
  from: ReturnType<typeof postgres>,
  to: ReturnType<typeof postgres>,
) {
  await to.begin(async (tx: any) => {
    await tx.unsafe(
      `TRUNCATE ${BACKUP_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
    for (const t of BACKUP_TABLES) {
      const rows: any[] = await from.unsafe(`SELECT * FROM "${t}"`);
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
}

/**
 * Boot refill: primary empty + standby has users -> copy standby -> primary.
 * Returns a short status for logging. Never touches a non-empty primary.
 */
export async function maybeRefillFromBackup(): Promise<string> {
  const sb = standbyDb();
  if (!sb) return "backup-off";
  let have: number;
  try {
    have = await userCount(primaryDb());
  } catch {
    return "backup-primary-unreachable";
  }
  if (have > 0) return "backup-primary-ok";
  let stocked = 0;
  try {
    stocked = await userCount(sb);
  } catch {
    return "backup-standby-unreachable";
  }
  if (!stocked) return "backup-both-empty";
  try {
    await copyAll(sb, primaryDb());
  } catch (e) {
    return `backup-refill-failed:${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
  return "backup-refilled";
}

/** Interval sync: primary -> standby. Never propagates an empty primary. */
export async function syncToBackup(): Promise<string> {
  const sb = standbyDb();
  if (!sb) return "backup-off";
  let have: number;
  try {
    have = await userCount(primaryDb());
  } catch {
    return "backup-primary-unreachable";
  }
  if (!have) return "backup-primary-empty-skip";
  try {
    await copyAll(primaryDb(), sb);
  } catch (e) {
    return `backup-sync-failed:${String((e as Error)?.message ?? e).slice(0, 120)}`;
  }
  return "backup-synced";
}
