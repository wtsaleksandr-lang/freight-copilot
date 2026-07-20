@echo off
setlocal
REM LoadMode desktop launcher. Builds the current code, starts the production
REM server on all interfaces, and opens the local dashboard.

title LoadMode Dashboard
cd /d "%~dp0"

where pnpm >nul 2>nul
if errorlevel 1 (
    echo ERROR: pnpm is not installed or is not on PATH.
    echo Install Node.js and then run: npm install -g pnpm
    pause
    exit /b 1
)

REM If the dashboard is already running, only open it.
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo LoadMode is already running on port 3000.
    start "" http://localhost:3000
    exit /b 0
)

if not exist ".env" (
    echo ERROR: .env is missing.
    echo Copy .env.example to .env and add DATABASE_URL, the AI key, and auth.
    pause
    exit /b 1
)

set HOST=0.0.0.0
if "%PORT%"=="" set PORT=3000

REM Open the browser after the server has had time to start.
start "" /b cmd /c "timeout /t 5 /nobreak >nul & start http://localhost:%PORT%"

echo Starting LoadMode on port %PORT%...
pnpm start:desktop

if errorlevel 1 (
    echo.
    echo LoadMode stopped with an error. Review the message above.
    pause
)
