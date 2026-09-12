# SheetSubmit — Agent Rules

## Project quick facts
- Railway backend + Pages (`sheetsubmit.pages.dev`).
- Git-connected Pages auto-deploy on push; backend deploys through Railway. No CI deploy workflow.
- Package manager **bun**. Run `bun install` in `backend/` and `Pages/` if `node_modules` missing.
- Frontend: React 19 + TypeScript + Vite 8 + Tailwind v4 + shadcn/ui (Nova, neutral, lucide, Geist) + Zustand.
- Runtime: Hono on Bun + Postgres (`postgres.js`) + standard `redis` client + `xlsx`. Optional Redis read-through cache uses `REDIS_URL`; no KV/D1/R2.
- Auth: Telegram bot login → HMAC session cookie (`ss_session`). Stateless verify via `crypto.subtle`.
- Deploy secrets: `deploy.env` (gitignored) — CLOUDFLARE_*, RAILWAY_*, TELEGRAM_LOGIN_CLIENT_ID, ADMIN_IDS, GITHUB_*.
- Telegram bot: **TEST token** only. Never use prod token.

## Codebase map

### Root
```
. / package.json          # orchestrator: dev:web/build/typecheck/test (bun --cwd)
  AGENTS.md               # this file
  deploy.env              # gitignored — CLOUDFLARE_* + RAILWAY_* + TELEGRAM_LOGIN_CLIENT_ID + ADMIN_IDS + GITHUB_*
  backend + worker deploys: Railway dashboard per service — Root Directory=backend|worker, Config Path=/backend/railway.toml|/worker/railway.toml, Watch Paths=service dir. No root railway.json (services.rootDirectory is NOT valid config). Connect worker service to Postgres + set WORKER_URL="worker.railway.internal" on backend
  .github/workflows/
    build-android.yml     # APK CI (assembleRelease + keystore-decode, release publish/changelog)
    generate-keystore.yml # one-time Android keystore generator (password via workflow input, never uploaded/logged)
    ci.yml                # backend/Pages/worker typecheck+lint+test on push/PR
  backend/                # Railway Hono/Bun service backed by Postgres; src/server.ts is the HTTP entrypoint; railway.toml deploy config; .env local-only template; optional REDIS_URL enables safe read-through caching
                        #   PERFORMANCE.md — 62-entry inventory covering 64 handlers + per-API perf plan (bottleneck → fix → est. speedup), 002_perf.sql migration sketch, rollout order
  worker/                 # Railway background worker service (Bun + postgres.js + standard redis client + Postgres, self-contained; Root Directory=worker in dashboard, railway.toml deploy config w/ /health check, single replica). Set optional REDIS_URL alongside DATABASE_URL. /health listens on $PORT and fixed :3000 (backend dials worker.railway.internal:3000), hostname 0.0.0.0. Jobs on own intervals (30s tick, single-leader advisory lock):
                        #   held-uid-check first (pending-approval monitoring: dead UIDs → pool_rows.state='dead' + pool_blocked dead entry, default 10min + ss:live relay so watching sheets update; NO background check of available rows — they die via user checks, see wa.ts markDead),
                        #   page-check + wa-check (eligibility sweeps → data.wa_status + wa:{src_uid}:{cuser} meta cache, 30min). Env: DATABASE_URL, CHECK_URL, *_INTERVAL_MS, UID_BATCH, CHECK_BATCH, WORKER_TOKEN (gates /health error detail); .env template
                        #   + HTTP GET /health (port 3000): {ok, startedAt, uptimeMs, jobs:[{name, everyMs, lastRunAt, lastRunAgoMs, lastError}]} — backend proxies it at GET /api/worker/health
  Pages/                  # React SPA (Vite)
  android/                # CI-only wrapper (never build locally). Config.java BASE_URL = https://sheetsubmit.pages.dev; native Telegram Login SDK uses BotFather client 8667114953 and CI GitHub Maven credentials
  backend/scripts/schema.ts # DB bootstrap/verify (bun scripts/schema.ts bootstrap|verify)
  test/                   # test fixture xlsx files (2fa.xlsx, cookie.xlsx, Page.xlsx)
  Pages/e2e/              # Playwright browser tests (auth.ts cookie-injection login, smoke.spec.ts) — `bun run test:e2e`, needs backend ALLOW_TEST_AUTH=1 + test DB, never prod; CI e2e job in .github/workflows/ci.yml
  agent/                  # dev debugging tools (call.ts authed caller, health.ts backend+worker sweep, timing.ts dual-origin latency sweep, users.ts TEST-user mint/verify/delete via POST /api/test/login (needs ALLOW_TEST_AUTH=1, aborts on closed door — never prod), pipeline.ts end-to-end run on behalf of minted users: upload→pool→price→hold→approve→wallet (+optional --with-routing suite, --wait-settle); needs --admin-uid in dev ADMIN_IDS, rowloss.ts API row-loss regression (stale-base 409, uid/status round-trip, snapshot index restore, 500-cap refusal, purge tombstone)) — secrets from gitignored agent/.env (AGENT_TOKEN + BACKEND_URL + FRONT_URL + SS_SESSION), real env overrides; never commit tokens
  docker-compose.test.yml # local test env (Postgres 16 + Redis 7, never prod) — USE IT whenever verifying backend DB behavior (pg.ts/pool/routes changes: DB-gated suites skipIf without DATABASE_URL), for Pages e2e, and for agent/ pipeline/rowloss runs against local. Loop: `docker compose -f docker-compose.test.yml up -d` → `$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/sheetsubmit_test"` → `bun scripts/schema.ts bootstrap` in backend/ → `bun test src` in backend/ (full suite incl. DB tests) → `docker compose -f docker-compose.test.yml down -v` when done (never leave test containers running)
