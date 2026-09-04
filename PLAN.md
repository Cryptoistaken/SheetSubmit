# SheetSubmit Feature Plan

> Created: Sep 4, 2026
> Status: Ready for implementation

---

## Feature 1: Sidewise Scrollable Pages Navigation

### Current State
- Tabs live in `HomePage.tsx` lines 333-370 as `div.home-tabs` containing `button.home-tab` elements
- CSS in `app.css:548-578`: `.home-tabs { display:flex; gap:4px; flex-shrink:0; background:var(--bg3); border:1px solid var(--border); border-radius:8px; padding:3px; margin:8px 24px 0 }`
- `.home-tab` has `white-space:nowrap` but no overflow handling — tabs overflow off-screen on narrow viewports
- No existing horizontal scroll pattern in the codebase to reuse

### Implementation

**File: `Pages/src/app.css`**

1. Add to `.home-tabs`:
   ```css
   overflow-x: auto;
   scrollbar-width: none;        /* Firefox */
   -webkit-overflow-scrolling: touch;
   ```
2. Add new rule:
   ```css
   .home-tabs::-webkit-scrollbar { display: none; }  /* Chrome/Safari */
   ```

No JS changes needed. Tabs stay as flex, just become scrollable when they overflow.

### Files to Change
- `Pages/src/app.css` — add 3 lines to `.home-tabs`, add 1 rule for scrollbar

---

## Feature 2: Modify File Types — Remove Checks, Fix Page Logic

### Current State

**File type system** (`Pages/src/lib/types.ts:45-58`, `worker/src/lib/shared.ts:6`):
- Only one type: `FileType = "fb_cookie"` with columns: `cookies`, `twofakey`, `uid`
- File types are distinguished by **name prefix** in FileCard (`FileCard.tsx:99-105`): `cookie*` → Cookie icon, `2fa*` → KeyRound, `page*` → FileText
- Column presets (`types.ts`): `cookie: [cookies, uid]` (no 2FA), `combo: [cookies, twofakey, uid]`, `page: [...all three]`

**Page Check / WA Check** (`sheetStore.ts`, `SheetToolbar.tsx`):
- `ss_autoCheck` (localStorage, default `true`): auto-runs `runCheck()` (FB alive check) when cookie cell changes
- `ss_waCheck` (localStorage, default `false`, labeled "Page Check" in UI): after alive check passes, auto-calls `runWaChecks()` → `api.pageCheck(cookie)`
- Toggle UI in `SheetToolbar.tsx:251-275`: split button dropdown with "Auto-check" and "Page Check" toggles
- `runWaChecks()` (`sheetStore.ts:1592`): filters `status==="good" && wa_status!=="eligible" && cookies`, calls `api.pageCheck(cookie)` with concurrency 3

**2FA cell & dot copy** (`fbcookie.ts:56-61`, `sheetStore.ts:1402-1413`):
- Dot double-tap: if `row.twofakey` exists → generates TOTP via `getCachedTOTP()` → copies to clipboard
- Also auto-copies on `commitCell` if `colKey==="twofakey"` on mobile (`sheetStore.ts:667-676`)
- Dot long-press: shows log popup with WA status, cross-file duplicates

### Changes Needed

**2a. Cookies file — remove page check, WA check, 2FA cell, 2FA copy:**
- When creating a file with `cookie` preset (no `twofakey` column), page/WA checks already can't run (no 2FA key → not classified as page pool)
- The `ss_waCheck` toggle should be hidden when the current file has no `twofakey` column
- In `SheetToolbar.tsx:349`: the WA Check menu item is already gated on `file?.type==="fb_cookie"` — also gate on `file?.columns?.some(c => c.key === "twofakey")`
- For dot double-tap: `fbcookie.ts:56` already checks `if (row.twofakey)` — if no 2FA column, this is moot
- For `commitCell` auto-copy: `sheetStore.ts:667` checks `colKey==="twofakey"` — if no 2FA column, this never triggers

**2b. 2FA file — remove page check, WA check:**
- Same gating: hide WA Check toggle when file is 2FA-only (no page logic)
- Actually: if the 2FA file has `twofakey` column but user doesn't want page checks, the `ss_waCheck` toggle already controls this. The user wants it **removed from the UI entirely** for 2FA files
- Gate the `ss_waCheck` toggle AND the WA Check menu item on: the file name starts with "page" (or has a new `poolEnabled` + page-specific flag)

