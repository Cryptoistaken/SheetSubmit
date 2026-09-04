# SheetSubmit Style Guide

> Based on Cloudflare's style principles. Apply to all UI text, labels, and interactions.

---

## 1. Voice & Tone

- **Plain language**: important first, avoid obscure words, one idea per sentence
- **Active voice + present tense**: "Users claimed 7" not "Claimed by users"
- **Confident**: clear, no hedging ("Check your connection" not "Something might be wrong")
- **Solutions-oriented**: state the problem + what to do about it

## 2. UI Labels

| Rule | Example |
|------|---------|
| Button labels: 2-3 words max | `Download`, `Return`, `Cancel`, `Claim` |
| Sentence case for headings | "Recent downloads" not "Recent Downloads" |
| No "Taken" suffix on counts | Show `7` with color, not `7 Taken` |
| Remove filler words | "Claimed by users" → "Claimed" |
| Numbers standalone | `10` not `10 items` (context makes it clear) |

## 3. Error Messages

Format: **What happened** + **What to do**

| Bad | Good |
|-----|------|
| "Failed to load pools" | "Could not load pools. Check your connection." |
| "Nothing claimed" | "No rows available to claim" |
| "No file found" | "No file found for this user" |
| "not found" | "Download not found" |
| "unknown operation" | "Unknown action. Refresh and try again." |

## 4. Accessibility (WCAG 2.1 AA)

- `aria-label` on all icon-only buttons (`⋯` → `aria-label="More options"`)
- `aria-expanded` on expandable cards
- `aria-modal="true"` + `role="dialog"` on modals (already done)
- Color is never the only indicator — always pair with text or icon
- Meaningful link text: "View file" not "click here"
- Logical reading order: top to bottom, left to right
- Visible focus rings on all interactive elements

## 5. Inclusive Language

| Avoid | Use instead |
|-------|-------------|
| blacklist / whitelist | blocklist / allowlist |
| man-in-the-middle | on-path attack |
| sanity check | validation |
| he/she | they/them |
| cripple | degrade |
| dummy | placeholder |
| master/slave | primary/replica |

## 6. Formatting

- **Dates**: `Sep 4, 3:42 PM` in UI, full ISO in tooltips
- **Numbers**: `1,234` with comma separator for large counts
- **Percentages**: `75%` not `75 percent`
- **Code/IDs**: monospace font (`var(--mono)`)
- **File names**: preserve original, add `title` for truncated text

## 7. Consistent Terminology

| Use | Don't use |
|-----|-----------|
| pool | collection, group, batch |
| claim | take, grab, download (when referring to the action) |
| rows | entries, items, records (in sheet context) |
| file | sheet, document, workbook |
| available | free, open, remaining |
| reverted | undone, returned, rolled back |
| eligible | valid, qualified, approved |
| ineligible | invalid, disqualified, rejected |

## 8. Page Descriptions

Every page gets a 1-sentence description shown below the title:

- **Files**: "Upload, manage, and export your Facebook cookie collections."
- **Archive**: "Recover or permanently delete archived files."
- **Pools**: "Track contributor files, manage claims, and download pool accounts."
- **Admin**: "Monitor users, files, and platform activity."
- **Tools**: "Utility tools for data processing and analysis."

## 9. Component Patterns

### Toast Notifications
- Success: `"Claimed 10 rows from Cookies"`
- Error: `"Could not claim rows. Check your connection."`
- Info: `"Reverted 7 rows to pool"`
- Max 1 line, auto-dismiss 3-4s

### Modals
- Title: verb + noun (`"Download options"`, not `"Options"`)
- Description: 1 sentence explaining what the modal does
- Primary action: last button (right side), bold
- Cancel: first button (left side), ghost style

### Empty States
- Title: what's missing (`"No downloads yet"`)
- Subtitle: how to fix it (`"Claim rows from a pool to see them here"`)
- Optional: action button (`"Go to pools"`)
