/**
 * Security and privacy hardening tests.
 *
 * These keep the promises in DESIGN 8 honest:
 *   - `offline_only` is airtight: a throwing `fetch` proves zero outbound requests
 *     while the real pipeline and real OCR solve a puzzle.
 *   - retention is enforced on startup, not merely documented.
 *   - image bytes never reach the log or the attempts table; `log_images` records a
 *     reference for unresolved puzzles only.
 *   - redaction cannot be bypassed at either sink, including by an upstream error
 *     body that carries a key.
 *
 * Nothing here needs a network, a token or a key.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { solveImage } from '../src/solver/pipeline.js';
import { createReasoner } from '../src/solver/reason.js';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { openStore, memoryStore } from '../src/state/db.js';
import { createLogger } from '../src/logging.js';
import { redactRecord, stripImageBytes } from '../src/redact.js';
import { createApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(root, 'corpus', '003-arithmetic-acht-min-een.png');

/** A scripted OCR worker: the pipeline path under test does not need real OCR. */
function fakeWorker(text, confidence = 90) {
  return {
    async setParameters() {},
    async recognize() {
      return { data: { text, confidence, words: [] } };
    },
  };
}

// ---------------------------------------------------------------------------
// offline_only is airtight
// ---------------------------------------------------------------------------

let realWorker;
before(async () => {
  realWorker = await createOcrWorker();
});
after(async () => {
  await realWorker?.terminate();
});

/**
 * Run `fn` with `globalThis.fetch` replaced by a counting bomb. Any outbound
 * request throws, so a code path that phones home cannot pass silently.
 */