**2c. Page file — don't check page until 2FA is provided:**
- Current: `runWaChecks()` filters `status==="good" && wa_status!=="eligible" && cookies && /c_user=\d+/` — it checks any alive row with cookie, regardless of 2FA
- Fix: add filter condition `&& row.twofakey && row.twofakey !== "No_2Fa"` to `runWaChecks()` and `runWaChecksFiltered()` and `runWaChecksWaFiltered()`
- This means: page check only runs on rows that have both a valid cookie AND a 2FA key

### Files to Change
- `Pages/src/components/sheet/SheetToolbar.tsx` — gate WA Check toggle on file having twofakey column + page-pool file
- `Pages/src/stores/sheetStore.ts` — add twofakey filter to `runWaChecks()`, `runWaChecksFiltered()`, `runWaChecksWaFiltered()`
- `Pages/src/features/filetypes/fbcookie.ts` — no changes needed (already guards)

---

## Feature 3: Modify File Icons — Theme-Aware, No Blue Shadow

### Current State

**Icon selection** (`FileCard.tsx:99-105`):
```ts
const FileIcon = file.name.toLowerCase().startsWith("cookie") ? Cookie
               : file.name.toLowerCase().startsWith("2fa")    ? KeyRound
               : file.name.toLowerCase().startsWith("page")   ? FileText
               : Cookie;
```
All from `lucide-react`.

**Icon container** (`app.css:665`): `.file-card-icon { width:32px; height:32px; background:var(--bg3); border-radius:var(--r); display:flex; align-items:center; justify-content:center }`
- No hardcoded colors — uses `var(--bg3)` which respects dark mode
- The icon itself (`<FileIcon size={16}/>`) inherits `color` from parent

**Badge colors** (`app.css:743`): `.file-type-badge.t-fb { color:var(--fb); background:var(--fb-bg) }` — `--fb:#6366f1` (indigo), `--fb-bg:#eef2ff`

**FAB icons** (`app.css:886`): `.home-fab-ic.t-fb` same indigo colors

### New Icons (all black/white, theme-aware)

**Cookie file** — keep existing `Cookie` from lucide-react, just remove any color:
- Icon: `Cookie` from `lucide-react` (existing)
- Color: `var(--text)` (black in light, white in dark) — no hardcoded colors
- Remove: blue shadow from `.file-card-icon`

**2FA file** — custom SVG shield/authenticator icon:
```tsx
const TwoFaIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 -11 960 876" width={size} height={size} {...props}>
    <path d="M960 427c0 44.7-36.2 80.9-80.9 80.9H600L480 265.2 609.5 40.9C631.9 2.2 681.3-11 720 11.3c38.7 22.4 51.9 71.8 29.6 110.5L620.1 346.1h259c44.7 0 80.9 36.2 80.9 80.9z" fill="currentColor"/>
    <path d="M720 842.7c-38.7 22.3-88.1 9.1-110.5-29.6L480 588.8 350.5 813.1c-22.4 38.7-71.8 51.9-110.5 29.6-38.7-22.4-51.9-71.8-29.6-110.5l129.5-224.3 140.1-5.3 140.1 5.3 129.5 224.3c22.3 38.7 9.1 88.1-29.6 110.5z" fill="currentColor"/>
    <path d="M480 265.2l-36.5 99.2-103.6-18.3-129.5-224.3c-22.3-38.7-9.1-88.1 29.6-110.5 38.7-22.3 88.1-9.1 110.5 29.6z" fill="currentColor"/>
    <path d="M459.1 346.1l-93.9 161.8H80.9C36.2 507.9 0 471.7 0 427s36.2-80.9 80.9-80.9z" fill="currentColor"/>
    <path d="M620.1 507.9H339.9L480 265.2z" fill="currentColor"/>
  </svg>
);
```
- Uses `fill="currentColor"` — inherits `var(--text)` from parent → black in light, white in dark

**Page file** — custom SVG flag-checkered icon:
```tsx
const PageIcon = ({ size = 16, ...props }: { size?: number } & React.SVGProps<SVGSVGElement>) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={size} height={size} {...props}>
    <path fill="currentColor" d="M14.4 6H20v10h-7l-.4-2H7v7H5V4h9zm-.4 8h2v-2h2v-2h-2V8h-2v2l-1-2V6h-2v2H9V6H7v2h2v2H7v2h2v-2h2v2h2v-2l1 2zm-3-4V8h2v2zm3 0h2v2h-2z"/>
  </svg>
);
```
- Uses `fill="currentColor"` — same theme-aware behavior

