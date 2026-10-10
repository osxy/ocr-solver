/**
 * Guards for the README's shape, so the second rewrite does not have to happen.
 *
 * The README is the front door: what it is, install, run, the failures people hit, the
 * known limitations, and pointers. Everything else belongs in DESIGN.md or docs/ (the
 * rule is written down in AGENTS.md §10). These six tests are the ratchet:
 *
 *   1. a length budget, so a milestone cannot append its mode and its evidence here;
 *   2. every relative link and anchor resolves, so moving detail to docs/ cannot leave
 *      a silently dead pointer behind;
 *   3. every code fence is closed, so a stray marker cannot turn the tail of the file
 *      into a wall of grey monospace;
 *   4. `## License` is the terminal section, so material appended after it is visible
 *      even when it is not another heading;
 *   5. every docs/*.md page is linked from the README, so a page cannot be added and
 *      then forgotten;
 *   6. a page that describes configuration also mentions the settings editor, so the
 *      file is not the only route a page shows.
 *
 * The budget numbers are deliberately stated here and in AGENTS.md §10. When the README
 * legitimately grows, raise them in one deliberate commit and say why in the message -
 * do not delete the assertion.
 *
 * WHAT GUARDS 3 AND 4 ARE NOT. They catch the symptom - an unclosed fence, a section
 * after the terminal one - not the cause. The doc that prompted them carried a subagent's
 * scratchpad after `## License`, raw tool-call markup and all, and it passed the length
 * budget because 414 lines was under 430. Writing one's notes into a repository file is
 * not assertable, and neither is a reviewer reading that file without reading it. If
 * these guards pass while a document is still wrong, that is no reason to trust the next
 * document more: the reviewer's failing was the one that mattered here, and it is the one
 * a test cannot fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
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

/**
 * Fence markers at column zero, the only kind this file uses. Matching `^` then the
 * marker keeps an indented or nested fence from being silently counted; if one ever
 * appears, extend this rather than guessing (a real parser is not worth it here).
 */
function fenceMarkers(text) {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => /^`{3,}/.test(line))
    .map(({ line, number }) => {
      const rest = line.replace(/^`{3,}/, '');
      return { number, info: rest.trim() };
    });
}

/**
 * GitHub closes a fence with a bare marker; an info string on a marker seen while a fence
 * is open does not close it - the previous fence was simply never closed.
 *
 * An even count is necessary but not sufficient: two fences can be present and still be
 * wrong (an opener removed and a second opener with an info string added leaves the count
 * even while the first block is never closed). Tracking open/closed catches that; parity
 * alone does not. Both assertions are kept so the common failure names itself: a deleted
 * marker is odd, a misordered one is even.
 */
test('every code fence in the README is balanced and correctly ordered', () => {
  const fences = fenceMarkers(readme);

  assert.equal(
    fences.length % 2,
    0,
    `README has ${fences.length} fence markers (odd); one is unclosed, so GitHub renders the tail of the file as code.`
  );

  let openAt = null;
  for (const fence of fences) {
    if (openAt === null) {
      openAt = fence.number;
      continue;
    }
    assert.equal(
      fence.info,
      '',
      `fence at line ${fence.number} carries an info string (\`${fence.info}\`) while the fence opened at line ${openAt} is still open; a closing fence is bare, so line ${openAt} was never closed.`
    );
    openAt = null;
  }
});

/**
 * The README is a front door, and `## License` is the last thing through it. Requiring the
 * section to be exactly a heading, a blank line and one link is stronger than "the last
 * `## ` heading is License": the scratchpad that slipped in had no heading of its own, so a
 * last-heading check alone would have passed it. It also means plain prose appended after
 * the license fails, not just a new section.
 */
test('the README ends with the License section', () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)];
  const last = headings.at(-1);

  assert.ok(last, 'README has no level-2 heading');
  assert.equal(
    last[1].trim(),
    'License',
    `the last \`## \` heading is "${last[1].trim()}"; the README must end with \`## License\`. Move anything after it to DESIGN.md or docs/.`
  );

  const tail = readme.slice(last.index + last[0].length);
  const tailLines = tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  assert.equal(
    tailLines.length,
    1,
    `the License section has ${tailLines.length} lines of content after the heading; it must be the terminal section.`
  );
  assert.match(
    tailLines[0],
    /^\[[^\]]+\]\(\.\/LICENSE\)\.?$/,
    `the License section should end with a single link to ./LICENSE, not "${tailLines[0]}".`
  );
});

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

