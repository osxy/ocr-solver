/**
 * Guards the claims DESIGN.md makes about the code.
 *
 * DESIGN.md §4.2 credited `bestResult()` with an OCR ranking the pipeline never
 * performed (issue #144): the function existed, nothing called it, and the document
 * described it as delivered behaviour. That is the "claim that outlived its code"
 * class - the same shape as `pruneInbox` and `setup-dialog.js` (#90) - and it is one a
 * test can catch: every `name()` the design document names should exist in `src/` and
 * have at least one call site there.
 *
 * The allowlist is deliberately short. It holds only JS keywords that are written with
 * empty parentheses in prose; `import()` is the sole current entry. A long allowlist
 * would mean the guard is checking the list rather than the code - if this one grows,
 * delete the guard instead of growing it. Known limitation: the 'caller' check counts a
 * source line, so a mention inside a trailing comment still counts. It catches the
 * documented-but-uncalled shape, which is what the issue was.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const design = readFileSync(join(repoRoot, 'DESIGN.md'), 'utf8');

/** JS keywords/syntax written as `name()` in prose, not project functions. */
const NOT_A_PROJECT_FUNCTION = new Set(['import']);

function walkJs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const srcLines = walkJs(join(repoRoot, 'src')).flatMap((file) => readFileSync(file, 'utf8').split('\n'));

test('every `name()` DESIGN.md names is a real function with a caller in src/', () => {
  const named = [...design.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(\)`/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'the guard found no `name()` in DESIGN.md; the extractor is broken');

  const problems = [];
  for (const name of new Set(named)) {
    if (NOT_A_PROJECT_FUNCTION.has(name)) continue;
    const declaration = new RegExp(`\\bfunction\\s+${name}\\s*\\(`);
    const call = new RegExp(`\\b${name}\\s*\\(`);
    const declarations = srcLines.filter((line) => declaration.test(line)).length;
    const calls = srcLines.filter(
      (line) => call.test(line) && !declaration.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line),
    ).length;

    if (declarations === 0) problems.push(`\`${name}()\` is named in DESIGN.md but no function declares it in src/`);
    else if (calls === 0) problems.push(`\`${name}()\` is named in DESIGN.md but nothing in src/ calls it`);
  }

  assert.deepEqual(
    problems,
    [],
    `DESIGN.md names functions the product does not provide or call:\n${problems.join('\n')}`,
  );
});
