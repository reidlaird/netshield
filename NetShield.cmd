@echo off
title NetShield
cd /d "%~dp0"

rem If the server is already running, just open the dashboard.
netstat -ano | findstr /r /c:":3010 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo NetShield is already running -- opening dashboard...
  start "" http://localhost:3010
  exit /b 0
)

rem Build the frontend once if the production bundle is missing.
if not exist "frontend\dist\index.html" (
  echo First run: building the dashboard...
  call npm run build
  if errorlevel 1 (
    echo Build failed. See output above.
    pause
    exit /b 1
  )
)

echo Starting NetShield on http://localhost:3010
echo Close this window to stop the server.
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:3010"
node backend\server.js
