# SheetSubmit Railway Migration Execution Plan

**Goal:** Make the backend deployable on Railway while keeping the React frontend on Cloudflare Pages and preserving the Pages Functions proxy as the browser-facing API.

**Target architecture:** Railway runs the Hono API as a standard Node/Bun HTTP service. Railway Postgres replaces Cloudflare Durable Objects as the system of record. Railway Redis provides distributed cache, rate limiting, and short-lived session/device state where appropriate. Cloudflare Pages remains the public origin and proxies `/api/*` to Railway through `BACKEND_URL`.

**Non-goals:** Do not move the frontend from Pages. Do not expose Railway directly to browser calls. Do not delete the Cloudflare Worker until rollback and production verification are complete. Do not promise an arbitrary 10x speedup; measure each hot path, remove avoidable round trips, add indexes/transactions, and retain only improvements proven by benchmarks.

## Evidence and Decisions

- Cloudflare Worker `sheetsubmit` is live at API version `1.5.1`; it uses `IndexDO`, `FileDO`, and `PoolDO` SQLite Durable Objects.
- Cloudflare Pages project `sheetsubmit` is healthy, uses Functions, and currently has production `BACKEND_URL=https://sheetsubmit.traderspopy.workers.dev`.
- Railway project `SheetSubmit` has production services: app `d0ec267b-f343-4e09-8683-42c773c6d676`, Postgres `cc34a9ae-d761-4e86-8035-043788b9d574`, Redis `f636a177-32ea-4cd6-87d9-04f144b239e8`.
- Railway app deployments currently fail because the repository has no Railway HTTP entrypoint and still depends on Cloudflare-only bindings.
- The Pages proxy added approximately 25ms median on `/api/health` in live sampling (`143ms` direct Worker vs `167ms` proxied). Keep it: it preserves same-origin cookies and avoids cross-site credential/CORS/CSRF risk. Large file transfers must be benchmarked separately.

## Required Engineering Rules

- Read and preserve the existing route contracts and response shapes before changing storage.
- Keep `worker/src/lib/do.ts` as the compatibility seam initially; port behavior behind it before simplifying callers.
- Use Postgres transactions and row locks for claim/hold/revert operations; the Durable Object's serialized behavior must not be lost.
- Add explicit Postgres constraints and indexes for every lookup, FIFO selection, ownership filter, and status transition used by production routes.
- Use one bounded Postgres pool and one Redis client per process; set connection, idle, and statement timeouts.
- Never use an unbounded in-memory cache or rate limiter in a multi-instance Railway deployment.
- Preserve validation, authorization, CSRF protection, data-loss safeguards, cookie flags, and error responses.
- All changed routes need happy-path, validation, unauthorized, and not-found coverage in `scripts/TestApi.ts` where applicable.
- Bump `API_VERSION` only with a tested API behavior change; verify the new version through both Railway and Pages proxy.
- Do not commit `deploy.env` or print any secret in logs, agent output, commits, or issue text.
- Commit and push each completed batch; update `AGENTS.md` whenever the codebase map changes.

## Parallel Workstreams

The following workstreams may run in parallel only where their dependency is satisfied. Each agent must first inspect current code and existing uncommitted changes, then report files changed, tests run, risks, and exact follow-up dependencies. Agents must not rewrite unrelated work or deploy production without the cutover gate.

### Workstream 1: Runtime and Railway deployment

Implement the Railway HTTP entrypoint over the existing Hono `fetch` handler. Configure Bun/Node runtime, `PORT`, `0.0.0.0`, graceful shutdown, health/readiness behavior, and Railway service build/start settings. Confirm the app can boot without Cloudflare bindings by using explicit dependency injection or a temporary fail-fast diagnostic, not silent mock data.

**Acceptance:** Railway app deploy reaches `SUCCESS`; `/api/health` returns 200; startup logs contain no secret values; SIGTERM closes database/Redis resources cleanly.

### Workstream 2: Fresh Postgres schema foundation

There is no production data in the Cloudflare Durable Objects, so do not build an export/import or historical data migration. Research every SQLite schema and operation in `IndexDO.ts`, `FileDO.ts`, and `PoolDO.ts`. Produce a versioned fresh-install Postgres schema, preserving data types and semantics while adding constraints, foreign keys where safe, composite indexes for real query predicates, and timestamps in UTC. Include an idempotent bootstrap and a schema verification command. The database must start empty and ready for new users/files after deployment.

**Acceptance:** Fresh Railway Postgres bootstrap succeeds twice; schema verification reports expected tables/indexes/constraints; the application can create its first user/file/pool; no data-copy or destructive migration runs.

### Workstream 3: IndexDO repository port

Port all `IndexDO` operations behind the existing `lib/do.ts` interface. Preserve user, file index, sessions, device tokens, metadata, admin, statistics, and wallet behavior. Use parameterized SQL, explicit transactions for multi-write operations, and pagination limits. Remove DO transport only after repository contract tests pass.

**Acceptance:** Existing admin, auth, file-index, session, metadata, and wallet API tests pass against a local Railway-compatible runtime and staging Railway service.

### Workstream 4: FileDO repository port