### Changes Needed

1. **FileCard.tsx** — replace icon imports:
   - Remove `KeyRound`, `FileText` from lucide imports
   - Add `TwoFaIcon`, `PageIcon` as local SVG components (or in a shared `icons.tsx`)
   - Update icon selection:
     ```ts
     const FileIcon = file.name.toLowerCase().startsWith("cookie") ? Cookie
                    : file.name.toLowerCase().startsWith("2fa")    ? TwoFaIcon
                    : file.name.toLowerCase().startsWith("page")   ? PageIcon
                    : Cookie;
     ```
   - Add `color: var(--text)` to `.file-card-icon` or inline on icon wrapper

2. **app.css** — remove blue shadow:
   - Find and remove any `box-shadow` on `.file-card-icon` or file icon elements
   - Remove `.t-fb` indigo colors from `.file-type-badge` and `.home-fab-ic`
   - Replace badge colors: 2FA → `var(--bg3)/var(--text2)` (neutral), page → `var(--green-bg)/var(--green)` (green association)

3. **FAB icons** (`Fab.tsx`, `HomePage.tsx`) — same icon swap if used there

### Files to Change
- `Pages/src/components/home/FileCard.tsx` — icon selection + new SVG components
- `Pages/src/app.css` — remove shadows, update badge colors
- `Pages/src/components/home/Fab.tsx` — update FAB icon if needed

---

## Feature 4: Pool Page Modifications

### 4.1 — Select User When Taking Files

**Current State:**
- `POST /:password/:pool/claim` (`pools.ts:66-75`) accepts `{count, userId?}` but **backend ignores userId** — always claims FIFO from `available`
- `PoolDO.ts claim` op: `SELECT row_key,data FROM pool_rows WHERE pool_id=? AND state='available' LIMIT ?` — no user filter
- Frontend `doUserClaim` (`PoolsView.tsx:155`) passes `userId` but it's dead code

**Implementation:**

**Worker — `PoolDO.ts` `claim` op:**
- Add `args.claimForUser` (the source user to take from)
- If `args.claimForUser` is set: `SELECT row_key,data FROM pool_rows WHERE pool_id=? AND state='available' AND src_uid=? LIMIT ?`
- If not set: current FIFO behavior

**Worker — `routes/pools.ts`:**
- Route `POST /:password/:pool/claim` body: `{count, claimForUser?: string}`
- Pass `claimForUser` to RPC

**Frontend — `PoolsView.tsx`:**
- In the pool toolbar, add a user selector dropdown before the Download button
- Dropdown populated from `detail.users` (the user list)
- When a user is selected, `doPoolClaim` passes `{count, claimForUser: selectedUserId}`
- When "All users" is selected, no filter (FIFO)

### 4.2 — Desktop Download Card Layout

**Current State:**
- Download cards: `.pool-card` with badge, filename, meta (date · claimed · reverted), action buttons
- Desktop: all in one row. Mobile: wraps

**Implementation:**
- Restructure to a cleaner desktop layout:
  - Left: pool badge + filename (truncated with ellipsis)
  - Center: date + claimed count on one line
  - Right: Download + Give back buttons
- Add `min-width` constraints so on desktop (>768px) the card reads as a single clean line
- Use CSS grid or flex with fixed-width sections

### 4.3 — Page Pool: Show Unverified Pages Count

**Current State:**
- `page` pool: `classifyRow()` (`PoolDO.ts:5`) only admits `wa_status==="eligible" && twofakey`
- So `page` pool is **verified-only** by design
- Unverified pages (has cookie + 2FA + alive but not checked) sit in `cookies_2fa` pool

**The user wants:** within the page pool, show a count of "unverified" pages — accounts that:
- Are in the page file (have cookie + 2FA)
- Are alive (status good)
- Have `wa_status !== "eligible"` (dot not green yet)

**Implementation:**

**Backend — `PoolDO.ts`:**
- Add new op `pagePoolStats`:
  ```sql
  SELECT
    COUNT(*) FILTER (WHERE wa_status = 'eligible') as verified,
    COUNT(*) FILTER (WHERE wa_status != 'eligible' OR wa_status IS NULL) as unverified
  FROM pool_rows
  WHERE pool_id = 'page'
  ```
  Actually, the row `data` JSON contains `wa_status`. We'd need to parse JSON per row — expensive.
  
  **Better approach:** Add `wa_status` as a real column on `pool_rows` (like `src_uid`), populated on `add` and updated when WA check results come in. Then the query is trivial.

  **Simplest approach:** Since `page` pool only contains verified rows by design (`classifyRow`), the "unverified" pages are actually in `cookies_2fa`. Show BOTH counts on the page pool tab:
  - "Verified pages" = count in `page` pool
  - "Unverified pages" = count in `cookies_2fa` where rows have `twofakey` + alive + `wa_status !== "eligible"`

