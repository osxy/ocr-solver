/**
 * Autostart registration.
 *
 * **A per-user Startup-folder entry, not a scheduled task (issue #163).** DESIGN 11
 * originally chose a Task Scheduler task for its logon trigger, 20 s delay and
 * "restart on failure". On a real machine, in an ordinary PowerShell, `schtasks
 * /Create` was refused with `Toegang geweigerd`: the service writes the task definition
 * into the root task folder, which a standard user may not write. `%LOCALAPPDATA%` (the
 * install dir) needs no elevation, so the copying half worked and only the autostart
 * half failed.
 *
 * The Startup folder needs no elevation at all and is already per-user, so it reaches the
 * same "starts at logon" outcome with nothing an ordinary user cannot do. The two extras
 * the task had are handled honestly:
 *
 *  - the **20 s delay** is reproduced with `WScript.Sleep` in the startup shim
 *    (`launcher.js`), because a manual start must not wait;
 *  - **restart on failure** is dropped. It was a no-op for an app crash: the task's
 *    action is `wscript.exe`, which runs node with `shell.Run ..., 0, False` and exits
 *    immediately, so the task instance ended before the app could fail. The only path
 *    it ever covered was a failed *deliberate* restart (#135), and that now falls back
 *    to the next logon. The app's own restart logic (#128) does not need it.
 *
 * The plan is data - the files to write and where - so the deploy logic is asserted on
 * Linux even though only a Windows runner can create the files for real.
 */
import {
  buildLauncherVbs,
  buildStartupVbs,
  defaultStartupDir,
  LAUNCHER_FILE,
  STARTUP_FILE,
} from './launcher.js';

export { STARTUP_FILE, defaultStartupDir };

/** Logon delay, in seconds, before the startup shim launches the app. */
export const LOGON_DELAY_SEC = 20;

/**
 * Describe the whole install as data - the files to write and where - without writing
 * anything. `install.js` executes it; `tests/deploy.test.js` asserts it. This is the
 * seam that keeps the deploy logic verifiable on Linux.
 *
 * @param {object} options
 * @param {string} options.installDir
 * @param {string} [options.launcherPath]
 * @param {string} [options.startupDir]
 * @param {string} [options.startupPath] explicit startup-shim path (tests)
 * @param {number} [options.delaySec]
 */
export function buildInstallPlan({
  installDir,
  launcherPath = null,
  startupDir = null,
  startupPath = null,
  delaySec = LOGON_DELAY_SEC,
} = {}) {
  if (!installDir) throw new Error('buildInstallPlan needs an installDir');
  const launcher = launcherPath ?? `${installDir}\\${LAUNCHER_FILE}`;
  const startup = startupPath ?? `${startupDir ?? defaultStartupDir()}\\${STARTUP_FILE}`;
  return {
    target: 'win32',
    startupPath: startup,
    files: [
      { role: 'launcher', path: launcher, content: buildLauncherVbs() },
      { role: 'startup', path: startup, content: buildStartupVbs({ launcherPath: launcher, delaySec }) },
    ],
  };
}