Port file metadata, rows, sequence counters, append/save, logs, duplicate-key queries, full reads, and wipe behavior. Design indexes from actual filters and enforce sequence updates transactionally. Preserve the 200-log cap and wipe-before-pool-cleanup behavior. Stream or paginate large reads instead of materializing avoidable copies.

**Acceptance:** Upload, persist, append, rows, full, logs, undo, archive, and wipe flows pass with row-count and sequence invariants; large-file benchmark records memory and latency.

### Workstream 5: PoolDO repository port and concurrency correctness

Port pool rows, prices, ledger, downloads, holds, claims, approvals, rejection/revert, verified counts, and user-file queries. Use short Postgres transactions with `FOR UPDATE SKIP LOCKED` or an equivalent safe allocation strategy. Prove FIFO ordering, source-file/user filters, price snapshots, idempotent transitions, and no double-claim behavior with concurrent tests.

**Acceptance:** Pool API suite passes; concurrent claim/hold stress test produces no duplicate row allocation, negative availability, incorrect totals, or invalid status transitions.

### Workstream 6: Redis, authentication, and security portability

Research current session, Telegram OIDC/JWKS, device claim, rate-limit, and WA-cache behavior. Port only state that benefits from Redis; keep durable business records in Postgres. Replace Cloudflare-only crypto/runtime APIs with Node-compatible implementations while retaining algorithm, expiry, constant-time comparison, cookie attributes, and failure behavior. Add origin checks for state-changing requests where required. Keep browser requests same-origin through Pages, so do not weaken the existing `SameSite=Lax` cookie to enable direct Railway calls.

**Acceptance:** Login/logout/session expiry/device claim/Telegram verification/rate-limit/WA cache tests pass; invalid signatures and expired sessions fail closed; Redis outage has an intentional safe failure mode; no credential appears in responses/logs.

### Workstream 7: API contract and performance audit

Inventory every route in `index.ts` and route modules. Build a compact benchmark matrix for health, auth, file list, rows/full, pool rows, claim/hold, admin search, and download. Capture p50/p95 latency, query count, response bytes, database time, Redis time, and memory. Use evidence to remove N+1 queries, duplicate reads, unnecessary serialization, missing indexes, and oversized selected columns. Add response compression only where it does not break the Pages proxy or binary downloads.

**Acceptance:** Before/after benchmark is committed as a report artifact outside secrets; every claimed optimization has a measured result; no endpoint regresses correctness or p95 latency. A 10x result is accepted only where measurement demonstrates it, otherwise report the actual improvement.

### Workstream 8: Test harness

Add repository contract tests that run against disposable Postgres/Redis-compatible services and expand `scripts/TestApi.ts` for changed route/error cases. Test first-user/file/pool creation, ownership, pool availability, ledger totals, wallets, sessions, and timestamps from an empty database. Keep test credentials and production secrets out of fixtures.

**Acceptance:** Typecheck, unit/contract tests, route tests, concurrency tests, and empty-database bootstrap verification pass.

### Workstream 9: Pages proxy, observability, and rollback

Verify the existing Pages Functions proxy preserves methods, query strings, request bodies, `Set-Cookie`, binary downloads, status codes, and timeout behavior when `BACKEND_URL` points to Railway. Add safe request correlation and latency metrics without logging cookies, tokens, spreadsheet rows, or Telegram identifiers. Define health, readiness, error-rate, and rollback checks. Keep the Worker URL available as a rollback target.

**Acceptance:** Pages `/api/health` and authenticated smoke flows pass through Railway; binary download/upload tests pass; rollback is one Pages environment-variable change; proxy and Railway failures are distinguishable in logs.

### Workstream 10: Cutover and decommission gate

Bootstrap the empty Railway Postgres schema on a staging/isolated Railway environment first, then deploy the app with production variables. Confirm Railway direct health, Pages-proxied health, first-user registration/login, files, pools, downloads, admin, Telegram webhook, and scheduled webhook maintenance. Change only Pages production `BACKEND_URL` for cutover. Monitor for at least 48 hours with rollback ready before disabling the Worker.

**Acceptance:** Railway deployment is healthy, Pages remains the public origin, an empty database supports first-use flows, all route tests pass against the new backend, no critical error/latency regression occurs during the observation window, and the Worker is not deleted until the rollback window closes.

## Execution Order and Gates

1. Run Workstreams 1, 2, 7, and 9 as discovery/foundation work; do not cut over.
2. After schema approval, run Workstreams 3, 4, and 5 in parallel against repository contracts.
3. Run Workstreams 6 and 8 after the database interfaces are stable; run security and concurrency tests before deployment.
4. Run Workstream 10 only after all acceptance gates pass and the data migration verification is signed off.
5. At each gate: inspect `git diff`, run typecheck/tests, commit only the bounded batch, push, and record the deployment/result.

## Final Verification Commands

```text
bun --cwd worker run typecheck
bun --cwd worker run test
EXPECT_VERSION=<new-version> bun scripts/TestApi.ts
GET https://<railway-domain>/api/health
GET https://sheetsubmit.pages.dev/api/health
```

The final production configuration is: browser → `https://sheetsubmit.pages.dev/api/*` → Pages Function → Railway API. Direct browser calls to Railway are not part of this migration.
