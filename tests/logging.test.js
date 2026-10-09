/**
 * Logging tests. Rotation is asserted against the real filesystem, because a
 * rotation test that only exercises a double cannot prove the real logger rotates.
 * Redaction and the never-throw guarantee are asserted too - a log line is where a
 * secret leaks, and a broken log line must not take down the worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { createLogger, defaultLogPath, redactRecord, DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES } from '../src/logging.js';

const home = () => '/home/andre';

test('the rotation constants are the documented 5 MB x 3', () => {
  assert.equal(DEFAULT_MAX_BYTES, 5 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_FILES, 3);
});

// ---------------------------------------------------------------------------
// Real default location
// ---------------------------------------------------------------------------

test('the Windows default log path is %LOCALAPPDATA%\\PuzzleSolver\\logs\\app.log', () => {
  const local = 'C:\\Users\\andre\\AppData\\Local';
  const path = defaultLogPath({ platform: 'win32', env: { LOCALAPPDATA: local }, homedir: home });
  assert.equal(path, join(local, 'PuzzleSolver', 'logs', 'app.log'));
  assert.equal(basename(path), 'app.log');
});

test('the XDG default log path uses XDG_STATE_HOME and falls back to ~/.local/state', () => {
  assert.equal(
    defaultLogPath({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, homedir: home }),
    join('/state', 'puzzlesolver', 'logs', 'app.log')
  );
  assert.equal(
    defaultLogPath({ platform: 'linux', env: {}, homedir: home }),
    join('/home/andre', '.local', 'state', 'puzzlesolver', 'logs', 'app.log')
  );
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

function logFiles(dir) {
  return readdirSync(dir).filter((name) => name.startsWith('app.log')).sort();
}

test('exceeding the size cap actually produces a rotated file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  const logger = createLogger({ path, maxBytes: 200, maxFiles: 3 });
  for (let i = 0; i < 10; i++) logger.info(`line number ${i} with enough padding to matter`);

  assert.ok(existsSync(path), 'the current file exists');
  assert.ok(existsSync(`${path}.1`), 'a rotation must produce app.log.1');
  assert.ok(logFiles(dir).length >= 2, `expected a rotated file, saw ${logFiles(dir).join(', ')}`);
});

test('the rotated file set never exceeds maxFiles', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  const logger = createLogger({ path, maxBytes: 120, maxFiles: 3 });
  for (let i = 0; i < 200; i++) logger.info(`a reasonably long line to force many rotations ${i}`);

  const files = logFiles(dir);
  assert.equal(files.length, 3, `maxFiles caps the set, saw ${files.join(', ')}`);
  assert.deepEqual(files, ['app.log', 'app.log.1', 'app.log.2']);
  // The current file holds the most recent records.
  assert.match(readFileSync(path, 'utf8'), /rotations 199/);
});

test('with maxFiles = 1 there is only the current file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  const logger = createLogger({ path, maxBytes: 60, maxFiles: 1 });
  for (let i = 0; i < 30; i++) logger.info(`line ${i}`);
  assert.deepEqual(logFiles(dir), ['app.log']);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('every log record is redacted, key and token alike', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  const apiKey = 'sk-abc123def456ghi789';
  const token = 'o.abcdef12345678901234';
  const logger = createLogger({ path });
  logger.info(`calling with key ${apiKey} and token ${token}`);
  logger.warn('an upstream error body', { authorization: `Bearer ${apiKey}`, access: token });

  const text = readFileSync(path, 'utf8');
  assert.equal(text.includes(apiKey), false, 'the API key must not reach the file');
  assert.equal(text.includes(token), false, 'the Pushbullet token must not reach the file');
  assert.equal(text.includes('abc123def456ghi789'), false);
  assert.match(text, /sk-abc…/);
  assert.match(text, /o\.abc…/);
});

test('redactRecord runs through both existing redactors', () => {
  const cleaned = redactRecord('key sk-abcdefghijklmnop token o.abcdef12345678901234');
  assert.equal(cleaned.includes('abcdefghijklmnop'), false);
  assert.equal(cleaned.includes('12345678901234'), false);
});

// ---------------------------------------------------------------------------
// Logging must never break solving
// ---------------------------------------------------------------------------

test('a failing file sink is swallowed and disabled, not thrown on every call', () => {
  const brokenFs = {
    appendFileSync() {
      throw new Error('disk full');
    },
    existsSync: () => false,
    mkdirSync() {},
    renameSync() {},
    rmSync() {},
    statSync() {
      throw new Error('nope');
    },
    writeFileSync() {},
  };
  const logger = createLogger({ path: '/does/not/matter/app.log', fs: brokenFs });
  assert.doesNotThrow(() => logger.info('one'));
  assert.doesNotThrow(() => logger.error('two'));
  assert.equal(logger.fileSinkBroken, true);
});

test('a circular object in a log call does not throw', () => {
  const logger = createLogger({ path: null });
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.info('circular', circular));
});

test('the console sink can be enabled and is redacted too', () => {
  const seen = [];
  const fakeConsole = {
    info: (line) => seen.push(line),
    warn: (line) => seen.push(line),
    error: (line) => seen.push(line),
    log: (line) => seen.push(line),
  };
  const logger = createLogger({ path: null, console: true, consoleImpl: fakeConsole });
  logger.error('boom sk-abcdefghijklmnop');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes('abcdefghijklmnop'), false);
  assert.match(seen[0], /^error /);
});

test('a log write appends rather than overwriting across loggers', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  createLogger({ path }).info('first record');
  createLogger({ path }).info('second record');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /first record/);
  assert.match(text, /second record/);
  assert.ok(statSync(path).size > 0);
});

test('a logger with no path writes nowhere and does not touch the disk', () => {
  const logger = createLogger({ path: null });
  assert.doesNotThrow(() => logger.info('nowhere'));
  assert.equal(logger.fileSinkBroken, false);
});
