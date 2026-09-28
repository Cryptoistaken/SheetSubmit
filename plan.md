# SheetSubmit — Neon cost fix plan

Date: 2026-09-28. Status: IMPLEMENTED as commit `1d70c3f` (API 2.0.38).
Backend tests: 125 pass / 0 fail on local stack. Railway env still to set
(see fix 3). `pg_stat_statements` installed on prod — re-check top queries
after a few days of traffic.
DB is live again on Launch (`launch_v3`, max 8 CU). Fresh billing period started
2026-09-28, all counters at 0. `pg_stat_statements` installed — stats start empty,
check back after a few days of traffic.

## What the numbers said (Sept 1–28, Free plan)

| Item | Used | Free limit | Verdict |
|---|---|---|---|
| Compute | 12.8 CU-h | 100 CU-h | OK, but 100% of it waste-shaped |
| Storage | 38 MB | 512 MB | fine |
| Egress | 1.52 GB | 5 GB | biggest waste signal (tiny 4 MB DB moved 1.5 GB) |
| Functions / buckets | none | — | $0 |

Table sizes now: `file_rows` 1416 kB, `meta` 1216 kB, `pool_rows` 944 kB.
Scan counts: `file_index` 318k, `file_rows` 164k, `pool_rows` 89k seq scans.

## Culprit 1 — heartbeat never lets the DB sleep (compute ~$1.36/mo)

Neon suspends compute after 5 min idle. Two loops wake it every 10 min, so it
almost never suspends (49 h awake in Sept ≈ 12.8 CU-h, matches Neon meter):

- `backend/src/index.ts:215` — `settleHolds` + `sessionCleanup` every 600s,
  unconditional, even when nothing is due.
- `backend/src/worker/runner.ts:167-194` — tick every 600s; takes the advisory
  lock (`SELECT pg_try_advisory_lock` + `pg_advisory_unlock`) on EVERY tick,
  before checking whether any job is actually due (`runner.ts:180-184`).
- Commit `1aa560a` slowed both 30s → 10min, but `runner.ts:166` claims this
  lets Neon suspend — wrong: any period under ~6 min wakes-per-cycle keeps it
  warm; 10 min wakes still cost ~3 min active each (cold start + suspend lag).

## Culprit 2 — list endpoints ship full row blobs (the 1.52 GB)

- `backend/src/lib/pg.ts:268` `downloadShape` includes `rows` + `keys` JSONB.
- `pg.ts:425` `downloads`/`holds` lists (limit 50, max 200) map every row through
  it. `ApprovalsView` opens HOLD+APPROVED+REJECTED in parallel and never displays
  those blobs (detail comes from `downloadRows`, `pg.ts:445`).
- `pg.ts:450` `count:"all"` takes up to 10,000 rows into one download.

## Culprit 3 — full-table scan on every pool write

- `pg.ts:431` `summaryAll`: unfiltered `GROUP BY` over all `pool_rows` FULL JOIN
  all `pool_rejects`. Fired from `pg.ts:535-537` on EVERY pool mutation.
  Returns ~6 rows; cost is scan, not bytes.

## Fixes (in order, smallest diff first)

1. **Meta-only lists** (`pg.ts:268,425`): strip `rows`/`keys` from
   `downloadShape` on the `downloads`/`holds` list ops (keep them on
   `download`/`downloadDetail`/`downloadRows`). Kills the GB-scale egress.
2. **Due-check before lock** (`runner.ts:172-184`): compute job due-ness from the
   in-memory `last` map BEFORE `pg_try_advisory_lock`; sleep with zero queries
   when nothing is due. Halves idle wake cost.
3. **Slow the sweeps via env only** (Railway vars, no code): `HELD_INTERVAL_MS`
   10min → 30min, `SIMPLE/ADVANCED_INTERVAL_MS` 30min → 2h,
   `WORKER_TICK_MS` 10min → 30min. `BACKUP_INTERVAL_MS` already no-ops
   (`backup.ts:46-56`, no `BACKUP_DATABASE_URL`).
4. **Scope `summaryAll`** (`pg.ts:431`, callers in `livePublish.ts:91-111`):
   per-password/pool `WHERE` instead of global scan. Small rows, big scan saving.
5. **Cap `detail`** (`pg.ts:409`, LIMIT 5000 full `data` blobs): paginate like
   `rows` (`pg.ts:410-421`) instead of one shot.
6. **Settle — EVENT-DRIVEN (decided)**: each approve/reject sets its own alarm
   (`setTimeout(firstActionAt + 300s - now)` → one `settleHolds` call) instead
   of the 10-min mailman round (`index.ts:215`). Hourly backstop sweep stays for
   crash/deploy safety (alarms die on restart). **No payout cap**: drop
   `LIMIT 20` (`pg.ts:117`) so one pass clears everything due — safe because
   each hold settles in its own tx (`pg.ts:119-139`) with a settled re-check
   (`pg.ts:121-122`), and fix the stale "run every 30s" comment (`pg.ts:116`).
   Payout lag becomes always ~5 min; idle wakes drop to ~1/hr.

## Expected billing on Launch after fixes

Rates: Postgres $0.106/CU-h, storage $0.35/GB-mo, egress 500 GB incl. then
$0.10/GB. Functions/object storage unused = $0.

| Scenario | Compute | Storage | Egress | Total/mo | Billed |
|---|---|---|---|---|---|
| Now (no fix), Oct run-rate | ~13 CU-h $1.38 | $0.01 | 1.5 GB $0 | ~$1.39 | ~$1.39 |
| Fixes 1–5, settle kept 10 min | ~12–14 CU-h $1.30–1.50 | $0.01 | ~$0 | ~$1.40 | ~$1.40 |
| + settle 30 min | ~4–6 CU-h $0.45–0.65 | $0.01 | $0 | ~$0.50 | ~$0.50 |
| + event-driven settle | ~1–3 CU-h $0.10–0.30 | $0.01 | $0 | ~$0.15–0.30 | **$0** (under-$0.50 invoices not collected) |

Note: fixes 1–5 barely move the dollar number on Launch (egress is free to
500 GB) — they buy headroom + speed. The compute bill only drops when the wake
floor drops (fix 6). Worst case guardrail: cap max CU per endpoint if traffic
ever spikes (currently 8 CU ceiling ≈ $0.85/h at full burn).

## Verify with data (after a few days of traffic)

```sql
-- top queries by total time
SELECT query, calls, round(total_exec_time::numeric,1) AS total_ms,
       round(mean_exec_time::numeric,2) AS mean_ms
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;
-- most frequent queries
SELECT query, calls FROM pg_stat_statements ORDER BY calls DESC LIMIT 10;
```

Then: `neon inspect db outliers|calls|seq-scans --project-id
solitary-dew-84831810 --role-name neondb_owner`.
Expect: `summaryAll`-shaped GROUP BYs and `downloads`-shaped SELECTs gone from
the top after fixes 1+4; tick queries down ~3–6x after fixes 2+3.
