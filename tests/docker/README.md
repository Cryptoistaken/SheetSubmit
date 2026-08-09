# Docker Clean-Clone Build Verification

Verifies the `Dockerfile` builds successfully from a clean git clone — i.e. with
`node_modules`, `.env`, and lockfiles (`package-lock.json` / `bun.lockb`) ABSENT.

**Result (2026-08-08): PASS** — cold build + hardened rebuild both succeeded; boot
smoke test passed (`server/index.js` starts, `/api/health` responds).

## What a "clean clone" must contain

Only git-tracked files. In this repo that is exactly `git ls-files` (53 files).
Forbidden in the stage dir: `node_modules`, `.env`, `package-lock.json`, `bun.lockb`
(verified absent before each build).

## Commands actually run (PowerShell)

```powershell
# 1. Stage a clean clone (only tracked files)
$stage = "C:\Users\Ratul\AppData\Local\Temp\opencode\ss-clean-build"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force $stage | Out-Null
git ls-files | ForEach-Object {
  $dest = Join-Path $stage $_
  $dir = Split-Path $dest -Parent
  if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
  Copy-Item -LiteralPath $_ -Destination $dest -Force
}

# 2. Build
docker build -t sheetsubmit-clean-test $stage
```

## Dockerfile contract (verified by reading)

| Requirement | Status |
|---|---|
| Does NOT `COPY package-lock.json` | PASS — file is gitignored, no COPY line |
| `bun install` without `--frozen-lockfile` | PASS — `RUN bun install --production` |
| `COPY package.json` before the rest | PASS — `COPY package.json ./` then `COPY . .` |
| Correct entrypoint | PASS — `CMD ["bun", "run", "server/index.js"]` |

## Successful build — output tail (cold build, first run)

```
#8 [3/5] COPY package.json ./
#8 DONE 0.1s

#9 [4/5] RUN bun install --production
#9 1.475 bun install v1.3.14 (0d9b296a)
#9 1.529 Resolving dependencies
#9 5.787 Resolved, downloaded and extracted [339]
#9 5.996 + dotenv@16.6.1 (v17.4.2 available)
#9 5.996 + express@4.22.2 (v5.2.1 available)
#9 5.996 + ioredis@5.11.1 (v6.0.0 available)
#9 5.996 + xlsx@0.18.5
#9 5.996 86 packages installed [4.58s]
#9 DONE 6.3s

#10 [5/5] COPY . .
#10 DONE 0.2s

#11 exporting to image
#11 exporting layers 2.7s done
#11 exporting manifest sha256:f585182f784c77091e14a53641048aa66045c6071449fca20e3580cc40b9add8 0.0s done
#11 naming to docker.io/library/sheetsubmit-clean-test:latest done
#11 unpacking to docker.io/library/sheetsubmit-clean-test:latest 1.8s done
#11 DONE 4.8s
```

## Hardened rebuild (after Dockerfile edit)

`FROM oven/bun:latest` -> `oven/bun:1.3.14` (same digest `e10577f0...`), added
`USER bun`. Rebuild PASSED — `bun install` layer reused from cache:

```
#5 [1/5] FROM docker.io/oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4
#8 [4/5] RUN bun install --production
#8 CACHED
#9 [5/5] COPY . .
#9 DONE 0.1s
#10 exporting to image
#10 naming to docker.io/library/sheetsubmit-clean-test:latest done
#10 DONE 0.9s
```

## Boot smoke test

```powershell
docker run --rm -d --name ss-smoke -e PORT=3000 -e TG_BOT_TOKEN=x -p 13000:3000 sheetsubmit-clean-test
Start-Sleep -Seconds 6; docker logs ss-smoke
Invoke-WebRequest http://localhost:13000/api/health   # -> {"status":"reconnecting"} (Redis absent locally)
docker exec ss-smoke sh -c "whoami"                  # -> bun  (non-root confirmed)
docker stop ss-smoke
```

Expected in a local run without Redis: `Redis connection error: connect ECONNREFUSED
127.0.0.1:6379` and health reports `"reconnecting"` — both are fine here. In a real
deploy Railway injects `REDIS_URL`, and the health endpoint then reports `"ok"`.

## Artifacts

- No build artifacts are left in the repo. Staging dir and docker logs live under
  `%TEMP%\opencode\` (outside the repo).
- Image tag `sheetsubmit-clean-test:latest` may be removed with
  `docker rmi sheetsubmit-clean-test`.