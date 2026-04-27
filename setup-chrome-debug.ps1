# Creates a "Chrome (Freight Copilot)" desktop shortcut that launches Chrome
# with --remote-debugging-port=9222 against a dedicated user profile.
#
# Why: when USE_REAL_CHROME=true, the freight-copilot scripts attach to this
# Chrome instance over CDP. Using your real Chrome (instead of Playwright's
# bundled Chromium) bypasses bot-detection on hostile carrier portals
# (Hapag-Lloyd, CMA CGM, etc.) — they see a normal user, not a "headless
# automated" browser.
#
# Re-run this script any time to recreate the shortcut.

$ErrorActionPreference = 'Stop'

# Locate Chrome.exe — try the common install paths.
$chromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $chrome) {
    throw "Could not find chrome.exe. Install Google Chrome first, or edit this script to point at your Chrome path."
}
Write-Host "Found Chrome at: $chrome"

# Use a dedicated user-data-dir under the project so this Chrome runs alongside
# your normal Chrome (separate cookies/history/extensions).
$projectDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$profileDir  = Join-Path $projectDir '.chrome-profile'
if (-not (Test-Path $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir | Out-Null
    Write-Host "Created Chrome profile dir: $profileDir"
}

$wsh = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Chrome (Freight Copilot).lnk'

$sc = $wsh.CreateShortcut($lnkPath)
$sc.TargetPath       = $chrome
$sc.Arguments        = "--remote-debugging-port=9222 --user-data-dir=`"$profileDir`""
$sc.WorkingDirectory = $projectDir
$sc.IconLocation     = "$chrome,0"
$sc.Description      = 'Chrome with debug port for Freight Copilot'
$sc.Save()
Write-Host "Created shortcut: $lnkPath"

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Set USE_REAL_CHROME=true in .env"
Write-Host "  2. Double-click 'Chrome (Freight Copilot)' on your Desktop."
Write-Host "  3. Log into the carrier portals you use (Maersk, Hapag, etc.) ONCE."
Write-Host "     Cookies persist in this Chrome's profile across sessions."
Write-Host "  4. Run quotes/agent/record commands as usual — they'll attach to this Chrome."
Write-Host ""
Write-Host "To revert to bundled Chromium: set USE_REAL_CHROME=false in .env."
