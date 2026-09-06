# SheetSubmit Postgres Migration and Railway Cutover Plan

**Goal:** Move the backend from Cloudflare Durable Objects to Railway Postgres, run it as a Railway HTTP service, and keep Cloudflare Pages as the only browser-facing origin.

**Architecture:** The browser calls `https://sheetsubmit.pages.dev/api/*`. The Pages Function proxies those requests to the Railway Hono service through `BACKEND_URL`. Railway Postgres is the durable source of truth for users, files, rows, pools, claims, holds, wallets, sessions, downloads, and ledgers. Redis remains provisioned but is not part of the first cutover; it can be added later only for measured cache/rate-limit bottlenecks.

**Tech stack:** Hono, Bun HTTP server, Railway Postgres, `postgres` client, Cloudflare Pages Functions, Telegram OIDC/JWKS, `xlsx`.

## Global Constraints

- Do not move the frontend from Cloudflare Pages.
- Do not expose Railway directly to browser calls.
- Keep the Cloudflare Worker deployed and usable as the rollback target until the observation window closes.
- Do not migrate historical data; the target Railway database is intentionally fresh and empty.
- Preserve every existing route, validation rule, authorization check, response shape, cookie flag, and data-loss safeguard unless a documented compatibility fix is required.
- Keep `worker/` unchanged by the Railway migration. All Railway runtime code belongs under `backend/`.
- Keep `backend/` free of test scripts temporarily, as requested. Before production cutover, restore focused contract/concurrency verification outside the runtime package or in a separate test package.
- Use parameterized SQL only. Never interpolate user input into SQL text.
- Use Postgres transactions and row locks for allocation and status transitions.
- Use one bounded Postgres pool per process with connection, idle, and statement timeouts.
- Do not add Redis to business-critical writes during this migration.
- Never print or commit values from `deploy.env`, `scripts/.env`, database URLs, bot tokens, session secrets, GitHub tokens, Railway tokens, or Cloudflare tokens.
- Use Railway GraphQL API and Cloudflare REST API for deployment/configuration. Do not use Railway CLI or Wrangler deployment commands.
- Commit and push each completed bounded batch after local verification.
- Update `AGENTS.md` whenever the codebase map or runtime entrypoint changes.

## Current State

- `worker/` is the live Cloudflare Worker and remains the rollback implementation.
- `backend/` is a copied migration tree and currently contains the old Durable Object implementation plus the initial Postgres schema/bootstrap files.
- `backend/sql/001_initial.sql` defines the fresh-install Postgres tables and indexes.
- `backend/scripts/schema.ts` provides `schema:bootstrap` and `schema:verify` commands.
- Backend test files and the Vitest configuration were removed temporarily by request.
- Railway project: `SheetSubmit`.
- Railway services: app `SheetSubmit`, Postgres `Postgres`, Redis `Redis`.
- Railway credentials and IDs are loaded only from `B:\Studio\Tools\SheetSubmit\deploy.env`.
- Cloudflare Pages project: `sheetsubmit`.
- Current Pages production `BACKEND_URL` points to the Worker and must not change until Railway verification passes.

## Data Mapping

| Durable Object | Postgres tables | Required behavior |
| --- | --- | --- |
| `IndexDO` | `users`, `file_index`, `sessions`, `meta`, `wallets` | User identity, ownership, archive state, sessions, device tokens, WA cache, wallet balances |
| `FileDO` | `file_meta`, `file_rows`, `file_logs` | File metadata, rows, sequence increments, append conflicts, 200-log cap, wipe |
| `PoolDO` | `pool_settings`, `pool_rows`, `pool_ledger`, `downloads` | FIFO allocation, source filters, holds, claims, approvals, reverts, price snapshots |

Pool allocation must use `SELECT ... FOR UPDATE SKIP LOCKED` or an equivalent transaction-safe strategy. A row must never be allocated to two concurrent claims or holds.

## Implementation Tasks

### Task 1: Normalize the fresh Postgres schema

**Files:**

- Modify `backend/sql/001_initial.sql`.
- Modify `backend/scripts/schema.ts`.
- Modify `backend/package.json` only if schema commands need adjustment.

**Steps:**

- Keep the migration idempotent and versioned through `schema_migrations`.
- Preserve millisecond timestamps where route responses currently expose numeric timestamps.
- Ensure ownership, archive, state, price, and non-negative count constraints are explicit.
- Ensure indexes cover owner/archive listing, file logs, pool FIFO, pool source filters, hold lookup, ledger history, download status, and session expiry.
- Make `schema:bootstrap` safe to execute twice.
- Make `schema:verify` check expected tables, indexes, constraints, and migration version.

**Gate:** Run both commands against the Railway Postgres service using the private Railway connection URL. The second bootstrap must make no destructive changes.

### Task 2: Replace the Durable Object transport with a Postgres repository seam

**Files:**

