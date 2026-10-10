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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
  AlreadyRunningError,
  INSTANCE_LOCK_FILE,
  acquireInstanceLock,
  instanceLockPathForStatePath,
  isProcessAlive,
  resolveInstanceLockPath,
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
