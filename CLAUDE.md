# Sheet Submit — Codebase Map

## Overview
A web-based account manager for IG cookies. Users manage sheets of accounts (username, password, 2fa), sync cookies via external APIs, and export/import xlsx files.

## Tech Stack
- **Frontend:** Vanilla JS (no framework), CSS custom properties for theming
- **Backend:** Express.js + Redis (ioredis)
- **Fonts:** Geist Sans, Geist Mono (Vercel design system)
- **Libraries:** SheetJS (xlsx) for spreadsheet import/export

## Project Structure
```
SheetSubmit/
├── server/
│   └── index.js            # Express server, API routes, proxy endpoints
├── css/
│   ├── base.css            # Reset, design tokens, fonts, animations
│   ├── layout.css          # Topbar, file cards, grid table, home tabs
│   ├── components.css      # Buttons, modals, toast
│   ├── dashboard.css       # User button/panel, settings, toggle switch
│   └── touch.css           # Touch device overrides
├── js/
│   ├── theme.js            # Light/dark theme toggle (localStorage)
│   ├── types.js            # File type definitions (columns, labels)
│   ├── api.js              # Client-side API calls to server
│   ├── state.js            # Global state, DOM refs, helpers
│   ├── home.js             # Home page: file list, archive, type modal
│   ├── sheet.js            # Sheet page: grid, edit, undo/redo, sync
│   ├── app.js              # Boot: health check, FAB, popstate, URL restore
│   ├── adapters/
│   │   ├── index.js        # Adapter registry (register/get)
│   │   └── igcookie.js     # IG Cookie adapter: TOTP, fetch cookies, push
│   └── filetypes/
│       ├── index.js        # File behavior registry (register/get)
│       └── igcookie.js     # IG Cookie behavior: password fill, dot actions
├── index.html              # Single page app shell
├── package.json            # Dependencies: express, ioredis, dotenv, xlsx
└── .env                    # REDIS_URL, PORT (gitignored)
```

## Key Concepts

### Header User Menu
Single circular button in the top-right showing the Telegram profile photo. Click opens a dropdown panel with user info (avatar, name, @username), Night mode toggle, and Logout button. Defined in `dashboard.css` and handled in `app.js`.

### File Types (`types.js`)
Each file type defines columns, labels, and badge styling:
```js
ig_cookie: { columns: [{ key: 'username' }, { key: 'password' }, { key: 'twofa' }] }
```

### Adapters (`adapters/`)
External API integrations. Each adapter is a named object with methods:
```js
__ss.registerAdapter('ig-cookie', { fetchCookies, pushCookies, syncRow, generateTOTP })
```
To add a new API: create `adapters/newname.js`, call `registerAdapter`.

### File Behaviors (`filetypes/`)
Per-type UI logic (dot actions, cell changes, sync):
```js
__ss.registerFileBehavior('ig_cookie', { onDotDoubleTap, onDotHold, syncRow, onCellChange })
```
To add a new file type: create `filetypes/newtype.js`, call `registerFileBehavior`.

### Server API Routes
| Route | Method | Purpose |
|-------|--------|---------|
| `/api/files` | GET/POST | List/create files (POST accepts `initialRows`) |
| `/api/files/:id` | GET/PUT/DELETE | Read/update/archive single file |
| `/api/files/:id/rows` | GET | Read row data |
| `/api/files/:id/persist` | PUT | Batch save rows + undo/redo + dataCount |
| `/api/files/:id/sync` | GET/PUT | Sync toggle state |
| `/api/files/:id/logs` | GET | API call logs |
| `/api/archive` | GET | List archived files |
| `/api/archive/:id/restore` | POST | Restore from archive |
| `/api/archive/:id` | DELETE | Permanently delete (removes rows, stacks, sync, logs) |
| `/api/ig/jobs` | POST | Proxy: IG Auto Cookies API |
| `/api/ig/jobs/:jobId` | GET | Proxy: poll IG job |
| `/api/sky/push` | POST | Proxy: SkySys push |
| `/api/sky/status/:jobId` | GET | Proxy: poll push status |
| `/api/health` | GET | Redis health check |

All file-data routes (`:id/rows`, `:id/persist`, `:id/sync`, `:id/logs`) verify file ownership via `requireFileAccess` middleware before returning data.

### Performance & Auth
- **Batch persist**: Single `PUT /:id/persist` replaces 5 separate calls (rows + undo + redo + file update + file fetch).
- **Single file GET**: `GET /:id` avoids fetching all files to find one.
- **dataCount**: File list includes pre-computed non-empty row count — no N+1 calls for home page meta.
- **Auth**: `requireFileAccess` middleware verifies the file belongs to the session user on every data route. Permanent delete cleans up all related Redis keys (rows, stacks, sync, logs).

### Themes
Light (default) and dark via `[data-theme]` attribute. All colors use CSS variables from `base.css`.

## Deployment
- Railway via GitHub (see RAILWAY.md)
- Requires Redis (Railway Redis addon)
- `PORT` env var set automatically by Railway

## Adding a New File Type
1. Add type definition in `js/types.js`
2. Create behavior in `js/filetypes/newtype.js`
3. If it needs external APIs, create adapter in `js/adapters/newapi.js`
4. Add server proxy routes in `server/index.js`
5. Load new scripts in `index.html`
