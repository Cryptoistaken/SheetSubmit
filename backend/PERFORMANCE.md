# PERFORMANCE.md — remaining work (the landed fixes are listed at the bottom)

Scope: `backend/` (Bun + Hono + Postgres on Railway), with consumer notes for `Pages/` and `android/`.
Estimates below are ranges for the affected payload, not guarantees — verify live with
`bun agent/timing.ts` (dual-origin sweep: direct + Cloudflare, total ms + `Server-Timing` backend ms).

## Remaining

### R2. Migration `002_perf.sql` + cross-dups SQL (rest of old #4)
Done already: pool rows pagination (`rows` op), SQL `verifiedCounts`, SQL key projection
(`keys`/`dupKeys`), expression indexes `pool_rows_eligible_fifo_idx` + `file_rows_key_idx`,
`poolUsers`/`summaryAll` GROUP BYs.
Left:
- Generated stored columns (so predicates become sargable everywhere, no expression drift):
```sql
-- pool_rows: eligible flag as generated column
ALTER TABLE pool_rows ADD COLUMN IF NOT EXISTS wa_eligible boolean
  GENERATED ALWAYS AS (
    lower(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible'
  ) STORED;
CREATE INDEX IF NOT EXISTS pool_rows_eligible_idx
  ON pool_rows (password, pool_id, state, wa_eligible, inserted_at, row_key)
  WHERE state = 'available';

-- file_rows: dedup key as generated column
ALTER TABLE file_rows ADD COLUMN IF NOT EXISTS row_key text
  GENERATED ALWAYS AS (
    COALESCE(NULLIF(data->>'uid',''),
             substring(data->>'cookies' FROM 'c_user=([0-9]+)'))
  ) STORED;
CREATE INDEX IF NOT EXISTS file_rows_key_idx
  ON file_rows (file_id, row_key)
  WHERE row_key IS NOT NULL;

-- admin search (optional: needs a role allowed to install extensions on Railway)
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX IF NOT EXISTS users_search_trgm_idx
--   ON users USING gin ((name||' '||username||' '||user_id) gin_trgm_ops);
```
- Then point the new-SQL at the columns, and rewrite `GET /api/cross-dups` as one
ownership/type-filtered query (`GROUP BY row_key HAVING count(*)>1`, exclude NULL keys)
instead of per-file `dupKeys` fan-out (≤40 files today). Est. **10–100x** on large collections.
- Caveats: generated stored columns rewrite rows under an `ACCESS EXCLUSIVE` lock — run in a
maintenance window, measure on staging first. If Railway forbids `pg_trgm`, keep the `ILIKE`
search as-is. `wa_eligible` deliberately normalizes both `wa_status` and legacy `waStatus`.

### R3. ETag/304 on file reads (old step 6)
Backend: `ETag = max(updated_at)` (list) / `seq` (full) on `GET /api/files`,
`GET /api/files/:id/full`. Needs the Pages half: send `If-None-Match`, skip render on 304.
Est. 5–10x bytes on repeat loads. (`/api/bot/info` + `/api/auth/telegram/config` already have ETag.)

### R4. Delete-user bulk (old #50)
Today: `DELETE /api/admin/user/:id` lists files then wipes sequentially per file.
Fix: collect file IDs, delete available pool rows by both `src_uid` and `src_file_id`,
then delete the user so FK cascades clear files/sessions/wallets. Est. **10–50x** by file count.

### R5 (optional, later). `downloads.rows` full-copy slimming
`downloads.rows` stores a full copy of claimed row JSONB. Schema evolution (store keys only,
regenerate at download) cuts storage/transfer substantially. Chunk large `keys` arrays when
used with `ANY(...)`.

## Rollout order (each step independently shippable)
1. R2 migration + cross-dups SQL.
2. R3 ETag + Pages client change (only step touching `Pages/`).
3. R4 delete-user bulk, then R5 if storage/transfer ever hurts.

## Verify
- `bun run typecheck` in `backend/`.
- `bun agent/timing.ts` before/after each step (needs `AGENT_TOKEN` + `BACKEND_URL` + test
`SS_SESSION` in gitignored `agent/.env`); compare `srv:` (backend ms), not just totals.
- Keep API responses byte-compatible so `Pages/` needs no change except R3.

## Landed (do not re-do)
| Fix | Where | Live evidence |
| `poolOp add` bulk ingest (R1): JS classify, one sorted-hash lock sweep, bulk DELETEs (`ANY($)`), one `INSERT ... jsonb_to_recordset`, one bulk UPDATE, batched rejects | `pg.ts` | 5k-row feed pool-ingest 44.2s → 1.2s (**~37x**); 22/22 semantic checks (re-feed noop, held/claimed frozen, dead repooled, claimed-never-reenters, rejects lifecycle); 3× concurrent overlapping 1k feeds → 2000 distinct keys, 0 dupes |
|---|---|---|
| claim/hold CTE + `FOR UPDATE SKIP LOCKED` | `allocate()` in `pg.ts` | `/api/pools` 2350ms → 68ms |
| append deltas + meta-only rename saves, bulk persist | `fileOp` in `pg.ts` | typecheck + review |
| fan-out kill: `summaryAll`, `holdsAll`, `downloadsAll`, `downloadAny`, `poolUsers` | `pg.ts` + `routes/pools.ts` | single-query `/api/pools`, `srv` 8–24ms |
| bot/info 10-min memory cache | `index.ts` | 493ms → 0ms cached |
| gzip (`compress()`), safe ETags on bot-info/config | `index.ts` | 13KB file payloads transfer compressed |
| session hygiene sweeper | `settleTimer` + `sessionCleanup` | — |
| WA stale-key batch delete (`metaDelMany`) | `pg.ts` + `routes/wa.ts` | — |
| admin single-user lookup (`adminUser`) | `pg.ts` + `routes/admin.ts` | — |
| SQL pool pagination + verified counts + key projection | `rows`/`verifiedCounts`/`keys` ops | `srv` 6–22ms |
| `Server-Timing: app;dur=N` on `/api/*` | `index.ts` | separates backend ms from network ms |
| worker dual-port (`$PORT` + fixed `:3000`, `0.0.0.0`) | `worker/index.ts` | `/api/worker/health` 502 → 200 |
| direct backend calls from prod web (`SameSite=None`) | `Pages/src/lib/api.ts`, `lib/session.ts` | front-vs-direct delta ±15ms |
| agent door + `agent/` tools + dual-origin timing | `routes/agent.ts`, `agent/` | this file's numbers come from there |
