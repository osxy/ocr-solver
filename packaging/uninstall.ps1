# PuzzleSolver uninstaller.
#
# Removes the per-user Startup-folder shim first (through app\src\deploy\uninstall.js,
# which owns the filename and path), then the program folder the installer created:
#
#   %LOCALAPPDATA%\Programs\PuzzleSolver   the program itself - always removed
#
# The user's data folders are NOT removed by default:
#
#   %LOCALAPPDATA%\PuzzleSolver            logs and state.db
#   %APPDATA%\PuzzleSolver                 config.toml and credentials.json
#
# That is the Windows convention: an uninstall removes the program, and application data
# under %APPDATA%/%LOCALAPPDATA% outlives it, which is why a reinstall keeps your
# settings and history. Deleting the data is `-Purge`, so it is something the user asks
# for rather than something that happens to them (#186).
#
# There is no security argument for removing credentials.json: it is DPAPI-protected
# with CurrentUser scope, so it is already useless to any other account on the machine.
# Deleting it only costs the legitimate owner. Do not "fix" this back to deleting it.
#
# The directory removal lives here rather than in Node because a running node.exe
# cannot delete its own folder on Windows.
#
# Executed on windows-latest since #59. What remains unverified is the *unprivileged*
# path, because the runner is an administrator (issue #163).

param(
    # Also delete the user's data (settings, credentials, history, logs). Off by
    # default: an uninstall removes the program, not the user's property.
    [switch]$Purge
)

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

# The program folder is the installer's and is always removed. The data folders are the
# user's, and the only way they reach the removal list is -Purge (#186).
$DataTargets = @(
    (Join-Path $env:LOCALAPPDATA 'PuzzleSolver'),
    (Join-Path $env:APPDATA 'PuzzleSolver')
)
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

if ($Purge) {
    Write-Host 'PuzzleSolver uninstalled, and its data was purged (-Purge).'
} else {
    Write-Host 'PuzzleSolver uninstalled. Your settings and history were kept:'
    foreach ($Data in $DataTargets) {
        if (Test-Path $Data) { Write-Host "  $Data" }
    }
    Write-Host 'Re-run with -Purge to delete that data too.'
}
