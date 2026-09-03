# Cloudflare Migration Plan — Workers + Durable Objects + Pages

> **For agentic workers:** Work task-by-task in order. Steps use checkbox (`- [ ]`) syntax. Each task ends with passing tests + a commit. Do not skip the verify steps.

**Goal:** Replace Railway (Express/Bun + Upstash Redis + Docker images) with an all-Cloudflare free-tier stack: Hono API on Workers with Durable Objects (SQLite) storage, SPA on CF Pages with a Functions proxy keeping session cookies first-party.

**Architecture:** One new `worker/` project (Hono + 3 DO classes: `IndexDO` singleton for users/bans/stats, `FileDO` per file for rows+versions+pruning, `PoolDO` per password for pool engine). Frontend stays a Vite SPA; deploy it to CF Pages and add two Pages Functions (`/api/*`, `/webhook/tg`) that proxy to the API Worker — same trick `frontend/server.js` uses today to keep the session cookie first-party. No data migration needed (no old data); old `backend/` + Railway are retired at cutover.

**Tech Stack:** Hono 4, `@cloudflare/vitest-pool-workers` (tests), Wrangler 4, Durable Objects SQLite storage, Web Crypto HMAC sessions, CF Pages + Pages Functions, GitHub Actions deploys, Cloudflare Turnstile + Bot Fight Mode. Frontend unchanged except proxy files + login widget.

## Global Constraints
- **Deploys happen ONLY via GitHub Actions** — no local `wrangler deploy`. Worker: `cloudflare/wrangler-action@v3` on push paths `worker/**`. Frontend: Pages via wrangler-action on push paths `frontend/**`. Actions pinned by SHA, `permissions: contents: read` only.
- **Security baseline:** Cloudflare Turnstile (free, unlimited) on the login screen, verified server-side via `siteverify`; Bot Fight Mode ON (dashboard); WAF rate-limit rule on `/api/*` and `/webhook/tg`.
- **Free tier only** — no card: Workers Free (100k req/day, 10 ms CPU/req), DO Free (5 GB, SQLite-backed only), Pages Free (500 builds/mo, unlimited static).
- **10 ms CPU/req** — no server-side xlsx build/parse; all xlsx stays client-side (`frontend/src/lib/xlsx.ts`). Reject request bodies > 4 MB with 413.
- **API paths + JSON shapes are 1:1 with the old API** (list below) — frontend changes only in proxy files.
- **Telegram bot = webhook mode only** (`/webhook/tg`); no polling loop.
- **Drop `services/backup.ts`** — DO SQLite is replicated/durable; no secondary-Redis sync. Documented deviation.
- **Drop history blob-dedup (`ss:blob:<hash>`)** — replaced by per-version full snapshots in SQLite; prune keeps ≤30 days and ≤100 versions. Memory win not needed at 5 GB.
- Test project isolation rules from `AGENTS.md` still apply (test bot token, never prod).
- Package manager: **bun**. All commands run from repo root unless noted.

## Data model (locks in here)

**`IndexDO`** — idFromName("global"), singleton.
```sql
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, name TEXT, username TEXT, photo_url TEXT,
  banned INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS file_index (
  file_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_owner ON file_index(owner_id);
```
Methods: `ensureUser`, `listUsers`, `setBanned`, `registerFile`, `setArchived`, `filesOf(ownerId)`, `findFile(fileId)`, `stats()`.

**`FileDO`** — idFromName(fileId).
```sql
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rows (idx INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (
  version INTEGER PRIMARY KEY, ts INTEGER NOT NULL, action TEXT NOT NULL, label TEXT
);
CREATE TABLE IF NOT EXISTS version_rows (
  version INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (version, idx)
) WITHOUT ROWID;
```
Methods: `init(meta, rows)`, `getMeta()`, `getRows()`, `getFull()`, `saveRows(rows, action)` (writes rows + snapshot `version = max+1`), `rename`, `setArchived`, `history()`, `getVersion(v)`, `restore(v)`, `fork(newId, label)`, `prune(keepDays, keepCount)` (called via alarm).

**`PoolDO`** — idFromName(password) — one DO per password, all three pools in one SQLite:
```sql
CREATE TABLE IF NOT EXISTS pool_rows (
  pool_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'available', claimed_by TEXT, claimed_at INTEGER,
  PRIMARY KEY (pool_id, idx)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS dedup (key TEXT PRIMARY KEY);        -- uid||c_user per password
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, pool_id TEXT NOT NULL,
  row_key TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, ts INTEGER NOT NULL
);
```
Methods: `addRows(poolId, rows)` (classify first), `removeRows(poolId, keys)`, `claim(poolId, userId, keys)`, `promote(poolId, keys)`, `counts()`, `detail(poolId)`, `ledger(poolId, limit)`, `revert(ledgerId)`. `classifyRow` + `getDedupKey` ported 1:1 from `backend/src/services/pools.ts` / `files.ts`.

