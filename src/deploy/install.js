/**
 * Register the logon task and write the launcher shim, at install time.
 *
 * UNVERIFIED ON WINDOWS. This runner is executed by `packaging/install.ps1` from the
 * bundled `node.exe`; it has never run on this host. The decisions it acts on - the
 * task XML, the shim text, the `schtasks` arguments - are built by `autostart.js` and
 * `launcher.js` and asserted there.
 *
 * Invoked as: node.exe <installDir>\app\src\deploy\install.js
 * The install dir is therefore three levels above this file.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallPlan, TASK_NAME } from './autostart.js';
import { buildLauncherVbs, defaultInstallDir } from './launcher.js';

export function runInstall({
  installDir = defaultInstallDir(),
  writeFile = writeFileSync,
  mkdir = mkdirSync,
  spawn = spawnSync,
  log = console,
} = {}) {
  const launcherPath = `${installDir}\\PuzzleSolver.vbs`;
  const plan = buildInstallPlan({ installDir, launcherPath });
  const vbs = buildLauncherVbs();

  mkdir(installDir, { recursive: true });
  writeFile(launcherPath, vbs, 'utf8');

  const xmlFile = plan.files.find((f) => f.path.endsWith('.task.xml'));
  mkdir(dirname(xmlFile.path), { recursive: true });
  writeFile(xmlFile.path, xmlFile.content, 'utf8');

  for (const { command, args } of plan.commands) {
    const result = spawn(command, args, { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status}`);
  }
  log.log?.(`installed ${TASK_NAME} to ${installDir}, task registered`);
  return { launcherPath, xmlPath: xmlFile.path };
}

// Run only when executed, not when imported by a test.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // installDir is <thisFile>/../../.. i.e. the app root's parent.
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, '..', '..');
  const root = resolve(appRoot, '..');
  runInstall({ installDir: root });
}
