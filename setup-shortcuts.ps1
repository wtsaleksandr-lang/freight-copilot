# Creates two Windows shortcuts for the Freight Copilot dashboard:
#   1. Desktop shortcut: "Freight Copilot" — double-click to start the server + open browser.
#   2. Startup shortcut: runs minimized at Windows login so the dashboard is always available at localhost:3000.
#
# Safe to re-run — it overwrites the shortcuts.
# To remove auto-start, delete the shortcut from: shell:startup (Run dialog -> shell:startup)

$ErrorActionPreference = 'Stop'

$projectDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath     = Join-Path $projectDir 'start-dashboard.bat'

if (-not (Test-Path $batPath)) {
    throw "start-dashboard.bat not found at $batPath"
}

$wsh = New-Object -ComObject WScript.Shell

# 1. Desktop shortcut (visible window with server logs)
$desktopPath  = [Environment]::GetFolderPath('Desktop')
$desktopLnk   = Join-Path $desktopPath 'Freight Copilot.lnk'
$sc1 = $wsh.CreateShortcut($desktopLnk)
$sc1.TargetPath       = $batPath
$sc1.WorkingDirectory = $projectDir
$sc1.WindowStyle      = 1   # 1 = normal
$sc1.Description      = 'Start the Freight Copilot dashboard'
$sc1.IconLocation     = 'shell32.dll,14'
$sc1.Save()
Write-Host "Created: $desktopLnk"

# 2. Startup folder shortcut (minimized, runs at login)
$startupPath  = [Environment]::GetFolderPath('Startup')
$startupLnk   = Join-Path $startupPath 'Freight Copilot Dashboard.lnk'
$sc2 = $wsh.CreateShortcut($startupLnk)
$sc2.TargetPath       = $batPath
$sc2.WorkingDirectory = $projectDir
$sc2.WindowStyle      = 7   # 7 = minimized
$sc2.Description      = 'Auto-start Freight Copilot dashboard at login'
$sc2.IconLocation     = 'shell32.dll,14'
$sc2.Save()
Write-Host "Created: $startupLnk"

Write-Host ""
Write-Host "Done. To test:"
Write-Host "  - Double-click 'Freight Copilot' on your desktop to launch now."
Write-Host "  - Or reboot / sign out + back in; the dashboard will auto-start minimized."
Write-Host "  - Open http://localhost:3000 in your browser any time the server is running."
Write-Host ""
Write-Host "To disable auto-start later: open Run (Win+R), type 'shell:startup', delete the shortcut."
