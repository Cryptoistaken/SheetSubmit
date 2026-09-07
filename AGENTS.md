# SheetSubmit — Agent Rules

## Project quick facts
- Railway backend + Pages (`sheetsubmit.pages.dev`).
- Git-connected Pages auto-deploy on push; backend deploys through Railway. No CI deploy workflow.
- Package manager **bun**. Run `bun install` in `backend/` and `Pages/` if `node_modules` missing.
- Frontend: React 19 + TypeScript + Vite 8 + Tailwind v4 + shadcn/ui (Nova, neutral, lucide, Geist) + Zustand.
- Runtime: Hono on Bun + Postgres (`bun:sql`) + `xlsx`. No Redis used (RAILWAY_REDIS_ID present but unused), no KV/D1/R2.
- Auth: Telegram bot login → HMAC session cookie (`ss_session`). Stateless verify via `crypto.subtle`.
- Deploy secrets: `deploy.env` (gitignored) — CLOUDFLARE_*, RAILWAY_*, TELEGRAM_LOGIN_CLIENT_ID, ADMIN_IDS, GITHUB_*.
- Telegram bot: **TEST token** only. Never use prod token.

## Codebase map

### Root
```
. / package.json          # orchestrator: dev:web/build/typecheck/test (bun --cwd)
  AGENTS.md               # this file
  deploy.env              # gitignored — CLOUDFLARE_* + RAILWAY_* + TELEGRAM_LOGIN_CLIENT_ID + ADMIN_IDS + GITHUB_*
  railway.json            # {"services":{"backend":{"rootDirectory":"backend"}}}
  .github/workflows/
    build-android.yml     # APK CI (assembleRelease + keystore-decode, release publish/changelog)
    generate-keystore.yml # one-time Android keystore generator
  backend/                # Railway Hono/Bun service backed by Postgres; src/server.ts is the HTTP entrypoint; railway.toml deploy config; .env local-only template
                        #   PERFORMANCE.md — 62-entry inventory covering 64 handlers + per-API perf plan (bottleneck → fix → est. speedup), 002_perf.sql migration sketch, rollout order
  Pages/                  # React SPA (Vite)
  android/                # CI-only wrapper (never build locally). Config.java BASE_URL = https://sheetsubmit.pages.dev; native Telegram Login SDK uses BotFather client 8667114953 and CI GitHub Maven credentials
  backend/scripts/schema.ts # DB bootstrap/verify (bun scripts/schema.ts bootstrap|verify)
  test/                   # test fixture xlsx files (2fa.xlsx, cookie.xlsx, Page.xlsx)
```

