/**
 * Restart decision logic: how this process starts its successor, if it can at all
 * (issue #128). Kept pure and injectable so the whole decision is exercised offline,
 * with no process, no shell and no Windows.
 *
 * The scheduled task declares `<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count>`,
 * which fires on a **non-zero** exit. It is crash recovery with a delay and a retry
 * count, not a request API. So a deliberate restart never *asks* the scheduler to do
 * it: it starts exactly one successor itself and then exits **0**, which the scheduler
 * reads as success. That is the whole defence against hazard 1 - the double-start.
 *
 * The installed app is launched by `wscript.exe "<PuzzleSolver.vbs>"`, which runs node
 * with window style `0`. A successor spawned as bare `node` would lose that and could
 * flash a console (hazard 2), so when the shim is identifiable the restart goes back
 * through it. `wscript.exe` is itself windowless and the shim hides node again, so the
 * desktop stays clean.
 *
 * Rejected mechanisms, recorded because they were plausible:
 *
 *  - **`process.execPath` re-exec.** Start-path independent, but it does not restore the
 *    hidden window and it replays whatever argv the *current* process happens to have,
 *    which is not necessarily the deployment mode the task is configured to run. The
 *    shim already encodes that mode, so it is the better authority.
 *  - **`schtasks /End` + `/Run`.** An OS-owned lifecycle that preserves the launcher,
 *    but `/End` hard-terminates the running task instance and therefore cannot run the
 *    graceful shutdown that drains an in-flight solve (hazard 4). It is also only
 *    correct under the installed task, and nothing here could verify the task identity
 *    without `schtasks.exe`.
 *  - **`RestartOnFailure` on purpose.** Never. It is the hazard.
 *
 * Where neither the marker nor an installed shim is present - a shell run, a dev
 * checkout, `config edit` - there is no honest self-restart, and the caller is handed
 * the exact command to type (hazard 6).
 */
import { spawn as spawnImpl } from 'node:child_process';
import { existsSync } from 'node:fs';

import { LAUNCHER_FILE, RESTART_LAUNCHER_ENV } from './launcher.js';

export { RESTART_LAUNCHER_ENV };

/** A hung solve must not make the process unkillable; after this the restart proceeds. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

/** `wscript.exe` is on the system PATH, but the task names it absolutely; match that. */
export function wscriptFor(env = process.env) {
  const root = env?.SystemRoot ?? env?.windir ?? null;
  return root ? `${root}\\System32\\wscript.exe` : 'wscript.exe';
}

/** The directory part of a Windows-style path, without `path.win32` (this may run on Linux). */
function windowsDirname(value) {
  const text = String(value ?? '');
  return text.replace(/[\\/][^\\/]*$/, '');
}

