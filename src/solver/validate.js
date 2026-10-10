/**
 * The acceptance gate.
 *
 * An answer is only ever sent when it matches the shape its puzzle class demands.
 * A wrong answer on a rate-limited form is worse than no answer, so anything that
 * fails here is escalated (to a stronger/vision model later) rather than posted.
 *
 * This gate is also the main defence against the OCR confidence trap: Tesseract
 * happily reports 95% confidence for an empty transcript, so empty input must be
 * rejected on its own merits, never trusted because of a high score.
 */
import { PUZZLE_CLASS } from './puzzle.js';

/** Trim and flatten a raw model/OCR answer into postable text. */
export function normalizeAnswer(raw) {
  if (raw == null) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '').trim();
  s = s.replace(/[.,;:!?]+$/g, '').trim();
  // Models love to answer "Het antwoord is: 7".
  s = s.replace(/^(?:het\s+antwoord\s+is|antwoord|answer)\s*[:\-]\s*/i, '').trim();
  return s;
}

/**
 * Things a model says when it is declining to answer.
 *
 * These must be rejected for every puzzle class. Without this, a model replying
 * "onbekend" to a question it could not read would pass the loose `unknown` rule -
 * it is short and single-line - and be posted as though it were a real answer.
 * Observed in practice, not hypothetically.
 */
const NON_ANSWERS = new Set([
  'onbekend', 'onduidelijk', 'onleesbaar', 'niet', 'kan', 'weet',
  'geen', 'geenidee', 'weetikhet', 'weetniet', 'kanniet', 'niettelezen',
  'unknown', 'unclear', 'illegible', 'unsure', 'none', 'null', 'nil', 'undefined',
  'n/a', 'na', 'error', 'fout', 'foutje', 'mis', 'leeg', 'empty', 'bad', 'invalid',
  'sorry', 'excuses', 'help', 'hulp', '?', '??', '???', '-', '--', '...', '…',
]);

const RULES = {
  [PUZZLE_CLASS.COUNT]: {
    canonical: (a) => a,
    test: (a) => /^\d+$/.test(a) && Number(a) >= 0 && Number(a) <= 20,
    describe: 'a bare integer between 0 and 20',
  },
  [PUZZLE_CLASS.ARITHMETIC]: {
    canonical: (a) => a,
    test: (a) => /^-?\d+$/.test(a) && Number(a) >= -99 && Number(a) <= 999,
    describe: 'a bare integer',
  },
  [PUZZLE_CLASS.ORDINAL_PICK]: {
    // Word answers are expected lowercase, matching the generated puzzles ('hoofd').
    canonical: (a) => a.toLowerCase(),
    test: (a) => /^[a-zà-ÿ]+$/.test(a) && a.length <= 30,
    describe: 'a single lowercase Dutch word',
  },
  [PUZZLE_CLASS.UNKNOWN]: {
    canonical: (a) => a,
    test: (a) => a.length > 0 && a.length <= 40 && !/\n/.test(a),
    describe: 'a short single-line answer',
  },
};

/**
 * Validate an answer against its puzzle class and return the canonical form
 * that should actually be posted. Returns { ok, answer, reason, expected }.
 */
export function validateAnswer(puzzleClass, normalized) {
  const rule = RULES[puzzleClass] ?? RULES[PUZZLE_CLASS.UNKNOWN];
  const answer = rule.canonical(normalizeAnswer(normalized));

  if (!answer) {
    return { ok: false, answer: '', reason: 'answer is empty', expected: rule.describe };
  }
  // Check the raw form and a whitespace-stripped form, so "geen idee" is caught too.
  if (NON_ANSWERS.has(answer.toLowerCase()) || NON_ANSWERS.has(answer.toLowerCase().replace(/\s+/g, ''))) {
    return {
      ok: false,
      answer,
      reason: `"${answer}" is a refusal, not an answer`,
      expected: rule.describe,
    };
  }
  if (!rule.test(answer)) {
    return { ok: false, answer, reason: `"${answer}" is not ${rule.describe}`, expected: rule.describe };
  }
  return { ok: true, answer, reason: 'ok', expected: rule.describe };
}
