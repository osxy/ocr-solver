/**
 * The updater's pure decisions (issue #168), exercised offline.
 *
 * `update.ps1` is Windows-only and cannot run here, so everything with a judgement in
 * it - the version gate and replace-not-merge - lives in `src/deploy/update.js` and is
 * tested against real temporary directories. What remains in PowerShell is the part
 * that truly needs Windows: `Get-FileHash`, `Expand-Archive`, `Start-Process`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyUpdate,
  decideUpdate,
  readPayloadVersion,
  runCli,
} from '../src/deploy/update.js';
import { runStop, STOP_TIMEOUT_MS } from '../src/deploy/stop.js';

function tempRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePackage(dir, version) {
  mkdirSync(join(dir, 'app'), { recursive: true });
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ name: 'puzzlesolver', version }));
}

// ---------------------------------------------------------------------------
// Version gate
// ---------------------------------------------------------------------------

test('readPayloadVersion reads the version the payload would install', (t) => {
  const dir = tempRoot(t);
  writePackage(dir, '0.46.0');
  assert.equal(readPayloadVersion(dir), '0.46.0');
  assert.equal(readPayloadVersion(join(dir, 'missing')), null, 'a missing payload is not a version');
});

test('a newer payload is allowed and an older one is refused (#168)', () => {
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: '0.46.0' }).allowed, true);
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: '0.45.1' }).reason, 'older');
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: '0.45.1' }).allowed, false);
  // Ordering is numeric per component, not lexicographic: 0.4.0 is older than 0.45.0.
  assert.equal(decideUpdate({ installedVersion: '0.45.0', incomingVersion: '0.4.0' }).reason, 'older');
  assert.equal(decideUpdate({ installedVersion: '0.45.0', incomingVersion: '0.45.1' }).reason, 'newer');
});

test('the same version is refused unless -Force, and an unreadable version is never equal', () => {
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: '0.45.2' }).allowed, false);
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: '0.45.2', force: true }).allowed, true);
  assert.equal(decideUpdate({ installedVersion: '0.45.2', incomingVersion: 'not-a-version' }).allowed, false);
  assert.equal(
    decideUpdate({ installedVersion: '0.45.2', incomingVersion: 'not-a-version', force: true }).reason,
    'unreadable-version'
  );
});

test('the check CLI exits 0 for a newer payload and non-zero for an older one', (t) => {
  const install = join(tempRoot(t), 'install');
  const source = join(tempRoot(t), 'source');
  writePackage(install, '0.45.2');
  writePackage(source, '0.46.0');
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m) };

  assert.equal(runCli(['check', '--install', install, '--source', source], { log }), 0);
  assert.match(lines.at(-1), /0\.45\.2 -> 0\.46\.0/);

  writePackage(source, '0.45.0');
  assert.equal(runCli(['check', '--install', install, '--source', source], { log }), 3, 'an older payload must block');
  assert.match(lines.at(-1), /refusing to update \(older\)/);
});

// ---------------------------------------------------------------------------
// Replace, do not merge
// ---------------------------------------------------------------------------

test('apply replaces the install tree, so a stale file cannot shadow the new one (#168)', (t) => {
  const root = tempRoot(t);
  const install = join(root, 'install');
  const source = join(root, 'source');
  mkdirSync(join(install, 'node_modules', 'old'), { recursive: true });
  writeFileSync(join(install, 'node_modules', 'stale-marker.txt'), 'stale');
  writeFileSync(join(install, 'node.exe'), 'old-node');
  writeFileSync(join(install, 'update.ps1'), 'the running updater');
  mkdirSync(join(source, 'node_modules', 'new'), { recursive: true });
  writeFileSync(join(source, 'node_modules', 'new', 'index.js'), 'fresh');
  writeFileSync(join(source, 'node.exe'), 'new-node');

  const result = applyUpdate({ installDir: install, sourceDir: source, selfPath: join(install, 'update.ps1') });

  assert.ok(result.removed.includes('node_modules'), 'the whole old tree is cleared, not merged');
  assert.equal(existsSync(join(install, 'node_modules', 'stale-marker.txt')), false, 'a stale file must not survive');
  assert.equal(readFileSync(join(install, 'node_modules', 'new', 'index.js'), 'utf8'), 'fresh');
  assert.equal(readFileSync(join(install, 'node.exe'), 'utf8'), 'new-node');
  // The updater script that is executing cannot be deleted out from under itself.
  assert.equal(existsSync(join(install, 'update.ps1')), true);
});

test('apply never touches the two user-data directories (#168)', (t) => {
  const root = tempRoot(t);
  const install = join(root, 'install');
  const source = join(root, 'source');
  // The app install directory, and beside it the two real data directories.
  mkdirSync(install, { recursive: true });
  writeFileSync(join(install, 'node.exe'), 'old');
  const dataLocal = join(root, 'LocalAppData', 'PuzzleSolver');
  const dataRoaming = join(root, 'AppData', 'PuzzleSolver');
  mkdirSync(dataLocal, { recursive: true });
  mkdirSync(dataRoaming, { recursive: true });
  writeFileSync(join(dataLocal, 'state.db'), 'sqlite-marker');
  writeFileSync(join(dataRoaming, 'config.toml'), 'config-marker');
  writeFileSync(join(dataRoaming, 'credentials.json'), 'dpapi-marker');

  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'node.exe'), 'new');
  applyUpdate({ installDir: install, sourceDir: source });

  assert.equal(readFileSync(join(dataLocal, 'state.db'), 'utf8'), 'sqlite-marker');
  assert.equal(readFileSync(join(dataRoaming, 'config.toml'), 'utf8'), 'config-marker');
  assert.equal(readFileSync(join(dataRoaming, 'credentials.json'), 'utf8'), 'dpapi-marker');
});

// ---------------------------------------------------------------------------
// Graceful stop
// ---------------------------------------------------------------------------

test('stop reports success when the app stopped or was never running, and failure on timeout', async (t) => {
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m) };

  const notRunning = await runStop({ requestStop: async () => ({ running: false, stopped: false, reason: 'not-running' }), log });
  assert.equal(notRunning.exitCode, 0, 'a stale lock is not a failure');

  const stopped = await runStop({ requestStop: async () => ({ running: true, stopped: true, pid: 42 }), log });
  assert.equal(stopped.exitCode, 0);
  assert.match(lines.at(-1), /pid 42/);

  const timeout = await runStop({
    requestStop: async () => ({ running: true, stopped: false, reason: 'timeout', pid: 42 }),
    log,
  });
  assert.equal(timeout.exitCode, 1, 'a live holder that ignored the request must abort the update');
  assert.match(lines.at(-1), /refusing to touch the install/);
  assert.equal(STOP_TIMEOUT_MS > 0, true);
});