### Backend — `backend/src/` (Hono/Bun, entry `src/server.ts`)
```
  index.ts              # app setup, routes, API_VERSION (currently 1.6.0; bump on any route change, surfaced by /api/health),
                      #   GET /api/health (all client calls are plain HTTPS — no WebSocket transport),
                      #   /api/auth/me (verifySession, returns CDN photoUrl+phone+isAdmin), POST /api/auth/logout,
                      #   POST /api/auth/device/claim {token} (rateLimit 10/60s, deviceGet/Delete),
                      #   GET /api/auth/telegram/config + POST /api/auth/telegram/verify (official Telegram Login OIDC/JWKS, stores picture+phone),
                      #   GET /api/bot/info, ensureWebhook on first request
                      #   + wallet routes: GET /api/wallet, POST /api/wallet/withdraw, GET /api/wallet/requests, POST /api/wallet/requests/:id/:action
 lib/shared.ts         # Env type (TG_BOT_TOKEN, ADMIN_IDS, SESSION_SECRET, TG_WEBHOOK_SECRET, BACKEND_URL, FRONTEND_URL, HITOOLS_CHECK_URL, TELEGRAM_LOGIN_CLIENT_ID)
 src/lib/telegramOidc.ts # Telegram Login OIDC/JWKS token verification
 src/lib/session.ts      # signSession, verifySession (HMAC SHA-256), requireAuth, isAdmin, cookie builder
 src/lib/do.ts            # 5-line rpc wrapper → repository (pg.ts)
  src/lib/pg.ts            # Postgres repository for users, files, pools, wallets, withdrawals and wallet_transactions (bun:sql, max 10 connections)
 src/lib/rateLimit.ts     # sliding window rate limiter, ipKey helper
 src/routes/files.ts      # files, archive and duplicate routes
                      #   + archive router (GET /, POST /:id/restore, POST /batch-restore, DELETE /:id, POST /batch-delete — bulk index ops, concurrent wipes, pool cleanup)
                      #   + crossDups router (GET /?fileId= — same-type uid scan, {counts, dups})
src/routes/pools.ts       # admin pool, hold, download, ledger and pricing routes
                      #   GET /holds (status filter), POST /holds/:id/approve, POST /holds/:id/reject (aliases return/revert),
                      #   GET /:pwd/:pool (PoolDetail, delegator=src_uid avail+claimed), /rows (paginated+verifiedOnly/unverifiedOnly), /ledger, /verified-counts, /page-counts (alias), /user-files, /price GET+PUT (stored price 0..1000, admin validated), POST /:pwd/:pool/claim (→ downloadId+filename+unitPrice/total/status), POST /:pwd/:pool/hold (same + mode/pick, srcUids/srcFileIds, HOLD status, FIFO inserted_at/row_key, storedPrice), POST /:pwd/:pool/revert
src/routes/admin.ts       # admin stats, users, files and moderation routes
                      #   PUT|DELETE /file/:id, GET /file/:id/rows|logs|undo, PUT /file/:id/persist,
                      #   POST /user/:id/:action (ban|unban), POST /user/:id/archive/:fileId/restore, DELETE /user/:id/archive/:fileId, DELETE /user/:id
src/routes/wa.ts          # POST /fb/check, /fb/page-check, /fb/wa-check and WA cache routes
                      #   GET /wa/cache?uids= (meta-backed, eligible-only, 24h TTL)
src/routes/bot.ts         # Telegram webhook and bot routes
  railway.toml          # Railway build and deployment configuration
```

### Pages — `Pages/src/` (Vite 8, entry `main.tsx`)
```
main.tsx              # StrictMode, Toast>Confirm>Auth>App, service-worker + chunk-error reload guard
App.tsx               # createBrowserRouter: RequireAuth gate (unauth → /login with redirect-back state) → Layout (Topbar+Outlet); public /login route (LoginRoute, bounces authed users back); bubble mode
index.css / app.css   # tailwind v4 + shadcn + geist + legacy styles
vite.config.ts        # react + @tailwindcss/vite, alias @→src, proxy /api→localhost:3000, manualChunks vendor-react|xlsx|vendor-ui|vendor-state|vendor
server.js             # Bun static server + same-origin /api + /webhook proxy (identity encoding, cookie forward) for Railway Web
components.json       # shadcn Nova, neutral, cssVariables, lucide
 pages/HomePage.tsx    # /,/files,/archive,/wallet,/pools/:password/:poolId,/admin,/analysis,/tools (+/pools redirect, /tools/splitter, /admin/user/:userId, /bubble-design); WalletView has user wallet and admin withdrawal-request tabs
pages/SheetPage.tsx   # /file/:id + /admin/user/:userId/file/:fileId
pages/BubbleDesignPage.tsx   # /admin renders via HomePage + components/home/AdminView.tsx (no AdminPage file)
 components/layout/Topbar.tsx          # connection card + shadcn profile dropdown + animated theme toggle
components/home/FileGrid.tsx, FileCard.tsx, PoolsView.tsx (top tabs Pool|Approvals, URL state ?view=&status=&hold= deep links, taker card, bulk approve/return, error+retry states, focus refetch, users list, no recent downloads), ArchiveView.tsx, AdminView.tsx, AnalysisView.tsx, WalletView.tsx, ApprovalDetailDialog.tsx (Download + money for all statuses), Fab.tsx, EmptyState.tsx
components/sheet/SheetGrid.tsx, SheetToolbar.tsx, QuickEditBar.tsx, SelectionBar.tsx, CellEditor.tsx, UploadOverlay.tsx, DownloadOverlay.tsx, CustomDownloadOverlay.tsx, WaCheckOverlay.tsx
components/bubble/BubbleMode.tsx   # ?bubble=1&file=ID + window.Android
components/auth/LoginScreen.tsx      # official Telegram Login OIDC (web widget + Turnstile, profile+phone+write scopes) or Android native SDK bridge; legacy bot login removed
components/tools/SplitterTool.tsx   # xlsx split into N parts
components/icons/FileTypeIcons.tsx, FacebookIcon.tsx
components/profile/ProfileAvatar.tsx
 components/ui/button.tsx, avatar.tsx, dialog.tsx, alert-dialog.tsx, dropdown-menu.tsx, theme-toggler.tsx, hold-to-delete-button.tsx, slide-to-confirm-button.tsx, ink-stamp.tsx, page-skeleton.tsx, search-input.tsx  # shadcn and reusable pool actions
contexts/AuthContext.tsx           # skip /me if no ss_had_session, session_expired redirect, retry 3×1.5s
stores/sheetStore.ts      # central Zustand: rows, undo/redo, persist (PUT /persist vs /append), dedup marks, WA checks, selection
stores/bubbleStore.ts     # {on, pickMode}
stores/profileCache.ts    # profile cache (fed from /me + admin users)
hooks/useUndoRedo.ts, usePersist.ts (beforeunload→flushPersist), useModalA11y.ts
 lib/api.ts                # BASE=RUNTIME_BASE+"/api", request/requestBlob, useConnStore (connection status fed by request outcomes), files/persist/append/WA/admin/pools, me/logout/botInfo/Telegram Login/claimDeviceSession
lib/types.ts              # FileType, ColumnDef, SheetFile, Row
lib/xlsx.ts               # importXlsx/buildXlsx/downloadXlsx/parseSheetRows
lib/downloadOpts.ts       # buildDownloadOpts counts
lib/utils.ts (cn), theme.ts, device.ts, toast.tsx, confirm.tsx, lazyRetry.ts
features/filetypes/index.ts, fbcookie.ts, validation.ts, totp.ts
public/config.js          # injected at runtime: window.APP_CONFIG={apiBase:""}
public/sw.js              # service worker (chunk-error reload)
functions/api/[[path]].ts # Pages Functions proxy → BACKEND_URL
functions/webhook/[[path]].ts
lib/__tests__/customDownload.test.ts, split.test.ts
stores/__tests__/sheetStore.test.ts
```

