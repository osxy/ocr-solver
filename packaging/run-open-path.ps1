# Prove the shipped artifact builds the documented Windows opener command for a *path*.
#
# Executed on windows-latest by the `deploy` job in .github/workflows/package.yml, reusing
# the zip the `package` job built. It runs the artifact's own node.exe against
# packaging/open-path-check.mjs, which imports the artifact's app/src/ui/open-path.js and
# asserts the command it constructs for an existing file (`explorer.exe /select,<path>`), a
# missing file (the nearest existing folder), and a URL (`rundll32`).
#
# This exists because the path branch of #217 was wrong *for three releases* while only the
# URL branch was asserted off Windows: the deployed artifact handed Explorer a bare path,
# and the reported result was Documents. The command construction is the seam; whether a
# window actually appears cannot be checked on a runner (no interactive desktop), and this
# script says so rather than implying otherwise.
#
# UNVERIFIED LOCALLY: PowerShell does not run on the Linux development host.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-open-path-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
    $payload = Join-Path $root 'payload'
    Expand-Archive -Path $Zip -DestinationPath $payload -Force

    $node = Join-Path $payload 'node.exe'
    $script = Join-Path $PSScriptRoot 'open-path-check.mjs'
    $adapter = Join-Path $payload 'app\src\ui\open-path.js'
    Assert (Test-Path $node) "the artifact has no node.exe at its root"
    Assert (Test-Path $adapter) "the artifact has no app\src\ui\open-path.js to test"
    Assert (Test-Path $script) "packaging/open-path-check.mjs is missing"

    $outFile = Join-Path $root 'open-path.out'
    $errFile = Join-Path $root 'open-path.err'
    $proc = Start-Process -FilePath $node -ArgumentList @($script, $payload) `
        -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $proc.WaitForExit(60000)) {
        $proc.Kill()
        throw 'ASSERT FAILED: the open-path check did not finish within 60s'
    }
    $code = $proc.ExitCode
    $stdout = Get-Content $outFile -Raw
    $stderr = Get-Content $errFile -Raw
    Write-Host $stdout
    Assert ($code -eq 0) "the open-path check exited $code. stderr: $stderr"
    Assert ($stdout -match 'open-path-ok') "the check did not report success. stdout: $stdout"
    Write-Host 'open-path: the packaged opener reveals a file with /select, and opens the folder for a missing one'

    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### Windows opener command (packaged artifact)

Executed on the shipped artifact with its own ``node.exe``: ``app/src/ui/open-path.js``
constructed ``explorer.exe /select,<path>`` for an existing file, the nearest existing
folder for a missing one, and ``rundll32 url.dll,FileProtocolHandler`` for a URL (#217).

**Not proved here:** whether Explorer actually opens a window, and which one. A runner has
no interactive desktop, so only the command construction is asserted. That gap is what let
the bare-path bug reach a user three releases running.
"@
    }
}
finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed.
exit 0
