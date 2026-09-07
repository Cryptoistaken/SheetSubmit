# PERFORMANCE.md — API inventory + 10x plan

Scope: `backend/` (Bun + Hono + Postgres on Railway), with consumer notes for `Pages/` and `android/`.
Basis for estimates: same-region PG round trip ≈ 0.3–1 ms per statement. Loops of N statements inside a transaction cost N×RTT. "x" = realistic end-to-end improvement for the affected payload size.

## TL;DR — 6 fixes cover 90% of the wins

| # | Fix | Hits | Est. x |
|---|-----|------|--------|
| 1 | `allocate()`/`transition()`: replace per-row UPDATE+ledger loops with one `UPDATE ... WHERE row_key IN (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING row_key,data` + one `INSERT INTO ledger SELECT` | claim, hold, approve, reject/revert | **100–1000x** (count="all" = 10k rows: ~20,000 stmts → 3 stmts) |
| 2 | `fileOp save/append`: stop `DELETE`+re-`INSERT` of every row per save. append → direct `UPDATE data=data||...WHERE idx` per changed row (batched via unnest); persist → bulk `INSERT ... SELECT jsonb_array_elements(...)`; meta-only saves (rename) → skip row rewrite entirely | files persist/append, admin persist, PUT file | **50–300x** |
| 3 | `poolOp add`: per-row `SELECT 1`+`INSERT`+ledger loop → single `INSERT ... ON CONFLICT DO NOTHING` from `jsonb_array_elements` + single ledger `INSERT SELECT` (incl. cross-pool DELETE as one statement with `= ANY`) | file create, persist/append feedPools | **100–1000x** on bulk uploads |
| 4 | SQL pushdown with generated columns + indexes on `pool_rows` (`wa_eligible bool`, `row_key` already a column) and `file_rows` (`row_key` generated: `uid`/`c_user`): rows pagination, summary/users, verified-counts, cross-dups become pure SQL | pool rows/detail, verified-counts, cross-dups | **10–100x** |
| 5 | Kill password fan-out: `downloads.id` is a PK — query by id without trying both passwords; `/api/pools` = one `GROUP BY password,pool_id`; holds/downloads = one query `WHERE password IN (...)` | all admin pool routes | **2–6x** |
| 6 | Cache `GET /api/bot/info` (getMe) in module memory for 1h | bot/info | **~100x** (200–500ms Telegram RTT → 0) |

---

## API inventory (62 routes) — per-API plan

Legend: `today` = dominant cost, `fix` = the change, `x` = estimated speedup.

### Auth — `src/index.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 1 | `GET /api/health` | static | none | 1x |
| 2 | `GET /api/auth/me` | HMAC verify (μs) + 1 user query | optional 30s LRU on user row for burst traffic; add expired-session cleanup job (hygiene) | 1–2x |
| 3 | `POST /api/auth/logout` | 1 delete | none | 1x |
| 4 | `POST /api/auth/device/claim` | deviceGet (1 RT) + deviceDelete (tx: 2 SELECT FOR UPDATE + deletes) | single tx that reads+deletes+returns chatId in one round trip | ~2x |
| 5 | `GET /api/bot/info` | **fetches Telegram getMe every request (200–500ms)** | module-level cache, 1h TTL | **~100x** |
| 6 | `GET /api/auth/telegram/config` | static | none | 1x |
| 7 | `POST /api/auth/telegram/verify` | JWKS cached 1h (good); ensureUser + session insert = 2 sequential writes; cold JWKS fetch 100–300ms | merge ensureUser+session into one tx; pre-warm JWKS at boot | ~1.5–2x (cold: 2x) |