### Auth flow
1. User opens site → AuthContext checks `ss_had_session` localStorage flag.
2. No flag → skip `/me`, RequireAuth bounces to `/login` immediately (zero wasted requests).
3. Flag exists → call `GET /api/auth/me`:
   - No cookie → 401 `not_authenticated` → clear flag, bounce to `/login`.
   - Invalid/expired cookie → 401 `session_expired` → clear flag, `/login` with notice.
   - Valid → 200 user JSON → set user.
4. LoginScreen: web shows official Telegram Login widget (Turnstile-gated) → `POST /api/auth/telegram/verify {id_token}`; inside the app it invokes the Android native SDK bridge instead (no Turnstile, no legacy bot flow).
5. On success → set `ss_had_session` flag, reload to saved destination (default `/`) → AuthContext picks up cookie.

## Rules
1. **Production isolation** — test bot token only, own Railway project. Never touch prod.
2. Use tokens/CSS variables for colors — no hardcoded hex.
3. **Android — NEVER build locally, CI only.**
4. Pages auto-deploy on git push; backend deploys through Railway. No CI deploy step.
5. No versioning — save increments `seq` counter in meta. Undo/redo is client-side only (Zustand in-memory).
6. Backend uses Postgres; keep operations lightweight and transactional.
7. No KV/D1/R2 bindings.
8. Backend API change flow: bump `API_VERSION` in `backend/src/index.ts` → run `bun run typecheck` in `backend/` → deploy through Railway → confirm via `GET /api/health`.
9. **Commit & push after every completed code-change batch.** After finishing a set of modifications (typecheck + tests pass), immediately inspect `git status`/`git diff`, `git add` only the files changed for this task, commit with a concise message, and `git push` to the current upstream branch. Do not leave completed task changes uncommitted or unpushed. If unrelated work is present, leave it untouched and commit only this task's files. If commit or push fails, report the failure and resolve it before finishing when possible.
10. **Keep this file fresh.** Any change that adds, removes, renames, or moves a route, file, DO op, store, or workflow → update the Codebase map + Auth flow above in the SAME commit, or the next agent works blind.

## Capacity
| Resource | Limit |
|----------|-------|
| Pages builds/month | 500 (Free) |
| Subrequests/request | 50 |
| Body limit | 4 MB |
| Bun Postgres pool | 10 connections max |
