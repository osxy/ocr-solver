/**
 * Guards for the README's shape, so the second rewrite does not have to happen.
 *
 * The README is the front door: what it is, install, run, the failures people hit, the
 * known limitations, and pointers. Everything else belongs in DESIGN.md or docs/ (the
 * rule is written down in AGENTS.md §10). These two tests are the ratchet:
 *
 *   1. a length budget, so a milestone cannot append its mode and its evidence here;
 *   2. every relative link and anchor resolves, so moving detail to docs/ cannot leave
 *      a silently dead pointer behind.
 *
 * The budget numbers are deliberately stated here and in AGENTS.md §10. When the README
 * legitimately grows, raise them in one deliberate commit and say why in the message -
 * do not delete the assertion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const readmePath = join(repoRoot, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

// Stated budget. Sized just above the file at the second rewrite (414 lines / 3207
// words) so that any addition needs a deliberate trim or a deliberate, explained bump.
const MAX_LINES = 430;
const MAX_WORDS = 3400;

test('the README stays within its length budget', () => {
  const lines = readme.split('\n').length - 1; // wc -l semantics
  const words = readme.trim().split(/\s+/).length;

  assert.ok(
    lines <= MAX_LINES,
    `README is ${lines} lines; the budget is ${MAX_LINES}. Move detail to DESIGN.md or docs/ before adding.`
  );
  assert.ok(
    words <= MAX_WORDS,
    `README is ${words} words; the budget is ${MAX_WORDS}. Move detail to DESIGN.md or docs/ before adding.`
  );
});

/**
 * GitHub's heading-to-anchor rule, close enough for these files: lowercase, drop
 * punctuation, turn spaces into hyphens. Multiple spaces become multiple hyphens, which
 * is what GitHub does with `Tray / service mode` -> `tray--service-mode`.
 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_ -]/gu, '')
    .replace(/ /g, '-');
}

function anchorsOf(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const headings = [...text.matchAll(/^#{1,6}\s+(.*)$/gm)].map((m) => slug(m[1]));
  return new Set(headings);
}

test('every relative link and anchor in the README resolves', () => {
  // Markdown links, including images. Absolute URLs and pure anchors are handled below.
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1].trim());

  for (const link of links) {
    if (/^(https?:|mailto:)/i.test(link)) continue;

    const [rawPath, fragment] = link.split('#');
    const targetPath = rawPath === '' ? readmePath : resolve(dirname(readmePath), rawPath);

    assert.ok(existsSync(targetPath), `README links to a missing path: ${link}`);

    if (!fragment) continue;
    if (statSync(targetPath).isDirectory()) continue; // a directory has no anchors

    const anchors = anchorsOf(targetPath);
    assert.ok(
      anchors.has(fragment),
      `README links to ${link}, but ${rawPath || 'README.md'} has no heading with that anchor`
    );
  }
});
