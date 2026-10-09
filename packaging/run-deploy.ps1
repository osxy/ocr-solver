# Exercise the Windows deployment glue a user actually touches: install.ps1, the
# scheduled task it registers, the packaged app under --headless, the double-click
# launcher, and uninstall.ps1.
#
# This is the one place the PowerShell/schtasks/wscript path is *executed* rather than
# merely asserted as text (tests/deploy.test.js). It runs only on windows-latest, from
# the extracted release artifact, because the whole point is to run the shipped bytes.
#
# Every check throws on failure, so a human never has to read the log to decide whether
# the job passed. The per-user folders are redirected into a temp tree so the run cannot
# touch the runner's real profile and is removed afterwards.
#
# UNVERIFIED LOCALLY: PowerShell, schtasks and wscript are not part of the offline suite.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

$taskName = 'PuzzleSolver'
$timer = [System.Diagnostics.Stopwatch]::StartNew()
$root = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-deploy-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

# isolate the run: install.ps1/uninstall.ps1 read %LOCALAPPDATA% and %APPDATA%
$env:LOCALAPPDATA = Join-Path $root 'LocalAppData'
$env:APPDATA = Join-Path $root 'AppData'
New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA, $env:APPDATA | Out-Null
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\PuzzleSolver'

$payload = Join-Path $root 'payload'
Expand-Archive -Path $Zip -DestinationPath $payload -Force
Assert (Test-Path (Join-Path $payload 'node.exe')) "the artifact has no node.exe at its root"

try {
    # --- 1. install.ps1 -----------------------------------------------------
    & (Join-Path $payload 'install.ps1')

    $expected = @(
        'node.exe',
        'PuzzleSolver.vbs',
        'PuzzleSolver.task.xml',
        'app\src\cli.js',
        'app\src\deploy\install.js',
        'node_modules\sharp\package.json'
    )
    foreach ($rel in $expected) {
        $path = Join-Path $installDir $rel
        Assert (Test-Path $path) "install: expected $rel at $path"
    }
    Write-Host "install: $($expected.Count) expected files are present under $installDir"

    # --- 2. the scheduled task is registered, and its properties are right --
    $taskXmlLines = & schtasks.exe /Query /TN $taskName /XML 2>&1
    Assert ($LASTEXITCODE -eq 0) "schtasks /Query /TN $taskName failed ($LASTEXITCODE): $taskXmlLines"
    $taskXml = $taskXmlLines -join "`n"

    Assert ($taskXml -match '<LogonTrigger>') 'task XML has no logon trigger'
    Assert ($taskXml -match '<Delay>PT20S</Delay>') 'task logon delay is not the documented PT20S'
    Assert ($taskXml -match '<RestartOnFailure>') 'task XML has no restart-on-failure (the reason for a task over the Run key)'
    Assert ($taskXml -match '<Interval>PT1M</Interval>') 'restart interval is not PT1M'
    Assert ($taskXml -match '<Count>3</Count>') 'restart count is not 3'
    Assert ($taskXml -match 'PuzzleSolver\.vbs') 'task does not launch the launcher shim'
    Write-Host 'task: registered with a PT20S logon trigger and PT1M x3 restart-on-failure'

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

    # --- 5. uninstall.ps1 removes the task and the folders ------------------
    & (Join-Path $installDir 'uninstall.ps1')

    $stillThere = & schtasks.exe /Query /TN $taskName 2>&1
    Assert ($LASTEXITCODE -ne 0) "uninstall: the task still exists: $stillThere"
    Assert (-not (Test-Path $installDir)) "uninstall: install dir still exists: $installDir"
    Assert (-not (Test-Path (Join-Path $env:LOCALAPPDATA 'PuzzleSolver'))) 'uninstall: logs/state dir still exists'
    Assert (-not (Test-Path (Join-Path $env:APPDATA 'PuzzleSolver'))) 'uninstall: config dir still exists'
    Write-Host 'uninstall: task and all three per-user folders are gone'

    $timer.Stop()
    $seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    Write-Host "deploy test passed in ${seconds}s"
    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### Windows deployment

install -> task registered and inspected -> packaged app starts under ``--headless`` -> ``PuzzleSolver.vbs`` launches -> uninstall: all passed in **${seconds}s**.

Not covered here, because a runner has no interactive desktop: the native ``systray2`` tray
widget, the ``node-notifier`` toast, and the ``explorer.exe`` browser hand-off. Restart-on-failure
is inspected as a task property, not observed as a restart.
"@
    }
}
finally {
    # Best-effort cleanup. The delete is expected to fail when uninstall.ps1 already
    # removed the task. Its non-zero exit is why this script ends with an explicit
    # `exit 0`: $LASTEXITCODE is not scope-local, so a child-scope assignment did not
    # stop the non-zero leaking into the pwsh process exit code (the first two CI runs
    # were red on a fully passing script for exactly that reason).
    & schtasks.exe /Delete /TN $taskName /F 2>&1 | Out-Null
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($installDir) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed; a thrown assertion skips it and the
# non-zero exit is correct.
exit 0
