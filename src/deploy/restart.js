/**
 * Restart decision logic: how this process starts its successor, if it can at all
 * (issue #128). Kept pure and injectable so the whole decision is exercised offline,
 * with no process, no shell and no Windows.
 *
 * The installed app is autostarted by a per-user Startup-folder shim (#163), which has no
 * `RestartOnFailure`; the rule is nevertheless unchanged: a deliberate restart starts
 * exactly one successor itself and then exits **0**, so nothing starts a second copy. That
 * is the whole defence against hazard 1 - the double-start.
 *
 * But only a successor that actually started gets that clean exit. `spawn` reports a
 * missing command asynchronously on `'error'` (never by throwing), so the restart waits
 * for `'spawn'` or `'error'` before deciding: success exits **0**, failure exits **non-zero**.
 * There is no successor on that path, so the port contention the clean exit guards against
 * cannot happen. (Before #163 a scheduled task's `RestartOnFailure` retried a non-zero exit;
 * the Startup-folder mechanism has no such recovery, so a failed restart now waits for the
 * next logon. The realistic failure - no launcher - is a damaged install, not a crash.)
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
 *  - **`schtasks /End` + `/Run`.** Was an OS-owned lifecycle that preserved the launcher,
 *    but `/End` hard-terminates the running task instance and therefore cannot run the
 *    graceful shutdown that drains an in-flight solve (hazard 4). The scheduled task was
 *    dropped in #163, so it is no longer an option at all.
 *  - **Relying on the scheduler's crash recovery on purpose.** Never. It was the hazard when
 *    a task existed, and the task itself is gone (#163).
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
 * Start exactly one successor, detached, and wait only long enough to learn whether it
 * actually started. The caller must have released the port and the database first;
 * `createShutdownHandler` guarantees that by calling `app.stop()` before this.
 *
 * `'spawn'` fires when the OS created the process; `'error'` fires when it did not (a
 * missing launcher is the realistic case). `spawn` never throws for a missing command,
 * so the outcome cannot be known synchronously - hence the async signature and the
 * truthful `spawned` it returns. `pid` is still filled in once the process exists.
 *
 * `wscript.exe` is a GUI-subsystem program, so `windowsHide` here only reinforces that
 * there is no console to show; the shim's own `shell.Run ..., 0, False` hides node.
 *
 * @returns {Promise<{spawned: boolean, pid?: number|null, reason?: string, error?: Error|null, display: string|null}>}
 */
export async function spawnSuccessor(plan, { spawn = spawnImpl, logger = null } = {}) {
  if (!plan?.restartable) {
    logger?.warn?.(`restart is not available here; run: ${plan?.display ?? 'the service command'}`);
    return { spawned: false, reason: plan?.reason ?? 'not-restartable', display: plan?.display ?? null };
  }

  let child;
  try {
    child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore', windowsHide: true });
  } catch (err) {
    // A synchronous throw (invalid invocation) is still a failure the caller must be
    // able to act on, so it is reported, not rethrown.
    logger?.warn?.(`could not start a successor: ${err?.message ?? err}`);
    return { spawned: false, reason: 'spawn-error', error: err ?? null, display: plan.display };
  }
  child.unref?.();

  const outcome = await new Promise((resolve) => {
    const onSpawn = () => { cleanup(); resolve('spawn'); };
    const onError = (err) => { cleanup(); resolve({ error: err }); };
    const cleanup = () => {
      child.removeListener?.('spawn', onSpawn);
      child.removeListener?.('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

  if (outcome === 'spawn') {
    logger?.info?.(`restart: started successor (${plan.display}), pid ${child.pid ?? 'unknown'}`);
    return { spawned: true, pid: child.pid ?? null, display: plan.display };
  }
  logger?.warn?.(`could not start a successor: ${outcome.error?.message ?? outcome.error}`);
  return { spawned: false, reason: 'spawn-error', error: outcome.error ?? null, display: plan.display };
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
    // Deliberately *not* `unref()`ed: the timer is the only thing that can settle the
    // race when the lock never drains, and an unref'd timer lets the event loop drain
    // first (observed on Node 22.13.0, where the node:test runner then cancelled the
    // subtest). It is always cleared once the race settles, so it never lingers.
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
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
 * restart. A **successful** restart `exit(0)` is not incidental: it is what keeps a
 * second copy from starting. A restart whose successor did not start exits **non-zero**
 * instead; there is no scheduler to retry it, so that is the last thing the process does.
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
      let spawned = false;
      try {
        ({ spawned } = await spawnSuccessor(plan, { spawn, logger }));
      } catch (err) {
        // spawnSuccessor reports its own failures; this only catches a truly unexpected
        // rejection, which is still a failed restart and takes the non-zero path below.
        logger?.warn?.(`could not start a successor: ${err?.message ?? err}`);
      }
      if (!spawned) {
        // No successor exists, so nothing can contend for the port. Before #163 a
        // non-zero exit asked the task's RestartOnFailure to bring the service back;
        // the Startup-folder mechanism has no such recovery, so this now leaves the
        // service down until the next logon. Kept non-zero because a silent success
        // would misreport a dead process as a running one.
        logger?.warn?.('no successor was started; exiting non-zero (no autostart recovery until the next logon)');
        exit(1);
        return { closed: true, restarted: false, error: error ?? null };
      }
    }
    exit(0);
    return { closed: true, error: error ?? null };
  };
}