/** Quote one command-line part the way `cmd` would need it; spaces and quotes are the trap. */
export function quoteCommandPart(part) {
  const text = String(part ?? '');
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * The installed shim sits beside the bundled `node.exe`, so `<dir of execPath>\PuzzleSolver.vbs`
 * is the shim the task runs. Deriving it means an old launcher that predates the marker
 * still restarts hidden. Returns `null` off Windows or when there is no directory part.
 */
export function deriveLauncherPath({ platform = process.platform, execPath = process.execPath, launcherFile = LAUNCHER_FILE } = {}) {
  if (platform !== 'win32' || !execPath) return null;
  const dir = windowsDirname(execPath);
  if (!dir || dir === execPath) return null;
  return `${dir}\\${launcherFile}`;
}

/** The exact command that would restart this process, for the cases where we cannot. */
export function manualRestartCommand({ execPath = process.execPath, argv = process.argv } = {}) {
  const parts = [execPath, ...argv.slice(1)];
  return parts.filter((part) => part != null).map(quoteCommandPart).join(' ');
}

/**
 * Decide how a restart would happen. Pure: every input that could differ between a test
 * and the real process is a parameter.
 *
 * @returns {{restartable: boolean, mechanism: 'launcher'|'manual', command: string|null,
 *   args: string[], display: string, reason: string}}
 */
export function planRestart({
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  env = process.env,
  launcherPath = env?.[RESTART_LAUNCHER_ENV] ?? null,
  fileExists = existsSync,
  launcherFile = LAUNCHER_FILE,
} = {}) {
  // Prefer the marker: it names the shim that actually started us, even if the install
  // moved. Fall back to the shim beside the bundled node.exe.
  const candidates = [];
  if (launcherPath) candidates.push(launcherPath);
  if (platform === 'win32') {
    const derived = deriveLauncherPath({ platform, execPath, launcherFile });
    if (derived) candidates.push(derived);
  }
  const launcher = candidates.find((candidate) => candidate && fileExists(candidate));

  if (platform === 'win32' && launcher) {
    return {
      restartable: true,
      mechanism: 'launcher',
      command: wscriptFor(env),
      args: [launcher],
      display: `${quoteCommandPart(wscriptFor(env))} ${quoteCommandPart(launcher)}`,
      reason: launcherPath && launcher === launcherPath ? 'started-by-launcher' : 'installed-launcher',
    };
  }

  return {
    restartable: false,
    mechanism: 'manual',
    command: null,
    args: [],
    display: manualRestartCommand({ execPath, argv }),
    reason: platform === 'win32' ? 'no-launcher' : 'not-windows',
  };
}

/**
 * Start exactly one successor, detached, and do not wait for it. The caller must have
 * released the port and the database first; `createShutdownHandler` guarantees that by
 * calling `app.stop()` before this.
 *
 * `wscript.exe` is a GUI-subsystem program, so `windowsHide` here only reinforces that
 * there is no console to show; the shim's own `shell.Run ..., 0, False` hides node.
 */
export function spawnSuccessor(plan, { spawn = spawnImpl, logger = null } = {}) {
  if (!plan?.restartable) {
    logger?.warn?.(`restart is not available here; run: ${plan?.display ?? 'the service command'}`);
    return { spawned: false, reason: plan?.reason ?? 'not-restartable', display: plan?.display ?? null };
  }
  const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref?.();
  logger?.info?.(`restart: started successor (${plan.display}), pid ${child.pid ?? 'unknown'}`);
  return { spawned: true, pid: child.pid ?? null, display: plan.display };
}

/**
 * Wait for the shared solve lock to drain, bounded. `app.quiesce()` has already stopped
 * the ingresses, so no new solve can be queued while this waits; the only work left is
 * the solve already in flight. A timeout is logged (never silent) and the restart
 * proceeds - a stuck solve must not leave the process unable to restart.
 */
export async function drainSolves(core, { timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS, logger = null } = {}) {
  if (!core || typeof core.whenIdle !== 'function') return { drained: true, reason: 'no-core' };
  const idle = core.whenIdle();
  if (!idle || typeof idle.then !== 'function') return { drained: true, reason: 'already-idle' };

  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  // A rejected lock promise still means "nothing is running any more" for our purpose.
  const outcome = await Promise.race([idle.then(() => 'idle', () => 'idle'), timeout]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    logger?.warn?.(`a solve was still running after ${timeoutMs}ms; restarting anyway`);
    return { drained: false, reason: 'timeout' };
  }
  return { drained: true, reason: 'idle' };
}

/**
 * The one shutdown path, shared by SIGINT/SIGTERM, the tray Quit item and a requested
 * restart. `exit(0)` is not incidental: it is what keeps `RestartOnFailure` from firing.
 *
 * For a restart it first quiesces the ingresses, drains the in-flight solve, and only
 * then calls `app.stop()` - so the successor is spawned after the port and the SQLite
 * file have been released (hazard 5), not merely assumed to be.
 *
 * A restart is refused (without exiting) when no mechanism applies, so a caller that
 * somehow asks for one anyway cannot take the service down by mistake.
 */
export function createShutdownHandler({
  app,
  tray = null,
  plan = null,
  spawn = spawnImpl,
  logger = null,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
  exit = (code) => process.exit(code),
} = {}) {
  let closing = false;

  return async function shutdown(signal = 'signal') {
    if (closing) return { closed: false, reason: 'already-closing' };

    if (signal === 'restart' && !plan?.restartable) {
      logger?.warn?.(`restart is not available here; run: ${plan?.display ?? 'the service command'}`);
      return { closed: false, reason: 'restart-unavailable', display: plan?.display ?? null };
    }

    closing = true;
    logger?.info?.(`received ${signal}; shutting down`);
    try {
      await tray?.stop?.();
    } catch {
      // a dead tray must not block shutdown
    }
    if (signal === 'restart') {
      try {
        await app.quiesce?.();
      } catch {
        // quiesce is best-effort; app.stop() below is the real release
      }
      await drainSolves(app.core, { timeoutMs: drainTimeoutMs, logger });
    }

    let error = null;
    try {
      await app.stop();
    } catch (err) {
      error = err;
      logger?.warn?.(`shutdown hit an error: ${err?.message ?? err}`);
    }

    if (signal === 'restart') {
      try {
        spawnSuccessor(plan, { spawn, logger });
      } catch (err) {
        // A successor that cannot be spawned must not change the exit code: a non-zero
        // exit would make the scheduler start its own, and then a half-dead app would
        // contend for the port. Better to exit clean and be restarted at next logon.
        logger?.warn?.(`could not start a successor: ${err?.message ?? err}`);
      }
    }
    exit(0);
    return { closed: true, error: error ?? null };
  };
}
