# PERFORMANCE.md — API inventory + 10x plan

Scope: `backend/` (Bun + Hono + Postgres on Railway), with consumer notes for `Pages/` and `android/`.
Basis for estimates: the code currently issues one awaited SQL statement per loop iteration. Actual gains depend on Railway network latency, row size, JSONB serialization, indexes, and contention; benchmark before promising a production multiplier. "x" means an expected range for the affected payload, not a guarantee.

## TL;DR — 6 fixes cover 90% of the wins

| # | Fix | Hits | Est. x |
|---|-----|------|--------|
| 1 | `allocate()`/`transition()`: replace per-row UPDATE+ledger loops with a CTE using `FOR UPDATE SKIP LOCKED`, one bulk UPDATE, one ledger INSERT, and the download update/insert | claim, hold, approve, reject/revert | **20–200x** for large claims; benchmark contention and payload size |
| 2 | `fileOp save/append`: stop `DELETE`+re-`INSERT` of every row per save. append → batched diff updates with `::jsonb`; persist → bulk insert; meta-only saves (rename) → skip row rewrite entirely | files persist/append, admin persist, PUT file | **10–100x** |
| 3 | `poolOp add`: preserve JS classification rules but move the accepted rows into a bulk SQL insert/ledger batch; cross-pool DELETE becomes one statement | file create, persist/append feedPools | **20–100x** on bulk uploads |
| 4 | SQL pushdown with generated columns + indexes on `pool_rows` (`wa_eligible bool`, `row_key` already a column) and `file_rows` (`row_key` generated: `uid`/`c_user`): rows pagination, summary/users, verified-counts, cross-dups become pure SQL | pool rows/detail, verified-counts, cross-dups | **10–100x** |
| 5 | Kill password fan-out: `downloads.id` is a PK — query by id without trying both passwords; `/api/pools` = one `GROUP BY password,pool_id`; holds/downloads = one query `WHERE password IN (...)` | all admin pool routes | **2–6x** |
| 6 | Cache `GET /api/bot/info` (getMe) in module memory for 1h | bot/info | **~100x** (200–500ms Telegram RTT → 0) |

---

## API inventory (62 entries, 64 handlers) — per-API plan

Legend: `today` = dominant cost, `fix` = the change, `x` = estimated speedup.

### Auth — `src/index.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 1 | `GET /api/health` | static | none | 1x |
| 2 | `GET /api/auth/me` | HMAC verify (μs) + 1 user query | optional 30s LRU on user row for burst traffic; add expired-session cleanup job (hygiene) | 1–2x |
| 3 | `POST /api/auth/logout` | 1 delete | none | 1x |
| 4 | `POST /api/auth/device/claim` | deviceGet (1 query) + deviceDelete transaction | combine into one transaction; this reduces statements/locking, but it is not literally one network round trip | ~1.2–1.5x |
| 5 | `GET /api/bot/info` | **fetches Telegram getMe every request (200–500ms)** | module-level cache, 1h TTL | **~100x** |
| 6 | `GET /api/auth/telegram/config` | static | none | 1x |
| 7 | `POST /api/auth/telegram/verify` | JWKS cached 1h (good); ensureUser + session insert = 2 sequential writes; cold JWKS fetch 100–300ms | merge ensureUser+session into one tx; pre-warm JWKS at boot | ~1.5–2x (cold: 2x) |

### Files — `src/routes/files.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 8 | `GET /api/files` | 1 query, full JSONB per file | ETag = max(updated_at) → 304 (Pages: send If-None-Match); gzip | 5–10x bytes on repeat loads |
| 9 | `POST /api/files` | `init` tx loops `INSERT` per row (5k rows = 5k statements); feedPools is fire-and-forget and is not on the response critical path | bulk insert via `jsonb_array_elements`; + fix #3 for background pool ingestion | **10–100x** for initialization; pool ingestion improves separately |
| 10 | `PUT /api/files/:id` (rename) | save tx **reads all rows + deletes + re-inserts all** even though rows unchanged | meta-only save: single `UPDATE file_meta SET data` when no rows provided | **~50–100x** |
| 11 | `DELETE /api/files/:id` | owned(1) + archive(1) | single `UPDATE file_index ... WHERE file_id=$ AND owner_id=$` | ~2x |
| 12 | `GET /api/files/:id/rows` | owned + all-rows select | join owner into one query; optional `?seq=` guard → 304 | ~2x (10x with 304) |
| 13 | `GET /api/files/:id/full` | owned(1) + seq(1) + rows(1) | one query joining file_meta+file_rows | ~2x |
| 14 | `PUT /api/files/:id/persist` | full rewrite of all rows per save + separate register write | fix #2 and fold index metadata into the same transaction; counts are a secondary optimization because rows are already loaded | **10–100x** |
| 15 | `PUT /api/files/:id/append` | loads ALL rows, applies ops in JS, rewrites ALL rows | direct batched updates/inserts; use `data || $cols::jsonb` and preserve the version check | **10–100x** |