**Frontend:**
- Add a 4th stat card (or modify existing) on the page pool tab showing "Unverified pages" count
- This requires a new backend op or filtering `cookies_2fa` rows

### 4.4 — Bulk Page Check from Pool

**Current State:**
- WA check happens inside individual file sheets (`WaCheckOverlay.tsx`) — not from the pool page
- `WaCheckOverlay` calls `runWaChecksWaFiltered(filter)` which calls `api.waCheck(cookie)` per row with concurrency 3
- Results are persisted to the file's rows via `changeJournal` + `persist()`

**The user wants:** from the pool page, admin can:
- Check ALL unverified page accounts in the pool
- Check per user (all files of a user)
- Check a specific file of a user
- Choose 1 method: WA API or Page API
- After check: if eligible, **mark it persistently** as page

**Implementation:**

**Backend — new endpoint or extend existing:**
- `POST /api/pools/:password/:pool/check-pages` body: `{method: "page"|"wa", userId?: string, fileId?: string}`
- The endpoint would:
  1. Get rows from pool (or filter by userId/fileId)
  2. Filter to unverified candidates (has cookie + 2FA + alive + not yet eligible)
  3. For each row, call `api.pageCheck(cookie)` or `api.waCheck(cookie)` (server-side)
  4. If eligible: update the row's `wa_status` in the pool AND in the source file (via `FILES` DO)
  5. Return counts: `{checked, eligible, failed}`

  **Problem:** This requires the worker to make outbound HTTP calls to FB check APIs, which it already does via `/fb/page-check` and `/fb/wa-check`. But those routes are per-request auth'd. The pool check would need to call them internally.

  **Simpler approach:** Keep the check logic in the frontend (like `WaCheckOverlay`), but:
  1. Fetch pool rows via `GET /:password/:pool/rows` (already exists)
  2. Filter to candidates client-side
  3. Run checks via existing `api.pageCheck()` / `api.waCheck()` (concurrency 3)
  4. On success: update the row in the source file via `api.persist(fileId, {rows})` or `api.append()`
  5. Also update the pool row data (new endpoint or re-add to pool)

  **Problem with frontend approach:** Pool rows are in `PoolDO`, not in `FileDO`. To update `wa_status` in the pool, we'd need a new PoolDO op.

**Recommended implementation:**

**Worker — `PoolDO.ts`:**
- New op `updateRowWaStatus`: given `pool_id`, `row_key`, `wa_status`, `wa_page_name`, `wa_ban_reason`, `wa_linked_number` → update the row's `data` JSON with new WA fields
- New op `bulkUpdateWaStatus`: given `pool_id`, array of `{row_key, wa_status, ...}` → batch update

**Worker — `routes/pools.ts`:**
- New endpoint: `POST /:password/:pool/check-pages` body: `{method: "page"|"wa", rows: [{rowKey, cookie}]}`
- Internally: iterate rows, call pageCheck/waCheck (reuse logic from `wa.ts`), collect results, call `bulkUpdateWaStatus`
- Return `{checked, eligible, ineligible, errors}`

**Frontend — `PoolsView.tsx`:**
- New button in page pool tab: "Check Unverified Pages"
- Opens a modal with options:
  - Scope: All / Per User (dropdown) / Specific File (dropdown)
  - Method: Page API / WA API
  - Start button
- Progress indicator (like `WaCheckOverlay`)
- On completion: show counts, refresh pool data

### 4.5 — Page Pool Download Options

**Current State:**
- Download from page pool gives all claimed rows or available rows
- No filtering by verified/unverified

**Implementation:**

**Worker — `PoolDO.ts`:**
- Modify `claim` op to accept filter params: `{verifiedOnly?: boolean, unverifiedOnly?: boolean}`
- Filter: parse row data JSON, check `wa_status === "eligible"` (verified) or `!== "eligible"` (unverified)
- If `verifiedOnly`: only claim rows where `wa_status === "eligible"`
- If `unverifiedOnly`: only claim rows where `wa_status !== "eligible"` or null

**Worker — `routes/pools.ts`:**
- Pass filter params from claim body to RPC

