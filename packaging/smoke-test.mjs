#!/usr/bin/env node
/**
 * Smoke-test the *assembled artifact*, not the source tree.
 *
 * Runs under the artifact's own `node.exe` and launches the artifact's own
 * `app/src/cli.js` from a working directory outside the repository, against the offline
 * corpus. That is what catches the things a build inside the repo skips:
 *
 *   - a `sharp` native binary that did not travel (import fails immediately)
 *   - a bundled Node that does not actually run the bundled code
 *   - the Tesseract traineddata missing from `node_modules`
 *   - path assumptions that only hold when cwd is the repository
 *
 *   node.exe packaging/smoke-test.mjs <extractedDir> <corpusDir>
 *
 * Exits non-zero on the first mismatch, before anything is zipped or published.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [extracted, corpus] = process.argv.slice(2);
if (!extracted || !corpus) {
  console.error('usage: node smoke-test.mjs <extractedDir> <corpusDir>');
  process.exit(2);
}

const expected = JSON.parse(readFileSync(join(corpus, 'expected.json'), 'utf8'));
const cli = join(extracted, 'app', 'src', 'cli.js');

console.log(`smoke: ${process.execPath}`);
console.log(`smoke: ${cli} ${corpus} --json`);

const run = spawnSync(process.execPath, [cli, corpus, '--json'], {
  cwd: extracted,
  encoding: 'utf8',
});

if (run.error) {
  console.error(`SMOKE TEST FAILED TO START: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`SMOKE TEST FAILED: the packaged app exited ${run.status}`);
  console.error(run.stdout);
  console.error(run.stderr);
  process.exit(1);
}

let results;
try {
  results = JSON.parse(run.stdout);
} catch {
  console.error('SMOKE TEST FAILED: the packaged app did not print JSON');
  console.error(run.stdout);
  console.error(run.stderr);
  process.exit(1);
}

const answerFor = new Map(results.map((result) => [result.image, result.answer]));
const failures = [];
for (const item of expected) {
  const got = answerFor.get(item.file);
  if (got !== item.answer) failures.push(`${item.file}: expected ${item.answer}, got ${got ?? '(none)'}`);
}

// The corpus is small and known; if it changes underneath us the smoke test should say
// so rather than quietly passing against a different set of puzzles.
const known = expected.map((item) => item.answer).sort().join(',');
if (known !== '2,7,hoofd') {
  console.error(`SMOKE TEST FAILED: the corpus no longer holds the known answers (found ${known})`);
  process.exit(1);
}

if (failures.length) {
  console.error(`SMOKE TEST FAILED (${failures.length} of ${expected.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`smoke test passed: the packaged app solved ${expected.length}/${expected.length} ` +
  `corpus images (${expected.map((item) => `${item.file} -> ${item.answer}`).join(', ')})`);
