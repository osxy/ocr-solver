/**
 * Corpus builder tests (M4).
 *
 * The builders must only ever emit a fixture whose answer is correct by
 * construction: a broken fixture is indistinguishable from a pipeline regression
 * in the accuracy report, and that is exactly the trap this milestone is about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';

import {
  buildCount,
  buildOrdinal,
  buildArithmetic,
  drawArithmetic,
  buildTextFixtures,
  buildDamagedTextFixtures,
  buildEdgeTextFixtures,
  buildImageSpecs,
  wrapTranscript,
  damageTranscript,
  assertSolvable,
} from '../src/corpus/build.js';
import { renderPuzzleImage, seededRandom } from '../src/corpus/render.js';
import { CATEGORIES } from '../src/solver/lexicon.js';

test('wrapTranscript keeps a short line whole and never exceeds two lines', () => {
  assert.deepEqual(wrapTranscript('wat is acht min een'), ['wat is acht min een']);
  const long = wrapTranscript('hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap');
  assert.ok(long.length <= 2);
  assert.equal(long.join(' '), 'hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap');
});

test('buildCount counts only the category words, across distractor counts', () => {
  const rand = seededRandom(1);
  for (let i = 0; i < 50; i++) {
    const item = buildCount({ category: 'kleur', matchCount: i % 5, distractorCount: 3, rand });
    assert.equal(item.expected, String(i % 5));
    assertSolvable(item, `count-${i}`);
  }
});

test('buildOrdinal answers the word its ordinal selects, never a distractor', () => {
  const rand = seededRandom(2);
  for (const ordinal of ['eerste', 'tweede', 'derde', 'laatste']) {
    for (let i = 0; i < 10; i++) {
      const item = buildOrdinal({ category: 'dier', ordinal, matchCount: 3, distractorCount: 3, rand });
      assert.ok(item, `ordinal ${ordinal} should be constructible`);
      assert.ok(CATEGORIES.dier.includes(item.expected), 'the answer must be a real category word');
      assertSolvable(item, `ordinal-${ordinal}-${i}`);
    }
  }
});

test('arithmetic fixtures obey the class validator, including division and negatives', () => {
  const rand = seededRandom(3);
  for (let i = 0; i < 100; i++) {
    const item = drawArithmetic(rand);
    assert.ok(item, 'a valid arithmetic draw must be found');
    assert.match(item.expected, /^-?\d+$/);
    assertSolvable(item, `arith-${i}`);
  }
  assert.equal(buildArithmetic({ aWord: 'tien', op: 'gedeeld', bWord: 'drie' }), null, 'non-integer division is rejected');
});

test('clean text fixtures are all solvable and cover every offline category', () => {
  const items = buildTextFixtures({ count: 60, seed: 9 });
  assert.equal(items.length, 60);
  const categories = new Set(items.filter((i) => i.category).map((i) => i.category));
  for (const category of ['kleur', 'lichaamsdeel', 'dier', 'vrucht', 'groente', 'kleding', 'meubel', 'beroep', 'vervoer']) {
    assert.ok(categories.has(category), `the fixtures should exercise ${category}`);
  }
  for (const item of items) assertSolvable(item, item.id);
});

test('damaged fixtures only contain damage the repair layer can undo', () => {
  const items = buildDamagedTextFixtures({ count: 40, seed: 11 });
  assert.ok(items.length > 10, 'the builder should find repairable damage');
  for (const item of items) {
    assert.notEqual(item.transcript, item.undamaged);
    assertSolvable(item, item.id);
  }
});

test('damageTranscript changes exactly one token and can be undone by repair', () => {
  const rand = seededRandom(4);
  const damaged = damageTranscript('hoeveel kleuren in lijst rood blauw', rand);
  assert.ok(damaged);
  assert.notEqual(damaged, 'hoeveel kleuren in lijst rood blauw');
  assertSolvable({ transcript: damaged, expected: '2' }, 'damaged-sample');
});

test('edge fixtures encode the cases a random draw rarely reaches', () => {
  const items = buildEdgeTextFixtures();
  assert.deepEqual(items.map((i) => i.expected), ['0', '4', 'groen', '4', '-7']);
  for (const item of items) assertSolvable(item, item.id);
});

test('image specs are labelled, varied, and correct before rendering', () => {
  const specs = buildImageSpecs({ count: 20, seed: 12 });
  assert.equal(specs.length, 20);
  const classes = new Set(specs.map((s) => s.class));
  assert.ok(classes.has('count') && classes.has('ordinal-pick') && classes.has('arithmetic'));
  for (const spec of specs) assertSolvable(spec, spec.id);
});

test('renderPuzzleImage is deterministic and emits a real PNG at the observed height', async (t) => {
  let first;
  let second;
  try {
    first = await renderPuzzleImage({ lines: ['Wat is acht min een?'], seed: 42 });
    second = await renderPuzzleImage({ lines: ['Wat is acht min een?'], seed: 42 });
  } catch (err) {
    // librsvg + fontconfig is the only non-hermetic input; a host with no fonts
    // (some minimal CI images) cannot render text at all. The committed PNGs are
    // what the corpus tests consume, so this check is allowed to skip.
    t.skip(`text rendering unavailable: ${err?.message ?? err}`);
    return;
  }
  assert.ok(first.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.ok(first.equals(second), 'the same seed must produce byte-identical output');
  const meta = await sharp(first).metadata();
  assert.ok(meta.height >= 44, `a rendered puzzle should be at least 44 px tall, got ${meta.height}`);
});
