# SheetSubmit-testmycode — Agent Rules

## Project quick facts
- **This is a TEST project** — isolated from production (`B:\Studio\Tools\SheetSubmit-Shadcnui` + Railway prod). Never touch prod bot token/images/project.
- Monorepo with **no workspaces** — standalone `frontend/` + `backend/` (no `packages/*`), plus `android/` (Gradle, CI-only). Root `package.json` just orchestrates scripts via `bun --cwd`.
- Package manager **bun**. Git initialized. Run `bun install` at root + each app if `node_modules` missing.
- Frontend: React 19 + TypeScript + Vite 8 + Tailwind v4 + shadcn/ui (Nova, neutral, lucide, Geist) + Zustand + boneyard-js.
- Backend: TypeScript Express 4 + ioredis + `xlsx` + `zod` + `compression`, ESM (`es2023`).
- Deploy: **2 Docker images** `popyog/sheetsubmit-testmycode-backend:latest` (Bun `src/index.ts`) + `popyog/sheetsubmit-testmycode-frontend:latest` (Bun `server.js` serving `dist/`, **no nginx** — SPA calls API via same-origin proxy; `VITE_API_BASE`/`BACKEND_URL` injected at runtime via `/config.js`). `redeploy.bat` → `scripts/redeploy.ts` builds+pushes both then `POST /__redeploy` (Railway GraphQL `serviceInstanceRedeploy`, needs `deploy.env` + `RAILWAY_TOKEN` on both services; no auto-deploy). Railway project: 3 services (web, api, Redis).
- Telegram bot: **TEST token** in `backend/.env` (gitignored). Never use prod token.

## Codebase map

### Root
```
. / package.json          # orchestrator: dev:web/dev:server/build/typecheck/test (bun --cwd)
  AGENTS.md               # this file — agent rules + map (includes snapshot § Snapshots)
  redeploy.bat            # → bun run scripts/redeploy.ts; fallback docker build+push+curl /__redeploy
  deploy.env              # gitignored — RAILWAY_TOKEN + FRONTEND_URL + BACKEND_URL
  .gitignore              # node_modules, dist, .env*, deploy.env, android keystore, .playwright-mcp
  .hoplite/settings.json  # local preview: bun --cwd frontend dev :5173
  scripts/redeploy.ts     # incremental deploy (git diff → isBackend/isFrontend → docker+Railway)
  scripts/api-live.mjs    # live API probe (needs SESSION_COOKIE in .env.live)
  .github/workflows/build-android.yml  # APK CI only (JDK17, assembleRelease, no frontend/backend CI)
  android/                # CI-only wrapper (never build locally); Config.BASE_URL do not change
  backend/  frontend/     # see below
```