async function withFetchSpy(fn) {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls += 1;
    throw new Error(`outbound request attempted during offline solve: ${args[0]}`);
  };
  try {
    const result = await fn();
    return { result, calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('offline_only makes zero outbound requests through the real pipeline', async () => {
  // The real OCR worker and the real corpus image: if any part of the offline
  // account touched the network, this fetches and fails.
  const { result, calls } = await withFetchSpy(() => solveImage(realWorker, CORPUS, { reasoner: null }));

  assert.equal(calls, 0, 'offline_only must not call fetch at all');
  assert.equal(result.answer, '7');
  assert.equal(result.method, 'tier0:arithmetic');
  assert.equal(result.model, null);
});

test('offline_only builds no reasoner even when a key is present', async () => {
  // The switch must be structural, not a runtime check inside the model client: no
  // chat client is constructed, so there is no object that could send an image.
  let chatBuilt = 0;
  let reasonerBuilt = 0;
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-sec-'));
  const app = await createApp({
    config: validateConfig({ solver: { offline_only: true } }).config,
    env: { LLM_API_KEY: 'sk-a-key-is-present-but-must-not-be-used' },
    providers: [],
    client: { getPushes: async () => [], createNote: async () => ({}), streamUrl: 'ws://localhost' },
    listener: { start: async () => {}, stop() {}, status: () => ({}) },
    reasoner: undefined,
    solveImage: async () => ({ answer: '2', confident: true }),
    createWorker: async () => ({ terminate: async () => {} }),
    createChatClientImpl: () => {
      chatBuilt += 1;
      return {};
    },
    createReasonerImpl: () => {
      reasonerBuilt += 1;
      return {};
    },
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  try {
    assert.equal(app.reasoner, null);
    assert.equal(chatBuilt, 0, 'no chat client may be constructed under offline_only');
    assert.equal(reasonerBuilt, 0);
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Retention is enforced
// ---------------------------------------------------------------------------

test('pruneAttempts deletes rows older than the retention window', () => {
  let clock = 1_000_000;
  const store = memoryStore({ now: () => clock });
  store.record({ subject: 'old', stage: 'ocr' });
  clock += 10 * 86_400;
  store.record({ subject: 'fresh', stage: 'ocr' });

  const removed = store.pruneAttempts({ retainDays: 7, now: () => clock });
  assert.equal(removed, 1);
  assert.equal(store.attemptsFor('old').length, 0, 'the old transcript is gone');
  assert.equal(store.attemptsFor('fresh').length, 1);
  store.close();
});

test('a negative retention window is refused rather than deleting everything', () => {
  const store = memoryStore();
  store.record({ subject: 'p', stage: 'ocr' });
  assert.equal(store.pruneAttempts({ retainDays: -1 }), 0);
  assert.equal(store.countAttempts(), 1);
  store.close();
});

test('the app prunes old attempts on startup, keeps fresh ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-sec-'));
  const path = join(dir, 'state.db');
  const oldSeconds = Date.now() / 1000 - 10 * 86_400;
  const freshSeconds = Date.now() / 1000 - 60;

  const seed = openStore({ path, now: () => oldSeconds });
  seed.record({ subject: 'old', stage: 'ocr', payload: { text: 'oude puzzel' } });
  seed.close();
  const seed2 = openStore({ path, now: () => freshSeconds });
  seed2.record({ subject: 'fresh', stage: 'ocr', payload: { text: 'nieuwe puzzel' } });
  seed2.close();

  const app = await createApp({
    config: validateConfig({ storage: { retain_days: 1 } }).config,
    env: {},
    providers: [],
    client: { getPushes: async () => [], createNote: async () => ({}), streamUrl: 'ws://localhost' },
    listener: { start: async () => {}, stop() {}, status: () => ({}) },
    reasoner: null,
    solveImage: async () => ({ answer: '2', confident: true }),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: path,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => Date.now() / 1000,
  });
  try {
    assert.equal(app.store.attemptsFor('old').length, 0, 'startup must enforce retention');
    assert.equal(app.store.attemptsFor('fresh').length, 1, 'recent attempts are kept');
  } finally {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Image-byte policy
// ---------------------------------------------------------------------------

test('the log/store redactor strips inline image bytes', () => {
  const bytes = 'data:image/png;base64,' + Buffer.from('real image bytes here').toString('base64');
  const cleaned = redactRecord(`payload=${bytes}`);
  assert.equal(cleaned.includes('real image bytes here'), false);
  assert.equal(/data:image\/png;base64,[A-Za-z0-9+/=]{20,}/.test(cleaned), false);
  assert.match(cleaned, /base64,\[bytes not logged\]/);

  const bufferJson = JSON.stringify(Buffer.from([0, 1, 2, 3, 4, 255]));
  assert.equal(redactRecord(bufferJson).includes('"data":[0,1'), false);
  assert.match(stripImageBytes(bufferJson), /image bytes not logged/);
});

test('the attempts store never keeps image bytes even if a caller passes them', () => {
  const store = memoryStore();
  const dataUrl = 'data:image/png;base64,' + Buffer.from('secret pixels').toString('base64');
  store.record({ subject: 'img', stage: 'ocr', payload: { text: 'hoi', dataUrl, buffer: Buffer.from([1, 2, 3]) } });

  const row = store.attemptsFor('img')[0];
  assert.equal(JSON.stringify(row.payload).includes('secret pixels'), false);
  assert.match(row.payload.dataUrl, /bytes not logged/);
  assert.equal(row.payload.text, 'hoi', 'the transcript is still kept for debugging');
  store.close();
});

test('log_images records a reference for unresolved puzzles only, never bytes', async () => {
  const store = memoryStore();
  // No reasoner and no OCR text -> unresolved, and no model is available offline.
  await solveImage(fakeWorker('', 0), CORPUS, { store, subject: 'unresolved', logImages: true });
  await solveImage(fakeWorker('Wat is acht min een?', 95), CORPUS, { store, subject: 'resolved', logImages: true });
  await solveImage(fakeWorker('', 0), CORPUS, { store, subject: 'no-opt-in', logImages: false });

  const unresolved = store.attemptsFor('unresolved').filter((r) => r.stage === 'image-ref');
  assert.equal(unresolved.length, 1, 'an unresolved puzzle keeps exactly one reference');
  assert.equal(typeof unresolved[0].payload.path, 'string');
  assert.equal(JSON.stringify(unresolved[0].payload).includes('base64'), false);

  assert.equal(store.attemptsFor('resolved').filter((r) => r.stage === 'image-ref').length, 0);
  assert.equal(store.attemptsFor('no-opt-in').filter((r) => r.stage === 'image-ref').length, 0);
  store.close();
});

// ---------------------------------------------------------------------------
// Redaction cannot be bypassed
// ---------------------------------------------------------------------------

test('the logger redacts secrets in errors, nested objects and arrays', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-sec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.log');

  const key = 'sk-or-v1-' + 'abcdef0123456789'.repeat(3);
  const token = 'o.' + 'A1b2C3d4E5f6'.repeat(3);
  const logger = createLogger({ path });

  const err = new Error(`request failed with key ${key}`);
  const nested = { authorization: `Bearer ${key}`, upstream: { body: { access_token: token } } };
  logger.info('error object', err);
  logger.warn('nested', nested);
  logger.error('array', [key, { token }]);
  logger.info('data URL', 'data:image/png;base64,' + Buffer.from('pixels').toString('base64'));

  const text = readFileSync(path, 'utf8');
  assert.equal(text.includes(key), false, 'the API key must not reach the log via any shape');
  assert.equal(text.includes(token), false, 'the Pushbullet token must not reach the log');
  assert.equal(text.includes('abcdef0123456789'), false, 'no key body survives');
  assert.equal(/data:image\/png;base64,[A-Za-z0-9+/=]{8,}/.test(text), false, 'no image bytes in the log');
});

test('a secret inside an upstream error body never reaches the attempts table', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-sec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'state.db');
  const logPath = join(dir, 'app.log');

  const secret = 'sk-or-v1-' + 'feedface'.repeat(6);
  const store = openStore({ path: dbPath });
  const logger = createLogger({ path: logPath });

  // A raw error object standing in for an upstream body that was NOT redacted on
  // the way in. The sinks are the last line of defence and must still not persist it.
  const client = {
    async chat() {
      throw new Error(`upstream 500 body: {"error":{"api_key":"${secret}"}}`);
    },
  };
  const reasoner = createReasoner({ client, store, subject: 'sec1', logger });

  await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), CORPUS, {
    store,
    subject: 'sec1',
    reasoner,
    logger,
  });
  store.close();

  const dbText = readFileSync(dbPath).toString('latin1');
  const logText = readFileSync(logPath, 'utf8');
  assert.equal(dbText.includes(secret), false, 'the key must not appear in the database file');
  assert.equal(logText.includes(secret), false, 'the key must not appear in the log file');

  const reopened = openStore({ path: dbPath });
  const rows = reopened.attemptsFor('sec1');
  assert.ok(rows.length > 0, 'the failure was still recorded for debugging');
  assert.equal(rows.some((r) => JSON.stringify(r.payload).includes(secret)), false);
  reopened.close();
});

test('the outbox stores a redacted upstream error', () => {
  const store = memoryStore();
  const secret = 'sk-or-v1-' + 'cafebabe'.repeat(4);
  store.claimOutbox('p1', 'h1');
  store.noteOutboxError('p1', 'h1', new Error(`reply rejected: ${secret}`));
  const row = store.getOutbox('p1', 'h1');
  assert.equal(row.response.includes(secret), false);
  assert.match(row.response, /sk-or…/);
  store.close();
});
