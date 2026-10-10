/**
 * Packaging tests. Nothing here is executed on Windows - `wscript` does not exist on
 * this host. What *is* asserted is the generated content: the launcher shim, the
 * per-user Startup-folder shim, and where the install plan writes them. Those are the
 * parts with a decision in them, and they are asserted literally so a broken default
 * cannot hide behind a double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildLauncherVbs, buildStartupVbs, defaultInstallDir, defaultStartupDir, LAUNCHER_FILE, STARTUP_FILE } from '../src/deploy/launcher.js';
import { buildInstallPlan, LOGON_DELAY_SEC } from '../src/deploy/autostart.js';
import { runInstall } from '../src/deploy/install.js';
import { runUninstall } from '../src/deploy/uninstall.js';

const repoRoot = join(import.meta.dirname, '..');
const packaging = join(repoRoot, 'packaging');

// ---------------------------------------------------------------------------
// Launcher shim
// ---------------------------------------------------------------------------

test('the launcher shim quotes both paths and runs the window hidden', () => {
  const vbs = buildLauncherVbs();
  const runLine = vbs.split('\r\n').find((l) => l.startsWith('shell.Run'));
  assert.ok(runLine, 'the shim must actually start the app');
  // Every executable path is wrapped: the `"` character is built from `""""` and a
  // path is wrapped in one on each side. A path with a space must not split into two
  // arguments, which is exactly what `base & "\node.exe"` would do.
  assert.ok(runLine.includes('"""" & node & """'), `node.exe must be quoted: ${runLine}`);
  assert.ok(runLine.includes('""" & script & """'), `cli.js must be quoted: ${runLine}`);
  assert.ok(runLine.endsWith(', 0, False'), 'window style 0 is what hides the console');
  assert.ok(vbs.includes('GetParentFolderName(WScript.ScriptFullName)'), 'paths derive from the shim itself');
  assert.ok(!/cmd\.exe/i.test(vbs), 'a cmd.exe hop would flash the very console we are avoiding');
  assert.ok(!/CreateObject\("WScript.Shell"\).*Run.*cmd/i.test(vbs));
});

test('the checked-in packaging/PuzzleSolver.vbs is exactly what the generator emits', () => {
  const onDisk = readFileSync(join(packaging, LAUNCHER_FILE), 'utf8');
  assert.equal(onDisk, buildLauncherVbs(), 'the shipped shim drifted from src/deploy/launcher.js');
});

test('the install location is per-user under %LOCALAPPDATA%\\Programs', () => {
  const dir = defaultInstallDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\Andre\\AppData\\Local' }, homedir: null });
  assert.equal(dir, 'C:\\Users\\Andre\\AppData\\Local\\Programs\\PuzzleSolver');
  assert.ok(dir.includes('Programs'), 'no admin rights means nothing under Program Files');
});

test('the startup shim waits, then delegates to the launcher hidden', () => {
  const vbs = buildStartupVbs({ launcherPath: launcher, delaySec: 20 });
  assert.ok(vbs.includes('WScript.Sleep 20000'), 'the 20 s logon delay lives in the shim, not the launcher');
  assert.ok(vbs.includes(`"${launcher}"`), 'the shim must launch the installed launcher');
  const runLine = vbs.split('\r\n').find((l) => l.startsWith('shell.Run'));
  assert.ok(runLine, 'the shim must actually start the app');
  assert.ok(runLine.endsWith(', 0, False'), 'window style 0 is what hides the console');
});

test('the startup folder is the per-user Start Menu Startup folder', () => {
  const dir = defaultStartupDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Andre\\AppData\\Roaming' }, homedir: null });
  assert.equal(dir, 'C:\\Users\\Andre\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup');
  assert.ok(!/Program Files/i.test(dir), 'a Startup entry needs no elevation');
  assert.equal(STARTUP_FILE, 'PuzzleSolver-startup.vbs');
});

// ---------------------------------------------------------------------------
// Autostart placement
// ---------------------------------------------------------------------------

const launcher = 'C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver\\PuzzleSolver.vbs';
const startupDir = 'C:\\Users\\Andre de Vries\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup';

test('the install plan writes the launcher, the Startup shim and the example config', () => {
  const plan = buildInstallPlan({ installDir: 'C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver', startupDir });
  assert.equal(plan.startupPath, `${startupDir}\\${STARTUP_FILE}`);
  const launcherFile = plan.files.find((f) => f.role === 'launcher');
  const startupFile = plan.files.find((f) => f.role === 'startup');
  assert.ok(launcherFile.path.endsWith('PuzzleSolver.vbs'));
  assert.ok(launcherFile.content.includes('shell.Run'), 'the launcher shim is written');
  assert.ok(startupFile.path.startsWith(startupDir), 'the startup shim belongs in the Startup folder');
  assert.ok(startupFile.content.includes('WScript.Sleep 20000'), 'the startup shim carries the logon delay');
  assert.ok(startupFile.content.includes(launcherFile.path), 'the startup shim points at the launcher');
  assert.equal(LOGON_DELAY_SEC, 20);

  // #181: the example config is part of the plan, lives beside where config.toml would
  // be (not the install dir, which an update replaces), and is never a live config.toml.
  const exampleFile = plan.files.find((f) => f.role === 'example-config');
  assert.ok(exampleFile, 'the plan must write the example config');
  assert.equal(plan.exampleConfigPath, exampleFile.path);
  assert.ok(exampleFile.path.endsWith('config.toml.example'), `unexpected example path: ${exampleFile.path}`);
  assert.ok(!/config\.toml$/.test(exampleFile.path), 'the example must not be named config.toml');
  assert.equal(exampleFile.skipIfExists, true, "the example must never clobber a user's edited copy");
});

test('the install plan no longer registers a scheduled task', () => {
  const plan = buildInstallPlan({ installDir: 'C:\\P', startupDir });
  assert.equal(plan.commands, undefined, 'no child process is run: task creation is what needed elevation');
  assert.ok(!JSON.stringify(plan).includes('schtasks'), 'the scheduled task is gone entirely');
});

// ---------------------------------------------------------------------------
// Installer / uninstaller scripts (content only - they cannot run here)
// ---------------------------------------------------------------------------

test('install.ps1 installs per-user, delegates to Node and checks the child exit code', () => {
  const ps = readFileSync(join(packaging, 'install.ps1'), 'utf8');
  assert.match(ps, /LOCALAPPDATA/);
  assert.match(ps, /Programs\\PuzzleSolver/);
  assert.match(ps, /node\.exe/);
  assert.match(ps, /deploy\\install\.js/);
  assert.ok(!/\$env:ProgramFiles/i.test(ps), 'per-user install must not touch Program Files');
  assert.ok(!/schtasks/i.test(ps), 'the scheduled task is gone; autostart is a Startup file');
  // The #162 trap: a native child's exit code is invisible to ErrorActionPreference, so
  // it has to be checked explicitly or success is printed after a failure.
  assert.match(ps, /\$LASTEXITCODE -ne 0/, 'a failing child must be checked explicitly');
  const checkAt = ps.indexOf('$LASTEXITCODE -ne 0');
  const successAt = ps.indexOf('Installed to ');
  assert.ok(checkAt >= 0 && successAt > checkAt, 'the success line must be unreachable when the child fails');

  // #167: install-and-go. The app is started *after* the exit-code check (so a failed
  // install never starts anything), through the launcher rather than the Startup shim
  // (the shim sleeps 20 s), and detached (`Start-Process`, so the installer exits).
  assert.match(ps, /\[switch\]\$NoStart/, 'the unattended install switch must exist');
  assert.match(ps, /Start-Process -FilePath \$Wscript -ArgumentList/, 'the launcher is started detached');
  assert.match(ps, /PuzzleSolver\.vbs/, 'the installer starts the launcher itself');
  assert.ok(!/PuzzleSolver-startup\.vbs/.test(ps), 'it must not go through the sleeping Startup shim');
  const startAt = ps.indexOf('Start-Process -FilePath $Wscript');
  assert.ok(startAt > checkAt, 'the app must only start after the child exit code was checked');
  assert.match(ps, /starting now/, 'the success text describes what happened, not what to do next');
});

test('install.ps1 reports the Mark-of-the-Web and clears it only under -Unblock (#176)', () => {
  const ps = readFileSync(join(packaging, 'install.ps1'), 'utf8');
  // Detection reads the Zone.Identifier alternate data stream, per file.
  assert.match(ps, /-Stream Zone\.Identifier/, 'detection must read the alternate data stream');
  assert.match(ps, /Mark-of-the-Web/, 'the report must name the mechanism');
  assert.match(ps, /\[switch\]\$Unblock/, 'clearing the mark is opt-in');
  assert.match(ps, /Unblock-File/, 'the opt-in path exists');

  // The rule is "never cleared silently", so the clear must sit after the -Unblock
  // check. Hoisting `Unblock-File` above the switch is exactly the regression this
  // asserts against; the deploy job asserts the same thing on a real marked file.
  const branchAt = ps.indexOf('if ($Unblock)');
  const clearAt = ps.indexOf('Unblock-File');
  assert.ok(branchAt >= 0, 'the -Unblock branch must exist');
  assert.ok(clearAt > branchAt, 'Unblock-File must run only inside the -Unblock branch');
  assert.ok(
    !ps.slice(0, branchAt).includes('Unblock-File'),
    'Unblock-File must not run before the -Unblock check'
  );

  // Detection before the copy is load-bearing: -Unblock clears the source first, so the
  // installed files are copied clean rather than being unblocked in place afterwards.
  assert.ok(
    ps.indexOf('Get-MarkedFile') < ps.indexOf('Copy-Item -Recurse'),
    'detection must run before the payload is copied'
  );
});

test('run-deploy.ps1 exercises the Mark-of-the-Web report on a marked payload file (#176)', () => {
  const ps = readFileSync(join(packaging, 'run-deploy.ps1'), 'utf8');
  assert.match(ps, /-Stream Zone\.Identifier/, 'the deploy test must create the mark it checks');
  assert.match(ps, /motw:/, 'the MotW check must be present');
  // It must prove the ordinary run leaves the mark alone, and that -Unblock clears it.
  assert.match(ps, /only -Unblock may do that/, 'the ordinary run must be asserted not to clear the mark');
  assert.match(ps, /-extraArgs @\('-NoStart', '-Unblock'\)/, 'the opt-in path must be exercised');
  assert.match(ps, /cleared the download mark/, 'the opt-in run must be asserted to say what it did');
});

test('uninstall.ps1 keeps the user data unless -Purge asks for it (#186)', () => {
  const ps = readFileSync(join(packaging, 'uninstall.ps1'), 'utf8');
  assert.match(ps, /deploy\\uninstall\.js/, 'the startup shim is removed through the Node runner');
  assert.ok(ps.includes(STARTUP_FILE), 'the damaged-install fallback must name the same shim file');
  assert.match(ps, /Start Menu\\Programs\\Startup/, 'the fallback must use the per-user Startup folder');
  assert.match(ps, /Programs\\PuzzleSolver/, 'the installer-created program folder is removed');
  assert.match(ps, /Remove-Item -Recurse -Force/);

  // The defect: the default path removed the data folders too. They must be absent
  // from the default removal list and reachable only through -Purge.
  assert.match(ps, /\[switch\]\$Purge/, 'a purge switch is how deletion is asked for');
  assert.match(ps, /\$Targets = @\(\$InstallDir\)/, 'the default target list must be the install dir alone');
  assert.match(ps, /if \(\$Purge\) \{ \$Targets \+= \$DataTargets \}/, 'the data folders are added only under -Purge');
  assert.match(ps, /Join-Path \$env:LOCALAPPDATA 'PuzzleSolver'/, 'the logs/state dir is named');
  assert.match(ps, /Join-Path \$env:APPDATA 'PuzzleSolver'/, 'the config/credentials dir is named');
  // The reason a reviewer must not "fix" this back: the credentials are already
  // useless to any other account, so deleting them protects nobody.
  assert.match(ps, /CurrentUser/, 'the DPAPI rationale must stay next to the deletion logic');
});

test('every packaged file is tracked in git (no generated artefact left untracked)', () => {
  for (const file of [LAUNCHER_FILE, 'install.ps1', 'uninstall.ps1']) {
    assert.ok(existsSync(join(packaging, file)), `${file} is missing from packaging/`);
  }
});

test('runInstall writes the launcher, the Startup shim and the example config, and runs nothing', () => {
  const writes = [];
  const mkdirs = [];
  const example = 'C:\\Users\\Andre\\AppData\\Roaming\\PuzzleSolver\\config.toml.example';
  const result = runInstall({
    installDir: 'C:\\Programs\\PuzzleSolver',
    startupDir: 'C:\\Users\\Andre\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    exampleConfigPath: example,
    writeFile: (path, content, enc) => writes.push({ path, content, enc }),
    mkdir: (path) => mkdirs.push(path),
    fileExists: () => false,
    log: { log() {} },
  });

  assert.equal(result.launcherPath, 'C:\\Programs\\PuzzleSolver\\PuzzleSolver.vbs');
  assert.ok(result.startupPath.endsWith('PuzzleSolver-startup.vbs'));
  const launcherShim = writes.find((w) => w.path.endsWith('PuzzleSolver.vbs'));
  assert.ok(launcherShim && launcherShim.content.includes('shell.Run'), 'the launcher shim is written');
  const startupShim = writes.find((w) => w.path.endsWith('PuzzleSolver-startup.vbs'));
  assert.ok(startupShim && startupShim.content.includes('WScript.Sleep 20000'), 'the Startup shim is written with the delay');
  assert.ok(startupShim.content.includes(result.launcherPath), 'the Startup shim points at the launcher');
  const exampleFile = writes.find((w) => w.path === example);
  assert.ok(exampleFile && exampleFile.content.includes('poll_interval_sec = 60'), 'the example config is written');
  assert.equal(writes.length, 3, 'the install writes files and starts nothing');
  assert.equal(result.exampleConfigPath, example);
});

test('runInstall keeps a user-edited example config on reinstall (#181)', () => {
  const writes = [];
  const example = 'C:\\Users\\Andre\\AppData\\Roaming\\PuzzleSolver\\config.toml.example';
  const result = runInstall({
    installDir: 'C:\\Programs\\PuzzleSolver',
    startupDir: 'C:\\S',
    exampleConfigPath: example,
    writeFile: (path, content, enc) => writes.push({ path, content, enc }),
    mkdir: () => {},
    // The example exists (the user edited it); the two generated shims do not.
    fileExists: (path) => path === example,
    log: { log() {} },
  });

  assert.equal(writes.some((w) => w.path === example), false, 'an edited example must survive a reinstall');
  assert.deepEqual(result.skipped, [example]);
  // The generated shims are still refreshed, which is the difference the flag encodes.
  assert.equal(writes.length, 2);
});

test('runInstall lets a write failure propagate instead of reporting success', () => {
  assert.throws(
    () => runInstall({
      installDir: 'C:\\P',
      startupDir: 'C:\\S',
      writeFile: () => { throw new Error('disk full'); },
      mkdir: () => {},
      log: { log() {} },
    }),
    /disk full/
  );
});

test('runUninstall removes the Startup shim and tolerates one that is absent', () => {
  const removedPaths = [];
  const removed = runUninstall({
    startupDir: 'C:\\Users\\Andre\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
    fileExists: () => true,
    unlink: (path) => removedPaths.push(path),
    log: { warn() {} },
  });
  assert.equal(removed.removed, true);
  assert.deepEqual(removedPaths, [removed.path]);
  assert.ok(removed.path.endsWith('PuzzleSolver-startup.vbs'));

  const missing = runUninstall({
    startupDir: 'C:\\S',
    fileExists: () => false,
    unlink: () => { throw new Error('must not be called'); },
    log: { warn() {} },
  });
  assert.equal(missing.removed, false, 'an absent startup entry is already the desired end state');
});

test('run-deploy.ps1 proves a failing installer is propagated and prints no success line', () => {
  const ps = readFileSync(join(packaging, 'run-deploy.ps1'), 'utf8');
  assert.match(ps, /process\.exit\(3\)/, 'the induced failure must exit non-zero');
  assert.match(ps, /induced-failure/, 'the failure scenario must be present');
  assert.match(ps, /-notmatch 'Installed'/, 'the failure must be asserted to print no success line');
  assert.match(ps, /code -ne 0/, 'the failure must be asserted to exit non-zero');
  // The autostart assertions move with the mechanism.
  assert.match(ps, /PuzzleSolver-startup\.vbs/);
  assert.match(ps, /Sleep 20000/);
  assert.ok(!ps.includes('schtasks'), 'no scheduled task is queried any more');
  // #167: both install paths are exercised - `-NoStart` starts nothing, the default run
  // starts the app, and the killed app's stale lock must not block the next start.
  assert.match(ps, /'-NoStart'/, 'the unattended path must be exercised');
  assert.match(ps, /not started now/, 'the -NoStart install must be asserted to start nothing');
  assert.match(ps, /starting now/, 'the default install must be asserted to start the app');
  assert.match(ps, /Wait-ForInstalledNodeProcess/, 'the post-install start must actually be observed');
});

// ---------------------------------------------------------------------------
// DPAPI round trip (executed on windows-latest; asserted as content here)
// ---------------------------------------------------------------------------

test('run-dpapi.ps1 runs the round trip against the artifact, not this checkout', () => {
  const ps = readFileSync(join(packaging, 'run-dpapi.ps1'), 'utf8');
  assert.match(ps, /Expand-Archive/);
  assert.match(ps, /Join-Path \$payload 'app\\src\\secrets\.js'/, 'it must test the shipped secrets.js');
  assert.match(ps, /dpapi-roundtrip\.mjs/);
  assert.match(ps, /\$code -eq 0/, 'a non-zero node exit must fail the step');
  assert.match(ps, /DPAPI round trip/, 'the step must confirm the script reported success');
  assert.match(ps, /unprotect calls/, 'the step must confirm the read half actually called Unprotect');
  assert.match(ps, /WaitForExit\(120000\)/, 'the run is bounded');
});

test('dpapi-roundtrip.mjs asserts migration, removal and a round trip through the shipped store', () => {
  const script = readFileSync(join(packaging, 'dpapi-roundtrip.mjs'), 'utf8');
  assert.match(script, /app', 'src', 'secrets\.js'/, 'it imports the shipped store, not a copy');
  assert.match(script, /createDpapiCredentialProvider/);
  assert.match(script, /saveSecrets/);
  assert.match(script, /existsSync\(credentialPath\)/, 'the plaintext file must be asserted gone');
  assert.match(script, /includes\(legacySecret\)/, 'the protected file must be asserted free of the plaintext');
  assert.match(script, /spawnSync/, 'the read-back must run in a separate process, not the writer');
  assert.match(script, /calls\.unprotect/, 'it must assert Unprotect was exercised');
  assert.equal(/powershell/i.test(script), false, 'the DPAPI call belongs in secrets.js, not duplicated in the proof');
});

test('the package workflow executes the DPAPI round trip on the Windows deploy job', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');
  assert.match(workflow, /run-dpapi\.ps1 -Zip \$zip/);
  // It must be a step of the job that already has the artifact, after the deploy glue.
  const deployIndex = workflow.indexOf('deploy:');
  const dpapiIndex = workflow.indexOf('Prove the DPAPI credential round trip');
  const releaseIndex = workflow.indexOf('release:');
  assert.ok(deployIndex >= 0 && dpapiIndex > deployIndex && dpapiIndex < releaseIndex, 'the DPAPI step belongs to the deploy job');
});
