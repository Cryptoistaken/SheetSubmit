# SheetSubmit — Agent Rules

## Project quick facts
- Cloudflare Worker (`sheetsubmit.traderspopy.workers.dev`) + Pages (`sheetsubmit.pages.dev`).
- Git-connected Pages + Worker auto-deploy on push. No CI deploy workflow.
- Package manager **bun**. Run `bun install` in `worker/` and `Pages/` if `node_modules` missing.
- Frontend: React 19 + TypeScript + Vite 8 + Tailwind v4 + shadcn/ui (Nova, neutral, lucide, Geist) + Zustand.
- Worker: Hono + Durable Objects (SQLite) + `xlsx`. No Redis, no KV, no D1.
- Auth: Telegram bot login → HMAC session cookie (`ss_session`). Stateless verify via `crypto.subtle`.
- Deploy secrets: `deploy.env` (gitignored) — `CLOUDFLARE_ACCOUNT_ID=9cd0d33911e8b252bf17912dac023e83`, `CLOUDFLARE_API_TOKEN`.
- Telegram bot: **TEST token** only. Never use prod token.

## Codebase map

### Root
```
. / package.json          # orchestrator: dev:web/build/test (bun --cwd)
  AGENTS.md               # this file
  deploy.env              # gitignored — CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
  .github/workflows/
    build-android.yml     # APK CI only (JDK17, assembleRelease)
  worker/                 # Cloudflare Worker (Hono + DO)
  Pages/                  # React SPA (Vite)
  android/                # CI-only wrapper (never build locally). Config.java BASE_URL = sheetsubmit.pages.dev
  scripts/TestApi.ts      # live API test suite (mirrors every worker route, all must pass) — run: bun scripts/TestApi.ts (secret auto-loads from scripts/.env)
                        #   subset: append filter — number (59), range (55-70), or name substring (claim) — e.g. `bun scripts/TestApi.ts 90-97`, `--help` for usage
```

### Worker — `worker/src/` (Hono, entry `src/index.ts`)
```
index.ts              # app setup, routes, API_VERSION (bump on any route change, surfaced by /api/health),
                      #   /api/auth/me (verifySession, adds photoUrl+isAdmin), /api/auth/logout,
                      #   /api/auth/device/claim, /api/auth/photo/:userId (Telegram getUserProfilePhotos→getFile, 24h meta cache),
                      #   /api/auth/turnstile-verify, /api/bot/info, ensureWebhook on first request
lib/shared.ts         # Env type (TG_BOT_TOKEN, ADMIN_IDS, SESSION_SECRET, TG_WEBHOOK_SECRET, WORKER_URL, FRONTEND_URL, HITOOLS_CHECK_URL, TURNSTILE_SECRET, DO bindings INDEX/FILES/POOLS)
lib/session.ts        # signSession, verifySession (HMAC SHA-256), requireAuth, isAdmin, cookie builder
lib/do.ts             # rpc(namespace, name, op, args) — single fetch to DO
lib/ids.ts            # genFileId, generateToken
do/IndexDO.ts         # singleton global: users, file_index, sessions, device tokens, meta KV (SQLite).
                      #   ops: ensureUser/user/users/adminUsers(file+archive counts)/ban/deleteUser/register/file/files(archived filter)/archive/batchArchive/purge/batchPurge/session*/device*/metaSet/metaGet/metaDel/stats
do/FileDO.ts          # per-file: meta, rows, logs (cap 200) (SQLite). save increments seq counter. wipe returns rows before deletion for pool cleanup
do/PoolDO.ts          # per-pool-password: pool_rows, ledger, downloads (SQLite).
                      #   ops: add/counts/detail/claim(records download, returns downloadId)/downloads/download/revertDownload/revert/removeAvailable/ledger
routes/files.ts       # files router (GET/POST /, PUT/:id, DELETE/:id=archive, PUT/:id/persist|append (feeds pools), GET/:id/rows|full)
                      #   + archive router (GET /, POST /:id/restore, POST /batch-restore, DELETE /:id, POST /batch-delete — bulk index ops, concurrent wipes, pool cleanup)
                      #   + crossDups router (GET /?fileId= — same-type uid scan, {counts, dups})
routes/pools.ts       # admin: GET / (PoolSummary[]), GET|POST /downloads, GET|POST /downloads/:id (xlsx blob / revert),
                      #   GET /:pwd/:pool (PoolDetail), /rows (paginated), /ledger, POST /:pwd/:pool/claim (→ downloadId+filename)
routes/admin.ts       # GET /stats, /users, /users/search, /user/:id (+files), /user/:id/archive, /file/:id,
                      #   PUT|DELETE /file/:id, GET /file/:id/rows|logs|undo, PUT /file/:id/persist,
                      #   POST /user/:id/ban|unban, POST /user/:id/archive/:fileId/restore, DELETE /user/:id/archive/:fileId, DELETE /user/:id
routes/wa.ts          # POST /fb/check (check.fb.tools proxy), /fb/page-check + /fb/wa-check (FB graphql ports),
                      #   GET /wa/cache?uids= (meta-backed, eligible-only, 24h TTL)
routes/bot.ts         # ensureWebhook, POST /webhook/tg (handleBotUpdate), GET /bot/info
scheduled.ts          # cron: ensureWebhook
wrangler.jsonc         # DO bindings INDEX/FILES/POOLS, cron 0 */6 * * *, vars
```

