# SheetSubmit — Feature Plan v2 (efficiency-first)

## One system, not five: UNIFIED SNAPSHOT ENGINE

**The big efficiency win:** undo/redo, version history, and protection against accidental data loss all need the *same* primitive — *a saved old state of the file*. So we build **one versioned-snapshot engine** and each feature becomes a thin consumer of it.

---

## A. Snapshot engine (server, one addition)

**What happens today (dangerous):** `PUT /persist` blindly overwrites `ss:rows:<id>` (`server/index.js:329`). Every change wipes the previous state forever. That's why the 26-row loss happened and why undo/redo never worked after upload.

**The fix — server-side snapshots keyed by *action*, not by every persist:**
- Client marks a status on meaningful actions only: `action` in the persist payload = `replace | append | merge | restore | check | sync | import`.
- `PUT /persist` snapshots the *current* `ss:rows:<id>` **before** overwriting **only when** `body.action` is present (i.e. a discrete user action finished).
- Plain cell typing → no version noise; undo/redo stack already tracks cell-level edits client-side (see §C). An idle timer adds one coalesced `action:'edit'` version every ~60s of continuous editing (configurable `HISTORY_EDIT_COALESCE_S`).
- **NO count cap on versions.** Retention is **age-based only** (`HISTORY_RETENTION_DAYS`, default 30) — every version lives for the full window; none is dropped for "too many". Space is controlled by compression (§A2), not deletion.

### A2. Git-style storage (keeps unlimited versions small)
Modeled on git's content-addressing + delta packing:
- **Content-addressable blobs:** rows are hashed (e.g. SHA-1 of the JSON). `ss:blob:<hash>` stored **once** per unique content — shared across files, so identical rows in different files cost one blob. Version records reference blob hashes, not copies.
- **Checkpoint + delta chain:** every Nth version (default 20, env `HISTORY_CHECKPOINT_EVERY`) stores a **full** snapshot blob; versions between checkpoints store only a **delta** vs their parent (JSON-diff of changed cells/uids). Recover = walk back to nearest full checkpoint, then apply deltas forward. Bounded memory, **zero version loss**.
- **Prune = age only, by reachability:** on each write, drop blobs whose last referencing version is older than the retention window. This is git-GC semantics — never a count limit.
- **Dedupe across files is free:** if you upload the same 26 rows to two files, the history engine writes one blob and two tiny refs.
- **GC is cross-file:** a blob is shared across files, so it cannot be deleted when one file is removed — reachability must be tracked globally via a ref index **`ss:blobrefs:<hash>`**, and a blob is only removed when its *last* referencing version (across every file) falls outside the retention window.
- **Prune needs a server-side scan job:** no scheduler exists today — the only background timer is backup.js's `setInterval`. Add the age-prune pass on the same (or a new) interval.
- **Backup caveats:** `backup.js:98`'s `dbsize` key-count guard skips a run when the key *count* is unchanged, so value-only mutations are missed — being fixed with an `ss:meta:dirty` marker. The Upstash mirror is non-incremental (full copy per run) and **never deletes pruned keys**, so GC'd blobs linger in the mirror unless an explicit delete path is added.

Why this is efficient: **one write path, zero new client saves, no new background job.** Backup.js continues to mirror `ss:*` to Upstash as the cold offsite copy.

## B. Restore = reversion of a snapshot (new routes)

- `GET  /files/:id/history` → `[{v, ts, action, rowCount, parentV}]` (metadata only, cheap — no blob payloads).
- `GET  /files/:id/history/:v` → materialize version `v` by walking its blob (or checkpoint+delta chain) → full rows for preview.
- `POST /files/:id/history/:v/restore` → writes that materialized state back as rows **and commits a new `restore` version** (git-revert semantics: the revert itself is a version, so you can always undo the revert).
- Admin variants mirror for the admin file viewer.

Client just refreshes rows + `renderSheet` after restore. **Confirm is mandatory** on restore (danger styled).

## C. Undo/redo unified (fixes the "doesn't work after upload" bug)

Today: cell edits push `{type:'cell'}` into `state.undoStack`; append/replace **wipe both stacks** (`js/sheet.js:1423,1438`) → buttons dead after any upload.

