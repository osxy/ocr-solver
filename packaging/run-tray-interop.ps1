# Prove the shipped artifact resolves the `systray2` class.
#
# Executed on windows-latest by the `deploy` job in .github/workflows/package.yml,
# reusing the zip the `package` job built. It runs the artifact's own node.exe against
# packaging/tray-interop.mjs, which imports the artifact's app/src/ui/tray-systray.js
# and the artifact's systray2, then asserts the resolution is a function.
#
# This exists because the deploy job's `--headless` launch skips the tray by design,
# and the launcher step only asserts that a node.exe process starts - so the interop
# layer that was actually broken had no automated check anywhere. This check enters
# it on the packaged Windows artifact. The native widget still cannot be started here
# (a runner has no interactive desktop); only the resolution is proven.
#
# UNVERIFIED LOCALLY: PowerShell does not run on the Linux development host.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-tray-interop-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
    $payload = Join-Path $root 'payload'
    Expand-Archive -Path $Zip -DestinationPath $payload -Force

    $node = Join-Path $payload 'node.exe'
    $script = Join-Path $PSScriptRoot 'tray-interop.mjs'
    $adapter = Join-Path $payload 'app\src\ui\tray-systray.js'
    Assert (Test-Path $node) "the artifact has no node.exe at its root"
    Assert (Test-Path $adapter) "the artifact has no app\src\ui\tray-systray.js to test"
    Assert (Test-Path $script) "packaging/tray-interop.mjs is missing"

    $outFile = Join-Path $root 'tray-interop.out'
    $errFile = Join-Path $root 'tray-interop.err'
    $proc = Start-Process -FilePath $node -ArgumentList @($script, $payload) `
        -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $proc.WaitForExit(60000)) {
        $proc.Kill()
        throw 'ASSERT FAILED: the tray interop check did not finish within 60s'
    }
    $code = $proc.ExitCode
    $stdout = Get-Content $outFile -Raw
    $stderr = Get-Content $errFile -Raw
    Write-Host $stdout
    Assert ($code -eq 0) "the tray interop check exited $code. stderr: $stderr"
    Assert ($stdout -match 'tray-interop-ok') "the check did not report success. stdout: $stdout"
    Write-Host 'tray interop: the packaged systray2 resolves to a SysTray function'

    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### Tray interop (packaged artifact)

Executed on the shipped artifact with its own ``node.exe``: ``app/src/ui/tray-systray.js``
resolved ``systray2`` to a function through the real Babel/CommonJS shape. The native
tray widget is still **not** started - a runner has no interactive desktop - but the
interop layer that had never worked now has an automated check on Windows. The
headless-launch and launcher steps below skip or do not assert this path.
"@
    }
}
finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed.
exit 0
