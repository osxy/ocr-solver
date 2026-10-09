/**
 * record-corpus unit tests (M4).
 *
 * The most valuable corpus entry is an unresolved puzzle, so the tests focus on
 * that case: it must be recorded with `expected: null` (not silently dropped) and
 * must carry the provenance/kind labels the accuracy report needs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  outcomeFromAttempts,
  buildRecordedEntry,
  upsertRecordedManifest,
  findImageForSubject,
} from '../scripts/record-corpus.js';
import { validateManifest } from '../src/accuracy.js';
import { memoryStore } from '../src/state/db.js';

function attempt(stage, payload, ok = null) {
  return { stage, payload, ok };
}

test('a solved subject yields its validated answer and class', () => {
  const outcome = outcomeFromAttempts([
    attempt('ocr', { text: 'Hoeveel kleuren in lijst rood blauw hond' }),
    attempt('tier0', { answer: '2' }),
    attempt('validate', { answer: '2', class: 'count', confident: true, method: 'tier0:count' }, true),
  ]);
  assert.equal(outcome.answer, '2');
  assert.equal(outcome.accepted, true);
  assert.equal(outcome.class, 'count');
  assert.equal(outcome.confident, true);
  assert.match(outcome.transcript, /Hoeveel kleuren/);
});

test('an unresolved subject has no answer but still records its class and transcript', () => {
  const outcome = outcomeFromAttempts([
    attempt('ocr', { text: 'Wat is de hoofdstad van Nederland?' }),
    attempt('validate', { answer: null, class: 'unknown', confident: false, method: null }, false),
  ]);
  assert.equal(outcome.answer, null);
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.class, 'unknown');
});

test('a pending entry is legal and labelled, so a failure cannot vanish', () => {
  const entry = buildRecordedEntry({
    id: 'recorded-real-push-1',
    subject: 'push-1',
    provenance: 'real',
    relFile: 'recorded/push-1.png',
    expected: null,
    expectedSource: 'pending',
    class: 'unknown',
    status: 'unresolved',
  });
  assert.equal(entry.provenance, 'real');
  assert.equal(entry.kind, 'image');
  assert.equal(entry.expected, null);
  assert.match(entry.status, /unresolved/);
  assert.doesNotThrow(() => validateManifest({ items: [entry] }));
});

test('upsert replaces an existing entry and appends a new one', () => {
  let manifest = { version: 1, items: [] };
  manifest = upsertRecordedManifest(manifest, { id: 'a', expected: null });
  manifest = upsertRecordedManifest(manifest, { id: 'b', expected: '2' });
  manifest = upsertRecordedManifest(manifest, { id: 'a', expected: '7' });
  assert.deepEqual(manifest.items.map((i) => i.id), ['a', 'b']);
  assert.equal(manifest.items[0].expected, '7');
});

test('findImageForSubject prefers an explicit image, then the inbox, then an image-ref', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-record-'));
  try {
    const explicit = join(dir, 'explicit.png');
    writeFileSync(explicit, 'x');
    assert.equal(findImageForSubject({ subject: 'p', image: explicit, inboxDir: dir }), explicit);

    writeFileSync(join(dir, 'p.png'), 'x');
    assert.equal(findImageForSubject({ subject: 'p', inboxDir: dir }), join(dir, 'p.png'));

    const store = memoryStore();
    store.record({ subject: 'q', stage: 'image-ref', payload: { path: explicit } });
    assert.equal(findImageForSubject({ subject: 'q', inboxDir: dir, store }), explicit);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('findImageForSubject returns null rather than inventing a path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-record-'));
  try {
    assert.equal(findImageForSubject({ subject: 'missing', inboxDir: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
