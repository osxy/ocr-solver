/**
 * Remove the logon task. Directory removal is left to `packaging/uninstall.ps1`,
 * because a running Node process cannot delete its own install directory on Windows.
 *
 * UNVERIFIED ON WINDOWS: `schtasks.exe` is not available here, so only the argument
 * construction in `autostart.js` is asserted.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeleteTaskArgs, TASK_NAME } from './autostart.js';

export function runUninstall({ spawn = spawnSync, log = console } = {}) {
  const args = buildDeleteTaskArgs({ taskName: TASK_NAME });
  const result = spawn('schtasks.exe', args, { stdio: 'inherit' });
  // A task that was never registered is already the desired end state.
  const missing = result.status !== 0;
  if (missing) log.warn?.(`schtasks ${args.join(' ')} returned ${result.status}; assuming no task to remove`);
  return { removed: !missing, args };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runUninstall();
