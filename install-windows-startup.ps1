$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$launcher = Join-Path $projectDir 'start-dashboard.bat'
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'LoadMode Dashboard.lnk'

if (-not (Test-Path $launcher)) {
    throw "Launcher not found: $launcher"
}

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launcher
$shortcut.WorkingDirectory = $projectDir
$shortcut.Description = 'Start the LoadMode freight dashboard after Windows sign-in'
$shortcut.WindowStyle = 7
$shortcut.Save()

Write-Host "Installed Windows startup shortcut:"
Write-Host "  $shortcutPath"
Write-Host ''
Write-Host 'LoadMode will start after you sign in to Windows.'
Write-Host 'Keep the PC awake and keep Tailscale connected for remote access.'
