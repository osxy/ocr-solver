# Exercise the Windows deployment glue a user actually touches: install.ps1, the
# per-user Startup-folder shim it registers, the packaged app under --headless, the
# double-click launcher, and uninstall.ps1.
#
# This is the one place the PowerShell/Startup-folder/wscript path is *executed* rather
# than merely asserted as text (tests/deploy.test.js). It runs only on windows-latest,
# from the extracted release artifact, because the whole point is to run the shipped
# bytes.
#
# It also proves the failure path, not just the success path: a payload whose installer
# exits non-zero must make install.ps1 exit non-zero and print no success line (#162).
# That is the check the deploy job was missing - and the reason the first real-machine
# failure printed "Installed" after node had printed a stack trace.
#
# Every check throws on failure, so a human never has to read the log to decide whether
# the job passed. The per-user folders are redirected into a temp tree so the run cannot
# touch the runner's real profile and is removed afterwards.
#
# UNVERIFIED LOCALLY: PowerShell and wscript are not part of the offline suite. The
# runner is an administrator, so the unprivileged path (#163) is not exercised here.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

# PowerShell 7.3+ can turn a native command's stderr into a terminating error when
# $ErrorActionPreference = 'Stop'. The induced-failure installer writes to stderr by
# design and the exit code is the signal under test, so disable that behaviour where the
# variable exists (it is absent on Windows PowerShell 5.1, which has no such behaviour).
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

$timer = [System.Diagnostics.Stopwatch]::StartNew()
$root = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-deploy-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

# isolate the run: install.ps1/uninstall.ps1 read %LOCALAPPDATA% and %APPDATA%
$env:LOCALAPPDATA = Join-Path $root 'LocalAppData'
$env:APPDATA = Join-Path $root 'AppData'
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:APPDATA | Out-Null
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\PuzzleSolver'
$startupFile = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\PuzzleSolver-startup.vbs'

$payload = Join-Path $root 'payload'
Expand-Archive -Path $Zip -DestinationPath $payload -Force
Assert (Test-Path (Join-Path $payload 'node.exe')) "the artifact has no node.exe at its root"

# Run install.ps1 in a child process so a thrown install error is observable as a process
# exit code, not a terminating error that aborts this script ($ErrorActionPreference is
# Stop here too). Returns the captured output and the exit code. `&` passes the script
# path as one argument, so a temp path with spaces cannot split.
function Invoke-Installer($scriptPath) {
    $text = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; text = $text }
}

