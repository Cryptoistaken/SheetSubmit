# Pools — take rules (After mock)

## Pools & prices
- Cookies: **$0.02** / account
- 2FA: **$0.05** / account
- Page: **$0.10** / account
- Estimate = qty × unit price, shown on stats + take button + confirm modal.

## Take modes (admin)
1. **Pool FIFO (default)** — takes oldest rows first across all contributors.
2. **Pick users** — checkbox on 1..N user cards. Take splits qty across picked
   users only. No pick = block with "Pick at least 1 user".
3. Per-user **Take** button = take from that user only.

## Hold → approve → balance
1. Confirm hold → rows leave `available`, entry appears as **HOLD**.
2. **Approve $X** → entry becomes **APPROVED**, `+$X` credited to contributors,
   source users/files get **TAKEN** mark.
3. **Reject** → entry removed, qty returned to pool `available`.

## Taken marking
- Claimed user's card + file rows show red `TAKEN` tag after approve.
- `avail / claimed` counters update on hold; balance only on approve.

## Mirrors real app
- `PoolsView.tsx:16 PASSWORDS, :17-21 POOL_TABS, :331-346 switches,`
  `:351-373 stats, :376-441 toolbar, :444-508 cards, :512-568 downloads.`
- Real: add `PRICE={cookies_only:0.02, cookies_2fa:0.05, page:0.10}`,
  `mode=fifo|pick`, `holds` table, credit on approve.
