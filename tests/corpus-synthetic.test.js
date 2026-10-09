/**
 * End-to-end check of the grown corpus (M4).
 *
 * The full offline accuracy run lives in `npm run accuracy` because it takes ~30 s.
 * This test does the part that must never regress in the default suite:
 *
 *   - every text fixture (clean, damaged and derived) is graded correctly;
 *   - a synthetic image per class is actually readable by the real pipeline, so a
 *     corpus that only looks solvable cannot silently depress the number;
 *   - the manifest is labelled, so a single blended metric cannot be produced by
 *     accident.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOcrWorker } from '../src/ocr/recognize.js';
import { solveImage } from '../src/solver/pipeline.js';
import { loadManifest, runTextCorpus, PROVENANCES, KINDS } from '../src/accuracy.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
const manifest = loadManifest(corpusDir);

test('the manifest labels every item with a provenance and a kind', () => {
  assert.ok(manifest.items.length > 100, `corpus should be large enough to move by <1% per failure, got ${manifest.items.length}`);
  for (const item of manifest.items) {
    assert.ok(PROVENANCES.includes(item.provenance), `${item.id} provenance`);
    assert.ok(KINDS.includes(item.kind), `${item.id} kind`);
  }
  const provenances = new Set(manifest.items.map((i) => i.provenance));
  assert.deepEqual([...provenances].sort(), ['derived', 'real', 'synthetic']);
});

test('one failure moves the overall corpus accuracy by less than 1%', () => {
  const step = 1 / manifest.items.length;
  assert.ok(step < 0.01, `corpus has ${manifest.items.length} items; a single failure moves ${(step * 100).toFixed(3)}%`);
});

test('every text fixture is solved correctly offline, including the observed OCR damage', () => {
  const textItems = manifest.items.filter((i) => i.kind === 'text');
  assert.ok(textItems.length > 100, `expected a large text corpus, got ${textItems.length}`);
  const rows = runTextCorpus(textItems);
  const failures = rows.filter((r) => !r.correct);
  assert.deepEqual(
    failures.map((f) => `${f.id}: want=${f.expected} got=${f.answer}`),
    [],
    'a text fixture failing means the lexicon, parser or repair layer regressed'
  );
});

test('the derived fixtures are the real observed OCR damage', () => {
  const derived = manifest.items.filter((i) => i.provenance === 'derived');
  assert.equal(derived.length, 3);
  for (const item of derived) {
    assert.ok(item.derivedFrom?.endsWith('.png'), 'a derived item must name the real image it came from');
  }
});

let worker;
before(async () => {
  worker = await createOcrWorker();
});
after(async () => {
  await worker?.terminate();
});

test('a synthetic image per class is readable by the real pipeline', async () => {
  const byClass = new Map();
  for (const item of manifest.items) {
    if (item.provenance !== 'synthetic' || item.kind !== 'image') continue;
    if (!byClass.has(item.class)) byClass.set(item.class, item);
  }
  assert.deepEqual([...byClass.keys()].sort(), ['arithmetic', 'count', 'ordinal-pick']);
  for (const [klass, item] of byClass) {
    const result = await solveImage(worker, join(corpusDir, item.file), {});
    assert.equal(result.answer, item.expected, `${klass}: ${item.file} -> ${result.answer}`);
    assert.equal(result.puzzleClass, item.class);
  }
});