```

### Backend — `backend/src/` (Hono/Bun, entry `src/server.ts`)
```
  index.ts              # app setup, routes, API_VERSION (currently 2.0.26; bump on any route change, surfaced by /api/health), typed JSON errors (known client failures → 4xx with message, unknown masked as 500 + logged with method+path),
                      #   GET /api/health (all client calls are plain HTTPS — no WebSocket transport),
                      #   GET /api/worker/health (proxies worker.railway.internal:3000/health — proves worker connectivity from the public URL),
                      #   GET /api/health (all client calls are plain HTTPS — no WebSocket transport),
                      #   /api/auth/me (verifySession, returns CDN photoUrl+phone+isAdmin), POST /api/auth/logout,
                      #   POST /api/auth/device/claim {token} (deviceGet/Delete),
                      #   GET /api/auth/telegram/config + POST /api/auth/telegram/verify (official Telegram Login OIDC/JWKS, stores picture+phone),
                      #   GET /api/bot/info, ensureWebhook on first request
                      #   + wallet routes: GET /api/wallet, POST /api/wallet/withdraw, GET /api/wallet/requests, POST /api/wallet/requests/:id/:action
 lib/shared.ts         # Env type (TG_BOT_TOKEN, ADMIN_IDS, SESSION_SECRET, TG_WEBHOOK_SECRET, BACKEND_URL, FRONTEND_URL, WORKER_URL, CHECK_URL, ALLOW_TEST_AUTH, TELEGRAM_LOGIN_CLIENT_ID)
 src/lib/telegramOidc.ts # Telegram Login OIDC/JWKS token verification
  src/lib/session.ts      # signSession, verifySession (HMAC SHA-256, fail-closed), requireAuth (HMAC + DB session + banned check), isAdmin, cookie builder (SameSite=None on https for direct cross-origin calls, Lax on http)
                      #   src/lib/__tests__/session.test.ts (sign/verify incl. tamper+expiry, cookie strings, isAdmin), sharedFeed.test.ts (poolRowKey/poolFeedSig), revertFinality.test.ts (revertDownload finality vs live DB, skipIf no DATABASE_URL), fileDeletePool.test.ts (filePoolState scoping + removeFileRows wipes one file fully + userFiles orphan filter, skipIf no DATABASE_URL), poolBlocked.test.ts (approve/claim record sold + feed refuses blocklisted, skipIf no DATABASE_URL), livePublish.test.ts (grouping/relay validation + guarded fan-out), routes/__tests__/live.test.ts (ticket SSE seam + guarded issue→stream→state), routes/__tests__/poolLive.test.ts (admin pool-count ticket SSE seam + issue→stream→counts + write-hook fan-out), routes/__tests__/applyHoldFlags.test.ts (dead+approved flag overlay) — `bun run test` in backend/
  src/lib/redis.ts        # optional standard node-redis client; fail-open read-through cache helpers using REDIS_URL (+ pool/index rpc entries evicted on mutation via redisDelPrefix — never cache pool reads across a feed); + live relay (publishLiveEvent, subscribeLiveEvents on ss:live with own sub connection)
  src/lib/live.ts         # live row-state domain: one-time stream tickets (60s TTL, single-use) + groupLiveStates (flat key rows → per-file maps, set flags only) + parseLiveEvent (worker relay validation, 500-key cap); pool-count tickets (mint/consumePoolLiveTicket keyed "password:pool") + poolRoom (`pool:{password}:{poolId}`, never collides with fileId rooms)
  src/lib/liveBus.ts      # in-process fan-out rooms per fileId (joinLive/publishLive) + raw publishRoom (pool-count rooms carry their own envelope); single replica (no numReplicas in railway.toml) so no Redis relay
  src/lib/livePublish.ts  # DB→rooms bridge: publishDownloadStates (one download) + publishKeyStates (bare keys, any password) + publishPoolCounts (summary + summaryAll + page verifiedCounts → pool rooms, counts only; pools[] carries {id, available} badges) + poolCountsSnapshot (one pool's snapshot for live-state), fail-open
  src/lib/agent.ts        # DEV-ONLY agent door: agentDoorOpen (ALLOW_AGENT_ACCESS=1 + AGENT_TOKEN), timing-safe token check, requireAgent (404s when closed)
 src/lib/do.ts            # 5-line rpc wrapper → repository (pg.ts)
  src/lib/pg.ts            # Postgres.js repository for users, files, pools, wallets, withdrawals and wallet_transactions (max 10 connections); SQL-side pool pagination, batched claims/removals, file-key projection, session cleanup and admin user lookup
                        # + STRICT ROUTING (classify): file preset feeds ONLY its own pool — combo→cookies_2fa, page→page (real 2fa required; wa-eligible = verified, cookie+2fa only = unverified, both claimable in page pool via verifiedOnly/unverifiedOnly), cookie→cookies_only; key-less or no-2fa live rows are invalid → pool_rejects (deduped per account, cleared on successful pooling), never cookies_only
                        # + LIVE STATES: liveStatesByDownload (per-file key flags for one download) + liveStatesByKeys (bare keys across passwords, cap 500) feed the row-state push fan-out (see routes/live.ts); repository() fans fresh pool counts out fire-and-void on every POOL_WRITE_OPS commit (add/claim/hold/holdApprove/holdReject/revertDownload/markDead/removeAvailable/removeFileRows → publishPoolCounts, same-password (+pool) scope)
                        # + DELETE OPS: filePoolState ({held, claimed} scoped by src_file_id) + removeFileRows (deletes every pool row of one file, any state) back the delete semantics in routes/files.ts; key-based heldCheck/removeAvailable stay for edit guards + pool-disable; userFiles hides rows whose src_file_id is gone from file_index (kills ghost files in the owners list)
                        # + SOLD BLOCKLIST: pool_blocked (007, global by row_key) — instant-claim + holdApprove record sold keys, worker held-uid-check records died-on-hold keys, pool feed (add) refuses blocklisted keys ({added, blocked}) and clears their available husks, diag surfaces the entry; backfilled from claimed + dead-held rows + sold downloads, so deleted files' accounts can never be re-uploaded and resold
  src/routes/files.ts      # files, archive and duplicate routes (500 rows/file strict, server-enforced; files per user uncapped)
                      # + DELETE SEMANTICS: ONLY held rows block deletes — archive + permanent delete 409 while the file has held pool rows (scoped filePoolState check, so another file's hold never blocks); otherwise the delete wipes ALL of the file's pool rows (available + approved/claimed + dead) via the removeFileRows op; edit paths (persist removed-rows, snapshot restore) still 409 on held via key-based heldCheck; sheetStore persist + HomePage delete surface the error toast
                      # + ROW-LOSS GUARDS: PUT /:id/persist takes optional base seq → 409 version conflict on stale (two-editor overwrite protection, shared.ts isPersistConflict); POST /:id/restore-snapshot restores rolling snapshots (up to 3 in meta KV filesnap:<id>, optional {index}, wiped with file, hold-locked like persist); purge writes a forensic tombstone (meta filetomb:<id>: name/owner/rowCount/logs) served by admin GET /file/:id/logs
                      # + decorateHoldState: file row reads (GET /:id/rows, /:id/full; admin.ts /file/:id/rows) overlay pool state → row._hold/_approved/_dead (SheetGrid tints rows; hold+approved rows locked client-side)
                      #   + archive router (GET /, POST /:id/restore, POST /batch-restore, DELETE /:id, POST /batch-delete — bulk index ops, concurrent wipes, pool cleanup; restore + batch-restore re-feed via feedPools)
                      #   + crossDups router (GET /?fileId= — same-type uid scan, {counts, dups})
