# Deploy to Railway

## Prerequisites
- GitHub account
- Railway account (railway.app)

## Steps

### 1. Push to GitHub
```bash
git remote add origin https://github.com/YOUR_USERNAME/sheetsubmit.git
git push -u origin main
```

### 2. Create Railway Project
1. Go to [railway.app](https://railway.app)
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Select your `sheetsubmit` repo

### 3. Add Redis
1. In your project, click "New" > "Database" >
2. Railway auto-generates `REDIS_URL` variable

### 4. Set Environment Variables
Set these in Railway service variables:
- `REDIS_URL` — auto-set by Redis addon
- `TG_BOT_TOKEN` — your Telegram bot token
- `APP_URL` — your Railway app URL (e.g. `https://your-app.up.railway.app`); `RAILWAY_PUBLIC_DOMAIN` takes precedence when present
- `REDIS_BACKUP_URL` — optional; Redis URL for the cold backup mirror (backup loop only runs when set)
- `BACKUP_INTERVAL` — backup interval in minutes (default `5`)
- `ADMIN_IDS` — comma-separated Telegram IDs (default `8447133985,1772093705`)
- `WA_CACHE_TTL_HOURS` — WhatsApp cache TTL in hours; `0` = keep forever (default `0`)

`PORT` is set automatically by Railway.
Planned tuning vars (not yet in code):
- `HISTORY_RETENTION_DAYS` — history retention in days (default `30`)
- `HISTORY_EDIT_COALESCE_S` — edit coalescing window in seconds (default `60`)
- `HISTORY_CHECKPOINT_EVERY` — full snapshot every N versions (default `20`)

### 5. Deploy
Railway auto-deploys on every push to `main`. The repo's `Dockerfile` is used to
build the image (`oven/bun:1.3.14`, runs as the non-root `bun` user). The build
does a clean `bun install --production` from `package.json` only — `node_modules`,
`.env`, and lockfiles are gitignored and must never be committed.

## How It Works
- `package.json` has `"start": "bun run server/index.js"` — matches the Docker `CMD`
- Railway detects the Dockerfile and runs the start command
- Server serves static files from root and handles API routes
- Redis stores all data (files, rows, undo/redo, sync state, logs)

## Custom Domain
1. Go to your service settings
2. Click "Networking" > "Generate Domain"
3. Or add a custom domain under "Custom Domain"