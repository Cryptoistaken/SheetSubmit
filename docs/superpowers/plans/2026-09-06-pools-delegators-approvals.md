# Pools Delegators, Approvals, and Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pool administration source-user based, simplify recent downloads and approvals into detail dialogs, add durable prices and download deletion, and standardize dialogs and destructive actions.

**Architecture:** Keep the existing PoolsView as the orchestration surface, but move repeated overlay/action behavior into small shared UI components. Make the worker authoritative for prices and download deletion, while deriving delegators from `pool_rows.src_uid` so available and claimed rows remain visible. Use shadcn Radix Dialog for all new and converted overlays; use slide-to-confirm only for approval and hold-to-delete for destructive actions.

**Tech Stack:** React 19, TypeScript, Vite, shadcn/ui Radix Dialog, lucide-react, Hono, Durable Objects SQLite, bun.

## Global Constraints

- Use existing project dependencies and semantic CSS tokens; do not add a new UI library.
- Preserve authentication, admin checks, validation, error handling, and keyboard accessibility.
- Do not use browser MCP for verification.
- Worker route changes require `API_VERSION` bump, worker typecheck/tests, and a matching live API test for each new route.
- Do not build Android locally.
- Commit and push the completed code-change batch after verification.

---

### Task 1: Add Shared Dialog and Action Primitives

**Files:**
- Create: `Pages/src/components/ui/dialog.tsx`
- Create: `Pages/src/components/ui/hold-to-delete-button.tsx`
- Create: `Pages/src/components/ui/slide-to-confirm-button.tsx`
- Create: `Pages/src/components/ui/ink-stamp.tsx`
- Modify: `Pages/src/lib/confirm.tsx`

**Interfaces:**
- `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogFooter`, and `DialogClose` wrap the installed Radix Dialog primitive.
- `HoldToDeleteButton({ onConfirm, disabled?, label? })` calls `onConfirm` only after the user completes the hold gesture and supports keyboard activation.
- `SlideToConfirmButton({ onConfirm, disabled?, label? })` calls `onConfirm` after a keyboard-accessible slide/confirm interaction.
- `InkStamp({ label })` renders a non-interactive approved stamp.
- `ConfirmProvider` uses the shared Dialog instead of the legacy overlay.

- [ ] Add the shadcn Radix Dialog component using the project package runner, then review imports and accessibility titles.
- [ ] Implement the two small action controls with native button fallback behavior, visible focus, disabled state, and no external dependency.
- [ ] Implement the approved stamp as a semantic status badge with reduced-motion-safe styling.
- [ ] Convert the confirmation provider to the shared Dialog while preserving its promise queue.
- [ ] Run `bun run typecheck` in `Pages/`.

### Task 2: Make Delegators Complete and Picker Selectable

**Files:**
- Modify: `worker/src/routes/pools.ts:19-25, 183-185`
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Modify: `Pages/src/lib/api.ts` only if returned user fields need typing updates

**Interfaces:**
- `summarize(rows)` returns one `PoolUser` per non-empty `src_uid`, with available and claimed counts from all row states.
- Existing `GET /pools/:password/:pool` and `GET /pools/:password/:pool/user-files` remain the picker data sources.

- [ ] Replace claimed-by aggregation with source delegator aggregation, retaining users with only available rows.
- [ ] Rename visible `Contributors` copy to `Delegators` and update empty/help copy.
- [ ] Ensure pick mode renders the complete delegator list and that “All” selects both visible users and their available file IDs.
- [ ] Keep user/file counts visible even when a delegator has no remaining available rows.
- [ ] Fix selection state updates so removing a delegator removes only that delegator’s files without nested state updates.
- [ ] Run worker and Pages typechecks.

### Task 3: Add Durable Pool Prices and Set Price Dialog

**Files:**
- Modify: `worker/src/do/PoolDO.ts`
- Modify: `worker/src/routes/pools.ts`
- Modify: `worker/src/index.ts` (`API_VERSION`)
- Modify: `Pages/src/lib/api.ts`
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Modify: `scripts/TestApi.ts`

**Interfaces:**
- `GET /api/pools/:password/:pool/price` returns `{ poolId, password, price }`.
- `PUT /api/pools/:password/:pool/price` accepts `{ price: number }` and returns the same shape; it requires admin auth and validates finite `0 <= price <= 1000`.
- `PoolDO` stores one price per pool in a small SQLite settings table and uses it for new claim/hold totals and download metadata, falling back to existing defaults for old installations.