src/routes/live.ts       # live row-state pushes: POST /files/:id/live-ticket (session + owner-or-admin → one-time ticket), GET /files/:id/live (ticket SSE stream, no session; mounts before files router so /* auth never sees it), GET /files/:id/live-state (flag-only overlay for resync/polling); approve/reject/revert/hold/markDead publish via livePublish, worker deaths relayed on ss:live; + live pool counts: POST /pools/:password/:pool/live-ticket (requireAuth + isAdmin → one-time ticket), GET /pools/:password/:pool/live (ticket SSE stream of pool-counts, same mount-order rule vs pools /* auth), GET /pools/:password/:pool/live-state (requireAuth + isAdmin counts snapshot for the 15s poll fallback — heals worker wa/page-sweep drift, which moves the page verified split but no counters)
src/routes/pools.ts       # admin pool, hold, download and pricing routes
                      #   GET /holds (status filter, PENDING alias maps to HOLD in pg.ts holds/holdsAll), POST /holds/:id/approve (from HOLD and REJECTED — re-claims still-free rows, dead rows consumed unpaid, {approved, dead, paid}), POST /holds/:id/reject + /return (same handler → holdReject op; from HOLD and APPROVED — rejecting an approved hold auto-debits wallets in full, {rejected, debited}),
                      #   GET /holds (status filter), POST /holds/:id/approve + /reject + /return (REVERT WINDOW: first action starts 5min, exactly one flip allowed, then final — pg.ts throws "decision is final — revert window closed"; NO wallet ops at action time), POST /downloads/:id/revert (revertDownload op, same finality guard — Delete on approvals uses it; UI Delete button locks when final),
                      #   settlement: backend sweeps every 30s (startBackgroundTasks → settleHolds op) — after first_action_at+5min, APPROVED credits owners for rows still claimed (dead unpaid), REJECTED pays nothing; legacy rows frozen settled
                      #   GET /downloads/:id (xlsx blob, any approval state; ?srcUid=&srcFileId=&name= → filtered per-user/per-file download via downloadRows op), GET /downloads/:id/detail (groups enriched with file name/createdAt/preset)
                      #   GET /:pwd/:pool/ledger → 410 gone (pool_ledger dropped; use download detail + wallet tx), GET /:pwd/:pool (PoolDetail, delegator=src_uid avail+claimed, users carry joined name/username/photoUrl from users table), /rows (paginated+verifiedOnly/unverifiedOnly, detail capped 5000), /verified-counts (SQL-side eligible count, no 5k starvation), /user-files (files carry name/createdAt/preset from file_index), /price GET+PUT (stored price 0..1000, admin validated), POST /:pwd/:pool/claim (→ downloadId+filename+unitPrice/total/status), POST /:pwd/:pool/hold (same + mode/pick, srcUids/srcFileIds, HOLD status, FIFO inserted_at/row_key, storedPrice)