/**
 * Every docs/*.md topic page is reachable from the README, so a page cannot be added
 * and then forgotten. The limit, stated so this does not read as more than it is: the
 * HTTP-vs-web-UI confusion happened with every page already linked. A page being
 * reachable says nothing about whether the text on it is right; the reader still has to
 * read the page. This catches an orphaned page, not a wrong one.
 */
test('every top-level docs page is linked from the README', () => {
  const docsDir = join(repoRoot, 'docs');
  const pages = readdirSync(docsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);

  assert.ok(pages.length > 0, 'docs/ has no top-level .md pages; the test has lost its subject');
  for (const page of pages) {
    assert.ok(
      readme.includes(`./docs/${page}`),
      `docs/${page} is not linked from the README, so a reader never reaches it`
    );
  }
});

/**
 * Describing configuration means mentioning the web UI. The rule is in AGENTS.md §10:
 * any page that shows a `config.toml` block, a `config set` command or individual
 * setting keys must also say the same settings can be changed in the settings editor
 * (the tray's **Settings** item, or `config edit --gui`). The editor is the path most
 * users take, and a page that describes a key without it reads as "edit this file by
 * hand".
 *
 * WHAT THIS GUARD IS NOT. It sees that a page *mentions* the editor. It cannot see
 * whether the mention is useful, whether it appears where a reader needs it, or whether
 * the rest of the page is correct - the README told headless users to set session
 * environment variables for a whole release while mentioning the editor in a trailing
 * sentence, and this check passed it. A green run means the mention exists, nothing
 * more; the reader still has to read the page.
 *
 * WHY THERE IS NO REGISTRY CROSS-CHECK HERE (tried, not clean). The stronger check
 * would enumerate the `section.key` entries the docs show and assert each one exists in
 * `SETTINGS` in `src/ui/settings.js`, so a page cannot document a setting the editor
 * cannot set. It is not here because the docs' `config.toml` blocks immediately surface
 * one real, pre-existing gap: `reply.max_per_hour` is in `DEFAULTS` and in
 * `docs/configuration.md`, but is absent from `SETTINGS`, so `config set reply.max_per_hour`
 * is rejected as an unknown key - a documented setting the web UI cannot set, exactly
 * the inconsistency the check exists to catch. Fixing that is not a docs-or-tests change.
 * The inline `section.key` half is also prose-sensitive: `docs/configuration.md` writes
 * "There is no `web_ui.enabled` key", which a regex cannot tell from a real key. Until
 * the registry is complete, the guard stays at the mention the rule asks for; a
 * weakened cross-check with an allowlist would hide the very gap it should report.
 */
test('a page that describes configuration also says the settings editor can change it', () => {
  const docsDir = join(repoRoot, 'docs');
  const pages = [
    { name: 'README.md', text: readme },
    ...readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => ({
        name: `docs/${entry.name}`,
        text: readFileSync(join(docsDir, entry.name), 'utf8'),
      })),
  ];

  assert.ok(pages.length > 0, 'no pages to check; the test has lost its subject');

  // What "describes configuration" means here, matching the audit in §10: a page that
  // shows the config file, a config CLI command or a TOML block. A page that names a
  // `section.key` only in passing (the solve and statistics pages describe a bound, not
  // how to change it) is not a configuration guide and is not tested.
  const configurationPatterns = [
    { what: '`config.toml`', re: /config\.toml/ },
    { what: 'a config CLI command', re: /\bconfig (set|get|edit)\b/ },
    { what: 'a TOML code block', re: /^`{3,}toml\b/m },
  ];

  // The mention the rule asks for: the settings editor under any of the names the docs
  // use for it.
  const webUi = /settings editor|settings ui|settings item|settings page|config edit\s+--gui|--gui\b/i;

  let configurationPages = 0;
  for (const page of pages) {
    const matches = configurationPatterns.filter((pattern) => pattern.re.test(page.text));
    if (matches.length === 0) continue;
    configurationPages += 1;

    assert.match(
      page.text,
      webUi,
      `${page.name} shows ${matches.map((m) => m.what).join(' and ')} but never mentions the settings editor or \`config edit --gui\`, so it reads as "edit this file by hand".`
    );
  }

  assert.ok(
    configurationPages > 0,
    'no page describes configuration; the test has lost its subject'
  );
});
