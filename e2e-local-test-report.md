# E2E Local Test Report — SheetSubmit spreadsheet (mobile, fake APIs)

Date: 2026-09-12/13 · Local only (never prod) · Browser deps via **npm** (`npx playwright`), unit tests via bun.

## What was built

- `Pages/e2e/page-entry.spec.ts` — 5 headed mobile (Pixel 7) tests, all green:
  1. `page auto-check runs on paste, skips just-edited row` (~4s)
  2. `cookie.xlsx cell-by-cell` (~4s)
  3. `2fa.xlsx cell-by-cell` (~4s)
  4. `Page.xlsx cell-by-cell` + typo→QEB-paste correction (~6s)
  5. `Page500 typed cell-by-cell + check + no loss` (~7.3 min, 1000 double-tap pastes)
- `scripts/e2e-local.ts` — one-command stack: `bun scripts/e2e-local.ts up|status|test|down`
  (test Postgres+Redis → schema bootstrap → backend `:3001` with `ALLOW_TEST_AUTH=1` → web `:8080` via `Pages/server.js` proxy).
- `scripts/gen-page500.py` — generates `test/Page500.xlsx` (500 rows, seeded deterministic UIDs `61590000000000+i`).
- Fixtures used: `test/cookie.xlsx` (5 cookies-only), `test/2fa.xlsx` (5 combo), `test/Page.xlsx` (5 page), `test/Page500.xlsx` (500 page).

## How it runs

```powershell
bun scripts/e2e-local.ts up     # db + backend :3001 + web :8080
$env:E2E_BASE_URL='http://127.0.0.1:8080'; npx playwright test e2e/page-entry.spec.ts --headed
bun scripts/e2e-local.ts down   # stop everything
```

- Auth: `POST /api/test/login` mints `ss_session` (needs `ALLOW_TEST_AUTH=1`, test DB only).
- Fakes via `page.route` (never touch Facebook/prod): `POST /api/fb/check` (first half UIDs
  alive, second half dead), `POST /api/fb/page-simple` (alive→eligible), `POST /api/fb/page-advanced`,
  `GET /api/wa/cache*` (`{cache:{}}`).
- Each test types an **empty** file cell-by-cell (double-tap paste, uid auto-fills from `c_user`),
  presses Check once (or never, for the auto test), then proves **no data loss**: grid text +
  `GET /api/files/:id/rows` compared field-by-field against the fixture (2fa compared normalized:
  spaces/dashes stripped, uppercased — the app normalizes on commit).

## Things found that were NOT visible at first

1. **Double-tap paste wiped by stale draft** (`stores/sheetStore.ts` `doubleTap`): after pasting it
   reset `draft:""` while the cell stayed selected, so the *next* cell's tap committed `""` over the
   just-pasted value. Server ended up uid-only. Fix: sync `draft` to the cell value after double-tap.
2. **API-created files aren't Page files** (`features/filetypes/index.ts` `isPageFile`): needs stored
   `columns` with `twofakey`. Files made via `POST /api/files` without `columns` never trigger the page
   sweep. Fix (test): pass `columns` explicitly like a real xlsx upload detects.
3. **Renamed endpoints/toggles**: sweep calls `POST /api/fb/page-simple` + `page-advanced`
   (`lib/api.ts`), gated by `ss_pageSimple`/`ss_pageAdvanced` — not the old `/fb/page-check`,
   `/fb/wa-check`, `ss_waCheck` names still seen in older code/tests.
4. **`request.postDataJSON()` is synchronous** — `.catch()` on it throws inside route handlers.
5. **Grid holds 100 rows** (`GRID_PAGE`, pads to 100; `Add row` +100, cap 500). For hands-free typing
   the app now auto-creates **10 spare rows** when editing within 10 of the end (`commitCell`) and
   auto-expands the visible window when the selection nears it (`SheetGrid`) — zero button clicks.
6. **TOTP auto-copy races clipboard seeding**: pasting 2fa writes the TOTP code to the clipboard, which
   can land *after* the test seeds the next value. Fix (test): verify-write loop until read-back matches.
7. **Double-tap splits under load** (edit bar opens, nothing pastes). App fix: single taps are deferred
   400ms so a second tap cancels them — double-tap never flashes the edit bar; single tap still opens it.
   Test fix: every paste verifies (uid `aria-label`) and retries ≤5× with 2s timeouts.
8. **Stale `lastSeq` → 409 storm** (`flushPersist`): overlapping saves never adopted the new seq, so every
   flush conflicted, refetched the whole file and remounted the grid (cells detached mid-click past
   ~100 rows). Fix: adopt `resp.seq` on every success; updated the unit test that encoded the old behavior.
9. **Persist is debounced** — assert server state with `expect.poll` (10s), never fixed sleeps.
10. **Mid-edit cells show the draft, not text** — assert uid via `aria-label`, not `toContainText`.
11. **Never pipe a long run through `Select-Object -First`** — it kills the test mid-run. Log to a file,
    poll the file with short bounded commands.
12. **App rules the test must respect**: invalid cells block Check ("fix invalid first"); same-file
    duplicates are blocked at entry with a toast; empty 2fa is valid; `No_2Fa` marker excluded from dedup.
13. **Auto page-check semantics** (covered by test 1): pasting row N triggers UID check for all rows but
    the page sweep *excludes row N* — row N−1 turns eligible instead, one step behind, Check never pressed.
    `ss_pageSimple=false` disables the sweep (UID check still runs).

## Verification

- `npx playwright test e2e/page-entry.spec.ts --headed` → **5 passed** (local, ~8 min total).
- `npm run typecheck` (Pages) → clean. `bun test sheetStore + filetypes` → **91 pass, 0 fail**.
- Skills used: `xlsx` (fixtures), `webapp-testing`, `playwright-testing` (skills.sh) — see global registry.