src/routes/admin.ts       # admin stats, users, files and moderation routes
                      #   PUT /file/:id/persist takes optional base seq (same 409 guard) + same removed-held 409 as owner persist (no admin exemption); POST /file/:id/restore-snapshot (same hold-lock rule as owner restore); GET /file/:id now includes seq (feeds admin sheet base)
                      #   GET /users/search (SQL ILIKE, limit 50 via adminUsersSearch op),
                      #   GET /pooldiag?key= (cross-password account trace: pool_rows in any state + pool_rejects + downloads + source files + live file-row locate with server-side classify; feeds the Pool lookup tool),
                      #   PUT|DELETE /file/:id, GET /file/:id/rows|logs|undo, PUT /file/:id/persist (feeds pools like the owner route),
                      #   DELETE /file/:id (admin archive) wipes the file's pool rows like owner archive; admin archive-restore re-feeds pools like owner restore,
                      #   POST /user/:id/:action (ban|unban), POST /user/:id/archive/:fileId/restore (re-feeds pools), DELETE /user/:id/archive/:fileId (held-block + pool wipe like owner purge), DELETE /user/:id (wipes all files + all their pool rows)
src/routes/wa.ts          # POST /fb/check (user liveness checks; dead uids → pools markDead op, kills their available pool rows + live-publishes them), /fb/page-check, /fb/wa-check and WA cache routes
                      #   GET /wa/cache?uids= (meta-backed, eligible-only, 24h TTL)
