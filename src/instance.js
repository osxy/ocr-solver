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
 * **A pid is not an identity (issue #212).** `process.kill(1, 0)` always succeeds, so
 * a lock naming pid 1 was treated as live even when nothing held it. That is
 * deterministic in a container: the app is usually pid 1 in a fresh PID namespace, so
 * a crash leaves a lock recording pid 1, and every restart refuses with the holder
 * permanently "alive". `process.kill(pid, 0)` answers "is there a process with this
 * pid", not "is it the process that took the lock".
 *
 * On Linux the process's start time and the kernel's boot id are recorded with the pid;
 * a holder is live only when both still match, so a recreated PID namespace (same boot
 * id, new pid-1 start time) and a reboot (new boot id) both read as stale. The identity
 * probe is best-effort: where `/proc` is absent (Windows) it returns `null` and the
 * check falls back to the pid, which keeps the documented pid-reuse gap there. That is
 * deliberate - a lock file has to work on every platform the app supports, and the
 * deterministic failure this closes is the Linux/container one.
 *
 * Known gap: pid reuse on a platform without an identity probe. A stale lock can look
 * live and the new start is refused. The realistic triggers (reboot, a long-lived
 * unrelated process) are rare enough that a heartbeat or a Windows start-time probe
 * (which needs a native call Node does not expose) is not yet worth its cost.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { defaultStatePath } from './config.js';

/** The lock file beside `state.db`; the name is deliberately boring and obvious. */
export const INSTANCE_LOCK_FILE = 'instance.lock';

/**
 * The stop-request file beside the lock (issue #168). A second process asks the holder
 * to run its graceful shutdown by writing this file; the holder watches for it. It is a
 * separate file, not a field in the lock, because the lock's `wx` create and its
 * release-ownership check are load-bearing and a foreign writer must not disturb them.
 */
export const INSTANCE_STOP_FILE = 'instance.stop';

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

/**
 * A process identity that survives a pid being reused (issue #212). Linux exposes the
 * process start time (field 22 of `/proc/<pid>/stat`) and the kernel boot id; together
 * they tell a recreated PID namespace from a live holder. Everywhere else - notably
 * Windows - there is no portable equivalent Node can read, so this returns `null` and
 * the caller falls back to the pid.
 *
 * `/proc/<pid>/stat`'s second field is the command in parentheses and may itself
 * contain spaces and parentheses, so the fields after it are found from the last `)`.
 * Reading it races a process exiting; failure is `null`, which the caller treats as
 * "cannot tell", not as "gone".
 */
export function readProcessIdentity(
  pid,
  { platform = process.platform, readFile = readFileSync } = {}
) {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFile(`/proc/${pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) return null;
    const bootId = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return { startTicks, bootId };
  } catch {
    return null;
  }
}

/**
 * Is the lock's recorded holder still the process that took it?
 *
 * A pid that is gone is stale. A pid that is alive with a recorded identity that no
 * longer matches is stale too: the pid was reused, the container was recreated, or the
 * machine rebooted. A holder that recorded no identity (an older lock file, or a
 * platform without a probe) falls back to the pid, and a holder whose identity cannot
 * be read right now is treated as live - refusing a start is recoverable, letting two
 * listeners run is not.
 */
export function isHolderAlive(
  holder,
  { isAlive = isProcessAlive, identityOf = readProcessIdentity } = {}
) {
  if (!holder || !Number.isInteger(holder.pid)) return false;
  if (!isAlive(holder.pid)) return false;
  if (!holder.identity) return true;
  const current = identityOf(holder.pid);
  if (!current) return true;
  return current.startTicks === holder.identity.startTicks && current.bootId === holder.identity.bootId;
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
  identityOf = readProcessIdentity,
  fs = { mkdirSync, writeFileSync, readFileSync, unlinkSync },
  logger = null,
} = {}) {
  if (!lockPath) throw new Error('acquireInstanceLock needs a lockPath');
  fs.mkdirSync(dirname(lockPath), { recursive: true });

  const record = { pid, startedAt: now(), identity: identityOf(pid) };
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
  if (isHolderAlive(holder, { isAlive, identityOf })) {
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

/**
 * The stop-request path for a lock. Sibling of the lock, so a caller that overrides the
 * lock path (tests, a non-default state path) gets a matching request path.
 */
export function instanceStopPathForLock(lockPath) {
  return join(dirname(lockPath), INSTANCE_STOP_FILE);
}

/**
 * Ask the running holder of `lockPath` to shut down gracefully, then wait for it.
 *
 * This is the stop half of the single-instance mechanism, added for the updater
 * (issue #168): Windows will not let a running `node.exe` be replaced, and a forced
 * kill would lose an in-flight solve. The request is a small file beside the lock; the
 * holder watches for it and runs its ordinary shutdown path. The wait is bounded, so a
 * holder that ignores the request is reported rather than waited on forever.
 *
 * A stale lock (the holder is already gone) is not a stop to perform: the caller only
 * needs the files to be free, and the stale-removal path already provides that.
 *
 * @returns {Promise<{running: boolean, stopped: boolean, reason: string}>}
 */
export async function requestInstanceStop({
  lockPath,
  now = Date.now,
  timeoutMs = 30_000,
  intervalMs = 200,
  isAlive = isProcessAlive,
  identityOf = readProcessIdentity,
  fs = { writeFileSync, readFileSync, unlinkSync },
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!lockPath) throw new Error('requestInstanceStop needs a lockPath');
  const holder = readHolder(() => fs.readFileSync(lockPath, 'utf8'));
  if (!isHolderAlive(holder, { isAlive, identityOf })) {
    return { running: false, stopped: false, reason: 'not-running', pid: holder?.pid ?? null };
  }

  const stopPath = instanceStopPathForLock(lockPath);
  fs.writeFileSync(stopPath, JSON.stringify({ pid: holder.pid, requestedAt: now() }));

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (!isHolderAlive(holder, { isAlive, identityOf })) {
      // The holder released the lock and exited. Any request file it did not consume is
      // cleaned by its release path; remove a leftover so the next start is not stopped.
      try {
        fs.unlinkSync(stopPath);
      } catch {
        // already gone
      }
      return { running: true, stopped: true, reason: 'stopped', pid: holder.pid };
    }
    await sleep(intervalMs);
  }
  try {
    fs.unlinkSync(stopPath);
  } catch {
    // already gone
  }
  return { running: true, stopped: false, reason: 'timeout', pid: holder.pid };
}

/**
 * Watch for a stop request aimed at this process and call `onStop` once. Used by
 * `runApp`: the app owns the lock, so it is the one that must react. The watcher also
 * stops itself when the lock is no longer ours, so an app that stopped for another
 * reason does not later act on a stale request.
 *
 * A short interval is enough for a user-initiated update and keeps the mechanism
 * observable in a test without `fs.watch`'s platform differences. The timer is
 * `unref`ed so it never keeps a process alive on its own.
 *
 * @returns {{stop: function, stopPath: string}}
 */
export function watchStopRequests({
  lockPath,
  pid = process.pid,
  onStop = null,
  intervalMs = 250,
  fs = { readFileSync, unlinkSync },
  setInterval: setIntervalImpl = setInterval,
} = {}) {
  const stopPath = instanceStopPathForLock(lockPath);
  const timer = setIntervalImpl(() => {
    const holder = readHolder(() => fs.readFileSync(lockPath, 'utf8'));
    if (!holder || Number(holder.pid) !== Number(pid)) {
      clearInterval(timer);
      return;
    }
    const request = readHolder(() => fs.readFileSync(stopPath, 'utf8'));
    if (!request || (request.pid != null && Number(request.pid) !== Number(pid))) return;
    try {
      fs.unlinkSync(stopPath);
    } catch {
      // another reader won the race; the shutdown below is still correct
    }
    clearInterval(timer);
    onStop?.(request);
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), stopPath };
}
