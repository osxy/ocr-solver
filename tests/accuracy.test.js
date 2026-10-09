/**
 * Accuracy metric unit tests (M4).
 *
 * These are deliberately about the *shape* of the number, not about OCR: the
 * pipeline's behaviour is covered by the corpus tests. What matters here is that
 * the metric distinguishes valid from correct, counts a pending entry in the
 * denominator, and never blends provenance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  summarize,
  buildReport,
  runTextCorpus,
  storeReport,
  validateManifest,
  loadCorpusItems,
  formatSummary,
  formatTray,
  saveReportCache,
  loadReportCache,
  defaultAccuracyCachePath,
} from '../src/accuracy.js';
import { memoryStore } from '../src/state/db.js';

const row = (overrides) => ({
  id: 'x', provenance: 'synthetic', kind: 'text', class: 'count', expected: '1',
  answer: '1', valid: true, correct: true, confident: true, method: 'tier0:count', error: null,
  ...overrides,
});

test('summarize separates valid from correct and keeps pending in the denominator', () => {
  const summary = summarize([
    row({}),
    row({ id: 'wrong', answer: '2', correct: false }),
    row({ id: 'unanswered', answer: null, valid: false, correct: false }),
    row({ id: 'pending', expected: null, correct: false }),
  ]);
  assert.equal(summary.seen, 4);
  assert.equal(summary.valid, 3, 'three produced a validator-accepted answer');
  assert.equal(summary.correct, 1, 'only one matched ground truth');
  assert.equal(summary.gradeable, 3, 'pending rows have no ground truth');
  assert.equal(summary.pending, 1);
  assert.equal(summary.accuracy, 1 / 3);
  assert.equal(summary.validRate, 3 / 4, 'a pending puzzle still counts as seen');
  assert.equal(summary.sentable, 3, 'all three valid rows here are also confident');
  assert.equal(summary.withheld, 0);
  assert.equal(summary.sentableRate, 3 / 4);

  // A validator-accepted but uncorroborated answer is visible as valid, and is
  // separated out of `sentable` rather than counted as something that was sent (#49).
  const withheld = summarize([row({ valid: true, confident: false })]);
  assert.equal(withheld.valid, 1);
  assert.equal(withheld.sentable, 0);
  assert.equal(withheld.withheld, 1);
  assert.equal(withheld.sentableRate, 0);
});

test('accuracy is null, not zero, when there is nothing to grade', () => {
  const summary = summarize([row({ expected: null, correct: false })]);
  assert.equal(summary.accuracy, null);
  assert.equal(summary.validRate, 1);
});

test('buildReport groups by provenance and kind without blending', () => {
  const report = buildReport([
    row({ id: 'r', provenance: 'real' }),
    row({ id: 's1', provenance: 'synthetic' }),
    row({ id: 's2', provenance: 'synthetic', answer: '9', correct: false }),
    row({ id: 'd', provenance: 'derived', kind: 'image' }),
  ]);
  assert.equal(report.byProvenance.real.seen, 1);
  assert.equal(report.byProvenance.synthetic.seen, 2);
  assert.equal(report.byProvenance.synthetic.accuracy, 0.5);
  assert.equal(report.byProvenance.derived.seen, 1);
  assert.equal(report.byKind.text.seen, 3);
  assert.equal(report.byKind.image.seen, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].id, 's2');
});

test('runTextCorpus repairs, parses and grades a real transcript', () => {
  const rows = runTextCorpus([
    { id: 'ok', provenance: 'synthetic', kind: 'text', class: 'count', expected: '2',
      transcript: 'hoeveel kleuren in lijst rood blauw hond' },
    { id: 'damaged', provenance: 'derived', kind: 'text', class: 'arithmetic', expected: '7',
      transcript: 'Wat js acht min een?' },
    { id: 'bad', provenance: 'synthetic', kind: 'text', class: 'count', expected: '5',
      transcript: 'hoeveel kleuren in lijst rood blauw hond' },
  ]);
  assert.equal(rows[0].correct, true);
  assert.equal(rows[1].correct, true, 'the j->i confusion repair must be graded honestly');
  assert.equal(rows[1].valid, true);
  assert.equal(rows[2].correct, false);
  assert.equal(rows[2].answer, '2');
});

test('storeReport counts real traffic and has no ground-truth accuracy', () => {
  const store = memoryStore();
  store.record({ subject: 'solved-1', stage: 'ocr', payload: { text: 'hoeveel kleuren in lijst rood' } });
  store.record({ subject: 'solved-1', stage: 'validate', ok: true, payload: { answer: '1', class: 'count', confident: true, method: 'tier0:count' } });
  store.record({ subject: 'unresolved-2', stage: 'ocr', payload: { text: 'iets onbekends' } });
  store.record({ subject: 'unresolved-2', stage: 'validate', ok: false, payload: { answer: null, class: 'unknown', confident: false, method: null } });
  store.record({ subject: 'circuit-breaker', stage: 'breaker', payload: { to: 'open' } });

  const report = storeReport(store);
  assert.equal(report.overall.seen, 2, 'the circuit-breaker subject is not a puzzle');
  assert.equal(report.overall.valid, 1);
  assert.equal(report.overall.validRate, 0.5);
  assert.equal(report.overall.accuracy, null, 'the store has no ground truth');
  assert.equal(report.byClass.count.seen, 1);
  store.close();
});

test('#49: a solved recorded puzzle is not a failure, and a withheld answer is not sent-able', () => {
  const store = memoryStore();
  store.record({ subject: 'solved', stage: 'validate', ok: true, payload: { answer: '2', class: 'count', confident: true } });
  // Validator-accepted but require_confidence would withhold it: valid, not sent-able.
  store.record({ subject: 'withheld', stage: 'validate', ok: true, payload: { answer: '3', class: 'count', confident: false } });
  store.record({ subject: 'unresolved', stage: 'validate', ok: false, payload: { answer: null, class: 'unknown', confident: false } });

  const report = storeReport(store);
  assert.equal(report.overall.seen, 3);
  assert.equal(report.overall.valid, 2, 'both validator-accepted answers are valid');
  assert.equal(report.overall.sentable, 1, 'only the corroborated one would be sent');
  assert.equal(report.overall.withheld, 1);
  assert.equal(report.overall.sentableRate, 1 / 3);

  // No ground truth exists, so nothing is a graded failure; the unanswered puzzle is
  // reported as unresolved instead of inflating `failures` (#49).
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.unresolved.map((r) => r.id), ['unresolved']);
  store.close();
});

test('#49: a graded corpus item that is wrong is still a failure, and pending is not', () => {
  const report = buildReport([
    row({ id: 'wrong', correct: false, answer: '9' }),
    row({ id: 'pending', expected: null, correct: false, valid: false, answer: null }),
  ]);
  assert.deepEqual(report.failures.map((f) => f.id), ['wrong']);
  assert.deepEqual(report.unresolved.map((u) => u.id), ['pending']);
});

test('a malformed manifest is refused rather than silently defaulted', () => {
  assert.throws(() => validateManifest({ items: [{ id: 'a', provenance: 'real' }] }), /unknown kind/);
  assert.throws(() => validateManifest({ items: [{ id: 'a', provenance: 'made-up', kind: 'text' }] }), /unknown provenance/);
  assert.throws(() => validateManifest({ items: [{ id: 'a', provenance: 'real', kind: 'image' }] }), /no file/);
  assert.throws(() => validateManifest({ items: [{ id: 'a', provenance: 'real', kind: 'text' }, { id: 'a', provenance: 'real', kind: 'text' }] }), /duplicate/);
  // A pending entry (expected null) is legal: that is a recorded unresolved puzzle.
  assert.doesNotThrow(() => validateManifest({ items: [{ id: 'a', provenance: 'real', kind: 'image', file: 'a.png', expected: null }] }));
});

test('loadCorpusItems merges recorded entries without touching the committed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-corpus-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, items: [
      { id: 'committed', provenance: 'real', kind: 'image', file: 'a.png', expected: '1' },
    ] }));
    const recordedDir = join(dir, 'recorded');
    mkdirSync(recordedDir, { recursive: true });
    writeFileSync(join(recordedDir, 'manifest.json'), JSON.stringify({ version: 1, items: [
      { id: 'recorded', provenance: 'real', kind: 'image', file: 'recorded/b.png', expected: null },
    ] }));
    const items = loadCorpusItems(dir);
    assert.deepEqual(items.map((i) => i.id), ['committed', 'recorded']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('formatSummary and formatTray are stable, human-readable strings', () => {
  const summary = summarize([row({}), row({ id: 'w', correct: false })]);
  assert.match(formatSummary(summary), /1\/2 correct/);
  assert.match(formatSummary(summary), /sent-able/);
  assert.equal(formatTray(null), null);
  assert.equal(
    formatTray({ corpus: { overall: { accuracy: 1 } }, store: { overall: { validRate: 0.5 } } }),
    'corpus 100.0% · traffic 50.0% valid',
    'an older cache without sentableRate falls back to the labelled valid figure'
  );
  assert.equal(
    formatTray({ corpus: { overall: { accuracy: 1 } }, store: { overall: { validRate: 0.5, sentableRate: 0.25 } } }),
    'corpus 100.0% · traffic 25.0% sent-able',
    'the traffic headline is what would actually be sent (#49)'
  );
});

test('the report cache round-trips and a missing cache is null, not a throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-cache-'));
  try {
    const path = join(dir, 'accuracy.json');
    assert.equal(loadReportCache(path), null);
    const bundle = { version: 1, corpus: { overall: { accuracy: 1 } } };
    saveReportCache(path, bundle);
    assert.deepEqual(loadReportCache(path), bundle);
    assert.equal(defaultAccuracyCachePath('/a/b/state.db'), join('/a/b', 'accuracy.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