### Archive — `src/routes/files.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 16 | `GET /api/archive` | 1 query | ETag as #8 | 5–10x bytes |
| 17 | `POST /api/archive/:id/restore` | ownedArchived + archive (2 RT) | single conditional UPDATE | ~2x |
| 18 | `POST /api/archive/batch-restore` | loads all archived files, JS filter, `batchArchive` loops UPDATE per file | one `UPDATE ... FROM unnest($ids,$datas)` | ~Nx (N≤40) |
| 19 | `DELETE /api/archive/:id` | wipe + purge fine; `removeAvailable` **loops DELETE+ledger per key** | single `DELETE ... WHERE row_key=ANY($)` + `INSERT ledger SELECT` | **50–100x** |
| 20 | `POST /api/archive/batch-delete` | same removeAvailable loop per file | same as #19 | 50–100x |

### Cross-dups — `src/routes/files.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 21 | `GET /api/cross-dups` | loads up to 10,000 extracted keys per file into JS for up to 40 files; it does not load complete row objects | generated `row_key` column + partial index; one ownership/type-filtered SQL query with `GROUP BY row_key HAVING count(*)>1`, excluding NULL keys | **10–100x** on large collections |

### Pools — `src/routes/pools.ts` (+ `poolOp` in pg.ts)

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 22 | `GET /api/pools` | 6 parallel summary queries (2 pw × 3 pools); DB work is 6x, but wall time is parallelized | one grouped query | **~1.2–2x wall time; 6x fewer DB statements** |
| 23 | `GET /api/pools/holds` | 2 parallel queries | one query `WHERE password IN (...)` | **~1.2–2x wall time; 2x fewer DB statements** |
| 24 | `POST /api/pools/holds/:id/approve` | password probe loop (up to 2 tx) + transition **loops UPDATE+ledger per key** | find by PK `id` (no password probe); fix #1 with a CTE | **20–200x** on big holds |
| 25 | `POST /api/pools/holds/:id/reject|return|revert` | same as 24 | same | 20–200x |
| 26 | `GET /api/pools/downloads` | 2 parallel queries | one `WHERE password IN (...)` | **~1.2–2x wall time; 2x fewer DB statements** |
| 27 | `GET /api/pools/downloads/:id/detail` | findDownload (2 probes) + `downloadDetail` **runs one SELECT per key for groups** | 1 query by PK + 1 grouped query `WHERE row_key=ANY($)` | **~100x** (N-key loop → 1) |
| 28 | `GET /api/pools/downloads/:id` (xlsx) | findDownload + xlsx build in memory | query by PK; stream CSV for >5k rows (xlsx write is CPU-bound) | ~2x (10x+ on huge exports) |
| 29 | `POST /api/pools/downloads/:id/revert` | findDownload + transition loop | #1 + PK lookup | 20–200x |
| 30 | `DELETE /api/pools/downloads/:id` | findDownload + delete | PK lookup, one delete | ~2x |
| 31 | `GET /api/pools/:password/:pool` | summary(1) + **detail = ALL rows incl. JSONB data → JS summarize** | one `GROUP BY state,src_uid` (no data transfer) | **10–100x** |
| 32 | `GET /api/pools/:password/:pool/rows` | **detail = ALL rows → JS filter/slice** | SQL `WHERE state='available' [AND src_uid=$] [AND wa_eligible=$] LIMIT/OFFSET` (generated `wa_eligible` col + index) | **10–100x** at 50k pool rows |
| 33 | `GET .../ledger` | 1 query LIMIT 500 | none | 1x |
| 34 | `GET .../verified-counts` | **pulls up to 5000 JSONB blobs → JS filter** + extra count query | two `COUNT(*)` with `wa_eligible` expression index | **50–100x** |
| 35 | `GET .../page-counts` | same as 34 | same | 50–100x |
| 36 | `POST .../claim` | selectRows + **per-row UPDATE + per-row ledger INSERT × N** + download INSERT | CTE selects/locks rows, bulk UPDATE returns data, bulk ledger INSERT, then download INSERT; count=all is about 20,000 statements today versus about 4 core statements after batching | **20–200x** |
| 37 | `POST .../hold` | same as 36 (+ pick filters) | same; push verified/unverified filtering into SQL before locking | 20–200x |
| 38 | `GET .../user-files` | SQL GROUP BY already; JS merge | none | 1x |
| 39 | `GET .../price` | 1 query | none | 1x |
| 40 | `PUT .../price` | 1 upsert | none | 1x |
| 41 | `POST .../revert` | 1+1 queries | none | 1x |