src/routes/bot.ts         # Telegram webhook and bot routes
src/routes/testAuth.ts    # TEST-ONLY POST /api/test/login (mints ss_session for Playwright e2e; 404s unless ALLOW_TEST_AUTH=1 — never set on prod)
src/routes/agent.ts     # DEV-ONLY /api/agent/* introspection (health, routes, stats, worker proxy, config presence flags — read-only, no secret values; 404s unless ALLOW_AGENT_ACCESS=1 + AGENT_TOKEN — never set on prod)
  railway.toml          # Railway deploy config (builder + startCommand + healthcheck ONLY — no buildCommand; Railpack auto-installs, packageManager=bun@1.4.0 in package.json is what pins bun over npm)
```

### Pages — `Pages/src/` (Vite 8, entry `main.tsx`)
```
main.tsx              # StrictMode, Toast>Confirm>Auth>App, service-worker + chunk-error reload guard
App.tsx               # createBrowserRouter: RequireAuth gate (unauth → /login with redirect-back state) → Layout (Topbar+Outlet); public /login route (LoginRoute, bounces authed users back); bubble mode
index.css / app.css   # tailwind v4 + shadcn + geist + legacy styles
vite.config.ts        # react + @tailwindcss/vite, alias @→src, proxy /api→localhost:3000, manualChunks vendor-react|xlsx|vendor-ui|vendor-state|vendor
server.js             # Bun static server + same-origin /api + /webhook proxy (identity encoding, cookie forward) for Railway Web
components.json       # shadcn Nova, neutral, cssVariables, lucide
 pages/HomePage.tsx    # /,/files,/archive,/wallet,/withdrawals,/pools/:password/:poolId,/approvals,/settings,/admin,/analysis,/tools (+/pools redirect, /tools/splitter, /tools/pool-lookup, /admin/user/:userId, /bubble-design); WalletView is wallet-only (balance + request form + balance history); WithdrawalsView (/withdrawals tab after Wallet, public/withdrawal-icon.svg img icon: own history, admin review list with approve/reject); every new file pools (backend forces poolEnabled:true on create; only an admin can switch a file off)
pages/SheetPage.tsx   # /file/:id + /admin/user/:userId/file/:fileId
pages/BubbleDesignPage.tsx   # /admin renders via HomePage + components/home/AdminView.tsx (no AdminPage file)
 components/layout/Topbar.tsx          # connection card + shadcn profile dropdown + animated theme toggle (mobile header everywhere; desktop home: admins get route breadcrumb left + utility cluster right via .home-topbar.admin CSS, regulars keep brand header + tabs, full header on sheet pages)
