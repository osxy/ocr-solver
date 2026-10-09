import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, memoryStore, SCHEMA_VERSION } from '../src/state/db.js';
import { loadPrompt, clearPromptCache, FALLBACK_PROMPTS } from '../src/solver/prompts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('records and reads back an attempt', () => {
  const store = memoryStore();
  store.record({
    subject: 'p1',
    stage: 'ocr',
    variant: 'adaptive_25_020',
    psm: '6',
    payload: { text: 'hoi', empty: false },
    confidence: 91,
    ms: 120,
  });

  const rows = store.attemptsFor('p1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'ocr');
  assert.equal(rows[0].payload.text, 'hoi');
  assert.equal(rows[0].confidence, 91);
  assert.equal(rows[0].ok, null);
  store.close();
});

test('stores ok as a real boolean rather than 0/1', () => {
  const store = memoryStore();
  store.record({ subject: 'p', stage: 'validate', ok: true });
  store.record({ subject: 'p', stage: 'validate', ok: false });
  store.record({ subject: 'p', stage: 'validate' });
  assert.deepEqual(store.attemptsFor('p').map((r) => r.ok), [true, false, null]);
  store.close();
});

test('keeps attempts for different subjects separate', () => {
  const store = memoryStore();
  store.record({ subject: 'a', stage: 'ocr' });
  store.record({ subject: 'b', stage: 'ocr' });
  assert.equal(store.attemptsFor('a').length, 1);
  assert.equal(store.countAttempts(), 2);
  store.close();
});

test('survives an unserialisable payload', () => {
  const store = memoryStore();
  const circular = {};
  circular.self = circular;
  assert.equal(store.record({ subject: 'x', stage: 'ocr', payload: circular }), true);
  assert.equal(store.attemptsFor('x').length, 1, 'logging must never break solving');
  store.close();
});

test('kv round-trips values and records the schema version', () => {
  const store = memoryStore();
  assert.equal(store.get('schema_version'), String(SCHEMA_VERSION));
  assert.equal(store.get('missing', 'fallback'), 'fallback');
  store.set('watermark', '123.5');
  store.set('watermark', '124.5');
  assert.equal(store.get('watermark'), '124.5', 'set must overwrite');
  store.close();
});

test('persists to a file and reopens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-'));
  const path = join(dir, 'state.db');
  try {
    const first = openStore({ path });
    first.record({ subject: 'p', stage: 'ocr', payload: { n: 1 } });
    first.close();

    const second = openStore({ path });
    assert.equal(second.attemptsFor('p').length, 1, 'data must survive a restart');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claims a push exactly once, across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-'));
  const path = join(dir, 'state.db');
  try {
    const push = {
      iden: 'p1',
      created: 1,
      modified: 2,
      type: 'file',
      file_name: 'a.png',
      file_url: 'http://example.test/a.png',
    };
    const first = openStore({ path });
    assert.equal(first.claimPush(push), true);
    assert.equal(first.claimPush(push), false, 'a duplicate tickle must not re-claim');
    assert.equal(first.getPush('p1').status, 'new');
    assert.equal(first.countPushes(), 1);
    first.setPushStatus('p1', 'solved');
    first.close();

    const second = openStore({ path });
    assert.equal(second.claimPush(push), false, 'the claim survives a restart');
    assert.equal(second.getPush('p1').status, 'solved');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ignored push is claimed so it is not re-fetched forever', () => {
  const store = memoryStore();
  store.claimPush({ iden: 'n1', type: 'note' }, { status: 'ignored' });
  assert.equal(store.getPush('n1').status, 'ignored');
  assert.equal(store.claimPush({ iden: 'n1', type: 'note' }), false);
  store.close();
});

test('the outbox claim happens before the send and is never released', () => {
  const store = memoryStore();
  assert.equal(store.claimOutbox('p1', 'h1'), true);
  assert.equal(store.claimOutbox('p1', 'h1'), false, 'a second delivery must lose the claim');
  assert.equal(store.getOutbox('p1', 'h1').sent_at, null, 'claimed is not sent');
  assert.equal(store.lastSentAt(), null, 'a claim must not count as a send');
  assert.equal(store.countSentSince(0), 0);
  assert.equal(store.pendingOutbox().length, 1);

  store.markOutboxSent('p1', 'h1', { response: { iden: 'note-1' } });
  const row = store.getOutbox('p1', 'h1');
  assert.ok(row.sent_at > 0);
  assert.match(row.response, /note-1/);
  assert.equal(store.countSentSince(0), 1);
  assert.equal(store.pendingOutbox().length, 0);
  assert.equal(store.lastSentAt(), row.sent_at);
  store.close();
});

test('a failed delivery stays claimed and records why', () => {
  const store = memoryStore();
  store.claimOutbox('p1', 'h1');
  store.noteOutboxError('p1', 'h1', new Error('network exploded'));
  const row = store.getOutbox('p1', 'h1');
  assert.equal(row.sent_at, null);
  assert.match(row.response, /network exploded/);
  assert.equal(store.claimOutbox('p1', 'h1'), false, 'an error must not release the claim');
  assert.equal(store.countSentSince(0), 0, 'a failed send does not count against the hourly cap');
  store.close();
});

test('loads the shipped solve prompt', () => {
  clearPromptCache();
  const prompt = loadPrompt('solve');
  assert.ok(prompt.length > 100);
  assert.match(prompt, /puzzle_class/);
  assert.match(prompt, /hoeveel/i);
});

test('falls back to a built-in prompt when the file is absent', () => {
  const prompt = loadPrompt('solve', { promptDir: join(tmpdir(), 'definitely-not-here') });
  assert.equal(prompt, FALLBACK_PROMPTS.solve);
});

test('returns an empty string for an unknown prompt name', () => {
  assert.equal(loadPrompt('nope', { promptDir: join(tmpdir(), 'definitely-not-here') }), '');
});