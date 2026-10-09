import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePuzzle, solveTier0, PUZZLE_CLASS } from '../src/solver/puzzle.js';
import { normalizeTranscript } from '../src/solver/transcript.js';

const parse = (raw) => parsePuzzle(normalizeTranscript(raw).text);

test('classifies and solves the count puzzle', () => {
  const p = parse('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?');
  assert.equal(p.class, PUZZLE_CLASS.COUNT);
  assert.equal(p.category, 'kleur');
  assert.deepEqual(p.list, ['wit', 'kiwi', 'hoofd', 'paars', 'olifant', 'aap']);
  const solved = solveTier0(p);
  assert.equal(solved.answer, '2');
  assert.equal(solved.confident, true);
});

test('classifies and solves the ordinal-pick puzzle', () => {
  const p = parse('In de lijst lijst hoofd buik citroen borst olifant paard wat is de/het eerste lichaamsdeel?');
  assert.equal(p.class, PUZZLE_CLASS.ORDINAL_PICK);
  assert.equal(p.category, 'lichaamsdeel');
  // 'lijst' is a list item here, not scaffolding - the scaffolding is 'In de lijst'.
  assert.deepEqual(p.list, ['lijst', 'hoofd', 'buik', 'citroen', 'borst', 'olifant', 'paard']);
  const solved = solveTier0(p);
  assert.equal(solved.answer, 'hoofd');
});

test('classifies and solves the arithmetic puzzle', () => {
  const p = parse('Wat is acht min een?');
  assert.equal(p.class, PUZZLE_CLASS.ARITHMETIC);
  assert.equal(solveTier0(p).answer, '7');
});

test('picks the last match for "laatste"', () => {
  const p = parse('In de lijst hond blauw kat groen wat is de laatste kleur?');
  assert.equal(p.class, PUZZLE_CLASS.ORDINAL_PICK);
  assert.equal(solveTier0(p).answer, 'groen');
});

test('honours second/third ordinals', () => {
  const p = parse('In de lijst rood blauw groen wat is de tweede kleur?');
  assert.equal(solveTier0(p).answer, 'blauw');
  const q = parse('In de lijst rood blauw groen wat is de derde kleur?');
  assert.equal(solveTier0(q).answer, 'groen');
});

test('counts animals and fruits too, not just colours', () => {
  assert.equal(solveTier0(parse('Hoeveel dieren in lijst hond blauw kat hoofd aap')).answer, '3');
  assert.equal(solveTier0(parse('Hoeveel vruchten in lijst appel peer hond kiwi')).answer, '3');
});

test('flags low confidence when a list token is unrecognised', () => {
  // 'kw' is a garbled 'kiwi'; the count could therefore be wrong.
  const solved = solveTier0(parse('Hoeveel vruchten in lijst appel kw peer'));
  assert.equal(solved.confident, false);
  assert.match(solved.detail, /unknown=\[kw\]/);
});

test('falls back to unknown for an unsupported question', () => {
  const p = parse('Wat is de hoofdstad van Nederland?');
  assert.equal(p.class, PUZZLE_CLASS.UNKNOWN);
  assert.equal(solveTier0(p), null);
});

test('does not mistake a word list for arithmetic', () => {
  const p = parse('In de lijst twee drie vier wat is het eerste getal?');
  assert.equal(p.class, PUZZLE_CLASS.ORDINAL_PICK);
  assert.equal(solveTier0(p).answer, 'twee');
});