components/layout/Sidebar.tsx         # collapsible admin-only rail, same on desktop + phones (default 240px, icons 64px, ss_sidebar_mode expanded|icons|hidden + ss_sidebar_width; trigger toggles expanded↔icons, hidden via drag/keys with floating expand button back; hover auto-expands only with (hover:hover) mice, tap trigger on touch; edge-drag resize 64–320px via 24px touch zone + grip (always visible on touch, hover-reveal on desktop), <6px move ignored as tap, release <68px hides, <160px icons; separator focusable with arrow keys; logo block h-12 matches topbar): logo header, home-section links + Admin group, footer with files-tab ViewSwitch (expanded only) + panel trigger (hover dead-zone: footer hover never expands/collapses, click toggles); admins hide the tab bar (#homeTabBar.admin-tabs) and get the breadcrumb header (no dup logo), regulars keep Topbar + tabs + floating toggle everywhere; profile/balance/theme live in the topbar, never the sidebar; sheet pages never mount it
components/home/FileGrid.tsx, FileCard.tsx, PoolsView.tsx (pool-only: password/pool switches + stat cards incl. invalid (missing/incomplete 2fa, from pool_rejects; hidden for cookies_only) + taker card (takes instantly, no confirm dialog; Take navigates to /approvals?hold=; Amount is display-only, editing moved to Settings) + owners list (no "..." menu, click expands user files as list rows with real name+created date+open-in-browser button)), ApprovalsView.tsx (/approvals top-level tab after Pools with ApprovalsIcon: PENDING/APPROVED/REJECTED switches (?status=&hold= deep links; fetches HOLD+APPROVED+REJECTED in parallel, HOLD→PENDING client-side) + shadcn AvatarGroup file icons per hold, no APPROVED seal, click expands inline drill-down owners→files with per-user/per-file download (server-filtered blob) + open file + Approve (PENDING/REJECTED) / Reject (PENDING/APPROVED) + Delete (hold-to-delete) + Approve/Reject/Delete all lock when final (revert countdown → "Decision final") + dead count toast after approve), SettingsView.tsx (/settings top-level tab after Approvals with public/settings-icon.svg img icon: expanded pool-price editor (both passwords × 3 pools, USD/BDT entry toggle, confirm dialog, stored USD) + ৳/$ conversion-rate editor), ArchiveView.tsx, AdminView.tsx, AnalysisView.tsx, WalletView.tsx (wallet-only; shared row helpers exported for WithdrawalsView), WithdrawalsView.tsx, Fab.tsx, ViewSwitch.tsx (grid/list toggle, floating prop: regulars floating, admins sidebar footer), EmptyState.tsx
components/sheet/SheetGrid.tsx, SheetToolbar.tsx, QuickEditBar.tsx, SelectionBar.tsx, CellEditor.tsx, UploadOverlay.tsx, DownloadOverlay.tsx, CustomDownloadOverlay.tsx, WaCheckOverlay.tsx
                      #   SheetToolbar ⋮ menu has an admin-only Pooling on/off switch (PUT /file/:id poolEnabled, owner or admin route; enabling re-saves to re-feed, disabling removes available pool rows server-side)
                      #   SheetToolbar ⋮ menu has Restore last save (POST restore-snapshot, confirm; previous state kept in client Undo); replace-upload over MAX_GRID_ROWS (500) confirms with truncation warning (types.ts replaceCapMessage); emptiness rule is types.ts isDataRow (columns ∪ uid ∪ status)
                      #   SheetGrid row states: pool rows show dot-only color; pending (hold) wears the account color on data cells (number/dot cells default); approved wears data+number cells + per-cell black cut on data cells only; cross-file dup colors uid/cookies cells (cell-xdup); dots always mean account status (alive/eligible/dead/dup/pending); same-file dupes blocked at commitCell; legacy _taken removed everywhere; alive #229342 / dead #e33b2e tokens, monochrome selection
