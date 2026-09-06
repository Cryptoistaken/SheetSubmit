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
. / package.json          # orchestrator: dev:web/build/typecheck/test (bun --cwd)
  AGENTS.md               # this file
  deploy.env              # gitignored — CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
  .github/workflows/
    build-android.yml     # APK CI (assembleRelease + keystore-decode, release publish/changelog)
    generate-keystore.yml # one-time Android keystore generator
  worker/                 # Cloudflare Worker (Hono + DO)
  Pages/                  # React SPA (Vite)
  android/                # CI-only wrapper (never build locally). Config.java BASE_URL = https://sheetsubmit.pages.dev; native Telegram Login SDK uses BotFather client 8667114953 and CI GitHub Maven credentials
  scripts/TestApi.ts      # live API test suite (mirrors every worker route, all must pass) — run: bun scripts/TestApi.ts (secret auto-loads from scripts/.env)
                        #   subset: TEST_FILTER env or argv — number (59), range (55-70), or name substring (claim), comma/space-combined — e.g. `bun scripts/TestApi.ts 90-97`, `bun scripts/TestApi.ts claim pools`, `--filter=`/`--only=`/`--grep=` prefixes stripped, `h`/`--help` for usage
  scripts/nuke.ts         # DB nuke via admin API — drains pools + deletes files/users — run: bun scripts/nuke.ts [--dry|--yes|--full|--keep id1,id2] (secret auto-loads from scripts/.env)
```

### Worker — `worker/src/` (Hono, entry `src/index.ts`)
```
  index.ts              # app setup, routes, API_VERSION (bump on any route change, surfaced by /api/health),
                      #   GET /api/health, GET /api/ws/ticket + GET /ws (WS gateway via IndexDO wsTicket, x-ws-version; health op),
                      #   /api/auth/me (verifySession, returns CDN photoUrl+phone+isAdmin), POST /api/auth/logout,
                      #   POST /api/auth/device/claim {token, turnstile} (Turnstile enforced if TURNSTILE_SECRET set),
                      #   GET /api/auth/telegram/config + POST /api/auth/telegram/verify (official Telegram Login OIDC/JWKS, stores picture+phone),
                      #   POST /api/auth/turnstile-verify, GET /api/bot/info, ensureWebhook on first request
lib/shared.ts         # Env type (TG_BOT_TOKEN, ADMIN_IDS, SESSION_SECRET, TG_WEBHOOK_SECRET, WORKER_URL, FRONTEND_URL, HITOOLS_CHECK_URL, TURNSTILE_*, TELEGRAM_LOGIN_CLIENT_ID, DO bindings INDEX/FILES/POOLS)
lib/telegramOidc.ts     # Telegram Login OIDC/JWKS token verification
lib/session.ts        # signSession, verifySession (HMAC SHA-256), requireAuth, isAdmin, cookie builder
lib/do.ts             # rpc(namespace, name, op, args) — single fetch to DO
do/IndexDO.ts         # singleton global: users, file_index, sessions, device tokens, meta KV, WS gateway (SQLite).
                      #   ops: ensureUser/user/users/adminUsers(file+archive counts)/ban/deleteUser/register/file/files(archived filter)/archive/batchArchive/purge/batchPurge/allFiles/session/getSession/deleteSession/deviceSet/deviceGet/deviceDelete/deviceByChat/wsTicket/deviceSession/metaSet/metaGet/metaGetMany/metaDel/stats + wsUpgrade/webSocketMessage/handleClientOp (pools.list, pool.claim, admin.*, wa.cache…)
do/FileDO.ts          # per-file: init/meta/seq/rows/full/save/getLogs(200 cap)/wipe (SQLite). save increments seq counter. wipe returns rows before deletion for pool cleanup
do/PoolDO.ts          # per-pool-password: pool_rows, ledger, downloads (SQLite).
                      #   ops: add/counts/detail/claim(records download, returns downloadId+filename)/verifiedCounts(+pageCounts alias)/userFiles/downloads/download/downloadDetail/revertDownload/revert/removeAvailable/ledger
routes/files.ts       # files router (GET/POST /, PUT/:id, DELETE/:id=archive, PUT/:id/persist|append (feeds pools), GET/:id/rows|full)
                      #   + archive router (GET /, POST /:id/restore, POST /batch-restore, DELETE /:id, POST /batch-delete — bulk index ops, concurrent wipes, pool cleanup)
                      #   + crossDups router (GET /?fileId= — same-type uid scan, {counts, dups})
routes/pools.ts       # admin: GET / (PoolSummary[]), GET /downloads, GET /downloads/:id/detail, GET /downloads/:id (xlsx blob, ?format=json), POST /downloads/:id/revert,
                      #   GET /:pwd/:pool (PoolDetail), /rows (paginated+verifiedOnly/unverifiedOnly), /ledger, /verified-counts, /page-counts (alias), /user-files, POST /:pwd/:pool/claim (→ downloadId+filename), POST /:pwd/:pool/revert
routes/admin.ts       # GET /stats, /users, /users/search, /user/:id (+files), /user/:id/archive, /file/:id,
                      #   PUT|DELETE /file/:id, GET /file/:id/rows|logs|undo, PUT /file/:id/persist,
                      #   POST /user/:id/:action (ban|unban), POST /user/:id/archive/:fileId/restore, DELETE /user/:id/archive/:fileId, DELETE /user/:id
routes/wa.ts          # POST /fb/check (check.fb.tools proxy), /fb/page-check + /fb/wa-check (FB graphql ports, requireAuth),
                      #   GET /wa/cache?uids= (meta-backed, eligible-only, 24h TTL)
