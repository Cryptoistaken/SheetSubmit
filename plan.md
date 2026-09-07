# Pool Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current pool screen into one pool workspace with three clear surfaces: Pool, Users/Files, and Approvals, while removing Recent Downloads from the pool experience.

**Architecture:** Keep the existing password and pool navigator as the shared context. Use three tabs inside that context instead of three disconnected pages, with URL state for the active tab and selected user/file where useful. Reuse the current pool, user, file, dialog, avatar, slide, and download primitives; extend the API only where the current response cannot support the requested detail.

**Tech Stack:** React 19, TypeScript, React Router, Vite, Tailwind v4, shadcn/ui, Hono/Bun, Postgres, existing `ProfileAvatar`, `FileCard`, `Dialog`, `SlideToConfirmButton`, and `HoldToDeleteButton`.

## Global Constraints

- Preserve the existing password navigator, pool navigator, price control, FIFO mode, and Pick users mode.
- Remove the Recent Downloads section and its pool-page data fetch; do not remove sheet-level file downloads.
- Use semantic project tokens, existing shadcn components, and existing avatar/file-card patterns.
- Every file-opening action from a pool requires confirmation with the file name.
- Approval/rejection must remain one backend transaction: approve credits users; reject releases held rows.
- Do not expose an approval as downloadable until it is approved.
- Do not build Android locally; verify web/backend with the existing Bun commands.
- Bump `API_VERSION` for any backend route or response change.

## Proposed Information Architecture

The URL remains `/pools/:password/:poolId`, with a query or nested state for `view=pool|users|approvals`. The three views are:

1. **Pool**: context controls, renamed inventory cards, FIFO/Pick mode, and one combined Taker card.
2. **Users / Files**: one navigator with `Users` first and `Files` second. A user expands inline to show that user's files; selecting a user opens a detail dialog.
3. **Approvals**: pending, rejected, and approved entries. Recent Downloads is not a fourth view and is not rendered anywhere on this page.

This is preferable to three separate route pages because a file opened from the pool can return to the same pool, tab, selection mode, search, and expanded user state. A route should only be added later if the page becomes independently shareable or has materially different authorization.

## Naming Proposal

- `Available` -> **Ready to take**
- `Claimed` -> **Taken**
- `Delegators` -> **Owners**

These names describe the action and provenance. If “Delegators” is a domain term users already understand, keep it as a small explanatory caption under **Owners** rather than using it as the primary heading.

## Money and State Corrections

- The Taker card should create a **hold**, not call the immediate `claim` path. Payment is only safe after approval.
- The amount shown before taking should be `selected row count x stored unit price`, with the exact count and price visible. “Amount” must not be an editable arbitrary payout.
- Pick mode must select rows by source user, source file, or both. The current API supports `srcUids[]` and `srcFileIds[]`; the UI must show which constraint is active.
- Approve credits each source user from the hold's stored `unit_price`. Reject returns every held row to `available` and clears taken markers. Both actions need idempotent server handling.
- A rejected entry should remain visible under **Rejected** for audit/history, but it must not show an active download action.
- Do not use a live current price when displaying or approving an old hold. The stored hold price is the source of truth.
- A per-user download containing only that user's share needs a server-side filtered export. The current download endpoint returns the whole stored download, so this is an API requirement, not only a modal change.

## Scope Decisions

### In scope

- Pool, Users/Files, and Approvals tabs.
- Renamed inventory cards and combined Taker card.
- User cards with avatar, name, files count, account count, and taken count.
- User detail dialog with taken file names and basic totals.
- File list using the existing file icon/title/date and the saved grid/list preference.
- Confirmation before opening a file, with return to the preserved pool state.
- Approval list with user avatars, file icon, title, creation time, amount, and download action.
- Approval detail with counts, per-user share/payment data, approve/reject sliders, and per-user filtered download.

### Not in scope for the first slice

