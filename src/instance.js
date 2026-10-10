/**
 * Single-instance guard (issue #167).
 *
 * Until this existed, nothing stopped a second copy of the app from starting. Two
 * copies are two Pushbullet listeners, and every puzzle is answered twice - a wrong
 * answer that also spends the reply budget. That is a strictly worse outcome than
 * refusing the second start. The path a user reaches first, double-clicking the
 * launcher, had no protection at all; the restart machinery (#128/#135) went to great
 * lengths to start exactly one successor while this ordinary path did not.
 *
 * The mechanism is a lock file in the runtime data directory, beside `state.db`. It is
 * the one lock an app can take on every platform it supports (a named mutex is the
 * Windows-idiomatic alternative and would need a POSIX fallback), and the data
 * directory is already per-instance - one state database, therefore one app. The file
 * is opened with `wx`, so creating it is atomic against another process: the loser
 * gets `EEXIST`, never a half-written file.
 *
 * **Stale is the normal case, not an error.** A process that dies without cleaning up
 * (killed, crashed, or the successor of a restart racing its predecessor) leaves the
 * file behind, and that must not block a legitimate start. The file records the
 * holder's pid, and a lock is stale when that pid is not a running process - or when
 * the file is unreadable or records no pid, which is what a truncated write looks
 * like. Removal is guarded by the same `wx` creation, so two processes that both find
 * a stale lock cannot both take it.
 *
 * Known gap: pid reuse. If the OS hands the recorded pid to an unrelated process, a
 * stale lock can look live and the new start is refused. The realistic triggers
 * (reboot, a long-lived unrelated process) are rare enough that the alternative - a
 * heartbeat or a cross-platform process-start-time probe - is not yet worth its cost.
 * A `release()` that outlives its process cannot help; the stale check is the answer.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultStatePath } from './config.js';

/** The lock file beside `state.db`; the name is deliberately boring and obvious. */
export const INSTANCE_LOCK_FILE = 'instance.lock';

/**
 * The second start's refusal. The CLI turns this into a message instead of a stack
 * trace, because it is an expected outcome, not a crash.
 */
export class AlreadyRunningError extends Error {
  constructor(holder = null, { lockPath = null } = {}) {
    const who = holder?.pid != null ? `pid ${holder.pid}` : 'another process';
    super(
      `PuzzleSolver is already running (${who}); this start will exit without starting ` +
        'a listener. Quit the running instance from the tray, then start it again.'
    );
    this.name = 'AlreadyRunningError';
    this.holder = holder;
    this.lockPath = lockPath;
  }
}

/** Where the lock lives for a given state database. Sibling, not global, so a
 * per-test `statePath` cannot collide with a real installation. */
export function instanceLockPathForStatePath(statePath) {
  return join(dirname(statePath), INSTANCE_LOCK_FILE);
}

/** Resolve the lock path the same way `createApp` resolves its state path. */
export function resolveInstanceLockPath({ statePath = null, platform, env, homedir } = {}) {
  const resolved = statePath ?? defaultStatePath({ platform, env, homedir });
  return instanceLockPathForStatePath(resolved);
}

/**
 * Existence probe for a pid. Signals are not delivered: signal `0` only asks the kernel
 * whether the process exists. `ESRCH` means it is gone; anything else (notably `EPERM`,
 * a live process owned by another user) means it exists.
 */
export function isProcessAlive(pid, { kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function readHolder(readFile) {
  try {
    const holder = JSON.parse(readFile());
    return holder && typeof holder === 'object' ? holder : null;
  } catch {
    // Missing, unreadable, or truncated: all stale.
    return null;
  }
}

/**
 * Take the lock, or report who holds it.
 *
 * @returns {{acquired: boolean, holder: object|null, lockPath: string, release: function}}
 *   `release` is a no-op on a lock that was not acquired, so callers can call it
 *   unconditionally.
 */
export function acquireInstanceLock({
  lockPath,
  pid = process.pid,
  now = Date.now,
  isAlive = isProcessAlive,
  fs = { mkdirSync, writeFileSync, readFileSync, unlinkSync },
  logger = null,
} = {}) {
  if (!lockPath) throw new Error('acquireInstanceLock needs a lockPath');
  fs.mkdirSync(dirname(lockPath), { recursive: true });

  const record = { pid, startedAt: now() };
  const tryCreate = () => {
    try {
      fs.writeFileSync(lockPath, JSON.stringify(record), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err?.code === 'EEXIST') return false;
      throw err;
    }
  };

  if (tryCreate()) return makeHeld(lockPath, pid, record, fs);

  const holder = readHolder(() => fs.readFileSync(lockPath, 'utf8'));
  if (holder && Number.isInteger(holder.pid) && isAlive(holder.pid)) {
    return { acquired: false, holder, lockPath, release: () => {} };
  }

  logger?.warn?.(
    `removing a stale instance lock at ${lockPath} (holder ${holder?.pid ?? 'unknown'} is gone)`
  );
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }

  // The retry is what makes stale removal safe under a race: both processes may unlink,
  // but only one `wx` create succeeds and the other falls through to report the winner.
  if (tryCreate()) return makeHeld(lockPath, pid, record, fs);

  const winner = readHolder(() => fs.readFileSync(lockPath, 'utf8'));
  return { acquired: false, holder: winner, lockPath, release: () => {} };
}

function makeHeld(lockPath, pid, record, fs) {
  return {
    acquired: true,
    holder: record,
    lockPath,
    release: () => {
      // Only delete a file that is still ours: a successor may already have replaced it
      // after our unlink, and removing that would let a third process in.
      try {
        const current = readHolder(() => fs.readFileSync(lockPath, 'utf8'));
        if (current && Number(current.pid) !== Number(pid)) return;
        fs.unlinkSync(lockPath);
      } catch {
        // already gone
      }
    },
  };
}
