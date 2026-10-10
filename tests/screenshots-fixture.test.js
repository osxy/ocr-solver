/**
 * The screenshot fixture is a pure function of a fixed clock (issue #114), and every
 * committed screenshot is displayed somewhere (issue #149).
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
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

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

const repoRoot = join(import.meta.dirname, '..');
const screenshotsDir = join(repoRoot, 'docs', 'screenshots');
// The directory's own README names every file in its table; an embed there would make this
// guard vacuous, so it is not a valid consumer.
const screenshotsReadme = resolve(screenshotsDir, 'README.md');

/** Every `.md` file under the repository, minus dependencies and VCS metadata. */
function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/**
 * Every committed screenshot is embedded somewhere (issue #149).
 *
 * A screenshot nobody displays costs repository weight and regeneration time for nothing.
 * `statistics-dark.png` was committed, regenerated and shown on no page at all until this
 * guard, and the directory README pointed at the top-level README that embeds none of the
 * six. The check is mechanical: parse the Markdown image syntax across the repository's
 * `.md` files and require each `docs/screenshots/*.png` to be the target of at least one.
 * A prose mention (DESIGN.md naming `solve.png`) is deliberately not enough - only an
 * `<img>` puts the picture in front of a reader.
 *
 * WHAT THIS GUARD IS NOT. It proves an image has a reader, not that the image is current:
 * only regenerating against the live UI can tell whether it is stale, and that needs a
 * browser, which `npm test` deliberately does not have. A green run means the image is
 * displayed, not that it is true.
 */
test('every committed screenshot is embedded as an image somewhere', () => {
  const shots = readdirSync(screenshotsDir)
    .filter((name) => name.endsWith('.png'))
    .map((name) => ({ name, path: join(screenshotsDir, name) }));
  assert.ok(shots.length > 0, 'docs/screenshots/ has no PNGs; the test has lost its subject');

  const referenced = new Set();
  for (const file of markdownFiles(repoRoot)) {
    if (resolve(file) === screenshotsReadme) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) {
      const target = match[1].replace(/^<|>$/g, '');
      if (/^(https?:|data:)/i.test(target)) continue;
      referenced.add(resolve(dirname(file), target));
    }
  }

  const missing = shots.filter((shot) => !referenced.has(resolve(shot.path))).map((shot) => shot.name);
  assert.deepEqual(
    missing,
    [],
    `these committed screenshots are embedded in no .md file: ${missing.join(', ')}. Embed each in the docs page that describes its mode, or remove it from the repository.`
  );
});