### Admin — `src/routes/admin.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 42 | `GET /api/admin/stats` | 1 query | none | 1x |
| 43 | `GET /api/admin/users` | GROUP BY w/ counts, indexed | none | 1x |
| 44 | `GET /api/admin/users/search` | **loads ALL users → JS filter** | SQL `ILIKE` on (user_id,name,username) + pg_trgm index | ~10x @ 10k users (grows with user count) |
| 45 | `GET /api/admin/user/:id` | **loads ALL users w/ file-counts → JS find** | one query: user + 2 correlated counts | **~100x** @ 10k users |
| 46 | `GET /api/admin/user/:id/archive` | 1 query | none | 1x |
| 47 | `POST .../archive/:fileId/restore` | 2 queries | 1 conditional UPDATE | ~2x |
| 48 | `DELETE .../archive/:fileId` | purge + wipe (2 RT) | 1 DELETE on file_index (cascades) | ~2x |
| 49 | `POST /api/admin/user/:id/:action` | 1 update | none | 1x |
| 50 | `DELETE /api/admin/user/:id` | files list + **sequential wipe per file** + delete; pool tables have no FK to users/files | collect file IDs, delete available pool rows by both `src_uid` and `src_file_id`, then delete the user so FK cascades clear files/sessions/wallets | **10–50x**, depending on file count |
| 51 | `GET /api/admin/file/:id` | 1 query | none | 1x |
| 52 | `PUT /api/admin/file/:id` | same rewrite bug as #10 | meta-only save | 50–100x |
| 53 | `DELETE /api/admin/file/:id` | 1 update | none | 1x |
| 54 | `GET /api/admin/file/:id/rows` | 1 query | none | 1x |
| 55 | `PUT /api/admin/file/:id/persist` | same as #14 | fix #2 | **10–100x** |
| 56 | `GET /api/admin/file/:id/logs` | 1 query | none | 1x |
| 57 | `GET /api/admin/file/:id/undo` | stub (returns `[]`) | none | 1x |