- [ ] Add the settings table and `priceGet`/`priceSet` DO operations with validation at the route boundary.
- [ ] Replace hardcoded price reads used for new claims/holds with the stored price while keeping legacy rows’ recorded prices intact.
- [ ] Add the two API client methods and bump `API_VERSION`.
- [ ] Add live API tests for get, set, invalid price, and unauthorized access following existing pool tests.
- [ ] Add a `Set price` button directly after the password filter toggle and a Dialog containing a labeled numeric price input and save/cancel actions.
- [ ] Display the active pool price near the pool controls without adding surface clutter.
- [ ] Run worker typecheck/tests and Pages typecheck.

### Task 4: Simplify Recent Downloads and Add Delete

**Files:**
- Modify: `worker/src/do/PoolDO.ts`
- Modify: `worker/src/routes/pools.ts`
- Modify: `worker/src/index.ts` (`API_VERSION`)
- Modify: `Pages/src/lib/api.ts`
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Modify: `Pages/src/components/home/DownloadDetailModal.tsx`
- Modify: `scripts/TestApi.ts`

**Interfaces:**
- `DELETE /api/pools/downloads/:id` requires admin auth, deletes only a download record that is already reverted/rejected, and returns `{ ok: true }`; active claimed/approved records return a validation error until reverted.
- `DownloadDetailModal` receives download metadata and action callbacks and owns the detail dialog content for source users, files, counts, download, revert, and delete.

- [ ] Add a validated `downloadDelete` DO operation and route; do not delete active records or return pool rows implicitly.
- [ ] Add the API client method and live API tests for active rejection, reverted deletion, missing ID, and success.
- [ ] Reduce Recent downloads surface cards to filename/pool, timestamp, quantity, and status only; remove all surface buttons.
- [ ] Open a shadcn Dialog on card click and show grouped users, each user’s files, counts, and Download/Revert/Delete actions inside it.
- [ ] Use `HoldToDeleteButton` for delete and the shared Dialog for any confirmation.
- [ ] Add an approved ink stamp when the detail is approved and all source-account groups are represented as taken.
- [ ] Refresh the list and close the dialog after successful deletion.
- [ ] Run worker tests/typecheck and Pages typecheck.

### Task 5: Convert Holds to Approvals Detail Dialog

**Files:**
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Create or modify: `Pages/src/components/home/ApprovalDetailDialog.tsx` only if extraction keeps PoolsView smaller

**Interfaces:**
- The section heading is `Approvals`.
- Surface approval cards contain summary metadata and status only.
- Clicking a card opens a Dialog with source users/files/counts, status, `SlideToConfirmButton` for pending approval, and `HoldToDeleteButton` for returning/deleting the entry.

- [ ] Remove Approve/Reject/Return buttons from approval surface cards.
- [ ] Use the shared Dialog for approval details and confirmations.
- [ ] Use slide-to-approve for pending records; on approval show an `APPROVED` stamp while keeping the dialog reopenable.
- [ ] Keep delete/return available from the open dialog and use hold-to-delete.
- [ ] Refresh approvals/downloads after each action and preserve loading/error feedback.
- [ ] Run Pages typecheck and unit tests.

### Task 6: Final Verification and Delivery

**Files:**
- Modify: `AGENTS.md` only if route/operation map changes are not already captured
- All files from Tasks 1-5

- [ ] Run `bun run typecheck` and `bun test` in `worker/`.
- [ ] Run `bun run typecheck`, `bun run test`, and `bun run build` in `Pages/`.
- [ ] Run `git diff --check`, inspect `git status`, and review the complete diff.
- [ ] Commit only task files with a concise message.
- [ ] Push the current upstream branch and report the commit/push result.

## Coverage Review

- Delegator rename and complete list: Task 2.
- Picker user visibility and select-all: Task 2.
- Recent download minimal surface, detail users/files/counts, actions, and delete: Task 4.
- Approval rename, detail popup, slide approval, approved stamp, and delete: Task 5.
- Set price button after password filters and popup: Task 3.
- Reusable dialogs and hold/slide actions: Task 1.
- No browser MCP verification: Global Constraints and Task 6.
