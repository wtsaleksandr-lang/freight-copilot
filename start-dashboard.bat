@echo off
REM Freight Copilot dashboard launcher.
REM Starts the Express server, then opens your default browser to localhost:3000.
REM If the dashboard is already running, just opens the browser and exits.

title Freight Copilot Dashboard
cd /d "%~dp0"

REM Detect whether port 3000 is already in use
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if %errorlevel% equ 0 (
    echo Freight Copilot is already running on port 3000.
    start "" http://localhost:3000
    timeout /t 2 >nul
    exit /b 0
)

REM Open browser in ~4s so the server has time to boot
start "" /b cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:3000"

REM Run the server (blocks this window until Ctrl+C or close)
pnpm dev serve
