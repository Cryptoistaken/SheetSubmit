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
- `APP_URL` — your Railway app URL (e.g. `https://your-app.up.railway.app`)

`PORT` is set automatically by Railway.

### 5. Deploy
Railway auto-deploys on every push to `main`.

## How It Works
- `package.json` has `"start": "bun run server/index.js"`
- Railway detects Node.js/Bun and runs the start command
- Server serves static files from root and handles API routes
- Redis stores all data (files, rows, undo/redo, sync state, logs)

## Custom Domain
1. Go to your service settings
2. Click "Networking" > "Generate Domain"
3. Or add a custom domain under "Custom Domain"
