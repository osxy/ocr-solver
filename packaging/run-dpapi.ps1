# Prove the DPAPI credential store round trip with the shipped artifact.
#
# Executed on windows-latest by the `deploy` job in .github/workflows/package.yml,
# reusing the zip the `package` job built. It runs the artifact's own node.exe against
# packaging/dpapi-roundtrip.mjs, which imports the artifact's app/src/secrets.js and
# asserts that a plaintext credentials file is migrated to DPAPI, removed, and readable
# back. There is no assertion here that DPAPI "should" work: the script fails loudly if
# the real call does not.
#
# UNVERIFIED LOCALLY: PowerShell does not run on the Linux development host.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-dpapi-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $root | Out-Null

try {
    $payload = Join-Path $root 'payload'
    Expand-Archive -Path $Zip -DestinationPath $payload -Force

    $node = Join-Path $payload 'node.exe'
    $script = Join-Path $PSScriptRoot 'dpapi-roundtrip.mjs'
    $secrets = Join-Path $payload 'app\src\secrets.js'
    Assert (Test-Path $node) "the artifact has no node.exe at its root"
    Assert (Test-Path $secrets) "the artifact has no app\src\secrets.js to test"
    Assert (Test-Path $script) "packaging/dpapi-roundtrip.mjs is missing"

    $outFile = Join-Path $root 'dpapi.out'
    $errFile = Join-Path $root 'dpapi.err'
    $proc = Start-Process -FilePath $node -ArgumentList @($script, $payload) `
        -NoNewWindow -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
    if (-not $proc.WaitForExit(120000)) {
        $proc.Kill()
        throw 'ASSERT FAILED: the DPAPI round trip did not finish within 120s'
    }
    $code = $proc.ExitCode
    $stdout = Get-Content $outFile -Raw
    $stderr = Get-Content $errFile -Raw
    Write-Host $stdout
    Assert ($code -eq 0) "the DPAPI round trip exited $code. stderr: $stderr"
    Assert ($stdout -match 'DPAPI round trip') "the round trip did not report success. stdout: $stdout"
    Write-Host 'DPAPI: plaintext migrated -> removed -> decrypted -> fresh write -> decrypted, all matched'

    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### DPAPI credential store

Executed on the shipped artifact: a legacy plaintext ``credentials.json`` was migrated to DPAPI, the
plaintext removed, and the value read back; a fresh write round-tripped too. Protected with
``ProtectedData`` at ``CurrentUser`` scope through the packaged ``node.exe``.
"@
    }
}
finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed.
exit 0
