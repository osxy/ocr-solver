# Extract the artifact into a clean directory and run its own node.exe. This is the
# step that verifies the zip rather than the source tree; if it fails the workflow stops
# before the release job can see the artifact.
#
# UNVERIFIED LOCALLY: PowerShell is not part of the offline suite.

param(
    [Parameter(Mandatory = $true)][string]$Zip,
    [Parameter(Mandatory = $true)][string]$Corpus,
    [Parameter(Mandatory = $true)][string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Zip)) { throw "artifact not found: $Zip" }

$work = Join-Path ([IO.Path]::GetTempPath()) ("puzzlesolver-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Write-Host "extracting $Zip to $work"

Expand-Archive -Path $Zip -DestinationPath $work -Force

$node = Join-Path $work 'node.exe'
if (-not (Test-Path $node)) { throw "the artifact did not contain node.exe at its root" }

# The corpus is test input, not part of the shipped payload; copy it next to the app so
# the run exercises the extracted tree from outside the repository.
$localCorpus = Join-Path $work 'corpus'
Copy-Item -Recurse -Force $Corpus $localCorpus

& $node (Join-Path $RepoRoot 'packaging/smoke-test.mjs') $work $localCorpus
if ($LASTEXITCODE -ne 0) { throw "the packaged app failed the smoke test (exit $LASTEXITCODE)" }