### WA — `src/routes/wa.ts` (upstream-bound)

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 58 | `POST /api/fb/check` | upstream check.fb.tools (~1–5s) | stream NDJSON instead of buffering 1MB then parse | ~1.2x (upstream-bound; can't 10x a proxy) |
| 59 | `POST /api/fb/page-check` | 1 FB fetch (up to 20s) | none — external-bound; cache already applied | 1x |
| 60 | `POST /api/fb/wa-check` | 2 FB fetches (up to 30s) | none — external-bound | 1x |
| 61 | `GET /api/wa/cache` | batched read (good); stale keys deleted per-key | one `DELETE ... WHERE k=ANY($)` | 2–5x (only when many stale) |

### Bot — `src/routes/bot.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 62 | `POST /webhook/tg` | sequential Telegram API calls (getChat, editMessage...) | parallelize independent calls | ~1.1x (upstream-bound) |

---

## Schema changes (one migration `002_perf.sql`)

```sql
-- pool_rows: eligible flag as generated column (drives #4 pushdowns)
ALTER TABLE pool_rows ADD COLUMN IF NOT EXISTS wa_eligible boolean
  GENERATED ALWAYS AS (
    lower(COALESCE(data->>'wa_status', data->>'waStatus', '')) = 'eligible'
  ) STORED;
CREATE INDEX IF NOT EXISTS pool_rows_eligible_idx
  ON pool_rows (password, pool_id, state, wa_eligible, inserted_at, row_key)
  WHERE state = 'available';

-- file_rows: dedup key as generated column (drives cross-dups + SQL counts)
ALTER TABLE file_rows ADD COLUMN IF NOT EXISTS row_key text
  GENERATED ALWAYS AS (
    COALESCE(NULLIF(data->>'uid',''),
             substring(data->>'cookies' FROM 'c_user=(\d+)'))
  ) STORED;
CREATE INDEX IF NOT EXISTS file_rows_key_idx
  ON file_rows (file_id, row_key)
  WHERE row_key IS NOT NULL;

-- admin search
-- Optional: requires a role allowed to install extensions on Railway.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS users_search_trgm_idx
  ON users USING gin ((name||' '||username||' '||user_id) gin_trgm_ops);
```

The search query must use the same concatenated expression for this index to help. If Railway does not permit `pg_trgm`, use indexed prefix search or accept a sequential scan; do not make the whole migration fail. Generated stored columns rewrite existing rows and can take an `ACCESS EXCLUSIVE` lock, so run this migration during a maintenance window and measure it on a staging copy first. Cross-duplicate SQL must include `row_key IS NOT NULL`, ownership, `archived = false`, and the requested file type. `wa_eligible` deliberately normalizes both `wa_status` and the legacy `waStatus` key.

The claim CTE must use this shape; PostgreSQL does not allow `FOR UPDATE` directly in the subquery of an `UPDATE`:

```sql
WITH selected AS (
  SELECT row_key
  FROM pool_rows
  WHERE password = $1 AND pool_id = $2 AND state = 'available'
  ORDER BY inserted_at, row_key
  LIMIT $3
  FOR UPDATE SKIP LOCKED
)
UPDATE pool_rows p
SET state = $4, claimed_by = $5, claimed_at = $6
FROM selected s
WHERE p.password = $1 AND p.pool_id = $2 AND p.row_key = s.row_key
RETURNING p.row_key, p.data;
```

## Cross-cutting

- **Compression** — add Hono `compress()` middleware: files list / full rows / pool details shrink 5–10x in bytes → biggest win on mobile (android included, zero client change).
- **ETag/304** on `GET /files`, `GET /files/:id/full` (`ETag: seq`) — needs a Pages touch (send `If-None-Match`, skip render on 304).
- **Session hygiene** — periodic `DELETE FROM sessions WHERE exp < now()` (interval at boot).
- **Pool sizing** — measure first. `max: 10` can queue the existing 40-way cross-dups fan-out; raising it without checking Railway's connection limit can make latency worse. Prefer reducing fan-out, then tune the pool.
- **Rate limit** — in-memory Map is fine for single Railway instance; if scaled horizontally, move to PG-backed counters.
- **`downloads.rows` stores a full copy of claimed row JSONB** — schema evolution (store keys only, regenerate at download) could cut storage/transfer substantially; optional, do later. Large `keys` arrays should be chunked when used with `ANY(...)`.
- **Verified-count compatibility** — the current response exposes `truncated`/`scanCap`. A SQL count implementation must preserve those fields or deliberately version the response; do not silently change client semantics.
- **WA cache deletion** — batching stale-key deletion requires a new `metaDelMany` repository operation; `metaDel` alone cannot implement the proposed single SQL DELETE.

## Rollout order (each step independently shippable)

1. Fix #6 (bot/info cache) + benchmark compression — trivial, no schema change.
2. Fix #1 (claim/hold/transition batching) — biggest x, contained to `pg.ts`.
3. Fix #2 (file save/append diff + bulk persist) + fix #3 (pool add bulk).
4. Migration `002_perf.sql` + fix #4 (rows/detail/verified-counts/cross-dups pushdown).
5. Fix #5 (fan-out consolidation) + admin pushdowns (#44/#45/#50).
6. ETag + Pages client change (only step touching `Pages/`; `android/` needs nothing).

## Verify

- `bun run typecheck` in `backend/`.
- No backend test suite exists (`backend/test/` is empty) — add `bun test` route tests mirroring `scripts/TestApi.ts` before/after each step; keep API responses byte-compatible so `Pages/` needs no change except ETag (step 6).
