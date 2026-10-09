/**
 * End-to-end regression test over the real puzzle images.
 *
 * This is the test that matters: it runs the actual preprocessing, the actual
 * Tesseract OCR, the repair layer and the offline solver against real noisy
 * artwork, and asserts the final answer. No network, no API key.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { solveImage } from '../src/solver/pipeline.js';
import { editDistance } from '../src/solver/lexicon.js';

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
const expected = JSON.parse(readFileSync(join(corpusDir, 'expected.json'), 'utf8'));

let worker;
before(async () => {
  worker = await createOcrWorker();
});
after(async () => {
  await worker?.terminate();
});

/** Similarity of two transcripts, 0..1, used to allow small OCR residue. */
function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

for (const item of expected) {
  test(`solves ${item.file} (${item.class}) -> ${item.answer}`, async () => {
    const result = await solveImage(worker, join(corpusDir, item.file));

    assert.ok(result.solved, `expected an offline solution, got: ${result.ranked[0]?.text ?? 'no OCR output'}`);
    assert.equal(result.answer, item.answer);
    assert.equal(result.solved.parsed.class, item.class);
    assert.equal(result.confident, true, 'answer must be marked confident');
    assert.equal(result.needsModel, false);

    if (item.category) assert.equal(result.solved.parsed.category, item.category);
    if (item.list.length) assert.deepEqual(result.solved.parsed.list, item.list);

    const gotTranscript = result.solved.normalized.text;
    assert.ok(
      similarity(gotTranscript, item.transcript) >= 0.9,
      `transcript too far from expected\n  got:      ${gotTranscript}\n  expected: ${item.transcript}`
    );
  });
}

test('every corpus image is answered offline, with no model call', async () => {
  const results = [];
  for (const item of expected) {
    results.push(await solveImage(worker, join(corpusDir, item.file)));
  }
  assert.equal(results.filter((r) => r.answer != null).length, expected.length);
  assert.equal(results.every((r) => r.needsModel === false), true);
});
