/**
 * Write the launcher shim, the per-user Startup-folder shim and the commented example
 * config, at install time.
 *
 * Executed by `packaging/install.ps1` from the bundled `node.exe`, and executed for real
 * on `windows-latest` since #59. What is still unverified is the *unprivileged* path:
 * the CI runner is an administrator, so it cannot prove the install works without
 * elevation (issue #163). The mechanism here - plain file writes under `%APPDATA%` and
 * `%LOCALAPPDATA%` - is chosen precisely so that an un-elevated user can perform it.
 *
 * Invoked as: node.exe <installDir>\app\src\deploy\install.js
 * The install dir is therefore three levels above this file.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInstallPlan } from './autostart.js';
import { defaultInstallDir, defaultStartupDir } from './launcher.js';

export function runInstall({
  installDir = defaultInstallDir(),
  startupDir = defaultStartupDir(),
  exampleConfigPath = null,
  writeFile = writeFileSync,
  mkdir = mkdirSync,
  fileExists = existsSync,
  log = console,
} = {}) {
  const plan = buildInstallPlan({ installDir, startupDir, exampleConfigPath });

  // Every file is a plain per-user write; nothing here needs elevation. A write error
  // (a full disk, a locked-down profile) throws naturally, and install.ps1 propagates
  // the non-zero exit instead of printing success.
  //
  // `skipIfExists` is the example config's rule (#181): a user's edited copy must
  // survive a reinstall or an update. The launcher and the Startup shim are generated
  // and are *supposed* to be refreshed, so they have no such flag.
  const skipped = [];
  for (const file of plan.files) {
    if (file.skipIfExists && fileExists(file.path)) {
      skipped.push(file.path);
      continue;
    }
    mkdir(dirname(file.path), { recursive: true });
    writeFile(file.path, file.content, 'utf8');
  }

  const launcherPath = plan.files.find((f) => f.role === 'launcher').path;
  log.log?.(
    `installed to ${installDir}; autostart shim at ${plan.startupPath}; ` +
      `example config at ${plan.exampleConfigPath}${skipped.includes(plan.exampleConfigPath) ? ' (left your copy)' : ''}`
  );
  return { launcherPath, startupPath: plan.startupPath, exampleConfigPath: plan.exampleConfigPath, skipped };
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
