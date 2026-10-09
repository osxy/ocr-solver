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