routes/bot.ts         # ensureWebhook, POST /webhook/tg (handleBotUpdate) — GET /bot/info lives in index.ts
scheduled.ts          # cron: ensureWebhook
  wrangler.jsonc         # DO bindings INDEX/FILES/POOLS, cron 0 */6 * * *, vars (FRONTEND_URL/HITOOLS_CHECK_URL/WORKER_URL); add TELEGRAM_LOGIN_CLIENT_ID after BotFather setup
```

### Pages — `Pages/src/` (Vite 8, entry `main.tsx`)
```
main.tsx              # StrictMode, Toast>Confirm>Auth>App
App.tsx               # createBrowserRouter: RequireAuth gate (unauth → /login with redirect-back state) → Layout (Topbar+Outlet); public /login route (LoginRoute, bounces authed users back); bubble mode
index.css / app.css   # tailwind v4 + shadcn + geist + legacy styles
vite.config.ts        # react + @tailwindcss/vite, alias @→src, proxy /api→localhost:3000 + /ws (ws:true), vendor-react chunk
components.json       # shadcn Nova, neutral, cssVariables, lucide
pages/HomePage.tsx    # /,/files,/archive,/wallet,/pools/:password/:poolId,/admin,/tools (+/pools redirect, /tools/splitter, /admin/user/:userId, /bubble-design)
pages/SheetPage.tsx   # /file/:id + /admin/user/:userId/file/:fileId
pages/AdminPage.tsx (empty stub) / BubbleDesignPage.tsx   # AdminPage logic lives in components/home/AdminView.tsx
components/layout/Topbar.tsx
components/home/FileGrid.tsx, FileCard.tsx, PoolsView.tsx, ArchiveView.tsx, AdminView.tsx, Fab.tsx, EmptyState.tsx, DownloadDetailModal.tsx
components/sheet/SheetGrid.tsx, SheetToolbar.tsx, QuickEditBar.tsx, SelectionBar.tsx, CellEditor.tsx, UploadOverlay.tsx, DownloadOverlay.tsx, CustomDownloadOverlay.tsx, WaCheckOverlay.tsx
components/bubble/BubbleMode.tsx   # ?bubble=1&file=ID + window.Android
components/auth/LoginScreen.tsx      # official Telegram Login OIDC (web widget + Turnstile, profile+phone+write scopes) or Android native SDK bridge; legacy bot login removed
components/ui/button.tsx, avatar.tsx  # shadcn cva variants
contexts/AuthContext.tsx           # skip /me if no ss_had_session, session_expired redirect, WS connect, retry 3×1.5s
stores/sheetStore.ts      # central Zustand: rows, undo/redo, persist (PUT /persist vs /append), dedup marks, WA checks, selection
stores/bubbleStore.ts     # {on, pickMode}
stores/profileCache.ts    # profile cache (WS-fed)
hooks/useUndoRedo.ts, usePersist.ts (beforeunload→flushPersist), useModalA11y.ts
 lib/api.ts                # BASE=RUNTIME_BASE+"/api", request/requestBlob, files/persist/append/WA/admin/pools, me/logout/botInfo/Telegram Login/claimDeviceSession
lib/ws.ts                 # wsConnect/wsCall/wsOn (WS gateway client)
lib/types.ts              # FileType, ColumnDef, SheetFile, Row
lib/xlsx.ts               # importXlsx/buildXlsx/downloadXlsx/parseSheetRows
lib/downloadOpts.ts       # buildDownloadOpts counts
lib/utils.ts (cn), theme.ts, device.ts, toast.tsx, confirm.tsx
features/filetypes/index.ts, fbcookie.ts, validation.ts, totp.ts
public/config.js          # injected at runtime: window.APP_CONFIG={apiBase:"", wsBase:"https://…workers.dev"}
functions/api/[[path]].ts # Pages Functions proxy → BACKEND_URL
functions/webhook/[[path]].ts
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
1. **Production isolation** — test bot token only, own Cloudflare project. Never touch prod.
2. Use tokens/CSS variables for colors — no hardcoded hex.
3. **Android — NEVER build locally, CI only.**
4. Pages + Worker auto-deploy on git push (git-connected). No CI deploy step.
5. No versioning — save increments `seq` counter in meta. Undo/redo is client-side only (Zustand in-memory).
6. Worker CPU limit: 10ms per request. Keep operations lightweight.
7. No KV/D1/R2 bindings. Storage is Durable Objects + SQLite only.
8. Worker API change flow (TestApi.ts hits the LIVE worker, so order matters): bump `API_VERSION` in `worker/src/index.ts` → `bun run typecheck` + `bun run test` in `worker/` → push so Cloudflare auto-deploys → confirm via `GET /api/health` `version` → then run `EXPECT_VERSION=<new> bun scripts/TestApi.ts` (secret auto-loads from `scripts/.env`, all must pass).
9. New API endpoint → new `test()` in `scripts/TestApi.ts` in the same change (happy path + 400/401/404). Never ship an untested route.
10. **Commit & push after every completed code-change batch.** After finishing a set of modifications (typecheck + tests pass), immediately inspect `git status`/`git diff`, `git add` only the files changed for this task, commit with a concise message, and `git push` to the current upstream branch. Do not leave completed task changes uncommitted or unpushed. If unrelated work is present, leave it untouched and commit only this task's files. If commit or push fails, report the failure and resolve it before finishing when possible.
11. **Keep this file fresh.** Any change that adds, removes, renames, or moves a route, file, DO op, store, or workflow → update the Codebase map + Auth flow above in the SAME commit, or the next agent works blind.

## Capacity
| Resource | Limit |
|----------|-------|
| Worker CPU/request | 10ms |
| Worker requests/day | 100k (Free) |
| DO storage | 10 GB max per DO |
| Pages builds/month | 500 (Free) |
| Subrequests/request | 50 |
| Body limit | 4 MB |
