/**
 * Ask the running app to stop, gracefully (issue #168).
 *
 * This is the half of the updater that touches the app's own lifecycle. The updater
 * cannot replace a running `node.exe` on Windows and must not force-kill it - that
 * would lose an in-flight solve - so it calls this script with the *installed* runtime
 * before it replaces anything. The request travels through the single-instance lock
 * (`src/instance.js`), which is the one place that knows whether an app is running and
 * which pid owns it (#212); the running app watches for the request and runs the same
 * shutdown path as SIGINT/SIGTERM, the tray Quit and a restart (#167, #128).
 *
 * Run as: node.exe <installDir>\app\src\deploy\stop.js
 * The lock path is resolved the same way the app resolves it, from `%LOCALAPPDATA%`,
 * so the updater and the app cannot disagree about which instance is running.
 *
 * Exit code is the contract the updater checks: 0 when the app is gone (stopped, or was
 * never running), 1 when a live holder ignored the request within the bound. An exit of
 * 1 must abort the update before any file is replaced.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestInstanceStop, resolveInstanceLockPath } from '../instance.js';

/** Hard bound on how long the app is given to drain before the updater gives up. */
export const STOP_TIMEOUT_MS = 30_000;

export async function runStop({
  lockPath = resolveInstanceLockPath(),
  timeoutMs = STOP_TIMEOUT_MS,
  requestStop = requestInstanceStop,
  log = console,
} = {}) {
  const result = await requestStop({ lockPath, timeoutMs });
  if (!result.running) {
    // A stale lock is not a failure: the files are already free, and the next start
    // replaces the record through the ordinary stale path.
    log.log?.('PuzzleSolver is not running; nothing to stop.');
    return { ...result, exitCode: 0 };
  }
  if (result.stopped) {
    log.log?.(`PuzzleSolver (pid ${result.pid}) stopped gracefully.`);
    return { ...result, exitCode: 0 };
  }
  log.warn?.(
    `PuzzleSolver (pid ${result.pid}) did not stop within ${timeoutMs}ms; refusing to touch the install.`
  );
  return { ...result, exitCode: 1 };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runStop()
    .then(({ exitCode }) => {
      process.exitCode = exitCode;
    })
    .catch((err) => {
      console.warn(`could not stop PuzzleSolver: ${err?.message ?? err}`);
      process.exitCode = 1;
    });
}