components/bubble/BubbleMode.tsx   # ?bubble=1&file=ID + window.Android; STRICT 2FA-first: key (base32, 10-32 chars, spaces optional) anchors the row, cookie (numeric c_user + key=value) completes it; cookie onto a keyless row refused ("Paste 2FA first"), malformed keys refused ("Bad 2FA key"), long-press skip marks keyless rows and advances only once the cookie lands
components/auth/LoginScreen.tsx      # official Telegram Login OIDC (web widget + Turnstile, profile+phone+write scopes) or Android native SDK bridge; legacy bot login removed; ?bubble=1 login page polls /me so a main-app login carries the bubble window in automatically
components/tools/SplitterTool.tsx   # xlsx split into N parts (/tools/splitter)
components/tools/PoolLookupTool.tsx # trace a uid/c_user across all pools + live file rows (/tools/pool-lookup, admin-only tool calling GET /admin/pooldiag) — shows BLOCKED banner + verdict for sold/dead-blocklisted accounts
components/icons/FileTypeIcons.tsx, ApprovalsIcon (rescript-icon), FacebookIcon.tsx
components/profile/ProfileAvatar.tsx
 components/ui/button.tsx, avatar.tsx, dialog.tsx, alert-dialog.tsx, dropdown-menu.tsx, theme-toggler.tsx, hold-to-delete-button.tsx, slide-to-confirm-button.tsx, ink-stamp.tsx, page-skeleton.tsx, search-input.tsx  # shadcn and reusable pool actions
contexts/AuthContext.tsx           # skip /me if no ss_had_session, session_expired redirect, retry 3×1.5s
stores/sheetStore.ts      # central Zustand: rows, undo/redo, persist (PUT /persist vs /append), dedup marks, WA checks, selection; _taken/_hold/_approved rows reject cell edits (commitCell, openQuickEdit, openInlineEdit); flushPersist sends base seq (409 version conflict → reload server version + stash ours in Undo + re-apply journal); applyRestore for snapshot restore; applyLiveStates for socket/poll flag patches (cells never touched); direct-edit guards: locked-row toast (never silent), formula blur-commit, open-cell draft commit, twofakey normalize + cookie/key blob split, bulk-clear skips locked
stores/bubbleStore.ts     # {on, pickMode}
stores/viewStore.ts       # file-grid view mode (ss_fileView): shared by the sidebar footer toggle (admins) + floating toggle (regulars)
stores/profileCache.ts    # profile cache (fed from /me + admin users; setProfiles ignores identity-less pool stubs so UIDs never clobber real names)
hooks/useUndoRedo.ts, usePersist.ts (beforeunload→flushPersist), useLiveRows.ts (ticket stream + polling fallback for open file, flag-only patches), useModalA11y.ts
  lib/api.ts                # BASE=RUNTIME_BASE+"/api", request/requestBlob, useConnStore (connection status fed by request outcomes), files/persist/append/WA/admin/pools, live (requestLiveTicket/getLiveState/apiBase for the row-state stream), me/logout/botInfo/Telegram Login/claimDeviceSession; RUNTIME_BASE goes direct to Railway on the prod web host (override → proxy otherwise; Android app always proxies — WebView blocks third-party cookies); verifyTelegramLogin falls back to the same-origin proxy when the direct cross-site POST fails and pins it via ss_api_proxy localStorage (cleared on logout) so later calls stay on the cookie's host