### Pages — `Pages/src/` (Vite 8, entry `main.tsx`)
```
main.tsx              # StrictMode, Toast>Confirm>Auth>App
App.tsx               # createBrowserRouter: Layout (Topbar+Outlet); gate: bubble mode vs LoginScreen vs RouterProvider
index.css / app.css   # tailwind v4 + shadcn + geist + legacy styles
vite.config.ts        # react + @tailwindcss/vite, alias @→src, proxy /api→localhost:3000
components.json       # shadcn Nova, neutral, cssVariables, lucide
pages/HomePage.tsx    # /,/files,/archive,/pools/:password/:poolId,/admin,/tools
pages/SheetPage.tsx   # /file/:id + /admin/user/:userId/file/:fileId
pages/AdminPage.tsx / BubbleDesignPage.tsx
components/layout/Topbar.tsx + OfflineBanner.tsx
components/home/FileGrid.tsx, FileCard.tsx, PoolsView.tsx, ArchiveView.tsx, AdminView.tsx, Fab.tsx
components/sheet/SheetGrid.tsx, SheetToolbar.tsx, QuickEditBar.tsx, SelectionBar.tsx, CellEditor.tsx, UploadOverlay.tsx, DownloadOverlay.tsx, CustomDownloadOverlay.tsx, WaCheckOverlay.tsx
components/bubble/BubbleMode.tsx   # ?bubble=1&file=ID + window.Android
components/auth/LoginScreen.tsx    # Telegram bot login, lazy did, 10s+60s claim poll, focus-only
components/ui/button.tsx           # shadcn cva variants
contexts/AuthContext.tsx           # skip /me if no ss_had_session, session_expired redirect
stores/sheetStore.ts      # central Zustand: rows, undo/redo, persist (PUT /persist vs /append), dedup marks, WA checks, selection
stores/bubbleStore.ts     # {on, pickMode}
hooks/useUndoRedo.ts, usePersist.ts (beforeunload→flushPersist), useModalA11y.ts
lib/api.ts                # BASE=RUNTIME_BASE+"/api", request/requestBlob, files/persist/append/WA/admin/pools, me/logout/botInfo/claimDeviceSession
lib/types.ts              # FileType, ColumnDef, SheetFile, Row
lib/xlsx.ts               # importXlsx/buildXlsx/downloadXlsx/parseSheetRows
lib/downloadOpts.ts       # buildDownloadOpts counts
lib/utils.ts (cn), theme.ts, device.ts, toast.tsx, confirm.tsx
features/filetypes/index.ts, fbcookie.ts, validation.ts, totp.ts
public/config.js          # injected at runtime: window.APP_CONFIG={apiBase:""}
functions/api/[[path]].ts # Pages Functions proxy → BACKEND_URL
functions/webhook/[[path]].ts
```

### Auth flow
1. User opens site → AuthContext checks `ss_had_session` localStorage flag.
2. No flag → skip `/me`, show LoginScreen immediately (zero wasted requests).
3. Flag exists → call `GET /api/auth/me`:
   - No cookie → 401 `not_authenticated` → clear flag, show login.
   - Invalid/expired cookie → 401 `session_expired` → clear flag, show login with notice.
   - Valid → 200 user JSON → set user.
4. LoginScreen: fetch bot info → generate `did` → show "Open Telegram" link.
5. User opens Telegram bot → `/start login_<did>` → bot stores `device:<did>` → webhook sets session.
6. LoginScreen polls `GET /api/auth/device/claim?token=<did>`: waits 10s, then 1/s for 60s, **only while tab focused**.
7. On success → set `ss_had_session` flag, reload → AuthContext picks up cookie.
8. On timeout → show "Recheck login" button → regenerates did, restarts flow.

## Rules
1. **Production isolation** — test bot token only, own Cloudflare project. Never touch prod.
2. Use tokens/CSS variables for colors — no hardcoded hex.
3. **Android — NEVER build locally, CI only.**
4. Pages + Worker auto-deploy on git push (git-connected). No CI deploy step.
5. No versioning — save increments `seq` counter in meta. Undo/redo is client-side only (Zustand in-memory).
6. Worker CPU limit: 10ms per request. Keep operations lightweight.
7. No KV/D1/R2 bindings. Storage is Durable Objects + SQLite only.
8. Worker API change flow (TestApi.ts hits the LIVE worker, so order matters): bump `API_VERSION` in `worker/src/index.ts` → `bun run typecheck` + `bun run test` in `worker/` → push so Cloudflare auto-deploys → confirm via `GET /api/health` `version` → then run `EXPECT_VERSION=<new> bun scripts/TestApi.ts` (secret auto-loads from `scripts/.env`, all must pass).
9. New API endpoint → new `test()` in `scripts/TestApi.ts` in the same change (happy path + 400/401/404). Never ship an untested route.

## Capacity
| Resource | Limit |
|----------|-------|
| Worker CPU/request | 10ms |
| Worker requests/day | 100k (Free) |
| DO storage | 10 GB max per DO |
| Pages builds/month | 500 (Free) |
| Subrequests/request | 50 |
| Body limit | 4 MB |