### Files — `src/routes/files.ts`

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 8 | `GET /api/files` | 1 query, full JSONB per file | ETag = max(updated_at) → 304 (Pages: send If-None-Match); gzip | 5–10x bytes on repeat loads |
| 9 | `POST /api/files` | `init` tx loops `INSERT` per row (5k rows = 5k stmts); then feedPools loop | bulk insert via `jsonb_array_elements`; + fix #3 | **~100x** on large uploads |
| 10 | `PUT /api/files/:id` (rename) | save tx **reads all rows + deletes + re-inserts all** even though rows unchanged | meta-only save: single `UPDATE file_meta SET data` when no rows provided | **~50–100x** |
| 11 | `DELETE /api/files/:id` | owned(1) + archive(1) | single `UPDATE file_index ... WHERE file_id=$ AND owner_id=$` | ~2x |
| 12 | `GET /api/files/:id/rows` | owned + all-rows select | join owner into one query; optional `?seq=` guard → 304 | ~2x (10x with 304) |
| 13 | `GET /api/files/:id/full` | owned(1) + seq(1) + rows(1) | one query joining file_meta+file_rows | ~2x |
| 14 | `PUT /api/files/:id/persist` | full rewrite of all rows per save + separate register write | fix #2 + fold register (file_index upsert) into same tx; compute counts in SQL (generated `row_key`) not JS full scan | **50–300x** |
| 15 | `PUT /api/files/:id/append` | loads ALL rows, applies ops in JS, rewrites ALL rows | direct per-row `UPDATE ... data=data||$cols` batched with unnest (client already sends only changed cells) | **50–300x** |

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
| 21 | `GET /api/cross-dups` | **loads every row of up to 40 files as JSONB into JS** (dupKeys per file) | generated `row_key` column on `file_rows` + index; one SQL `GROUP BY row_key HAVING count>1` over the user's live files | **10–100x** (also bounded memory: today ~80MB at 40×10k rows) |

### Pools — `src/routes/pools.ts` (+ `poolOp` in pg.ts)

| # | API | Today | Fix | x |
|---|-----|-------|-----|---|
| 22 | `GET /api/pools` | 6 parallel summary queries (2 pw × 3 pools) | one `SELECT password,pool_id,state,count(*) ... GROUP BY` | **~6x** |
| 23 | `GET /api/pools/holds` | 2 parallel queries | one query `WHERE password IN (...)` | ~2x |
| 24 | `POST /api/pools/holds/:id/approve` | password probe loop (up to 2 tx) + transition **loops UPDATE+ledger per key** | find by PK `id` (no password probe); fix #1 | **100–1000x** on big holds |
| 25 | `POST /api/pools/holds/:id/reject|return|revert` | same as 24 | same | 100–1000x |
| 26 | `GET /api/pools/downloads` | 2 queries | one `WHERE password IN (...)` | ~2x |
| 27 | `GET /api/pools/downloads/:id/detail` | findDownload (2 probes) + `downloadDetail` **runs one SELECT per key for groups** | 1 query by PK + 1 grouped query `WHERE row_key=ANY($)` | **~100x** (N-key loop → 1) |
| 28 | `GET /api/pools/downloads/:id` (xlsx) | findDownload + xlsx build in memory | query by PK; stream CSV for >5k rows (xlsx write is CPU-bound) | ~2x (10x+ on huge exports) |
| 29 | `POST /api/pools/downloads/:id/revert` | findDownload + transition loop | #1 + PK lookup | 100–1000x |
| 30 | `DELETE /api/pools/downloads/:id` | findDownload + delete | PK lookup, one delete | ~2x |
| 31 | `GET /api/pools/:password/:pool` | summary(1) + **detail = ALL rows incl. JSONB data → JS summarize** | one `GROUP BY state,src_uid` (no data transfer) | **10–100x** |
| 32 | `GET /api/pools/:password/:pool/rows` | **detail = ALL rows → JS filter/slice** | SQL `WHERE state='available' [AND src_uid=$] [AND wa_eligible=$] LIMIT/OFFSET` (generated `wa_eligible` col + index) | **10–100x** at 50k pool rows |
| 33 | `GET .../ledger` | 1 query LIMIT 500 | none | 1x |
| 34 | `GET .../verified-counts` | **pulls up to 5000 JSONB blobs → JS filter** + extra count query | two `COUNT(*)` with `wa_eligible` expression index | **50–100x** |
| 35 | `GET .../page-counts` | same as 34 | same | 50–100x |
| 36 | `POST .../claim` | selectRows (full data) + **per-row UPDATE + per-row ledger INSERT × N** + download INSERT | single `UPDATE ... WHERE row_key IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED) RETURNING row_key,data` + 1 ledger INSERT SELECT + 1 download INSERT. count=all: **20,000 stmts → 3** | **500–1000x** |
| 37 | `POST .../hold` | same as 36 (+ pick filters) | same | 500–1000x |
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
| 50 | `DELETE /api/admin/user/:id` | files list + **sequential wipe per file** + delete | `DELETE FROM users WHERE user_id=$` (FK cascade clears file_index/rows/logs) + one available-pool-rows cleanup `WHERE src_uid=$` | **10–50x** |
| 51 | `GET /api/admin/file/:id` | 1 query | none | 1x |
| 52 | `PUT /api/admin/file/:id` | same rewrite bug as #10 | meta-only save | 50–100x |
| 53 | `DELETE /api/admin/file/:id` | 1 update | none | 1x |
| 54 | `GET /api/admin/file/:id/rows` | 1 query | none | 1x |
| 55 | `PUT /api/admin/file/:id/persist` | same as #14 | fix #2 | **50–300x** |
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
  GENERATED ALWAYS AS ((data->>'wa_status') ILIKE 'eligible') STORED;
