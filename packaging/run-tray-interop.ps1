# Prove the shipped artifact resolves the `systray2` class, and that Windows can load
# the tray icon the artifact ships.
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
# It then asserts the second half of the tray contract added for #185: the adapter now
# hands systray2 an absolute path to a committed `.ico` (systray2 reads the file itself
# and Windows cannot decode a bare PNG as an icon resource). `LoadImage` with
# `LR_LOADFROMFILE` is the same Win32 API the tray binary calls, so a non-null handle
# is the proof that the PNG-compressed ICO entry is accepted - the thing the offline
# suite cannot show. What still needs an interactive desktop, and remains unverified,
# is the rendered pixels.
#
# UNVERIFIED LOCALLY: PowerShell does not run on the Linux development host.

param(
    [Parameter(Mandatory = $true)][string]$Zip
)

$ErrorActionPreference = 'Stop'

function Assert($condition, $message) {
    if (-not $condition) { throw "ASSERT FAILED: $message" }
}

# Win32 `LoadImage`, the call the Go tray binary makes on its icon bytes.
if (-not ('IconLoad' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class IconLoad {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadImage(IntPtr hinst, string lpszName, uint uType, int cxDesired, int cyDesired, uint fuLoad);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
"@
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

    # `LoadImage` is the contract for an icon resource. A PNG-compressed ICO entry is
    # documented as accepted since Vista and the app requires Windows 10/11; this is
    # where that is checked against the shipped artifact rather than assumed.
    $LR_LOADFROMFILE = 0x0010
    $IMAGE_ICON = 1
    foreach ($state in @('tray-normal', 'tray-grey')) {
        $ico = Join-Path $payload "app\src\ui\icons\$state.ico"
        Assert (Test-Path $ico) "the artifact has no tray icon at $ico"
        $handle = [IconLoad]::LoadImage([IntPtr]::Zero, $ico, $IMAGE_ICON, 0, 0, $LR_LOADFROMFILE)
        if ($handle -eq [IntPtr]::Zero) {
            $win32 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "ASSERT FAILED: LoadImage rejected $ico (Win32 error $win32)"
        }
        [void][IconLoad]::DestroyIcon($handle)
        Write-Host "tray icon: LoadImage accepted $ico"
    }

    if ($env:GITHUB_STEP_SUMMARY) {
        Add-Content -Path $env:GITHUB_STEP_SUMMARY -Value @"
### Tray interop (packaged artifact)

Executed on the shipped artifact with its own ``node.exe``: ``app/src/ui/tray-systray.js``
resolved ``systray2`` to a function through the real Babel/CommonJS shape. The native
tray widget is still **not** started - a runner has no interactive desktop - but the
interop layer that had never worked now has an automated check on Windows. The
headless-launch and launcher steps below skip or do not assert this path.

The shipped ``app/src/ui/icons/tray-normal.ico`` and ``tray-grey.ico`` were then loaded
with Win32 ``LoadImage``/``LR_LOADFROMFILE``, the call the tray binary makes, and both
returned a non-null handle (#185). The rendered pixels remain unverified.
"@
    }
}
finally {
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}

# Reached only when every assertion above passed.
exit 0