**Frontend — `PoolsView.tsx`:**
- When downloading from page pool, show extra options in the download modal:
  - "All accounts" (current behavior)
  - "Verified pages only" (green dot)
  - "Unverified pages only" (not yet checked or not eligible)
- These options only appear when `cur === "page"`

---

## Feature 5: Recent Downloads — User Breakdown & Download Options

### Current State

**Download data** (`PoolDO.ts downloads` table):
- `id`, `pool_id`, `claimed_by` (single user who claimed), `claimed` (count), `filename`, `keys` (JSON row_keys), `rows` (JSON full row data), `reverted`, `ts`
- Each download = one claim event by one user

**Frontend display** (`PoolsView.tsx:387-410`):
- Cards show: pool badge, filename, date, claimed count, reverted status
- Download + Give back buttons
- No user profile info shown

**User profiles** available via:
- `GET /admin/users` → `[{id, name, username, photoUrl, ...}]`
- `GET /admin/user/:id` → single user with files

**Row data per download:**
- `rows` JSON contains full `Row` objects with: `cookies`, `uid`, `twofakey`, `wa_status`, `status`, `src_uid`, `src_file_id`

### 5.1 — Stacked Profile Pics on Download Cards

**Implementation:**

**Frontend — `PoolsView.tsx`:**
- Fetch user profiles on load: `api.adminUsers()` (already available)
- For each download, `d.claimedBy` is a single user. But the user wants to see ALL users who claimed from that filename (multiple downloads can share a filename pattern)
- **Option A:** Group downloads by filename, show all claimers' avatars
- **Option B:** Each download card shows the single claimer's avatar (simpler, matches data model)

I think **Option B** is correct — each download is one user's claim. Show that user's avatar + name.

- Add user profile lookup: `Map<userId, {name, username, photoUrl}>` from `adminUsers`
- In download card, replace/augment the badge area with avatar stack
- For single user: show avatar (36px circle)
- Avatar uses `photoUrl` from admin users API (Telegram profile pic)

**CSS:**
```css
.dl-avatar { width:36px; height:36px; border-radius:50%; border:1.5px solid var(--border); object-fit:cover; flex-shrink:0 }
.dl-avatar-placeholder { /* same but bg:var(--bg3), center letter */ }
```

### 5.2 — Download Detail Modal

**When clicking a download card, open a modal showing:**

```
┌─────────────────────────────────────────────────┐
│ cookies_dgddigital_2026-09-03_60g2.xlsx     [X] │
│ Sep 3, 2026 · 7 claimed · cookies_only          │
├─────────────────────────────────────────────────┤
│                                                  │
│  [avatar] User #abc123                          │
│    Source: #file45678901                         │
│    In file: 50 accounts · 7 taken               │
│    [View file]  [Download ▾]                    │
│                                                  │
│  [avatar] User #def456                          │
│    Source: #file78901234                         │
│    In file: 30 accounts · 5 taken               │
│    [View file]  [Download ▾]                    │
│                                                  │
├─────────────────────────────────────────────────┤
│ [Close]                                          │
└─────────────────────────────────────────────────┘
```

**Implementation:**

**Backend — new endpoint:**
- `GET /pools/downloads/:id/detail` → returns download with enriched user data
- Response:
  ```json
  {
    "id": "...",
    "filename": "...",
    "poolId": "...",
    "claimed": 7,
    "reverted": false,
    "ts": 1234567890,
    "users": [
      {
        "userId": "abc123",
        "name": "...",
        "username": "...",
        "photoUrl": "...",
        "taken": 7,
        "sourceFileId": "file45678901",
        "totalInFile": 50,
        "takenInFile": 7
      }
    ],
    "rows": [...]  // full row data for download
  }
  ```

  **But wait** — a single download has ONE `claimed_by` user. The "users" list would be just one entry. Unless we group multiple downloads by filename.

  **Re-think:** The user wants to see all users who contributed rows to the same source file, not just the one user who claimed this specific download. This requires cross-referencing:
  - Source files → users who own them
  - Pool rows → which source file they came from
  - Downloads → which rows were claimed

  **Better approach:**
  - `GET /pools/downloads/:id/detail` returns the download's rows
  - Group rows by `src_file_id` (from row data or `src_file_id` column)
  - For each source file group: find the file owner (via `src_uid` or `INDEX` DO)
  - Show: file owner profile, source file ID, total rows in file, rows taken in this download

