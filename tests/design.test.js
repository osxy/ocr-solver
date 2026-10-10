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
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

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

/**
 * The §6 "Technology choices" table is a dependency audit in miniature: a reader trusts
 * it to answer "what does this ship?". It named the `openai` SDK (issue #150) three
 * sections after §4.7 argued for a hand-rolled `fetch` client - a claim that outlived its
 * code, and the one class #144's `name()` guard cannot see. This checks the table against
 * `package.json` in both directions.
 *
 * Built-ins have no package.json entry, so they are the only allowlist, and it is short:
 * a Node global or `node:` module the table legitimately names. A token must also look like
 * an npm name (lowercase, no colon) to be treated as a package, which keeps `CurrentUser`
 * and prose out of the check. If the allowlist ever grows into a list of packages, delete
 * the guard rather than grow it.
 */
const NODE_BUILTINS = new Set(['fetch', 'WebSocket', 'node:sqlite', 'node:test', 'node:assert']);
const NPM_NAME = /^(@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/;

/** The Choice cells of the §6 technology table, in row order. */
function technologyChoices() {
  const start = design.indexOf('## 6. Technology choices');
  const end = design.indexOf('## 7.', start);
  assert.ok(start !== -1 && end !== -1, 'DESIGN.md has no §6 technology table; the guard lost its subject');
  return [...design.slice(start, end).matchAll(/^\|([^|\n]+)\|([^|\n]+)\|/gm)]
    .map((match) => match[2])
    .filter((cell) => !/^\s*-+\s*$/.test(cell)); // the header separator row
}

test('every dependency the §6 technology table names exists in package.json', () => {
  const choices = technologyChoices();
  assert.ok(choices.length > 0, 'the §6 table has no rows; the extractor is broken');

  const deps = new Set(Object.keys(pkg.dependencies ?? {}));
  const problems = [];
  let named = 0;

  for (const cell of choices) {
    for (const [, token] of cell.matchAll(/`([^`]+)`/g)) {
      if (NODE_BUILTINS.has(token) || !NPM_NAME.test(token)) continue;
      named += 1;
      if (!deps.has(token)) {
        problems.push(`§6 names \`${token}\` as a dependency, but package.json does not depend on it`);
      }
    }
  }

  assert.ok(named > 0, 'the §6 table names no dependency; the extractor is broken');
  assert.deepEqual(problems, [], `DESIGN.md's technology table names dependencies the product does not have:\n${problems.join('\n')}`);
});

test('every package.json dependency is named in the §6 technology table', () => {
  const namedTokens = new Set(
    technologyChoices().flatMap((cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1])),
  );
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.ok(deps.length > 0, 'package.json has no dependencies; the guard lost its subject');

  const problems = deps.filter((dep) => !namedTokens.has(dep));
  assert.deepEqual(problems, [], `package.json depends on ${problems.join(', ')}, which the §6 technology table never names`);
});

/*
 * NOT GUARDED, deliberately: DESIGN.md's status line and ✅/⬜ component markers
 * (#154). Deciding whether a marker understates what shipped means comparing prose to
 * the release tags, and a test cannot reach `git tag` offline - a test that tried would
 * be checked against a hardcoded expectation, which is the same stale claim moved into
 * the test file. The marker prose is kept honest by the rule in DESIGN.md's header and by
 * review; that limitation is stated rather than papered over with a weak assertion.
 */
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