lib/types.ts              # FileType, ColumnDef, SheetFile, Row
lib/currency.ts           # display currency (USD stored, BDT @ editable rate, default 120, ss_bdt_rate + ss:bdt-rate event via load/save/useBdtRate; fmtMoney/usdToInput/inputToUsd read the live rate, useCurrency re-renders on rate change): useCurrency hook (one ss_currency key, legacy USDC/ss_price_currency migrated, live-synced), fmtMoney, usdToInput/inputToUsd (BDT keeps paisa so 7.3 round-trips); Topbar pill + PoolsView + ApprovalsView + SettingsView + WalletView all follow it
lib/xlsx.ts               # importXlsx/buildXlsx/downloadXlsx/parseSheetRows
lib/downloadOpts.ts       # buildDownloadOpts counts
lib/utils.ts (cn), theme.ts, device.ts, toast.tsx, confirm.tsx, lazyRetry.ts
features/filetypes/index.ts, fbcookie.ts, validation.ts, totp.ts
features/filetypes/__tests__/filetypes.test.ts (validateCell, TOTP RFC vectors, fb-cookie behavior, isPageFile)
public/config.js          # injected at runtime: window.APP_CONFIG={apiBase:""}
public/sw.js              # service worker (chunk-error reload)
functions/api/[[path]].ts # Pages Functions proxy → BACKEND_URL
functions/webhook/[[path]].ts
lib/__tests__/customDownload.test.ts, split.test.ts, idb.test.ts (IDB outbox mirror/snapshot/replay), rowguard.test.ts (isDataRow/replaceCapMessage/isPersistConflict + destructive call-site guards), xlsx.test.ts (build/parse round-trip, importXlsx, buildDownloadOpts, hydrateWaCache), apiClient.test.ts (request contract via mocked fetch)
stores/__tests__/sheetStore.test.ts (api mock mirrors the live lib/api.ts surface — no version-history stubs; that API is gone), sheetStoreOffline.test.ts (offline snapshot open), liveStates.test.ts (flag patches), lib/__tests__/live.test.ts (stream client + poolRowKey)
```

### Auth flow
1. User opens site → AuthContext checks `ss_had_session` localStorage flag.
2. No flag → skip `/me`, RequireAuth bounces to `/login` immediately (zero wasted requests).
3. Flag exists → call `GET /api/auth/me` (once per page-load at most):
   - No cookie → 401 `not_authenticated` + `loginRequired:true` → clear flag, bounce to `/login`, never retry.
   - Invalid/expired cookie → 401 `session_expired` + `loginRequired:true` → clear flag, `/login` with notice, never retry.
   - Valid → 200 user JSON → set user.
4. LoginScreen: web shows official Telegram Login widget (Turnstile-gated) → `POST /api/auth/telegram/verify {id_token}`; inside the app it invokes the Android native SDK bridge instead (no Turnstile, no legacy bot flow).
5. On success → set `ss_had_session` flag, reload to saved destination (default `/`) → AuthContext picks up cookie.
6. Prod web calls the backend directly (cross-origin, `SameSite=None` cookie); one re-login is needed after switching modes because the old host-only proxy cookie is not sent cross-origin. Android keeps the same-origin proxy.

## Rules
1. **Production isolation** — test bot token only, own Railway project. Never touch prod.
2. Use tokens/CSS variables for colors — no hardcoded hex.
3. **Android — NEVER build locally, CI only.**
4. Pages auto-deploy on git push; backend deploys through Railway. No CI deploy step.
5. No versioning — save increments `seq` counter in meta. Undo/redo is client-side only (Zustand in-memory).
6. Backend uses Postgres; keep operations lightweight and transactional.
7. No KV/D1/R2 bindings.
8. **Postgres.js type coercion** — `NUMERIC`/`DECIMAL` and out-of-i32-range `BIGINT` (e.g. epoch-millis timestamps) may come back as **strings**; cast (`amount::float8`, `created_at::float8`) or wrap with the `json()` helper in pg.ts. Pass JSONB objects/arrays directly to postgres.js parameters; do not pre-stringify them, or JSONB recordset inputs become doubly encoded. JSON responses must carry real numbers/objects.
8. Backend API change flow: bump `API_VERSION` in `backend/src/index.ts` → run `bun run typecheck` in `backend/` → deploy through Railway → confirm via `GET /api/health`.
9. **Commit & push after every completed code-change batch.** After finishing a set of modifications (typecheck + tests pass), immediately inspect `git status`/`git diff`, `git add` only the files changed for this task, commit with a concise message, and `git push` to the current upstream branch. Do not leave completed task changes uncommitted or unpushed. If unrelated work is present, leave it untouched and commit only this task's files. If commit or push fails, report the failure and resolve it before finishing when possible.
10. **Keep this file fresh.** Any change that adds, removes, renames, or moves a route, file, DO op, store, or workflow → update the Codebase map + Auth flow above in the SAME commit, or the next agent works blind.
11. **Agent door is dev-only.** `ALLOW_AGENT_ACCESS=1` + `AGENT_TOKEN` live only in dev Railway backend variables, never in git, never on prod. Seal before any prod release: unset `ALLOW_AGENT_ACCESS` (door 404s when closed).

## Capacity
| Resource | Limit |
|----------|-------|
| Pages builds/month | 500 (Free) |
| Subrequests/request | 50 |
| Body limit | 4 MB |
| Postgres.js pool | 10 connections max |