### Backend — `backend/src/` (`backend/package.json` `server@0.1.0`, `src/index.ts` entry)
```
config/env.ts            # loads backend/.env (3-level root resolve), exports PORT/REDIS_URL/TG_BOT_TOKEN/ADMIN_IDS/RAILWAY_PUBLIC_DOMAIN/BACKEND_PUBLIC_URL/FRONTEND_URL/WEBHOOK_URL/LOGIN_BASE/HISTORY_*/WA_CACHE_TTL/BACKUP_INTERVAL/STATIC_ROOT
lib/shared.ts             # FileType=fb_cookie, ColumnDef/FileTypeDef/SheetFile/StoredFile/Row, MUTABLE_FILE_FIELDS
lib/ids.ts                # genFileId (base36), generateToken (32B hex)
types/express.d.ts        # req.userId/file/files/fileIdx augmentation
middleware/auth.ts        # requireAuth (session cookie + 5m cache + 15s ban cache), requireFileAccess, requireAdmin/isAdmin, migrateListKey, findAllUserIds/findFileAcrossUsers
middleware/error.ts       # errorHandler + bootstrapProcessHandlers
middleware/logging.ts     # requestLogger + redactUrl
middleware/asyncRoute.ts  # async → .catch(next)
services/redis.ts         # single ioredis client (Upstash TLS), key()/getJSON/mgetJSON(PIPELINE)/setJSON/delKey
services/telegram.ts      # tg() wrapper, completeTelegramLogin, handleBotUpdate (/start/login_/myid), startBot (webhook vs poll)
services/files.ts         # getUserFiles/findUserFile, updateUserFilesAtomic (WATCH+MULTI 5 retries), createForkFile, getDedupKey (uid||c_user), countDataRows
services/pools.ts         # Pool engine: PoolId cookies_only|cookies_2fa|page, classifyRow, keys pool:<pwd>:<id>:{available,claimed,dedup,ledger,users}+taken:global:<pwd>, add/remove/promote/handleFileSave/removeFileRowsFromPools
services/history.ts       # snapshotHistory (WATCH+withFileLock, delta vs full, checkpoint every 20, blob ss:blob:<hash>), materializeVersion, pruneHistory, gc
services/backup.ts        # secondary Redis sync: copyKeys (SCAN+PIPELINE), createBackup (dirty+EVAL), restoreFromBackup, startBackupLoop
routes/auth.ts            # GET /api/auth/telegram, /photo/:userId, /logout, /me, /device, /device/claim (SameSite=None|Lax cookie)
routes/files.ts           # filesRouter: GET/POST /, PUT/:id, DELETE/:id, PUT/:id/persist, PUT/:id/append, GET/:id/rows|full; archiveRouter + crossDupsRouter
routes/history.ts         # GET /:id/history, GET /:id/history/:v, POST /:id/history/:v/{restore,name,fork}
routes/pools.ts           # admin-only: GET / (counts), GET /:poolId[/:password] detail, GET /*/rows, GET /*/ledger, POST /*/claim, GET /*/download (xlsx), GET /downloads, POST /downloads/:id/revert
routes/admin.ts           # GET /stats, /users, /user/:userId|/archive, POST /archive/:fileId/restore, GET/PUT/DELETE /file/:fileId (+rows/undo/history/logs), DELETE/PUT /user/:userId, POST /user/:userId/{ban,unban}
routes/wa.ts              # POST /api/fb/check (fb.tools→hitools), POST /fb/page-check, POST /fb/wa-check (GraphQL), GET /wa/cache
routes/bot.ts             # GET /bot/info, POST /webhook/tg (root, not /api)
routes/deploy.ts          # POST /__redeploy (Bearer RAILWAY_TOKEN, timingSafeEqual → Railway GraphQL)
scripts/backfill-pools.ts # bun wrapper for backfillExistingFiles
app.ts                    # createApp() — json(10mb)+compression, trust proxy 1, CORS exact FRONTEND_URL, 7 routers, /api/health, /webhook/tg, static STATIC_ROOT, SPA fallback
index.ts                  # bootstrap: createApp, restoreFromBackup, startBackupLoop, startHistoryGc, startBot
Dockerfile                # 2-stage oven/bun:1.3.14, USER bun, EXPOSE 3000, CMD bun run src/index.ts
test/redis-mock.ts        # in-mem ioredis fake (WATCH/MULTI/pipeline/sadd/lrange/etc), installRedisMock/installAuthMock
test/pools-service.test.ts + pools-routes.test.ts + files-atomic.test.ts + history.test.ts + append.test.ts + auth-misc.test.ts
```

