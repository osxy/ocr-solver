import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswer, normalizeAnswer } from '../src/solver/validate.js';
import { PUZZLE_CLASS } from '../src/solver/puzzle.js';

test('normalizes model chatter out of an answer', () => {
  assert.equal(normalizeAnswer('  7  '), '7');
  assert.equal(normalizeAnswer('"7"'), '7');
  assert.equal(normalizeAnswer('7.'), '7');
  assert.equal(normalizeAnswer('Het antwoord is: 7'), '7');
  assert.equal(normalizeAnswer('antwoord: hoofd'), 'hoofd');
});

test('rejects an empty answer regardless of how it arrived', () => {
  // Tesseract reports ~95% confidence for a blank transcript, so emptiness has to
  // be judged on its own and never trusted because of a high confidence score.
  for (const raw of ['', '   ', undefined, null, '""']) {
    const v = validateAnswer(PUZZLE_CLASS.COUNT, raw);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'answer is empty');
  }
});

test('count answers must be a bare small integer', () => {
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '2').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '0').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '20').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, 'twee').ok, false);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '2 kleuren').ok, false);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '21').ok, false);
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '-1').ok, false);
});

test('arithmetic answers must be a bare integer', () => {
  assert.equal(validateAnswer(PUZZLE_CLASS.ARITHMETIC, '7').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.ARITHMETIC, '-3').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.ARITHMETIC, '7.5').ok, false);
  assert.equal(validateAnswer(PUZZLE_CLASS.ARITHMETIC, 'zeven').ok, false);
});

test('ordinal-pick answers must be a single word, canonicalised to lowercase', () => {
  const lower = validateAnswer(PUZZLE_CLASS.ORDINAL_PICK, 'hoofd');
  assert.equal(lower.ok, true);
  assert.equal(lower.answer, 'hoofd');

  const upper = validateAnswer(PUZZLE_CLASS.ORDINAL_PICK, 'Hoofd');
  assert.equal(upper.ok, true);
  assert.equal(upper.answer, 'hoofd', 'capitalised answers are canonicalised, not rejected');

  assert.equal(validateAnswer(PUZZLE_CLASS.ORDINAL_PICK, 'het hoofd').ok, false);
  assert.equal(validateAnswer(PUZZLE_CLASS.ORDINAL_PICK, '7').ok, false);
});

test('rejects a model refusing to answer, for every class', () => {
  // Observed live: a model replied "onbekend" to a question it could not read, and
  // the loose `unknown` rule accepted it because it is short and single-line.
  for (const refusal of ['onbekend', 'Onbekend', 'unknown', 'geen idee', 'weet niet', 'n/a', '???', '-', '...']) {
    for (const cls of Object.values(PUZZLE_CLASS)) {
      const v = validateAnswer(cls, refusal);
      assert.equal(v.ok, false, `${JSON.stringify(refusal)} must be rejected for ${cls}`);
      // Punctuation-only refusals are stripped to empty first, so they are rejected
      // as empty rather than as a named refusal. Both are rejections, which is the
      // property that matters.
      assert.match(v.reason, /refusal|empty/, `${cls} should explain why for ${JSON.stringify(refusal)}`);
    }
  }
});

test('does not reject real answers that merely look terse', () => {
  assert.equal(validateAnswer(PUZZLE_CLASS.COUNT, '0').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.ORDINAL_PICK, 'hoofd').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.UNKNOWN, 'Amsterdam').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.UNKNOWN, 'nee').ok, true, '"nee" is a real answer, not a refusal');
});

test('unknown puzzles still require a short single-line answer', () => {
  assert.equal(validateAnswer(PUZZLE_CLASS.UNKNOWN, 'Amsterdam').ok, true);
  assert.equal(validateAnswer(PUZZLE_CLASS.UNKNOWN, 'x'.repeat(41)).ok, false);
});

test('an unrecognised puzzle class falls back to the loosest rule', () => {
  assert.equal(validateAnswer('something-new', 'anything').ok, true);
});
