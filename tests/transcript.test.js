import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscript } from '../src/solver/transcript.js';

const text = (s) => normalizeTranscript(s).text;

test('lowercases and collapses whitespace', () => {
  assert.equal(text('  Wat   IS  acht  '), 'wat is acht');
});

test('strips trailing question marks and other punctuation', () => {
  assert.equal(text('Wat is acht min een?'), 'wat is acht min een');
  assert.equal(text('Hoeveel kleuren in lijst wit paars?'), 'hoeveel kleuren in lijst wit paars');
  assert.equal(text('aap?'), 'aap');
});

test('keeps the de/het phrasing intact', () => {
  assert.equal(text('eerste de/het lichaamsdeel'), 'eerste de/het lichaamsdeel');
  assert.equal(text('de/het?'), 'de/het');
});

test('repairs a misread s as j in "is"', () => {
  const r = normalizeTranscript('Wat js acht min een?');
  assert.equal(r.text, 'wat is acht min een');
  assert.ok(r.repairs.some((x) => x.from === 'js' && x.to === 'is'));
});

test('repairs through digit-for-letter substitution', () => {
  assert.equal(text('1s'), 'is');
  assert.equal(text('kiw1'), 'kiwi');
  assert.equal(text('k1wi'), 'kiwi');
});

test('re-joins a split glyph', () => {
  const r = normalizeTranscript('hoof d paars');
  assert.equal(r.text, 'hoofd paars');
  assert.ok(r.repairs.some((x) => x.rule === 'rejoin'));
});

test('splits hyphenated OCR artefacts into separate list items', () => {
  assert.equal(text('lijst-lijst hoofd buik- citroen'), 'lijst lijst hoofd buik citroen');
});

test('is conservative: leaves unknown words alone rather than force-fitting', () => {
  // 'kw' is a garbled 'kiwi' but is too far away to rewrite safely. Rewriting it
  // could silently change a word count, so it must survive untouched.
  assert.equal(text('wit kw: paars'), 'wit kw paars');
});

test('reports unknown tokens so callers can flag low confidence', () => {
  const r = normalizeTranscript('hoeveel kleuren in lijst wit kw paars');
  assert.deepEqual(r.unknownTokens, ['kw']);
});

test('reports no unknown tokens for a clean corpus transcript', () => {
  const r = normalizeTranscript('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?');
  assert.deepEqual(r.unknownTokens, []);
  assert.deepEqual(r.repairs, []);
});

test('handles empty and nullish input', () => {
  assert.equal(text(''), '');
  assert.equal(text(null), '');
  assert.equal(text(undefined), '');
});
