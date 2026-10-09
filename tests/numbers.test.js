import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNumberWord, parseExpression, solveArithmetic, evaluateTerms } from '../src/solver/numbers.js';

test('parses simple Dutch number words', () => {
  assert.equal(parseNumberWord('nul'), 0);
  assert.equal(parseNumberWord('een'), 1);
  assert.equal(parseNumberWord('acht'), 8);
  assert.equal(parseNumberWord('tien'), 10);
  assert.equal(parseNumberWord('negentien'), 19);
  assert.equal(parseNumberWord('twintig'), 20);
});

test('parses compound number words', () => {
  assert.equal(parseNumberWord('eenentwintig'), 21);
  assert.equal(parseNumberWord('vijfenveertig'), 45);
  assert.equal(parseNumberWord('negenennegentig'), 99);
  assert.equal(parseNumberWord('honderd'), 100);
  assert.equal(parseNumberWord('tweehonderd'), 200);
  assert.equal(parseNumberWord('driehonderdvijf'), 305);
});

test('parses compounds written with a diaeresis', () => {
  assert.equal(parseNumberWord('drieënveertig'), 43);
  assert.equal(parseNumberWord('tweeëntwintig'), 22);
});

test('rejects non-number words', () => {
  for (const w of ['in', 'de', 'lijst', 'hoofd', 'kleuren', 'eerste', '']) {
    assert.equal(parseNumberWord(w), null, `expected ${JSON.stringify(w)} to be null`);
  }
});

test('solves the corpus arithmetic puzzle in words', () => {
  const r = solveArithmetic('Wat is acht min een?');
  assert.ok(r);
  assert.equal(r.answer, '7');
});

test('solves the four Dutch operators', () => {
  assert.equal(solveArithmetic('wat is twee plus drie').answer, '5');
  assert.equal(solveArithmetic('wat is tien min vier').answer, '6');
  assert.equal(solveArithmetic('wat is zes keer zeven').answer, '42');
  assert.equal(solveArithmetic('wat is twintig gedeeld door vijf').answer, '4');
});

test('honours multiplication precedence over addition', () => {
  assert.equal(solveArithmetic('wat is twee plus drie keer vier').answer, '14');
});

test('accepts literal digits as well as number words', () => {
  assert.equal(solveArithmetic('wat is 8 min 1').answer, '7');
  assert.equal(solveArithmetic('wat is 8-1').answer, '7');
});

test('returns null for a non-arithmetic question', () => {
  assert.equal(parseExpression('in de lijst hoofd buik citroen wat is het eerste lichaamsdeel'), null);
  assert.equal(parseExpression('hoeveel kleuren in lijst wit paars'), null);
  assert.equal(parseExpression('wat is dit'), null);
});

test('refuses division by zero instead of returning Infinity', () => {
  assert.equal(evaluateTerms([
    { type: 'number', value: 1 },
    { type: 'operator', value: '/' },
    { type: 'number', value: 0 },
  ]), null);
});