## API compatibility (old → new, same paths/shape)
| Old route (backend/src/routes/*) | New impl |
|---|---|
| `GET/POST /api/files`, `PUT/DELETE /api/files/:id`, `PUT /:id/persist`, `PUT /:id/append`, `GET /:id/rows|full` | `filesRouter` → IndexDO + FileDO |
| `GET /api/files/:id/history`, `GET /:id/history/:v`, `POST /:id/history/:v/{restore,name,fork}` | FileDO history methods |
| `GET /api/auth/telegram`, `/photo/:userId`, `/logout`, `/me`, `/device`, `/device/claim` | auth router + IndexDO |
| pools routes (admin) | PoolDO methods |
| admin routes (`/stats`, `/users`, user/file mgmt) | IndexDO + FileDO |
| `POST /api/fb/check`, `/fb/page-check`, `/fb/wa-check`, `GET /wa/cache` | pure `fetch` proxies to hitools (same URLs/headers as old `routes/wa.ts`) |
| `POST /webhook/tg` | bot router → `handleBotUpdate` port; reply via `ctx.waitUntil` |

---

### Task 1: Scaffold `worker/` project
**Files:** Create `worker/package.json`, `worker/wrangler.jsonc`, `worker/tsconfig.json`, `worker/src/index.ts`, `worker/test/health.test.ts`
**Interfaces:** Produces `src/index.ts` exporting default Hono `app` + `export { IndexDO } from "./do/IndexDO"` etc., `export default { fetch: app.fetch, scheduled }`.

- [ ] `bun init` in `worker/`; add `hono`, dev deps `wrangler`, `@cloudflare/vitest-pool-workers`, `vitest`, `typescript`
- [ ] `wrangler.jsonc`: name `sheetsubmit-api`, `main src/index.ts`, `compatibility_date` current, `durable_objects.bindings [{name: INDEX, class_name: "IndexDO"}, {name: FILES, class_name: "FileDO"}, {name: POOLS, class_name: "PoolDO"}]`, `migrations [{tag:"v1", new_sqlite_classes:["IndexDO","FileDO","PoolDO"]}]`, `triggers.crons ["0 */6 * * *"]` (GC), `vars` placeholders
- [ ] Health route + test:
```ts
// src/index.ts (start)
import { Hono } from "hono";
const app = new Hono();
app.get("/api/health", (c) => c.json({ ok: true, ts: Date.now() }));
export default { fetch: app.fetch, scheduled: () => {} };
```
```ts
// test/health.test.ts
import { SELF } from "cloudflare:test";
it("health", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
});
```
- [ ] `bun run test` (vitest-pool-workers) → PASS; `bunx wrangler dev` boots → commit `worker: scaffold hono + wrangler + tests`

### Task 2: Shared types + session auth
**Files:** Create `worker/src/lib/shared.ts` (copy of `backend/src/lib/shared.ts` types — keep `FileType`, `ColumnDef`, `FileTypeDef`, `SheetFile`, `Row`), `worker/src/lib/session.ts`, `worker/src/do/IndexDO.ts`, `worker/test/auth.test.ts`; Modify `src/index.ts`
**Interfaces:** Produces `signSession(userId): Promise<string>`, `verifySession(token): Promise<{uid}|null>`, `requireAuth` Hono middleware (reads cookie `ss_session`, sets `c.set("uid")`), `Env` bindings type.
- HMAC-SHA256 via Web Crypto (`crypto.subtle`), payload `{uid, exp}` base64url, secret from `wrangler.jsonc` var `SESSION_SECRET`. Cookie: `HttpOnly; Secure; SameSite=Lax; Max-Age=30d`.
- IndexDO class with the `users`/`file_index` schema above; `fetch()` dispatch on `this.ctx.storage.sql` RPC-style methods via `POST /` `{op, args}` JSON protocol (simplest RPC; no RPC decorators needed on free).
- Port login flow 1:1 from `backend/src/services/telegram.ts` (`completeTelegramLogin`): same Telegram API call (`api.telegram.org/bot<token>/getUpdates`-independent, uses login code), same `ADMIN_IDS` check from env var → `isAdmin` on `c.var`.
- Tests: session round-trip (sign→verify→tamper fails), IndexDO ensureUser/listUsers/ban, `/api/me` 401 without cookie, 200 with.
- Run tests → PASS → commit `worker: index DO + hmac sessions + auth middleware`

### Task 3: FileDO + files router
**Files:** Create `worker/src/do/FileDO.ts`, `worker/src/routes/files.ts`, `worker/test/files.test.ts`; Modify `src/index.ts` (mount router, bind FileDO via `c.env.FILES.idFromName(fileId)`)
**Interfaces:** Produces FileDO methods above + `getFileDO(env, id): DurableObjectStub`; routes match old JSON shapes from `backend/src/routes/files.ts` — port response builders verbatim from that file.
- `PUT /:id/persist` = FileDO `saveRows` with `action: "edit"`; `PUT /:id/append` = merge-by-dedup then save with `action: "append"`; `countDataRows`/`No_2Fa` strip ported from `backend/src/lib/xlsx.ts`-adjacent helpers in `backend/src/services/files.ts`.
- Body guard: middleware returning 413 when `content-length` > 4_000_000.
- Tests: create file → rows round-trip → persist bump version → append dedups → delete unregisters index. Run → PASS → commit `worker: FileDO rows/versions + files router`

### Task 4: History endpoints + prune alarm
**Files:** Create `worker/src/routes/history.ts`, `worker/test/history.test.ts`; Modify `FileDO.ts` (alarm)
- `history()` returns version meta list; `getVersion(v)` materializes `version_rows` for v; `restore(v)` = copy version_rows → rows + new snapshot; `name(v,label)` updates label.
- `FileDO.alarm()` → `prune(30, 100)`; every `saveRows` calls `ctx.storage.setAlarm(now + 24h)`.
- Test: save 3× → 3 versions → restore v1 → rows equal v1 → prune with keepCount=2 drops oldest.
- Run → PASS → commit `worker: history + alarm prune`

### Task 5: PoolDO + pools router
**Files:** Create `worker/src/do/PoolDO.ts`, `worker/src/routes/pools.ts`, `worker/test/pools.test.ts`; Modify `src/index.ts`
**Interfaces:** Port `classifyRow`, `getDedupKey`, promote/handleFileSave logic 1:1 from `backend/src/services/pools.ts` (same decisions, same row shapes). Claim/ledger/revert semantics identical to old `pool:<pwd>:<id>` keys, now rows in SQLite. Dedup scope = per password (was `taken:global:<pwd>`).
- Routes: `GET /api/pools` counts, `GET /:password/:poolId` detail, `GET /*/rows`, `GET /*/ledger`, `POST /*/claim`, `POST /*/revert` — admin-gated, JSON only (xlsx downloads move client-side: frontend `PoolsView` already has download builders in `lib/xlsx.ts` — Task 8 wires them).
- Test: add 10 rows → claim 3 → ledger has 3 → revert 1 → states correct; cross-pool dedup within same password enforced.
- Run → PASS → commit `worker: pool engine in DO`

### Task 6: Admin + user management routes
**Files:** Create `worker/src/routes/admin.ts`, `worker/test/admin.test.ts`
- Port `backend/src/routes/admin.ts` responses onto IndexDO (`stats`, `users`, ban/unban, delete user → cascade: filesOf → FileDO.setArchived/delete) and admin file ops (find via `file_index`, reuse FileDO methods). Photo proxy `/api/photo/:userId` → `fetch(telegram avatar)` passthrough.
- Test: ban blocks auth; stats counts match fixture DOs. Run → PASS → commit `worker: admin routes`

### Task 7: WA proxies + Telegram webhook + scheduled GC
**Files:** Create `worker/src/routes/wa.ts`, `worker/src/routes/bot.ts`, `worker/src/scheduled.ts`; Modify `src/index.ts`
- `wa.ts`: port 3 proxy endpoints from `backend/src/routes/wa.ts` (same upstream URLs/headers, zod schemas reused). `GET /wa/cache` returns `{enabled:false}` (cache TTL is 0 in prod env today).
- `bot.ts`: port `handleBotUpdate` from `backend/src/services/telegram.ts` — `/start`, `login_<code>`, `myid` flows, same messages; secret token check on `X-Telegram-Bot-Api-Secret-Token`. `GET /api/bot/info` returns bot username. `setWebhook` documented in cutover task.
- `scheduled.ts`: GC = iterate `file_index` → FileDO.prune; guard ≤50 subrequests (Workers free) by processing pages per run (cursor persisted in IndexDO meta).
- Test: webhook rejects bad secret; fb/check proxies mocked upstream. Run → PASS → commit `worker: wa + bot webhook + cron`

### Task 8: Frontend — CF Pages + Functions proxy
**Files:** Create `frontend/functions/api/[[path]].ts`, `frontend/functions/webhook/[[path]].ts`, `frontend/public/config.js`; no src changes
- `config.js` (static, replaces runtime injection): `window.APP_CONFIG={apiBase:""};`
- Proxy (port logic from `frontend/server.js` proxyRequest — same header hygiene: drop hop-by-hop, forward `set-cookie` via `getSetCookie()`, no `content-encoding` forwarding):
```ts
// frontend/functions/api/[[path]].ts
export const onRequest: PagesFunction<{ BACKEND_URL: string }> = async ({ request, env, params }) => {
  const url = new URL(request.url);
  const upstream = await fetch(env.BACKEND_URL + "/api/" + params.path + url.search, request);
  return upstream; // body+headers stream through; Set-Cookie preserved
};
```
- `webhook/[[path]].ts` same with no `/api/` prefix. `wrangler.jsonc` (pages config) with `BACKEND_URL` = API Worker URL. Deploys run via CI (Task 9), not Git integration. Local verify first: `bunx wrangler pages dev` + `bunx wrangler dev` (worker) → login flow → sheet persist.
- Commit `frontend: pages functions proxy + static config`

### Task 9: GitHub Actions — CI deploys (worker + frontend)
**Files:** Create `.github/workflows/deploy-worker.yml`, `.github/workflows/deploy-frontend.yml`
**Interfaces:** Consumes GitHub secrets `CLOUDFLARE_API_TOKEN` (template: Workers Scripts:Edit + Pages:Edit + Account:Read), `CLOUDFLARE_ACCOUNT_ID`. Produces automated deploys on push to `main`.

`.github/workflows/deploy-worker.yml` (shape — pin `wrangler-action` to a current SHA when writing it):
```yaml
name: deploy-worker
on:
  push:
    branches: [main]
    paths: ["worker/**"]
permissions: { contents: read }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: cloudflare/wrangler-action@<sha>
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: worker
          command: deploy
```
- Test step before deploy: `bun install && bun run test` inside `worker/` (job step, `working-directory: worker`).
- `deploy-frontend.yml` mirrors it: paths `frontend/**`, build `bun install && bunx vite build` (cwd `frontend`), then wrangler-action `command: pages deploy dist --project-name sheetsubmit-web`.
- Docs: both `*.pages.dev`/`*.workers.dev` URLs printed in CI logs; commit `ci: cloudflare deploys via github actions`
- Note: adding a repo-level `paths` guard prevents deploy churn on docs-only pushes.

### Task 10: Turnstile + bot blocking
**Files:** Modify `worker/src/routes/auth.ts` (verify token), `frontend/src/components/auth/LoginScreen.tsx` (render widget), `.github/workflows/*` (env)
**Interfaces:** Produces `verifyTurnstile(token, ip): Promise<boolean>` (POST `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `TURNSTILE_SECRET_KEY`); login endpoints reject without valid token.
- Frontend: load `https://challenges.cloudflare.com/turnstile/v0/api.js`, render widget with site key (Pages env var `TURNSTILE_SITE_KEY` injected via `/config.js` alongside `apiBase`), send token with login request.
- Worker: `POST /api/auth/*` verifies token before `completeTelegramLogin`; 403 on failure. Tests: mock siteverify (upstream mock in vitest-pool-workers via `fetchMock`).
- Dashboard (manual, cutover): Security → Bots → **Bot Fight Mode ON**; WAF rate-limit rule: `/api/*` 300 req/min per IP → block 10 min; keep `/webhook/tg` exempt from challenge (Telegram servers must reach it — scope challenge rules to browser-only paths, never the webhook).
- Run tests → PASS → commit `security: turnstile login + bot fight mode`

### Task 11: Cutover
- [ ] Merge to `main` → CI deploys worker + frontend (Task 9 flows). Set worker secrets once via `wrangler secret put` from CI-approved local session or dashboard: `TG_BOT_TOKEN`, `ADMIN_IDS`, `SESSION_SECRET`, `HITOOLS_*`, `TURNSTILE_SECRET_KEY` (same values as `backend/.env`)
- [ ] Telegram `setWebhook` → `https://sheetsubmit-api.<subdomain>.workers.dev/webhook/tg`
- [ ] Pages env `BACKEND_URL` + `TURNSTILE_SITE_KEY` set in dashboard (or `wrangler.jsonc` vars)
- [ ] Enable Bot Fight Mode + WAF rate-limit rules (from Task 10 checklist)
- [ ] Smoke test: CI-deployed site end-to-end (login with Turnstile, import xlsx, edit+persist, pools claim, history restore, admin) using `scripts/api-live.mjs` patterns + webapp-testing
- [ ] Update `AGENTS.md` map + snapshot table; retire Railway services + delete old `backend/` Dockerfile flow (no old data to keep). Commit `deploy: cloudflare cutover`

## Free-tier budget (20 users)
- Requests: 20 users × ~200 req/day ≈ 3k/day « 100k (Workers+DO share quota; DO calls count)
- Storage: sheets+history in SQLite « 5 GB; prune caps growth
- Cron: 5 free triggers, using 1; 10 ms cron CPU fine for prune fan-out with cursor
- xlsx: client-side only; persist bodies capped 4 MB