- Create `backend/src/lib/pg.ts`.
- Modify `backend/src/lib/do.ts`.
- Modify `backend/src/lib/shared.ts`.
- Remove `backend/src/do/IndexDO.ts`.
- Remove `backend/src/do/FileDO.ts`.
- Remove `backend/src/do/PoolDO.ts`.

**Interface:** Keep callers using:

```ts
rpc(namespace, name, operation, args)
```

Route `INDEX` operations to the global repository, `FILES` operations to the file repository keyed by `name`, and `POOLS` operations to the pool repository keyed by `name`.

**Index operations to implement:**

`ensureUser`, `user`, `users`, `ban`, `register`, `file`, `files`, `archive`, `batchArchive`, `purge`, `batchPurge`, `deleteUser`, `walletCredit`, `walletGet`, `adminUsers`, `metaSet`, `metaGet`, `metaGetMany`, `metaDel`, `allFiles`, `stats`, `session`, `getSession`, `deleteSession`, `deviceSet`, `deviceGet`, `deviceDelete`, `deviceByChat`, and `deviceSession`.

**File operations to implement:**

`init`, `meta`, `seq`, `rows`, `full`, `counts`, `keys`, `dupKeys`, `projection`, `append`, `save`, `getLogs`, and `wipe`.

**Pool operations to implement:**

`priceGet`, `priceSet`, `downloadDelete`, `add`, `counts`, `summary`, `detail`, `claim`, `hold`, `verifiedCounts`, `pageCounts`, `pageVerifiedCounts`, `userFiles`, `downloads`, `download`, `downloadDetail`, `holds`, `holdApprove`, `holdReject`, `holdRevert`, `holdReturn`, `revertDownload`, `removeAvailable`, `ledger`, and `revert`.

**Transaction rules:**

- `append` and `save` lock the file metadata row before reading or incrementing `seq`.
- `claim` and `hold` select available rows in FIFO order and lock them before changing state.
- Approval, rejection, and revert lock the download record before changing its rows and status.
- Multi-row ledger and download writes occur in the same transaction as the state change.
- Price is read and snapshotted in the same transaction that creates a download.

**Gate:** Every existing route call remains on the `rpc` seam. No route imports the Postgres client directly.

### Task 3: Port the Railway runtime

**Files:**

- Create `backend/src/server.ts`.
- Modify `backend/src/index.ts`.
- Modify `backend/src/lib/shared.ts`.
- Modify `backend/src/lib/rateLimit.ts`.
- Modify `backend/src/routes/files.ts`.
- Remove `backend/src/scheduled.ts` from the Railway runtime.
- Remove `backend/wrangler.jsonc` from the Railway runtime.
- Modify `backend/package.json`.
- Modify `backend/tsconfig.json`.
- Modify `backend/bun.lock` through `bun install`.

**Runtime requirements:**

- Listen on `0.0.0.0` and `process.env.PORT`.
- Export the Hono app independently from the server bootstrap.
- Build `Env` from Railway environment variables without Cloudflare Durable Object bindings.
- Run a best-effort Telegram webhook check without blocking the first response.
- Handle `SIGTERM` and `SIGINT` by stopping the HTTP server and closing the Postgres pool.
- Keep `/api/health` independent of database availability for Railway diagnostics, while database routes fail explicitly rather than using mock data.
- Use `x-forwarded-for` as a fallback when `cf-connecting-ip` is absent.
- Replace Cloudflare-only `executionCtx.waitUntil` calls with bounded background promises that report failures without blocking responses.
- Add a `start` command using `bun src/server.ts`.

**Gate:** Run `bun --cwd backend run typecheck`, start the server with a local `PORT`, and confirm `/api/health` returns 200 without Cloudflare bindings.

### Task 4: Preserve route behavior during storage replacement

**Files:**

- Review and modify `backend/src/routes/files.ts`.
- Review and modify `backend/src/routes/pools.ts`.
- Review and modify `backend/src/routes/admin.ts`.
- Review and modify `backend/src/routes/wa.ts`.
- Review and modify `backend/src/routes/bot.ts`.
- Review and modify `backend/src/lib/session.ts`.
- Review and modify `backend/src/lib/telegramOidc.ts` only where Node/Bun compatibility requires it.

**Required checks:**

- New file creation registers the index record before inserting child rows.
- Ownership checks use the Postgres file index and reject archived/unowned files.
- Archive and purge preserve wipe-before-pool-cleanup behavior.
- Append conflicts return HTTP 409.
- Pool filters preserve `srcUid`, `srcFileId`, verified/unverified, FIFO, and pick-mode behavior.
- Download price snapshots remain immutable after claim/hold creation.
- Hold status transitions are idempotent and reject invalid transitions.
- Cookies remain `HttpOnly`, `Secure`, `SameSite=Lax`, and scoped to `/`.
- Telegram OIDC rejects invalid issuer, audience, signature, and expiry.
- Same-origin Pages proxy behavior remains the browser contract.