CREATE INDEX IF NOT EXISTS pool_rows_eligible_idx
  ON pool_rows (password, pool_id, state, wa_eligible);

-- file_rows: dedup key as generated column (drives cross-dups + SQL counts)
ALTER TABLE file_rows ADD COLUMN IF NOT EXISTS row_key text
  GENERATED ALWAYS AS (
    COALESCE(NULLIF(data->>'uid',''),
             substring(data->>'cookies' FROM 'c_user=(\d+)'))
  ) STORED;
CREATE INDEX IF NOT EXISTS file_rows_key_idx ON file_rows (file_id, row_key);

-- admin search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS users_name_trgm_idx ON users USING gin ((name||' '||username||' '||user_id) gin_trgm_ops);
```

## Cross-cutting

- **Compression** — add Hono `compress()` middleware: files list / full rows / pool details shrink 5–10x in bytes → biggest win on mobile (android included, zero client change).
- **ETag/304** on `GET /files`, `GET /files/:id/full` (`ETag: seq`) — needs a Pages touch (send `If-None-Match`, skip render on 304).
- **Session hygiene** — periodic `DELETE FROM sessions WHERE exp < now()` (interval at boot).
- **Pool sizing** — PG pool `max: 10` → 20; batched queries make concurrency the new bottleneck under bursts.
- **Rate limit** — in-memory Map is fine for single Railway instance; if scaled horizontally, move to PG-backed counters.
- **`downloads.rows` stores a full copy of claimed row JSONB** — schema evolution (store keys only, regenerate at download) would cut storage/transfer ~10x; optional, do later.

## Rollout order (each step independently shippable)

1. Fix #6 (bot/info cache) + compression — trivial, no schema change.
2. Fix #1 (claim/hold/transition batching) — biggest x, contained to `pg.ts`.
3. Fix #2 (file save/append diff + bulk persist) + fix #3 (pool add bulk).
4. Migration `002_perf.sql` + fix #4 (rows/detail/verified-counts/cross-dups pushdown).
5. Fix #5 (fan-out consolidation) + admin pushdowns (#44/#45/#50).
6. ETag + Pages client change (only step touching `Pages/`; `android/` needs nothing).

## Verify

- `bun run typecheck` in `backend/`.
- No backend test suite exists (`backend/test/` is empty) — add `bun test` route tests mirroring `scripts/TestApi.ts` before/after each step; keep API responses byte-compatible so `Pages/` needs no change except ETag (step 6).
