/**
 * The screenshot fixture is a pure function of a fixed clock (issue #114).
 *
 * The capture itself needs Firefox, so it cannot run in CI. The reproducibility property
 * lives entirely in the fixture, though: its timestamps are ours, so they must come from a
 * fixed instant rather than `Date.now()`. Before this was fixed, every regeneration
 * produced a byte-different `statistics.png` / `statistics-dark.png` and a real UI change
 * was indistinguishable from clock noise. These tests are the guard that the fixture stays
 * a function of the clock it is handed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildHistory, FIXTURE_NOW } from '../scripts/screenshot-fixture.mjs';

const HOUR = 3600;
const DAY = 24 * HOUR;

test('the fixture is the same plan for the same instant', () => {
  const first = buildHistory(FIXTURE_NOW);
  const second = buildHistory(FIXTURE_NOW);
  assert.ok(first.length > 0, 'the fixture must record something');
  assert.deepEqual(first, second, 'the same instant must produce an identical plan');
});

test('the fixture never consults the real clock', () => {
  // Freeze `Date.now` at a far-future instant. If `buildHistory` reaches for the real
  // clock, every timestamp jumps to 2099 and this fails - which is exactly the regression
  // this test exists to catch. It cannot pass on the old `Date.now()`-relative fixture.
  const realNow = Date.now;
  Date.now = () => Date.UTC(2099, 0, 1, 0, 0, 0);
  try {
    for (const op of buildHistory(FIXTURE_NOW)) {
      assert.ok(
        Math.abs(op.at - FIXTURE_NOW) <= DAY,
        `timestamp ${op.at} is not derived from FIXTURE_NOW (${FIXTURE_NOW})`
      );
    }
  } finally {
    Date.now = realNow;
  }
});

test('the fixture clock is the argument, so a different instant shifts every row', () => {
  const step = 7 * DAY;
  const base = buildHistory(FIXTURE_NOW);
  const shifted = buildHistory(FIXTURE_NOW + step);
  assert.equal(base.length, shifted.length);
  for (let i = 0; i < base.length; i++) {
    assert.equal(shifted[i].at, base[i].at + step, `op ${i} did not shift with the clock`);
    // The recorded payload is the same; only the clock moves.
    assert.deepEqual(shifted[i].entry, base[i].entry, `op ${i} payload changed with the clock`);
  }
});

test('the fixture carries nothing real', () => {
  const subjects = new Set(buildHistory(FIXTURE_NOW).map((op) => op.entry.subject));
  for (const subject of subjects) {
    assert.match(subject, /^demo\//, `fixture subject ${subject} is not a demo name`);
    assert.doesNotMatch(subject, /@/, `fixture subject ${subject} looks like a real ident`);
  }
});
