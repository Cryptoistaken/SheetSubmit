# Plan — pools take flow + wallet (for now)

Scope locked 2026-09-06. Mock (`pools-compare.html`) is reference only — build below on the live site.

## 1. Pick users + files to take from (live Pools page)
- Admin takes directly from pool → oldest rows first (FIFO, current behavior, keep).
- New mode toggle: **Pool FIFO** (default) / **Pick users**.
- Pick mode: checkbox on contributor cards, 1..N selectable, all/clear helpers.
- Expanding a user shows their pool files, each with its own **checkbox** —
  admin picks specific file(s), not the whole user share (backend already
  supports `srcFileId` filter; one hold entry per user+file, see §3).
- No user/file picked → block with "Pick at least 1 user".
- User card shows **file count** (e.g. "3 files").
- Each file row shows **available + taken counts** (e.g. "60 avail / 12 taken")
  plus a **View file** button → navigates to that user's file URL
  (`/admin/user/:userId/file/:fileId`), NOT a popup/modal.
- Keep per-card **Take** (single user, all its files) action.

## 2. Per-pool price per account
- Cookies **$0.02**, 2FA **$0.05**, Page **$0.10**.
- Price lives server-side (pool config + snapshot on each hold).
- **Do NOT show payout estimate on the page for now** — no estimate in stats,
  take button, or confirm modal. Payout stays visible only in approve action
  (admin sees what they approve) — nothing contributor-facing yet.

## 3. Hold → approve → balance (live, new)
- Every admin take creates a **HOLD** (rows leave `available`, marked taken).
- New **Holds & approvals** section: each hold shows pool, qty, source user(s).
- **Approve** → hold becomes APPROVED, contributor balances credited
  (qty × pool price, split per contributor by attributed rows).
- **Reject / Return** → rows go back to pool `available` (reuse revert path).
- Old instant-claim becomes hold-claim; existing `reverted` history untouched.
- Backend (minimal): `hold` + `price` on download record, `balance` on user
  record, `POST /pools/downloads/:id/approve` (admin), credit via IndexDO.
  Bump `API_VERSION`, add `TestApi.ts` tests (happy + 400/401/404).

## 4. Wallet page + withdrawals (live, new)
- Wallet tab exists but empty (`HomePage.tsx` wallet pane) — build it:
  - Shows own **balance** (from `/api/auth/me`).
  - **Withdraw button** → enter amount (≤ balance) → creates withdrawal request
    (status PENDING, amount reserved from balance).
  - **History**: PENDING / PAID / REJECTED list.
- Admin side (in/near Holds & approvals or Admin view):
  - Pending withdrawals list with **Mark paid** / **Reject** (reject refunds balance).
- Backend (minimal): withdrawals in IndexDO (`id, user_id, amount, status, ts`),
  `POST /api/wallet/withdraw`, `GET /api/wallet/mine`,
  admin `GET /api/wallet/requests` + `POST /api/wallet/:id/(pay|reject)`.
  Same `API_VERSION` bump + `TestApi.ts` tests as §3.

## Out of scope (later)
- Payout estimates on page, contributor-facing earnings breakdown.
- Payment rails (manual payout, admin marks paid + note).
- Instant-take option (all takes go through hold for now).