- Replacing the existing database model with a new approval model.
- Rebuilding the shared `FileCard`, avatar, or slider components.
- A separate Recent Downloads history feature.
- Arbitrary manual amount editing.
- Automatic payout withdrawal; approval only credits the existing wallet balance.

## Files and Responsibilities

- Modify `Pages/src/components/home/PoolsView.tsx`: shared pool context, three-view navigation, Pool view, Taker card, Users/Files view, and removal of recent downloads.
- Modify `Pages/src/components/home/ApprovalDetailDialog.tsx`: approval detail layout, per-user accounting, filtered-download action, and approve/reject state handling.
- Modify `Pages/src/components/home/DownloadDetailModal.tsx`: only if its remaining call sites need a common detail presentation; otherwise leave it unused by the pool page and delete only after search confirms no consumers.
- Modify `Pages/src/lib/api.ts`: typed approval/user/file detail wrappers and filtered per-user export request, only if existing endpoints are insufficient.
- Modify `backend/src/routes/pools.ts`: approval detail/export routes only if the existing payload cannot safely supply the UI.
- Modify `backend/src/lib/pg.ts`: transactional approval/rejection fixes and filtered export query only when required by the API contract.
- Modify `backend/src/index.ts`: bump `API_VERSION` for backend route/response changes.
- Modify `Pages/src/components/ui/page-skeleton.tsx`: mirror the final three-view loading shape.
- Add or update focused tests under `Pages/src/**/__tests__` and backend tests for hold approval/rejection money and row state.

## Implementation Tasks

### Task 1: Lock the data contract and state machine

**Files:**
- Modify: `Pages/src/lib/api.ts`
- Modify: `backend/src/routes/pools.ts` only where the current response is insufficient
- Modify: `backend/src/lib/pg.ts` only for transactional correctness gaps
- Modify: `backend/src/index.ts` if routes/responses change
- Test: existing backend pool tests or a focused new test near the existing pool tests

- [ ] Document and test the states `HOLD -> APPROVED` and `HOLD -> REJECTED`.
- [ ] Ensure approval credits the stored hold price and rejection clears `held`, `hold_id`, `claimed_by`, and `claimed_at`.
- [ ] Define an export request that accepts `downloadId` plus one `srcUid` or equivalent server-validated user share selection.
- [ ] Return enough typed data for user totals, file names, account counts, taken counts, percentage share, and payment.
- [ ] Reject invalid or mixed-owner export requests instead of silently returning the full download.
- [ ] Run the focused backend test and `bun run typecheck` in `backend/`.

### Task 2: Add the three-view shell and remove Recent Downloads

**Files:**
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Modify: `Pages/src/App.tsx` only if URL tab state needs a route change
- Modify: `Pages/src/components/ui/page-skeleton.tsx`

- [ ] Keep password, pool, and price controls at the top of every view.
- [ ] Add accessible tab navigation with Pool first, Users / Files second, Approvals third.
- [ ] Remove `getDownloads()` from pool loading and remove the Recent Downloads section/modal path from this screen.
- [ ] Preserve loading, empty, error, narrow-width, and keyboard states.
- [ ] Keep the active view in the URL so browser Back returns to the same pool context.

### Task 3: Build the Pool view and Taker card

**Files:**
- Modify: `Pages/src/components/home/PoolsView.tsx`

- [ ] Rename the three inventory cards to Ready to take, Taken, and Owners with explicit numeric labels.
- [ ] Keep Pool FIFO and Pick users unchanged in meaning.
- [ ] Replace scattered take controls with one Taker card containing pool, selection mode, quantity/amount summary, and Take button.
- [ ] In Pick mode, provide searchable single/multiple user selection and file selection without allowing ambiguous mixed selection.
- [ ] Show count, unit price, and total amount before confirmation.
- [ ] Use the existing confirmation dialog before creating a hold.
- [ ] Keep the existing verified/unverified filter for Page pools.

