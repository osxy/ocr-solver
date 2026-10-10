# PuzzleSolver updater.
#
# Applies a release the user already downloaded over the installed copy. It has **no
# network access of its own** (issue #168): it does not call the GitHub API and never
# fetches anything, so there is no `/releases/latest` trap (every release here is a
# pre-release, so "latest" returns nothing) and no script that downloads and runs remote
# code. The user verifies the download as the README already tells them to; this script
# re-verifies the checksum when the `.sha256` sidecar sits beside the archive.
#
# The three things update.ps1 cannot delegate to `install.ps1`:
#
#  1. Replace, do not merge. `install.ps1` self-copies and overwrites, which never
#     deletes - a stale `node_modules` entry would shadow the new one. The replace rule
#     lives in `app/src/deploy/update.js` (`applyUpdate`) and is tested offline.
#  2. Stop and restart. Windows will not let a running `node.exe` be replaced, and a
#     forced kill would lose an in-flight solve. The running app is asked to stop
#     gracefully through the single-instance lock (`app/src/deploy/stop.js`, #167/#212);
#     if it does not stop within the bound, the update aborts before touching a file.
#  3. Refuse an older payload. A user can extract the wrong zip; the version gate is
#     also in `update.js` and tested offline.
#
# Only these three things touch the user's data directories, and it never names them:
#   %LOCALAPPDATA%\Programs\PuzzleSolver   the app - replaced
#   %APPDATA%\PuzzleSolver                 config.toml, credentials.json - never touched
#   %LOCALAPPDATA%\PuzzleSolver            state.db, inbox, logs, images - never touched
#
# Executed on windows-latest only (the deploy job); PowerShell is not part of the
# offline suite.

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    # Scripted/unattended updates: install only, do not start the app.
    [switch]$NoStart,
    # Repair/reinstall the same version. Never a downgrade: the version gate still
    # refuses an older payload even with -Force.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# A native child's non-zero exit is invisible to ErrorActionPreference; the explicit
# $LASTEXITCODE checks below are the #162 trap.
if (-not (Test-Path $Zip)) { throw "the downloaded archive was not found: $Zip" }
$Zip = [IO.Path]::GetFullPath($Zip)

$InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\PuzzleSolver'
if (-not (Test-Path (Join-Path $InstallDir 'node.exe'))) {
    throw "no installed copy at $InstallDir; run install.ps1 first"
}

# --- 1. Verify the download before extracting it -------------------------------
# The sidecar is the project's only integrity signal (the binary is unsigned). When it
# is present it is authoritative: a mismatch refuses, and the archive is not extracted.
$Sidecar = "$Zip.sha256"
if (Test-Path $Sidecar) {
    $expected = ((Get-Content $Sidecar -Raw).Trim() -split '\s+')[0]
    if ($expected -notmatch '^[0-9a-fA-F]{64}$') { throw "the checksum file does not begin with a sha256 digest: $Sidecar" }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash
    if ($actual -ne $expected.ToUpperInvariant()) {
        throw "checksum mismatch for $Zip (expected $expected, got $actual); refusing to update"
    }
    Write-Host "checksum verified: $([IO.Path]::GetFileName($Zip))"
} else {
    Write-Warning "no checksum sidecar beside $Zip; the download's integrity was not verified"
}

# --- 2. Extract to a temp directory and validate the payload --------------------
$temp = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-update-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $temp | Out-Null
$payload = Join-Path $temp 'payload'
try {
    Expand-Archive -Path $Zip -DestinationPath $payload -Force
    $PayloadNode = Join-Path $payload 'node.exe'
    $PayloadUpdate = Join-Path $payload 'app\src\deploy\update.js'
    $PayloadStop = Join-Path $payload 'app\src\deploy\stop.js'
    if (-not (Test-Path $PayloadNode)) { throw "the archive has no node.exe at its root" }
    if (-not (Test-Path $PayloadUpdate)) { throw "the archive has no app\src\deploy\update.js" }
    if (-not (Test-Path $PayloadStop)) { throw "the archive has no app\src\deploy\stop.js" }

    # --- 3. Version gate: never install an older build by accident ---------------
    $checkArgs = @($PayloadUpdate, 'check', '--install', $InstallDir, '--source', $payload)
    if ($Force) { $checkArgs += '--force' }
    & $PayloadNode @checkArgs
    if ($LASTEXITCODE -ne 0) { throw "refusing to update: the version gate failed (exit $LASTEXITCODE)" }

    # --- 4. Stop the running app gracefully, or abort ---------------------------
    & $PayloadNode $PayloadStop
    if ($LASTEXITCODE -ne 0) {
        throw "the running app did not stop (exit $LASTEXITCODE); the install was left untouched"
    }

    # --- 5. Replace (never merge) and re-create the per-user shims ---------------
    # `--self` keeps the updater from deleting itself when it is run from the install
    # directory. The apply runs on the payload's node.exe (in temp), so it is not
    # deleting the executable it is running from.
    & $PayloadNode $PayloadUpdate 'apply' '--install' $InstallDir '--source' $payload '--self' $PSCommandPath
    if ($LASTEXITCODE -ne 0) { throw "the install could not be replaced (exit $LASTEXITCODE)" }

    # The launcher and Startup shim are regenerated from the new tree, so a moved or
    # changed shim is refreshed rather than kept from the old version.
    $InstallNode = Join-Path $InstallDir 'node.exe'
    $InstallDeploy = Join-Path $InstallDir 'app\src\deploy\install.js'
    & $InstallNode $InstallDeploy
    if ($LASTEXITCODE -ne 0) { throw "the launcher/Startup shim could not be re-created (exit $LASTEXITCODE)" }

    # --- 6. Start the new app, unless asked not to -------------------------------
    if ($NoStart) {
        Write-Host "Updated $InstallDir. It starts at logon; the app was not started now (-NoStart)."
    } else {
        $Launcher = Join-Path $InstallDir 'PuzzleSolver.vbs'
        $Wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
        if (-not (Test-Path $Wscript)) { $Wscript = 'wscript.exe' }
        Start-Process -FilePath $Wscript -ArgumentList "`"$Launcher`""
        Write-Host "Updated $InstallDir. It starts at logon, and it is starting now."
    }
}
finally {
    Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