**Unified delta model (one stack, both kinds):**
```js
{ type: 'cell', rowIdx, colKey, prevVal }   // tiny, existing
{ type: 'rows', rows: <full prior state> }  // snapshots for upload ops
```
- Append, Replace, Merge, Restore all push `{type:'rows'}` into the undo stack and clone-row into redo when undone. Remove the stack-wipe lines at `js/sheet.js:1423,1438`.
- Undo/redo handles both delta kinds; both restack correctly. **Same** `_persistImmediate` persists stacks as today. Cap stack at 100 entries (current client cap, `js/sheet.js:535`).
- **Result:** undo/redo now (finally) works across every action type — fixes the bug you flagged, with no separate code path.
- **Check/sync accounted separately:** a Check run mutates `wa_status` on many cells; it cannot be undone per-cell after the run. Check & sync write their affected-cells diff to the undo stack as `{type:'rows'}` (smaller) *or* rely on history restore. Decide in implementation; requirement: a user can always revert a Check back to pre-check state via one Undo.

## C2. Undo gaps found in your exact workflow (auto-check + delete + revert)

You keep **auto-check ON**, so each cookie paste triggers a re-check; you then delete dead rows / bad 2fa keys, and **revert via Undo to recover a key if it was a mistake**. Two bugs block that today — both must be fixed:

1. **`deleteSelectedCells` clears cells WITHOUT pushing undo** (`js/sheet.js:1166-1188`). Deleting a 2fa key (or a whole selected row) is permanent right now — Undo can't get it back. **Fix:** each cleared cell pushes `{type:'cell', prevVal}` before clearing (or one `{type:'rows'}` snapshot for the whole delete op). Then "I deleted the wrong key" = one Undo.
2. **Auto-check mutations aren't undoable.** When paste triggers `maybeAutoCheck` → `runCheck`, the `status`/`wa_status` writes happen inside the check run without undo entries. **Fix:** capture a `{type:'rows'}` snapshot of rows being mutated at check start, so the auto-check result is itself revertible ("it marked my account dead by mistake" → Undo restores pre-check state).

