/**
 * The no-terminal hand-off (#169): the one-time link file, and the Windows message box.
 *
 * The dialog's own behaviour (terminal vs hidden, first run vs tray Settings) is asserted
 * in `tests/web-config.test.js` through the injected `output`/`notifyUser`. These tests
 * cover the two pieces those seams stand in for, without a display and without launching
 * PowerShell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMessageBoxCommand, showMessageBox } from '../src/ui/message-box.js';
import { clearHandoffLink, defaultHandoffDir, HANDOFF_FILE, writeHandoffLink } from '../src/ui/handoff.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-handoff-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the hand-off file lives in the data directory, not the install directory', () => {
  assert.equal(
    defaultHandoffDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }),
    join('C:\\Users\\u\\AppData\\Local', 'PuzzleSolver', 'handoff')
  );
  // The install directory is replaced wholesale on update; the record must not live there.
  assert.equal(
    defaultHandoffDir({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }).includes('Programs'),
    false
  );
  assert.equal(
    defaultHandoffDir({ platform: 'linux', env: { XDG_STATE_HOME: '/home/u/.state' }, homedir: '/home/u' }),
    join('/home/u/.state', 'puzzlesolver', 'handoff')
  );
});

test('writeHandoffLink records the URL, mode 0600, and clearHandoffLink removes it', (t) => {
  const dir = tempDir(t);
  const url = 'http://127.0.0.1:51234/?token=secret-once';
  const record = writeHandoffLink(url, { dir });
  assert.equal(record.written, true);
  assert.equal(record.path, join(dir, HANDOFF_FILE));
  assert.equal(readFileSync(record.path, 'utf8'), `${url}\n`);
  if (process.platform !== 'win32') {
    assert.equal(statSync(record.path).mode & 0o777, 0o600, 'the token-bearing file is owner-only');
  }

  clearHandoffLink(record.path);
  assert.equal(existsSync(record.path), false);
  // Clearing a missing or null path must not throw: teardown runs on every outcome.
  clearHandoffLink(record.path);
  clearHandoffLink(null);
});

test('a hand-off file that cannot be written reports it instead of throwing', () => {
  const boom = {
    mkdirSync() {
      throw new Error('EACCES');
    },
    writeFileSync() {
      throw new Error('EACCES');
    },
  };
  const record = writeHandoffLink('http://x/', { dir: '/nope', fs: boom });
  assert.equal(record.written, false);
  assert.equal(record.path, join('/nope', HANDOFF_FILE));
});

test('the message box is a Windows-only, injection-safe PowerShell command', () => {
  assert.equal(buildMessageBoxCommand('hi', { platform: 'linux' }), null);
  assert.equal(buildMessageBoxCommand('hi', { platform: 'darwin' }), null);

  const url = 'http://127.0.0.1:1/?token=x';
  const spec = buildMessageBoxCommand(`open it: ${url}`, { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } });
  assert.equal(spec.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(spec.args.slice(0, 2), ['-NoProfile', '-NonInteractive']);
  assert.equal(spec.args[2], '-EncodedCommand');
  const script = Buffer.from(spec.args[3], 'base64').toString('utf16le');
  assert.ok(script.includes(url), 'the URL is carried as data, not as a command-line argument');
  assert.ok(script.includes('System.Windows.Forms.MessageBox'));
  // A quote in the message is escaped, so it cannot close the string and inject script.
  const quoted = buildMessageBoxCommand("it's here", { platform: 'win32', env: {} });
  const quotedScript = Buffer.from(quoted.args[3], 'base64').toString('utf16le');
  assert.ok(quotedScript.includes("'it''s here'"));
});

test('showMessageBox resolves on spawn and never rejects', async () => {
  const unsupported = await showMessageBox('hi', { platform: 'linux' });
  assert.deepEqual(unsupported, { shown: false, reason: 'unsupported' });

  const started = await showMessageBox('hi', {
    platform: 'win32',
    env: {},
    spawn: () => {
      const emitter = new EventEmitter();
      emitter.unref = () => {};
      queueMicrotask(() => emitter.emit('spawn'));
      return emitter;
    },
  });
  assert.equal(started.shown, true);

  const failed = await showMessageBox('hi', {
    platform: 'win32',
    env: {},
    spawn: () => {
      throw new Error('no powershell');
    },
  });
  assert.deepEqual(failed, { shown: false, reason: 'spawn-failed' });
});
