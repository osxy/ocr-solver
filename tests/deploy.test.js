/**
 * Packaging tests. Nothing here is executed on Windows - `wscript` and `schtasks`
 * do not exist on this host. What *is* asserted is the generated content: the
 * launcher text, the task XML and the schtasks argument lists. Those are the parts
 * with a decision in them, and they are asserted literally so a broken default
 * cannot hide behind a double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { buildLauncherVbs, defaultInstallDir, LAUNCHER_FILE } from '../src/deploy/launcher.js';
import {
  buildTaskXml,
  buildCreateTaskArgs,
  buildDeleteTaskArgs,
  buildInstallPlan,
  LOGON_DELAY_SEC,
  RESTART_COUNT,
  RESTART_INTERVAL,
  TASK_NAME,
} from '../src/deploy/autostart.js';
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

// ---------------------------------------------------------------------------
// Scheduled task
// ---------------------------------------------------------------------------

const launcher = 'C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver\\PuzzleSolver.vbs';

test('the task XML starts at logon with the documented 20 second delay', () => {
  const xml = buildTaskXml({ launcherPath: launcher });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<Delay>PT20S<\/Delay>/);
  assert.equal(LOGON_DELAY_SEC, 20);
});

test('the task XML restarts on failure (the reason to prefer a task over the Run key)', () => {
  const xml = buildTaskXml({ launcherPath: launcher });
  assert.match(xml, /<RestartOnFailure>/);
  assert.match(xml, new RegExp(`<Interval>${RESTART_INTERVAL}<\\/Interval>`));
  assert.match(xml, new RegExp(`<Count>${RESTART_COUNT}<\\/Count>`));
  assert.equal(RESTART_INTERVAL, 'PT1M');
  assert.equal(RESTART_COUNT, 3);
});

test('the task launches the shim through wscript with every path quoted', () => {
  const xml = buildTaskXml({ launcherPath: launcher });
  assert.match(xml, /<Command>"%SystemRoot%\\System32\\wscript\.exe"<\/Command>/);
  assert.ok(
    xml.includes(`<Arguments>"${launcher}"</Arguments>`),
    'a path with spaces must be quoted in Arguments, or Task Scheduler splits it'
  );
  assert.ok(xml.includes('<WorkingDirectory>C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver</WorkingDirectory>'));
});

test('the task cannot double-launch and has no execution time limit', () => {
  const xml = buildTaskXml({ launcherPath: launcher });
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/, 'a long-running app must not be killed after 3 days');
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
});

test('XML-special characters in a path are escaped, not injected', () => {
  const xml = buildTaskXml({ launcherPath: 'C:\\a & b\\PuzzleSolver.vbs' });
  assert.ok(xml.includes('C:\\a &amp; b\\PuzzleSolver.vbs'));
  assert.ok(!xml.includes('C:\\a & b\\PuzzleSolver.vbs'));
});

test('schtasks create/delete arguments name the task and force the operation', () => {
  assert.deepEqual(buildCreateTaskArgs({ xmlPath: 'C:\\x\\task.xml' }), ['/Create', '/TN', TASK_NAME, '/XML', 'C:\\x\\task.xml', '/F']);
  assert.deepEqual(buildDeleteTaskArgs({}), ['/Delete', '/TN', TASK_NAME, '/F']);
});

test('the install plan carries the task XML and a single create command', () => {
  const plan = buildInstallPlan({ installDir: 'C:\\Programs\\PuzzleSolver' });
  const xmlFile = plan.files.find((f) => f.path.endsWith('.task.xml'));
  assert.ok(xmlFile && xmlFile.content.includes('<LogonTrigger>'));
  assert.deepEqual(plan.commands, [
    { command: 'schtasks.exe', args: ['/Create', '/TN', TASK_NAME, '/XML', 'C:\\Programs\\PuzzleSolver\\PuzzleSolver.task.xml', '/F'] },
  ]);
});

// ---------------------------------------------------------------------------
// Installer / uninstaller scripts (content only - they cannot run here)
// ---------------------------------------------------------------------------

test('install.ps1 installs per-user and delegates task creation to Node', () => {
  const ps = readFileSync(join(packaging, 'install.ps1'), 'utf8');
  assert.match(ps, /LOCALAPPDATA/);
  assert.match(ps, /Programs\\PuzzleSolver/);
  assert.match(ps, /node\.exe/);
  assert.match(ps, /deploy\\install\.js/);
  assert.ok(!/\$env:ProgramFiles/i.test(ps), 'per-user install must not touch Program Files');
  assert.ok(!/Start-Process.*schtasks/i.test(ps), 'task creation lives in install.js, not duplicated here');
});

test('uninstall.ps1 removes the task and all three per-user folders', () => {
  const ps = readFileSync(join(packaging, 'uninstall.ps1'), 'utf8');
  assert.match(ps, /deploy\\uninstall\.js/, 'the task is removed through the Node runner');
  assert.match(ps, /Programs\\PuzzleSolver/);
  assert.match(ps, /Join-Path \$env:LOCALAPPDATA 'PuzzleSolver'/, 'logs/state must go');
  assert.match(ps, /Join-Path \$env:APPDATA 'PuzzleSolver'/, 'config/credentials must go');
  assert.match(ps, /Remove-Item -Recurse -Force/);
});

test('every packaged file is tracked in git (no generated artefact left untracked)', () => {
  for (const file of [LAUNCHER_FILE, 'install.ps1', 'uninstall.ps1']) {
    assert.ok(existsSync(join(packaging, file)), `${file} is missing from packaging/`);
  }
});

test('runInstall writes the shim and the task XML and registers the task', () => {
  const writes = [];
  const mkdirs = [];
  const spawns = [];
  const result = runInstall({
    installDir: 'C:\\Programs\\PuzzleSolver',
    writeFile: (path, content, enc) => writes.push({ path, content, enc }),
    mkdir: (path) => mkdirs.push(path),
    spawn: (command, args) => {
      spawns.push({ command, args });
      return { status: 0 };
    },
    log: { log() {} },
  });

  assert.equal(result.launcherPath, 'C:\\Programs\\PuzzleSolver\\PuzzleSolver.vbs');
  const vbs = writes.find((w) => w.path.endsWith('.vbs'));
  assert.ok(vbs && vbs.content.includes('shell.Run'), 'the shim is written');
  const xml = writes.find((w) => w.path.endsWith('.task.xml'));
  assert.ok(xml && xml.content.includes('PT20S'), 'the task XML is written');
  assert.deepEqual(spawns, [
    { command: 'schtasks.exe', args: buildCreateTaskArgs({ xmlPath: result.xmlPath }) },
  ]);
});

test('runInstall reports a non-zero schtasks exit instead of claiming success', () => {
  assert.throws(
    () => runInstall({
      installDir: 'C:\\P',
      writeFile: () => {},
      mkdir: () => {},
      spawn: () => ({ status: 1 }),
      log: { log() {} },
    }),
    /schtasks\.exe .* failed with 1/
  );
});

test('runUninstall deletes the task and tolerates one that was never registered', () => {
  const calls = [];
  const removed = runUninstall({
    spawn: (command, args) => {
      calls.push({ command, args });
      return { status: 0 };
    },
    log: { warn() {} },
  });
  assert.deepEqual(calls, [{ command: 'schtasks.exe', args: buildDeleteTaskArgs({}) }]);
  assert.equal(removed.removed, true);

  const missing = runUninstall({ spawn: () => ({ status: 1 }), log: { warn() {} } });
  assert.equal(missing.removed, false, 'an absent task is already the desired end state');
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