**Auto-check + cache interplay (efficiency):** since a check fires on *every* paste, the WA-eligibility check (the expensive GraphQL call) must consult the global `ss:wa:<c_user>` cache (§G) first — a cached `eligible` uid is stamped without any network call, even when auto-check is ON. The cheap cookie-dead/alive check still runs per paste (that's the point of auto-check); only the costly WA lookup is cached/skipped.

### C3. Undo does NOT survive reload

Today the undo/redo stacks are written to Redis (`ss:undo`/`ss:redo`) but **never read back** — `openFile` resets them to `[]`. This plan fixes it:

- New `GET /:id/undo` route returns both stacks; the client reloads them in `openFile`.
- Undo/redo handlers must call `persist()` — today they don't, so an undo followed by a close within ~300ms (the `persist()` debounce) is lost.
- Add a `beforeunload` flush so a sudden close can't strand the last debounced persist.

Be explicit about the "delete a key then close browser" scenario: the **only reliable retrieval** is the server-side version history (§A/§B/§F restore), **not** in-memory undo. Undo is reload-safe only within the same page session unless the reload-load fix above is in place.

## D. Merge xlsx (append + dedupe — same picker)

- `#menuMerge` in `...` menu → reuses the exact existing xlsx parser.
- Incoming rows deduped against current `state.rows`:
  - fb: `row.uid` (c_user); ig: `row.username` only — **same `getDedupKey` the cross-dup checker already uses** (`server/index.js:488-490`), so merge and duplicate-highlighting agree.
  - Content-hash (`ss:blob:<hash>`, §A2) used only as a **fast pre-filter** for byte-identical rows; the uid/username key remains the authoritative duplicate test (same uid + different cookie = still a duplicate).
- Appending only new rows, clear redoStack, push one `{type:'rows'}` undo entry.
- Toast `Merged N (skipped M)`.

## E. Replace-all confirmation (safety gate on the main risk)

- Before applying replace, mandatory `__ss.showConfirm`:
  > "Replace ALL N rows? Your file currently holds M rows. Existing data will be **permanently replaced**. Continue?"
  - okText "Yes, replace" — danger-styled. Cancel leaves current data intact.
- Because snapshots exist server-side, data is never actually lost even if the confirm is bypassed — belt and suspenders.

## F. Version-history modal (Google-Sheets-style `...`)

**How the user sees changes & picks a version to revert:**

- `#menuVersions` item → modal `versionOverlay` listing `ss:hist:<id>` records, newest first:
  - **Timestamp (always shown):** local time `DD MMM YYYY, HH:MM` + relative (`5 min ago`) + exact epoch kept in `ts`.
  - **Action badge:** edit / replace / append / merge / restore / check / sync / import.
  - **Row count delta:** `+3 / −2 / =` vs the previous version, so the user sees *what changed in size* at a glance.
  - **Change summary (what was done):** for each version, compute a lightweight diff at list time — e.g. `Added 3 rows`, `Removed 2 rows`, `Changed wa_status on 5 rows`, `Full replace (26→29 rows)` — derived from comparing `rowCount` + uid sets between neighbors. The modal shows this as the one-line "what happened" description.
- **Preview:** click a version → read-only preview of that version's rows (first ~10) so the user confirms it's the right state.
- **Revert:** **Restore this version** button → mandatory `__ss.showConfirm` ("Restore version from <time>? Current rows (N) will be replaced.") → `POST /files/:id/history/:v/restore`.
  - Restore itself becomes a **new version** (`action:'restore'`) with its own timestamp, so a revert is always itself revertible — nothing is ever lost.
- **Data model guarantees the UI:** each snapshot already carries `{v, ts, action, rowCount, rows}` (§A). The diff lines are computed from `rows` vs the neighboring snapshot (uid-keyed), so "what changed" is real, not hand-labeled.
- **No version cap:** history keeps every version for the retention window (30 days, age-only prune). The list **pages** (load ~50, "show more") so hundreds of versions don't slow the modal.
- Close + backdrop.

### Timestamp rules
- `ts` set server-side at snapshot time (`Date.now()`), displayed in the user's browser-local timezone.
- Relative time refreshes on modal open (no live ticker needed).
- A restored version keeps its *original* `ts` when re-listed (it's shown under its creation time, with a `restored` tag), while the restore *event* itself gets a new timestamp.

### Mockup of the modal (what the user sees)
```
┌─ Version history ────────────────────────────────┐
│  18 Aug 2026, 14:32  (5 min ago)      [+3] Merge │
│  Added 3 rows (3 new uids)                       │
│  ─────────────────────────────────────────────── │
│  18 Aug 2026, 14:05  (32 min ago)    [+26] Check │
│  Changed wa_status on 26 rows                    │
│  ─────────────────────────────────────────────── │
│  18 Aug 2026, 13:10  (1 hr ago)      [=0] Replace│
│  Full replace 29 → 29 rows                       │
│  ─────────────────────────────────────────────── │
│  18 Aug 2026, 09:00  (5 hr ago)      [New] Import│
│  Created file with 26 rows                       │
└──────────────────────────────────────────────────┘
```
Each row is clickable → preview → **Restore this version** (danger confirm).

### F2. Cell edit history = git blame, computed not stored
The git insight (confirmed): **the diffs between consecutive versions ARE the edit history** — no separate per-cell log table. A right-click → "Edit history" on any cell walks the delta chain backwards and derives `(when, action, prev value → new value)` for that cell — exactly Google's *Show edit history*, but computed on demand, zero extra storage. Undo stack covers keystroke-level; this covers version-level attribution.

### F3. Google-Sheets borrowings (from research)
- **Day-grouped list:** versions grouped under expandable day headers (Tue 18 Aug ▸), matching Google — collapses long timelines; flat list remains below (paged).
- **Named versions:** bookmark a snapshot with a name ("Before merge", "26-row baseline"). `name` field on the version record, editable from the modal. Google caps at 40; we don't (age-only retention).
- **Fork a version:** "Copy version" materializes an old state into a **new file** (recover deleted rows without touching the live file). Optional — implement after core restore works.
- **What we deliberately DON'T copy:** Google wipes history after a restore — ours is revertible; Google keeps 100-version/30-day count caps — ours is age-only; Google's per-cell log — ours is blame-computed.

## Workflow-fit (maps to how you actually use the sheet)

Your real pattern: **add a 2fa key → add a cookie to the same row → repeat cell-by-cell → later upload/merge → download → archive → restore or permanent-delete.** The design is shaped around it:

1. **Cell-by-cell entry (the bulk of your work) is NOT a version flood.** Each `2fa key` or `cookie` paste is a plain cell edit → tiny `{type:'cell'}` undo entries, fast Undo/Redo. No `ss:hist` spam. If you stop typing for `HISTORY_EDIT_COALESCE_S` (60s), the *whole session* folds into one `action:'edit'` version — so the timeline shows "Edited 12 cells", not 12 versions.
2. **Auto-check ON + every paste triggers re-check (§C2).** Cheap alive/dead check runs per paste (that's the point). The expensive WA-eligibility lookup is cache-backed (`ss:wa:<c_user>`), so a known-eligible uid is stamped with zero network calls even under auto-check. And the auto-check *result* is undoable — "marked my account dead by mistake" → one Undo restores pre-check state.
3. **Undo/redo is your everyday tool** for the "oops wrong key" case; **versions are your "hours later" safety net** for "I want last Tuesday's state back". Two depths, one engine.
4. **Delete a 2fa key / dead row (§C2) is now undoable** — today it's permanent (`deleteSelectedCells` doesn't push undo). After the fix, deleting the wrong key = one Undo to retrieve it.
5. **Upload/append/merge** = 1 version each (`action:'append'`/`'merge'`), with before-state snapshot so a bad merge is one Undo away and restorable from the list.
6. **Download** doesn't change data → no version (nothing to restore).
7. **Archive** keeps `ss:hist:<id>` intact (same as rows/undo today — archive only moves the file entry, doesn't touch data keys). **Restore from archive** brings the file back **with its full version history**, so a file you deleted-then-archived still shows every past state.
8. **Permanent delete** removes `ss:hist:<id>` along with rows/undo/redo/sync/logs (`server/index.js:403`) — expected, file is gone. But `ss:wa:<c_user>` (eligibility) survives by design (§G), so re-importing the same accounts never re-checks eligibility. **NOTE:** `server/index.js:403` and the admin twin `:737` had a prefix bug (`del` without `ss:`) — fixed as part of this plan; batch-delete `:417-421` and user-wipe `:869-873` were already correct (`delKey`). All four sites now also remove `ss:hist:<id>`.
9. **Auto-delete/auto-prune**: versions are pruned by **age only** (30 days) — **never by count** — and kept small via content-hash dedupe + delta checkpoints (§A2), so you can have hundreds of versions of a file without eating memory. **No server-side auto-prune of archived *files* exists** — the 30-day countdown on archive cards is UI-only (`js/home.js:305`). Archived-file auto-deletion is **out of scope / not implemented**; only *version history* is age-pruned.

So: the timeline is a **true "what did I do to this file" diary** — your cookie/2fa sessions, every merge, every check, every archive/restore — each stamped with time and revertible.

## G. Global WA eligibility cache (survives file delete/recreate)

**Problem:** a Page Check result lives only on the row inside a file (`row.wa_status`). If that file is archived/deleted and re-imported, every account gets re-checked against FB — slow and burns the API even for accounts already known `eligible`.

**Fix — cache by `c_user`, not by file:**
- New Redis key family **`ss:wa:<c_user>`** → `{ status: 'eligible' | 'ineligible' | 'error', error, banReason, ts, checkedAt }`, global across all files & users, no TTL-deletion on file delete.
- **Write:** the Page Check flow (`runWaChecks` → `/api/fb/wa-check`) writes each `c_user` result into `ss:wa:<c_user>` (batched RPUSH → hash, or single HASH `ss:wacache` keyed by c_user). **This WA check is a direct Facebook proxy** (`server/index.js:1072` — `business.facebook.com/api/graphql`, `doc_id WhatsAppOnboardingUnifiedInboxSurfaceQuery`) — **not** SkySys; `/api/sky/push` is only the IG cookie push proxy. The cache is **FB-only** — ig_cookie has no `checkAccounts` (`js/sheet.js:40` hides the check buttons for it). Store the raw error string in the `error` field: today `runWaChecks` collapses every failure to `wa_status='error'` and discards the reason (`js/sheet.js:325-331`), so rate-limit vs hard-fail are indistinguishable.
- **Read/skip:** whenever rows load (open file, upload/merge/replace), before firing any WA check, the client asks `GET /api/wa/cache?uids=...` (or server resolves on `/rows`). Rows already cached `eligible`/`ineligible` are stamped immediately and **excluded from the check batch**; only unknown/`error` uids get checked. Existing `eligible` rows never re-checked.
- **Delete-safety:** file deletion (`server/index.js:403`, archive permanent-delete) touches only `rows/undo/redo/sync/logs` — **`ss:wa:*` keys are intentionally untouched**, so re-creating the file with the same `c_user` restores the eligibility instantly without a new FB call.
- **Freshness:** optional `WA_CACHE_TTL_HOURS` (default 0 = keep forever). Cache writes also update `row.wa_status` on load so the UI/Download filters (FB Page / No Page) stay correct.
- Cross-file dedupe already flags duplicate uids; this cache removes *re-checking cost* on top.

## Sequencing (efficiency + safety first)

1. **E. Replace confirm** (30s, prevents recurrence of the incident).
2. **C2. Delete/auto-check undo** (client-only; unblocks your everyday revert workflow).
3. **C. Unify undo/redo** (client-only, kills the bug, unblocks rest).
4. **A + B. Server snapshot engine + restore** (backend, rq-safe).
5. **G. Global WA cache** (server + `runWaChecks` wiring, biggest recurring cost saver).
6. **D. Merge** (pure client, reuses model).
7. **F. Versions modal** (front-end, consumes A+B), then F2 blame cell-history + F3 day-grouping/named versions/fork.
8. Rebuild → push → Railway auto-deploy.

## Touch points

| area | change |
|---|---|
| `server/index.js` | snapshot-before-overwrite in persist; **blob store (`ss:blob:<hash>`) + checkpoint/delta chain + age-only prune**; history list/materialize/restore routes; wa-cache read/write (`ss:wa:*`); leave `ss:wa:*` alone on file/archive delete; admin mirrors |
| `js/sheet.js` | unify undo/redo, replace-confirm gate, merge, versions modal; **make `deleteSelectedCells` push undo; make auto-check result undoable**; hydrate rows from wa-cache and skip cached uids in `runWaChecks`; blame-walk cell history (F2); day-grouping + named versions + fork (F3) |
| `js/api.js` | `getHistory`, `restoreSnapshot`, `getWaCache`, `nameVersion`, `forkVersion`, admin twin |
| `js/state.js` | ids: `menuMerge`, `menuVersions`, `versionOverlay`, `versionList` |
| `index.html` | `...` items + versions modal markup |
| env | `HISTORY_RETENTION_DAYS=30`, `HISTORY_EDIT_COALESCE_S=60`, `HISTORY_CHECKPOINT_EVERY=20`, `WA_CACHE_TTL_HOURS=0` |

**Efficiency wins over v1:** one snapshot engine replaces the separate code paths for 3 features; server-side snapshot avoids client writes & latency; no full-history payloads (metadata-only list; version data fetched only on restore/preview); global WA cache eliminates repeat FB eligibility checks across files/restores/deletes.

---

**[v2 changes relative to v1: §3 undo + §4 backup merged into one §A snapshot engine, single §C undo handles all action types, E confirm gates dangerous ops. Everything else carries over.]**

---

## Known pre-existing bugs fixed before this plan

- **(a) Permanent-delete prefix bug:** `server/index.js:403` and admin twin `:737` `del('rows:...')` without the `ss:` prefix — deletes nothing. Fixed (following §8) with `ss:hist:<id>` added.
- **(b) Undo/redo never read back from Redis:** stacks are written to `ss:undo`/`ss:redo` but `openFile` resets them to `[]` — a reload always kills undo. Fixed by the §C3 reload-load route.
- **(c) Undo/redo handlers don't persist:** an undo then close within the 300ms `persist()` debounce is lost. Fixed in §C3.
- **(d) No `beforeunload` flush:** the last debounced persist can be stranded on a sudden close. Fixed in §C3.
- **(e) `deleteSelectedCells` clears without undo** (`js/sheet.js:1166-1188`) — deletions are permanent. Fixed in §C2.
- **(f) IG master-password autofill floods duplicates and bricks `runCheck`:** pasting the IG master password re-triggers auto-check storms that duplicate rows and overload `runCheck`. Fixed as part of the §C2 auto-check rework.
- **(g) Home `crossDupCounts` fetched once per session and never invalidated:** duplicate badges go stale until reload. Fixed by re-fetching/invalidating on relevant mutations.
- **(h) Batch-delete deletes keys for arbitrary ids without validating archive membership** (`server/index.js:407-424`) — a security hole. Fixed by checking each id against the archive list before deleting keys.