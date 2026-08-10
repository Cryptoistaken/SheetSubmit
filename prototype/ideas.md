# SheetSubmit — Floating Bubble Ideas

A system-wide floating bubble for the Android app (same pattern as KiloProxy's
`FloatingControlService` + `BubbleMenuOverlay`). It floats over any app so you
can manage FB cookie accounts and grab TOTP codes **without opening the
SheetSubmit app every time**.

The 4 candidate designs below describe **logic and behavior only** — no code.
The final app implementation will follow whatever we pick (plus a clickable
HTML mockup to test the UX before touching the Android code).

---

## Shared foundations (all 4 options)

- **Overlay service** — runs as a foreground service with a persistent
  notification; requires the "Display over other apps" permission.
- **Bubble** — a draggable round button that snaps to the screen edge when
  released. Tap (or long-press, depending on option) opens the panel.
- **Current account** — the bubble acts on one account at a time. Default:
  the account last opened in the app, remembered in app preferences.
- **Clipboard** — save actions never require typing. They read whatever is in
  the system clipboard and validate it:
  - FB cookie → must contain `c_user=123...`
  - 2FA key → must be base32 (A–Z, 2–7), cleaned of spaces/dashes, min 10 chars
- **TOTP code** — generated with the same SHA-1 / 30-second / 6-digit algorithm
  the web app already uses, then copied to the clipboard.
- **Feedback** — every action shows a short inline toast inside the panel
  ("Cookie saved ✓", "Not a cookie", "Code copied: 123456").
- **Data flow** — the bubble sends an action to the app's WebView, which calls
  a small bridge the web app exposes; the existing `api.persist`, TOTP and
  validation logic is reused. Nothing is stored twice.

---

## Option A — Speed Dial (3 buttons)

**Open:** tap the bubble → a small panel with exactly 3 buttons.

**Buttons & behavior:**

| Button | Behavior |
|--------|----------|
| Copy Code | Generates the 6-digit TOTP from the current account's 2FA key, copies it, and shows it big inside the panel with a 30-second countdown ring. Tap the code to re-copy. |
| Save Cookie | Reads the clipboard. If it contains `c_user=…`, saves it to the current account's cookie cell (auto-fills uid if empty). If not, shows an error toast. |
| Save 2FA Key | Reads the clipboard. If it's valid base32, saves it to the current account's 2FA cell. If not, shows an error toast. |

**Notes:** simplest possible UI; no account switching (acts on last-active
account). Fits everywhere, never crowded.

---

## Option B — Full Panel (5 buttons + account pill)

**Open:** tap the bubble → a wider panel with an account selector on top and
5 buttons below.

**Buttons & behavior:**

| Button | Behavior |
|--------|----------|
| Account pill | Shows the current uid + status color. Tap to open a dropdown of all accounts in the file; picking one makes it the current account (no need to open the app). |
| Copy Code | Same as Option A. |
| Save Cookie | Same as Option A. |
| Save 2FA Key | Same as Option A. |
| Check | Runs the existing FB check (good / bad / pending) for the current account, updates its status dot. |
| Open App | Launches the SheetSubmit app to the full sheet for editing. |

**Notes:** most capable; the account switcher solves the multi-account case
without the app. More visually busy.

---

## Option C — Tap-to-Copy (fastest for the #1 action)

**Open:** 
- **Tap** the bubble → instantly generates and copies the TOTP code, no menu.
  A small floating chip appears near the bubble showing the code with a
  30-second countdown. Tap the chip to re-copy.
- **Long-press** the bubble → opens the full menu: Save Cookie, Save 2FA Key,
  Check, Open App.

**Buttons & behavior:** same actions as Option B, but the most frequent one
(copy code) is a single tap on the bubble itself, zero menu navigation.

**Notes:** best when "copy the code without opening the app" is the whole
point. Slightly less discoverable — new users won't know long-press exists.

---

## Option D — Smart Sheet (auto-detect, no buttons)

**Open:** tap the bubble → a mini-sheet panel opens. There are **no action
buttons** — the clipboard is analyzed automatically and the right thing
just happens.

**Behavior on open:**

1. Read the clipboard.
2. If it looks like an FB cookie (contains `c_user=`):
   - Find the row whose uid equals that `c_user`.
   - **Match found** → save the cookie into that row (updates its cookie cell,
     marks it good).
   - **No match** → add a new row at the top with that uid + cookie.
   - Banner in the panel: "Cookie saved → 1000123456789" with an **Undo** link.
3. If it looks like a 2FA key (base32, ≥10 chars):
   - Save it to the row whose cookie was just saved (this session); otherwise
     to the currently selected row.
   - Banner: "2FA key saved → …" with an **Undo** link.
4. If neither → banner: "Not a cookie (no c_user=) nor a 2FA key".
5. **If after any save the row has a 2FA key, the TOTP code is generated and
   copied automatically** — shown big in the panel with a 30-second countdown.
   Tapping the code re-copies it.

**The mini sheet** lists all accounts (uid, cookie preview, masked 2FA key,
status color). Tapping a row makes it the current account; the matching row
in the big sheet gets highlighted.

**Notes:** the fastest possible flow — copy → tap → code is already copied.
Safety nets: undo on every auto-save, validation before any write, and the
`c_user` matching prevents overwriting the wrong row. If a save would have no
effect (clipboard empty or unrecognized), it only informs — it never writes.

---

## Comparison summary

| | A | B | C | D |
|---|---|---|---|---|
| Tap behavior | 3-button menu | full panel | instant copy code | smart sheet auto-save |
| Long-press | — | — | full menu | — |
| Copy code | 2 taps | 2 taps | 1 tap | automatic after save |
| Save cookie / 2FA | 2 taps | 2 taps | 2 taps (long-press menu) | 1 tap, auto-detect |
| Account switcher | no | yes (pill) | no | yes (tap a row) |
| Complexity | low | high | medium | medium |
| Best for | simple | power users | speed | speed + convenience |

## Recommendation

- **Option D** is the best endgame: zero-button flow, one tap does everything,
  and matching by `c_user` keeps the data safe.
- **Option C** is the best fallback if D feels too "magic" — the #1 action
  stays a single tap, everything else one long-press away.
- A and B are useful as simpler/completer references for the same gesture.

Next step (when we resume): build a clickable HTML mockup of the chosen
option styled with the SheetSubmit website design system, test it, then port
the overlay + panel into the Android app.
