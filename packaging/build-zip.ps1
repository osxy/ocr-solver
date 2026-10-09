# Zip the assembled payload into the downloadable artifact.
#
# Zips the *contents* of the payload, so extraction puts node.exe, app/ and
# node_modules/ at the top level — which is exactly what install.ps1 (and the smoke
# test) expect. Nothing here is executed on the Linux development host.
#
# UNVERIFIED LOCALLY: PowerShell is not part of the offline suite.

param(
    [Parameter(Mandatory = $true)][string]$Payload,
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$OutDir
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Payload)) { throw "payload directory not found: $Payload" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$zip = Join-Path $OutDir "PuzzleSolver-$Version-win-x64.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }

Compress-Archive -Path (Join-Path $Payload '*') -DestinationPath $zip -CompressionLevel Optimal

$item = Get-Item $zip
Write-Host "created $zip ($([math]::Round($item.Length / 1MB, 1)) MiB)"