**Frontend — new modal component `DownloadDetailModal.tsx`:**
- Props: `{downloadId, onClose}`
- Fetches `api.getDownloadDetail(downloadId)`
- Shows filename, date, pool, reverted status at top
- Lists source file groups with user avatar, file link, taken/total counts
- Download button per group opens sub-options

### 5.3 — Per-User Download Options

**When clicking Download in the detail modal, show options:**

```
Download options
○ Full file (all rows from source)
○ Taken only (7 rows claimed)
○ Untaken only (43 rows remaining)
[Download]
```

**Implementation:**

**Frontend — download sub-modal:**
- On "Download" click for a user/file group:
  - Fetch full source file rows: `api.getFileFull(sourceFileId)` → `{file, rows}`
  - Also have the claimed rows from the download detail
  - Filter:
    - "Full file" → all rows from source file
    - "Taken" → rows that appear in this download's `keys` array
    - "Untaken" → rows NOT in this download's `keys` array
  - Generate XLSX with appropriate columns (from `META[poolId].cols`)
  - Trigger download

### 5.4 — Page Pool: Verified/Unverified Download Options

**Additional options for page pool downloads:**

```
Download options
○ Full file
○ Taken only
○ Untaken only
─── Page filter ───
○ All pages
○ Verified pages only (green dot)
○ Unverified pages only
[Download]
```

**Implementation:**
- Same as 5.3 but with additional filter on `wa_status`
- When `poolId === "page"`:
  - "Verified" → rows where `wa_status === "eligible"`
  - "Unverified" → rows where `wa_status !== "eligible"` or null
- Apply page filter BEFORE taken/untaken filter
- Generate XLSX accordingly

### Files to Change (Feature 5)

**Worker:**
- `worker/src/routes/pools.ts` — new `GET /downloads/:id/detail` endpoint
- `worker/src/do/PoolDO.ts` — new `downloadDetail` op

**Frontend:**
- `Pages/src/lib/api.ts` — add `PoolDownloadDetail` type + `getDownloadDetail()` function
- `Pages/src/components/home/PoolsView.tsx` — add avatar to download cards, add detail modal trigger
- `Pages/src/components/home/DownloadDetailModal.tsx` — **new file**, detail modal with per-user breakdown + download options
- `Pages/src/app.css` — styles for modal, avatar, option list

---

## Implementation Order

1. **Feature 1** (scrollable tabs) — 5 min, pure CSS, no dependencies
2. **Feature 3** (file icons) — 15 min, CSS + small component changes
3. **Feature 2** (file type logic) — 30 min, store + toolbar changes
4. **Feature 4.1** (select user for claim) — 20 min, backend + frontend
5. **Feature 4.2** (desktop download layout) — 15 min, CSS
6. **Feature 4.3** (unverified pages count) — 30 min, backend op + frontend stat
7. **Feature 4.4** (bulk page check from pool) — 60 min, new endpoint + modal + progress
8. **Feature 4.5** (page pool download filter) — 20 min, backend filter + frontend options
9. **Feature 5.1-5.4** (download detail + options) — 90 min, new endpoint + modal + download logic

**Total estimated time: ~4.5 hours**

---

## Key Files Reference

| File | Purpose |
|------|---------|
| `Pages/src/pages/HomePage.tsx` | Tab navigation (lines 333-370) |
| `Pages/src/app.css` | All CSS (`.home-tabs:548`, `.file-card:628`, `.pool-switch:1096`) |
| `Pages/src/components/home/FileCard.tsx` | File card icons (lines 99-105) |
| `Pages/src/components/home/PoolsView.tsx` | Pool page UI |
| `Pages/src/stores/sheetStore.ts` | WA check logic (`runWaChecks:1592`, `runWaChecksWaFiltered:1874`) |
| `Pages/src/components/sheet/SheetToolbar.tsx` | Check toggles (lines 251-275), WA menu item (349) |
| `Pages/src/components/sheet/WaCheckOverlay.tsx` | WA check overlay (existing batch UI pattern) |
| `Pages/src/lib/api.ts` | All API functions |
| `Pages/src/lib/types.ts` | `FILE_TYPE_DEFS`, `FileType`, `ColumnDef` |
| `worker/src/do/PoolDO.ts` | Pool DO (claim, downloads, userFiles ops) |
| `worker/src/routes/pools.ts` | Pool routes (all endpoints) |
| `worker/src/routes/wa.ts` | Page/WA check endpoints |
| `worker/src/lib/shared.ts` | `Env`, `Row`, `SheetFile` types |
