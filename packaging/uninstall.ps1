# PuzzleSolver uninstaller.
#
# Removes the per-user Startup-folder shim first (through app\src\deploy\uninstall.js,
# which owns the filename and path), then the three per-user folders the app created:
#
#   %LOCALAPPDATA%\Programs\PuzzleSolver   the program itself
#   %LOCALAPPDATA%\PuzzleSolver            logs and state.db
#   %APPDATA%\PuzzleSolver                 config.toml and credentials.json
#
# The directory removal lives here rather than in Node because a running node.exe
# cannot delete its own folder on Windows.
#
# Executed on windows-latest since #59. What remains unverified is the *unprivileged*
# path, because the runner is an administrator (issue #163).

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\PuzzleSolver'
$Node = Join-Path $InstallDir 'node.exe'
$Deploy = Join-Path $InstallDir 'app\src\deploy\uninstall.js'

if (Test-Path $Node) {
    if (Test-Path $Deploy) {
        & $Node $Deploy
        # A startup entry left behind would start a removed app at the next logon, so a
        # failure here is fatal rather than a warning (same trap as install.ps1, #162).
        if ($LASTEXITCODE -ne 0) { throw "PuzzleSolver uninstall failed: node.exe exited with $LASTEXITCODE" }
    }
}

# Fallback: if node.exe is missing (a damaged install), uninstall.js never ran, but the
# Startup shim must still go or logon will try to launch a removed app.
$StartupShim = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\PuzzleSolver-startup.vbs'
if (Test-Path $StartupShim) { Remove-Item -Force $StartupShim }

$Targets = @(
    $InstallDir,
    (Join-Path $env:LOCALAPPDATA 'PuzzleSolver'),
    (Join-Path $env:APPDATA 'PuzzleSolver')
)
foreach ($Target in $Targets) {
    if (Test-Path $Target) {
        Write-Host "Removing $Target"
        Remove-Item -Recurse -Force $Target
    }
}

Write-Host 'PuzzleSolver uninstalled.'
