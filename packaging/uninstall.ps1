# PuzzleSolver uninstaller.
#
# Removes the scheduled task first (through app\src\deploy\uninstall.js, which owns
# the schtasks arguments), then the three per-user folders the app created:
#
#   %LOCALAPPDATA%\Programs\PuzzleSolver   the program itself
#   %LOCALAPPDATA%\PuzzleSolver            logs and state.db
#   %APPDATA%\PuzzleSolver                 config.toml and credentials.json
#
# The directory removal lives here rather than in Node because a running node.exe
# cannot delete its own folder on Windows.
#
# UNVERIFIED ON WINDOWS: never executed on the Linux development host.

$ErrorActionPreference = 'Stop'

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\PuzzleSolver'
$Node = Join-Path $InstallDir 'node.exe'
$Deploy = Join-Path $InstallDir 'app\src\deploy\uninstall.js'

if (Test-Path $Node) {
    if (Test-Path $Deploy) { & $Node $Deploy }
}

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