### Frontend — `frontend/src/` (`frontend/package.json` `web@0.0.0`, Vite 8)
```
main.tsx                  # StrictMode, Toast>Confirm>Auth>App, is-touch toggle, sw.js register
App.tsx                   # createBrowserRouter: Layout (Topbar+Outlet+OfflineBanner); gate: bubble mode vs LoginScreen vs RouterProvider
index.css / app.css       # tailwind v4 (@import tailwindcss, tw-animate, shadcn/tailwind, geist) + legacy grid/QEB/diff/bubble/offline styles
vite.config.ts            # react + @tailwindcss/vite + boneyardPlugin (/file/smoke), alias @→src, proxy /api→localhost:3000
components.json            # shadcn Nova, neutral, cssVariables, lucide
server.js                 # Bun serve dist + proxy /api|/webhook/tg → BACKEND_URL (same-origin apiBase=""), injects /config.js, POST /__redeploy → Railway GraphQL
pages/HomePage.tsx        # /,/files,/archive,/pools/:password/:poolId,/admin,/tools (+redirect /pools→/pools/dgddigital/cookies_only); tabs, Fab, FileGrid, importXlsx, lazy Admin/Archive/Pools/Splitter
pages/SheetPage.tsx       # /file/:id + /admin/user/:userId/file/:fileId — SheetGrid+QuickEditBar+SelectionBar, usePersist flush, boneyard sheet-grid skeleton
pages/VersionDiffPage.tsx # /file/:id/version/:v — diff via versionCache+DiffView
pages/AdminPage.tsx / BubbleDesignPage.tsx
components/layout/Topbar.tsx + OfflineBanner.tsx
components/home/FileGrid.tsx, FileCard.tsx, PoolsView.tsx (admin pools), ArchiveView.tsx, AdminView.tsx, Fab.tsx, EmptyState.tsx
components/sheet/SheetGrid.tsx (virtualized, long-press 500ms selection), SheetToolbar.tsx, QuickEditBar.tsx, SelectionBar.tsx, CellEditor.tsx, UploadOverlay.tsx, DownloadOverlay.tsx, CustomDownloadOverlay.tsx, VersionHistory.tsx, DiffView.tsx/diff.ts, WaCheckOverlay.tsx
components/bubble/BubbleMode.tsx  # ?bubble=1&file=ID + window.Android takeover
components/auth/LoginScreen.tsx    # Telegram bot login via api.botInfo
components/ui/button.tsx           # shadcn cva variants
contexts/AuthContext.tsx           # api.me + ss_auth_user cache, 3 retries
stores/sheetStore.ts      # central Zustand (rows≥100 padded, undo/redo, persist via PUT /persist vs /append, offline queue, dedup marks, WA checks, selection)
stores/versionCache.ts    # LRU Map fileId→Map<v,rows> (3 files×50 versions)
stores/bubbleStore.ts     # {on, pickMode}
stores/filesStore.ts      # empty stub — use HomePage local state + api
hooks/useUndoRedo.ts, usePersist.ts (beforeunload→flushPersist keepalive), useModalA11y.ts
lib/api.ts                # BASE=RUNTIME_BASE+"/api" (window.APP_CONFIG.apiBase), request/requestBlob (credentials:include), files/persist/append/archive/cross-dups/WA/admin/versions/pools (dgddigital 404 fallback), me/logout/botInfo/claimDeviceSession
lib/types.ts              # FileType fb_cookie, ColumnDef/FileTypeDef (cookies/twofakey/uid), SheetFile/Row (_taken/_pool/wa_status), NO_2FA_MARK
lib/xlsx.ts               # importXlsx/buildXlsx/downloadXlsx/parseSheetRows/splitRows, No_2Fa strip, c_user uid extract, Android bridge
lib/downloadOpts.ts       # buildDownloadOpts counts (all/valid/combo/onlyCookie/only2fa/wa/dead)
lib/utils.ts (cn), theme.ts (ss_theme), device.ts (IS_TOUCH), toast.tsx, confirm.tsx
features/filetypes/index.ts (getFileBehavior), fbcookie.ts, validation.ts, totp.ts
offline/db.ts (IndexedDB sheetsubmit-offline/queue), offline/sync.ts (queueSave/flush, 409 mergeAndPersist)
bones/registry.ts + bones/sheet-grid.bones.json
public/sw.js, logo-*.svg, favicon-*.svg
```

### Infra / deploy
- No `docker-compose`, no `Railway.toml`, no root Dockerfile — 2 standalone Dockerfiles.
- `frontend/Dockerfile` multi-stage build (`tsc -b && vite build`) → `bun server.js :80`; `backend/Dockerfile` runtime `bun run src/index.ts :3000`.
- Env: `backend/.env` (PORT 3000, REDIS_URL, TG_BOT_TOKEN, ADMIN_IDS=8447133985,1772093705) + `backend/.env.api` template; `frontend/.env.web` (`VITE_API_BASE=` empty — runtime via `/config.js`).

## Rules
1. **Production isolation is sacred** — test bot token only, this project's own images and Railway project. Never register the production bot's webhook here, never push to `popyog/sheetsubmit-shadcnui:*`.
2. After `npx shadcn add`, the CLI writes to a literal `frontend/@/` folder in this monorepo — move files into `src/` and delete `@/`.
3. Use tokens/CSS variables for colors — no hardcoded hex.
4. The production repos (`B:\Studio\Tools\SheetSubmit` and `B:\Studio\Tools\SheetSubmit-Shadcnui`) are protected — do not touch them unless the task explicitly requires it.
5. **Deploy flow:** Railway does **not** auto-deploy on image push. `redeploy.bat` (→ `scripts/redeploy.ts`) builds + pushes both images, then calls each service's `POST /__redeploy` to trigger redeploy. Needs `deploy.env` (`RAILWAY_TOKEN` + both service URLs) and `RAILWAY_TOKEN` set on both Railway services.
6. **Android — NEVER build locally, CI only.** Android lives in `.github/workflows/build-android.yml`; keep `Config.BASE_URL` unchanged unless told otherwise.

## Snapshots
> Easy rollback — `git revert` or `git reset --hard <hash>` to restore. Latest at top.

| Date | Commit | Notes |
|------|--------|-------|
| 2026-09-03 | `b3e9c0b` | Keep Claude bubble variants on idle animation only; remove tap, long-press, and drag states |
| 2026-09-03 | `62199bf` | Bubble free-float + uniform scale + tap flash — visible-state normalize, overlay-first clipboard focus |
| 2026-09-03 | `fb8df28` | fix snapshot hash — `17a586d` was pre-push, now `fb8df28` is HEAD (same content) |
| 2026-09-03 | `17a586d` | Pools implemented — auto-pooling + claim/ledger/revert, `PLAN.md` removed, AGENTS map refreshed (pre-push snapshot) |