### Task 4: Build Users / Files navigation

**Files:**
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Reuse: `Pages/src/components/home/FileCard.tsx`, `Pages/src/components/profile/ProfileAvatar.tsx`, `Pages/src/components/ui/search-input.tsx`

- [ ] Put Users before Files in the navigator.
- [ ] Render user cards with avatar, name, files count, account count, and taken count.
- [ ] Expand a user inline to show their files; do not require a separate page for the first interaction.
- [ ] Open a user detail dialog with taken file names, account totals, taken totals, payment, and share percentage.
- [ ] Render Files with existing file icon/title/date patterns and honor `ss_fileView` grid/list preference.
- [ ] In non-pick mode, clicking a file opens a confirmation dialog naming the file; confirming navigates to its file URL with pool state encoded for return.
- [ ] In pick mode, clicking a file selects it and never navigates.

### Task 5: Build the Approvals view and detail flow

**Files:**
- Modify: `Pages/src/components/home/PoolsView.tsx`
- Modify: `Pages/src/components/home/ApprovalDetailDialog.tsx`
- Modify: `Pages/src/lib/api.ts` only for the agreed detail/export contract

- [ ] Add Pending, Rejected, and Approved filters or tabs; default to Pending.
- [ ] Render each approval as a list card with user avatar group, file icon, file title, creation time, amount, status, and download action where valid.
- [ ] Open a detail dialog showing account count, source users, file name, total taken, total payment, and share percentages.
- [ ] Make each user row expandable/selectable to show that user's account count, source file, taken count, payment, percentage, and filtered download.
- [ ] Keep slide to approve and slide to reject controls distinct and keyboard-operable.
- [ ] Disable actions while a request is active and refresh the list after success.

### Task 6: Verify the complete flow

**Files:**
- Test: focused frontend tests for selection/amount/view state
- Test: backend tests for approve/reject/export behavior

- [ ] Verify FIFO take, single-user pick, multi-user pick, file-specific pick, and empty selection.
- [ ] Verify file confirmation, return-to-pool state, and Back behavior.
- [ ] Verify approval credits the correct users exactly once.
- [ ] Verify rejection returns rows and creates no wallet credit.
- [ ] Verify per-user export cannot download another user's rows.
- [ ] Verify mobile layout at 320px and keyboard navigation through tabs, dialogs, pick controls, and sliders.
- [ ] Run `bun run test` and `bun run typecheck` from the appropriate `Pages/` and `backend/` directories.

## Decisions Needed Before Implementation

1. **Primary labels:** approve `Ready to take / Taken / Owners`, or keep `Available / Claimed / Delegators` with explanatory subtitles?
2. **Approval list default:** show only Pending initially, or show all statuses in one list with a status filter?
3. **Amount display:** use account count x unit price only, or show a second breakdown by user and file in the collapsed card?
4. **Multiple pick semantics:** should selecting multiple users mean all available rows from those users, or should a quantity cap still apply across them?
5. **File navigation:** should the file open in the normal user sheet route or the admin user/file route? The safer default is the admin route because pool operators are admins.
6. **Rejected history:** retain rejected records indefinitely in the Approvals view, or apply a date/status retention limit?
7. **Per-user download:** should it download only the selected user's rows from the approved entry, or also include only that user's original file grouping and metadata?

## Self-Review

- Spec coverage: pool controls, renamed stats, FIFO/pick, combined taker, users/files navigator, file confirmation, approvals, avatars, file metadata, detail accounting, filtered download, approve/reject state changes, and Recent Downloads removal are covered above.
- Intentional correction: immediate `claim` is not used for payable taker actions because it bypasses wallet credit.
- Intentional simplification: no new route hierarchy or state store until URL state proves insufficient.
- Residual risk: current backend has known wallet-blind ledger revert and negative-balance-on-approved-revert paths; these should be fixed or explicitly excluded before approval actions are exposed in the redesigned UI.
