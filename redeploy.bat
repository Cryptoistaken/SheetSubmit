@echo off
cd /d "%~dp0"

rem Incremental redeploy: builds/pushes only changed images (via git diff).
rem Delegates to scripts/redeploy.ts. Flags: --backend, --frontend, --all/--force, --dry-run
rem Examples: redeploy.bat --backend    (only backend)
rem           redeploy.bat --frontend   (only frontend)
rem           redeploy.bat --all        (force both)
rem           redeploy.bat --dry-run    (show plan without building)

where bun >nul 2>&1
if %errorlevel% equ 0 (
  bun run scripts/redeploy.ts %*
  exit /b %errorlevel%
)

echo bun not found — falling back to full rebuild (both images)...
if not exist deploy.env (
  echo deploy.env not found. Copy deploy.env.example to deploy.env and fill it in.
  exit /b 1
)
for /f "usebackq delims=" %%a in ("deploy.env") do set "%%a"

docker build -f backend/Dockerfile -t popyog/sheetsubmit-testmycode-backend:latest backend
if %errorlevel% neq 0 exit /b %errorlevel%
docker push popyog/sheetsubmit-testmycode-backend:latest
if %errorlevel% neq 0 exit /b %errorlevel%

docker build -f frontend/Dockerfile -t popyog/sheetsubmit-testmycode-frontend:latest frontend
if %errorlevel% neq 0 exit /b %errorlevel%
docker push popyog/sheetsubmit-testmycode-frontend:latest
if %errorlevel% neq 0 exit /b %errorlevel%

echo.
echo Images pushed. Triggering Railway redeploys via the in-app /__redeploy endpoints...
curl.exe -s -X POST -H "Authorization: Bearer %RAILWAY_TOKEN%" "%BACKEND_URL%/__redeploy"
echo.
curl.exe -s -X POST -H "Authorization: Bearer %RAILWAY_TOKEN%" "%FRONTEND_URL%/__redeploy"
echo.
echo Done! Redeploy triggered on both services.