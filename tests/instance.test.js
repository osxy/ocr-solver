/**
 * The single-instance lock (issue #167).
 *
 * The lock's whole job is the failure path: a second start must be refused, and a lock
 * left by a dead process must not refuse a legitimate start. Those two cases are the
 * tests; the happy path is only there to make them meaningful. The stale cases are the
 * ordinary event the restart work creates, so they get as much coverage as the refusal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  AlreadyRunningError,
  INSTANCE_LOCK_FILE,
  acquireInstanceLock,
  instanceLockPathForStatePath,
  instanceStopPathForLock,
  isHolderAlive,
  isProcessAlive,
  readProcessIdentity,
  requestInstanceStop,
  resolveInstanceLockPath,
  watchStopRequests,
} from '../src/instance.js';

function tempLock(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-lock-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, INSTANCE_LOCK_FILE);
}

test('the lock lives beside the state database, not in a global location', () => {
  // `path.join` is platform-native, so assert the shape (same directory, fixed name)
  // rather than a separator that differs between the CI host and Windows.
  const lock = instanceLockPathForStatePath('/home/u/.local/share/puzzlesolver/state.db');
  assert.equal(lock, '/home/u/.local/share/puzzlesolver/instance.lock');

  const windows = resolveInstanceLockPath({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\A\\AppData\\Local' },
    homedir: null,
  });
  assert.equal(basename(windows), 'instance.lock');
  assert.ok(windows.startsWith('C:\\Users\\A\\AppData\\Local'), windows);
  assert.ok(/PuzzleSolver[\\/]instance\.lock$/.test(windows), windows);
});

test('the first start takes the lock and the second is refused', (t) => {
  const lockPath = tempLock(t);
  const first = acquireInstanceLock({ lockPath, pid: 111, isAlive: () => true });
  assert.equal(first.acquired, true);
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 111);

  const second = acquireInstanceLock({ lockPath, pid: 222, isAlive: () => true });
  assert.equal(second.acquired, false, 'a live holder must refuse the second start');
  assert.equal(second.holder.pid, 111);
  assert.throws(
    () => { if (!second.acquired) throw new AlreadyRunningError(second.holder); },
    (err) => err.name === 'AlreadyRunningError' && /pid 111/.test(err.message)
  );
});

test('release frees the lock for the next start', (t) => {
  const lockPath = tempLock(t);
  const first = acquireInstanceLock({ lockPath, pid: 111, isAlive: () => true });
  first.release();
  assert.equal(acquireInstanceLock({ lockPath, pid: 222, isAlive: () => false }).acquired, true);
});

test('a lock left by a dead process is stale and does not block a start', (t) => {
  const lockPath = tempLock(t);
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: 1 }));
  const next = acquireInstanceLock({ lockPath, pid: 222, isAlive: (pid) => pid !== 999999 });
  assert.equal(next.acquired, true, 'a dead pid must be replaced rather than believed');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 222);
});

test('an unreadable or truncated lock file is stale, not fatal', (t) => {
  const lockPath = tempLock(t);
  writeFileSync(lockPath, '{"pid":123'); // a write interrupted by a crash
  const next = acquireInstanceLock({ lockPath, pid: 222, isAlive: () => true });
  assert.equal(next.acquired, true);
});

test('a lock that records no pid is stale', (t) => {
  const lockPath = tempLock(t);
  writeFileSync(lockPath, JSON.stringify({ startedAt: 1 }));
  const next = acquireInstanceLock({ lockPath, pid: 222, isAlive: () => true });
  assert.equal(next.acquired, true);
});

test('releasing a lock that has already been replaced does not delete the successor', (t) => {
  const lockPath = tempLock(t);
  const first = acquireInstanceLock({ lockPath, pid: 111, isAlive: () => true });
  // Simulate a dead first process whose stale lock was replaced by a live successor.
  writeFileSync(lockPath, JSON.stringify({ pid: 222, startedAt: 2 }));
  first.release();
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 222, 'the successor\'s lock must survive');
});

test('isProcessAlive treats ESRCH as gone and every other error as alive', () => {
  assert.equal(isProcessAlive(process.pid), true, 'our own process is alive');
  assert.equal(isProcessAlive(0), false, 'no pid is not a process');
  assert.equal(isProcessAlive(-1), false);
  assert.equal(
    isProcessAlive(123, { kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } }),
    false
  );
  assert.equal(
    isProcessAlive(123, { kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }),
    true,
    'a process owned by another user still exists'
  );
});

// ---------------------------------------------------------------------------
// Process identity, not just a pid (#212)
// ---------------------------------------------------------------------------

test('the lock records a process identity beside the pid when one is available', (t) => {
  const lockPath = tempLock(t);
  const identity = { startTicks: '4242', bootId: 'boot-1' };
  const lock = acquireInstanceLock({
    lockPath,
    pid: 111,
    isAlive: () => true,
    identityOf: () => identity,
  });
  assert.equal(lock.acquired, true);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')).identity, identity);
});

test('a lock naming pid 1 is stale when its recorded identity is not the live pid 1 (#212)', (t) => {
  // The defect: `process.kill(1, 0)` always succeeds, so a recreated container's
  // leftover lock (recorded identity from the previous instance) was believed forever.
  const lockPath = tempLock(t);
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 1, startedAt: 1, identity: { startTicks: '100', bootId: 'boot-1' } })
  );
  const next = acquireInstanceLock({
    lockPath,
    pid: 222,
    // pid 1 always exists - the whole reason a pid alone is not an identity.
    isAlive: () => true,
    identityOf: () => ({ startTicks: '500', bootId: 'boot-1' }),
  });
  assert.equal(next.acquired, true, 'a stale pid-1 record must be replaced, not believed');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, 222);
});

test('a live holder whose recorded identity still matches is believed', (t) => {
  const lockPath = tempLock(t);
  const identity = { startTicks: '100', bootId: 'boot-1' };
  acquireInstanceLock({ lockPath, pid: 111, isAlive: () => true, identityOf: () => identity });
  const second = acquireInstanceLock({
    lockPath,
    pid: 222,
    isAlive: () => true,
    identityOf: () => identity,
  });
  assert.equal(second.acquired, false, 'a matching identity is a genuinely live holder');
  assert.equal(second.holder.pid, 111);
});

test('a boot-id change makes a recorded holder stale even when pid and start ticks repeat', (t) => {
  const lockPath = tempLock(t);
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: 7, startedAt: 1, identity: { startTicks: '100', bootId: 'boot-1' } })
  );
  const next = acquireInstanceLock({
    lockPath,
    pid: 222,
    isAlive: () => true,
    identityOf: () => ({ startTicks: '100', bootId: 'boot-2' }),
  });
  assert.equal(next.acquired, true, 'a new boot is a new instance, whatever the ticks say');
});

test('a holder with no recorded identity or an unreadable probe falls back to the pid', () => {
  assert.equal(isHolderAlive(null), false);
  assert.equal(isHolderAlive({ pid: 111 }, { isAlive: () => false }), false);
  // An older lock file (no identity field) keeps the documented pid-only behaviour.
  assert.equal(isHolderAlive({ pid: 111 }, { isAlive: () => true, identityOf: () => null }), true);
  // A recorded identity on a platform that cannot read one now is treated as live:
  // refusing a start is recoverable, two listeners are not.
  assert.equal(
    isHolderAlive(
      { pid: 111, identity: { startTicks: '1', bootId: 'b' } },
      { isAlive: () => true, identityOf: () => null }
    ),
    true
  );
});

test('readProcessIdentity reads start ticks past the parenthesised command, Linux only', () => {
  const stat = '111 (node (worker)) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 4242 0 0';
  const files = {
    '/proc/111/stat': stat,
    '/proc/sys/kernel/random/boot_id': 'boot-1\n',
  };
  assert.deepEqual(
    readProcessIdentity(111, { platform: 'linux', readFile: (p) => files[p] }),
    { startTicks: '4242', bootId: 'boot-1' }
  );
  assert.equal(
    readProcessIdentity(111, { platform: 'win32', readFile: () => stat }),
    null,
    'Windows has no portable identity probe; the pid fallback is documented'
  );
  assert.equal(readProcessIdentity(111, { platform: 'linux', readFile: () => { throw new Error('ENOENT'); } }), null);
});

// ---------------------------------------------------------------------------
// Graceful stop request (#168)
// ---------------------------------------------------------------------------

test('requestInstanceStop asks a live holder to stop and resolves once it is gone', async (t) => {
  const lockPath = tempLock(t);
  const stopPath = instanceStopPathForLock(lockPath);
  let alive = true;
  acquireInstanceLock({ lockPath, pid: 4242, isAlive: () => alive, identityOf: () => null });

  let requested = null;
  const watcher = watchStopRequests({
    lockPath,
    pid: 4242,
    intervalMs: 5,
    onStop: (request) => {
      requested = request;
      alive = false; // the app ran its graceful shutdown and exited
    },
  });

  const result = await requestInstanceStop({
    lockPath,
    isAlive: () => alive,
    identityOf: () => null,
    intervalMs: 5,
    timeoutMs: 2000,
  });
  watcher.stop();

  assert.equal(result.stopped, true, 'the stop must be observed, not assumed');
  assert.equal(requested.pid, 4242, 'the request names the holder it is asking');
  assert.equal(existsSync(stopPath), false, 'the consumed request must not linger to stop the next start');
});

test('requestInstanceStop does not ask a stale holder to stop, and bounds a timeout', async (t) => {
  const lockPath = tempLock(t);
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: 1, identity: null }));
  const stale = await requestInstanceStop({
    lockPath,
    isAlive: () => false,
    identityOf: () => null,
    intervalMs: 5,
    timeoutMs: 50,
  });
  assert.equal(stale.running, false);
  assert.equal(stale.stopped, false);
  assert.equal(stale.reason, 'not-running');

  // A live holder that ignores the request is reported, not waited on forever.
  const ignored = await requestInstanceStop({
    lockPath,
    isAlive: () => true,
    identityOf: () => null,
    intervalMs: 5,
    timeoutMs: 20,
  });
  assert.equal(ignored.stopped, false);
  assert.equal(ignored.reason, 'timeout');
});