try {
    # --- 1. install.ps1 succeeds and lands the files ------------------------
    $installed = Invoke-Installer (Join-Path $payload 'install.ps1')
    Assert ($installed.code -eq 0) "install.ps1 exited $($installed.code): $($installed.text)"
    Assert ($installed.text -match 'Installed to ') "install.ps1 did not print a success line: $($installed.text)"

    $expected = @(
        'node.exe',
        'PuzzleSolver.vbs',
        'app\src\cli.js',
        'app\src\deploy\install.js',
        'node_modules\sharp\package.json'
    )
    foreach ($rel in $expected) {
        $path = Join-Path $installDir $rel
        Assert (Test-Path $path) "install: expected $rel at $path"
    }
    Write-Host "install: $($expected.Count) expected files are present under $installDir"

    # --- 2. autostart is a per-user Startup entry, not a scheduled task ------
    # The task was refused with `Toegang geweigerd` for an ordinary user (#163), so the
    # mechanism is a file any user can write. Assert its path and its two load-bearing
    # behaviours: the 20 s logon delay and the delegation to the launcher.
    Assert (Test-Path $startupFile) "startup: expected the shim at $startupFile"
    $startupText = Get-Content $startupFile -Raw
    Assert ($startupText -match 'WScript\.Sleep 20000') 'startup: the logon delay is not the documented 20 s'
    Assert ($startupText -match 'PuzzleSolver\.vbs') 'startup: the shim does not launch the launcher'
    Assert ($startupText -match 'shell\.Run') 'startup: the shim does not run the app'
    Write-Host 'startup: per-user Startup shim present with a 20 s delay, no elevation involved'

    # --- 3. the packaged app starts and refuses without a token -------------
    $node = Join-Path $installDir 'node.exe'
    $cli = Join-Path $installDir 'app\src\cli.js'
    $outFile = Join-Path $root 'headless.out'
    $errFile = Join-Path $root 'headless.err'
    $app = Start-Process -FilePath $node -ArgumentList @($cli, 'listen', '--headless') `
        -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $app.WaitForExit(60000)) {
        $app.Kill()
        throw 'ASSERT FAILED: app --headless did not exit within 60s'
    }
    $code = $app.ExitCode
    $err = Get-Content $errFile -Raw
    # A missing token is a *documented* refusal: exit 1 with an actionable message, not a
    # crash. A stack trace here would mean startup failed before it reached the check.
    Assert ($code -eq 1) "app --headless: expected the documented refusal (exit 1), got $code. stderr: $err"
    Assert ($err -match 'no Pushbullet token found') "app --headless: refusal did not name the missing token. stderr: $err"
    Assert ($err -notmatch '\.js:\d+') "app --headless: the refusal printed a stack trace (a crash). stderr: $err"
    Write-Host 'app: packaged node.exe started under --headless and refused with the documented message'

    # --- 4. PuzzleSolver.vbs starts a process (the thing a user double-clicks) --
    & wscript.exe (Join-Path $installDir 'PuzzleSolver.vbs')
    $deadline = (Get-Date).AddSeconds(60)
    $launched = @()
    while ($launched.Count -eq 0 -and (Get-Date) -lt $deadline) {
        $launched = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installDir) })
        if ($launched.Count -eq 0) { Start-Sleep -Milliseconds 200 }
    }
    Assert ($launched.Count -gt 0) "launcher: PuzzleSolver.vbs did not start node.exe for $installDir within 60s"
    Write-Host "launcher: PuzzleSolver.vbs started $($launched.Count) node.exe process(es)"
    foreach ($proc in $launched) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2

    # --- 5. uninstall.ps1 removes the startup shim and the folders -----------
    # A throw inside uninstall.ps1 aborts this script (ErrorActionPreference = Stop), so
    # success is proved by the file assertions below rather than by $LASTEXITCODE.
    & (Join-Path $installDir 'uninstall.ps1')

    Assert (-not (Test-Path $startupFile)) "uninstall: the Startup shim still exists: $startupFile"
    Assert (-not (Test-Path $installDir)) "uninstall: install dir still exists: $installDir"
    Assert (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'PuzzleSolver'))) 'uninstall: logs/state dir still exists'
    Assert (-not (Test-Path (Join-Path $env:APPDATA 'PuzzleSolver'))) 'uninstall: config dir still exists'
    Write-Host 'uninstall: Startup shim and all three per-user folders are gone'

    # --- 6. a failing child must be propagated, never printed as success ----
    # This is the check that was missing when the first real user saw "Installed" after
    # node.exe had failed (#162). The payload's installer is replaced with one that exits
    # non-zero; install.ps1 must exit non-zero and print no success line.
    $failRoot = Join-Path $root 'induced-failure'
    $failLocal = Join-Path $failRoot 'LocalAppData'
    $failAppData = Join-Path $failRoot 'AppData'
    New-Item -ItemType Directory -Force -Path $failLocal, $failAppData | Out-Null
    $failPayload = Join-Path $failRoot 'payload'
    Copy-Item -Recurse -Force $payload $failPayload
    Set-Content -Path (Join-Path $failPayload 'app\src\deploy\install.js') -Value 'process.exit(3);' -Encoding utf8

    $savedLocal = $env:LOCALAPPDATA
    $savedAppData = $env:APPDATA
    $env:LOCALAPPDATA = $failLocal
    $env:APPDATA = $failAppData
    try {
        $failed = Invoke-Installer (Join-Path $failPayload 'install.ps1')
    } finally {
        $env:LOCALAPPDATA = $savedLocal
        $env:APPDATA = $savedAppData
    }
    Assert ($failed.code -ne 0) "induced failure: install.ps1 exited $($failed.code); a failing child must be propagated. output: $($failed.text)"
    Assert ($failed.text -notmatch 'Installed') "induced failure: install.ps1 printed a success line after the child failed: $($failed.text)"
    Write-Host "failure: an installer exiting non-zero made install.ps1 exit $($failed.code) with no success line"

    $timer.Stop()
    $seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    Write-Host "deploy test passed in ${seconds}s"
    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### Windows deployment

install -> per-user Startup shim inspected -> packaged app starts under ``--headless`` -> ``PuzzleSolver.vbs`` launches -> uninstall: all passed in **${seconds}s**.

The failure path is proved too: a payload whose installer exits non-zero makes ``install.ps1`` exit non-zero and print no success line (#162).

Not covered here, because a runner has no interactive desktop: the native ``systray2`` tray
widget, the ``node-notifier`` toast, and the ``explorer.exe`` browser hand-off. The runner is
an administrator, so the unprivileged install path (#163) has still never been exercised.
"@
    }
}
finally {
    # Best-effort cleanup: kill any node.exe we started and remove the whole temp tree
    # (the Startup shim lives inside it, so there is no global object to unregister).
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installDir) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed; a thrown assertion skips it and the
# non-zero exit is correct.
exit 0