**Gate:** Compare representative Worker and backend responses for health, auth errors, file-not-found, pool validation, and download status behavior.

### Task 5: Restore verification outside the backend runtime package

Backend test scripts are intentionally absent for the current coding phase. Before cutover, create a separate verification surface without adding test dependencies to the Railway runtime package.

**Files:**

- Modify `scripts/TestApi.ts` to accept `TEST_BASE` while preserving the Worker default.
- Create `scripts/railway-smoke.ts` for health, empty-database auth errors, first-user setup, file ownership, pool allocation, and rollback checks.
- Create a disposable contract harness under `scripts/contract/` only if it can run against Railway Postgres without production data.
- Do not place production secrets in fixtures.

**Required concurrency checks:**

- Two simultaneous claims cannot return the same `row_key`.
- Two simultaneous holds cannot return the same `row_key`.
- Rejecting a hold returns rows to `available` exactly once.
- Approving a hold changes rows to `claimed` exactly once.
- Reverting a download never creates negative availability or duplicate ledger effects.

**Gate:** Run typecheck, schema verification, smoke tests, route checks, and concurrency checks against an isolated empty Railway database before changing Pages.

### Task 6: Configure Railway through GraphQL API

**Inputs:** `deploy.env`, read locally without printing values.

**Railway resources:**

- Project: `SheetSubmit`.
- Environment: `production`.
- App service: `SheetSubmit`.
- Database service: `Postgres`.

**API actions:**

- Configure the app service to deploy `Cryptoistaken/SheetSubmit` with root directory `/backend`.
- Set build command to `bun install` when required by the service builder.
- Set start command to `bun run start`.
- Set healthcheck path to `/api/health`.
- Set `DATABASE_URL` to the Railway Postgres private reference.
- Set `FRONTEND_URL=https://sheetsubmit.pages.dev`.
- Set `TELEGRAM_LOGIN_CLIENT_ID=8667114953`.
- Set `ADMIN_IDS=8447133985,1772093705`.
- Set `HITOOLS_CHECK_URL` to the existing configured value.
- Set `WORKER_URL` to the Railway public domain only after the domain exists.
- Set optional Telegram/Turnstile secrets only when present in the approved secret store.
- Trigger deployment through Railway GraphQL API.
- Poll deployment status until `SUCCESS` or capture the failure reason without exposing secrets.
- Create or retrieve the Railway public domain through GraphQL API.

**Gate:** Direct `GET https://<railway-domain>/api/health` returns `{ok:true}` and the expected API version. Database bootstrap and first-use smoke tests pass.

### Task 7: Point Cloudflare Pages to Railway through REST API

**Cloudflare API actions:**

- Read the current Pages project configuration without printing tokens.
- Update only the production `BACKEND_URL` to the verified Railway HTTPS domain.
- Trigger or wait for the Pages deployment generated by the environment change.
- Do not modify the Worker route or delete the Worker.

**Proxy checks:**

- `GET https://sheetsubmit.pages.dev/api/health` returns the Railway version.
- `OPTIONS` returns 204 and preserves allowed-origin headers.
- `Set-Cookie` survives the proxy.
- JSON request bodies and query strings survive the proxy.
- Binary download responses survive the proxy.
- Railway failure and Pages proxy failure remain distinguishable in deployment logs.

**Rollback:** Restore the previous Pages production `BACKEND_URL=https://sheetsubmit.traderspopy.workers.dev` through the Cloudflare API. Do not make direct browser calls to Railway.

### Task 8: Observe and close the migration

- Monitor Railway deployment health, Postgres connection errors, 4xx/5xx rates, response latency, memory, and database query latency for at least 48 hours.
- Compare health and authenticated smoke-flow latency against the existing Worker baseline.
- Do not claim a speedup without p50/p95 measurements.
- Keep the Worker deployed throughout the observation window.
- Disable or decommission the Worker only after rollback is no longer required and the user explicitly approves it.

## Execution Gates

1. Schema and runtime typecheck pass locally.
2. Postgres bootstrap succeeds twice on an isolated Railway database.
3. Repository operations pass route and concurrency verification.
4. Railway direct health and first-use flows pass.
5. Pages proxy health and authenticated smoke flows pass.
6. Rollback to the Worker is verified before production observation.
7. The 48-hour observation window completes without a critical regression.

## Verification Commands

```text
bun --cwd backend run typecheck
bun --cwd backend run schema:bootstrap
bun --cwd backend run schema:verify
bun scripts/railway-smoke.ts
GET https://<railway-domain>/api/health
GET https://sheetsubmit.pages.dev/api/health
```

Final traffic path:

```text
Browser → https://sheetsubmit.pages.dev/api/* → Cloudflare Pages Function → Railway Hono API → Railway Postgres
```
