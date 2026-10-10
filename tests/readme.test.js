/**
 * Guards for the README's shape, so the second rewrite does not have to happen.
 *
 * The README is the front door: what it is, install, run, the failures people hit, the
 * known limitations, and pointers. Everything else belongs in DESIGN.md or docs/ (the
 * rule is written down in AGENTS.md §10). These seven tests are the ratchet:
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
 *      file is not the only route a page shows;
 *   7. every `section.key` the docs' TOML blocks show exists in the settings registry,
 *      so a page cannot document a setting the editor cannot set;
 *   8. every setting in the registry is documented in the configuration reference, the
 *      reverse of 7, so a registry key the docs never show cannot hide (#138).
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
import { parse as parseToml } from 'smol-toml';
import { SETTINGS } from '../src/ui/settings.js';
import { DEFAULTS } from '../src/config.js';

const repoRoot = join(import.meta.dirname, '..');
const readmePath = join(repoRoot, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

/**
 * README.md plus every top-level docs page, as `{ name, text }`. Shared by the prose
 * guard and the registry cross-check so the two cannot disagree about what "a page"
 * means.
 */
function loadDocPages() {
  const docsDir = join(repoRoot, 'docs');
  return [
    { name: 'README.md', text: readme },
    ...readdirSync(docsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => ({
        name: `docs/${entry.name}`,
        text: readFileSync(join(docsDir, entry.name), 'utf8'),
      })),
  ];
}

/** The body of every ```toml fenced block in a page, in file order. */
function tomlBlocks(text) {
  return [...text.matchAll(/^```toml\b[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1]);
}

/** Every nested `section.key` path in a parsed TOML object; arrays and scalars are leaves. */
function keyPaths(node, prefix = '') {
  const paths = [];
  if (node == null || typeof node !== 'object' || Array.isArray(node)) return paths;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...keyPaths(value, path));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

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
 * THE REGISTRY CROSS-CHECK IS THE NEXT TEST. The stronger half of this rule - every
 * `section.key` the docs' TOML blocks show exists in `SETTINGS` - was withheld when
 * this one landed because its first run found a real gap (`reply.max_per_hour` was in
 * `DEFAULTS` and in `docs/configuration.md` but absent from `SETTINGS`, so
 * `config set reply.max_per_hour` was rejected as an unknown key). An allowlisted
 * cross-check would have hidden exactly the inconsistency it exists to catch; #133
 * closed the gap and ships the check. It reads only TOML blocks, so a key named in
 * prose (`docs/configuration.md` says "There is no `web_ui.enabled` key") is not
 * mistaken for one being documented.
 */
test('a page that describes configuration also says the settings editor can change it', () => {
  const pages = loadDocPages();

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

/**
 * The stronger half of the rule: not just that a configuration page mentions the
 * editor, but that every `section.key` a TOML block shows is a setting the registry
 * actually has. A documented setting the editor cannot set is precisely the
 * inconsistency the rule exists to prevent (this check found `reply.max_per_hour`,
 * #133), and it also catches a typo'd key in a doc, which the prose guard cannot.
 *
 * It reads the blocks with the same parser the app uses, so a key in prose is not
 * mistaken for a documented key, and a section-less fragment (openrouter.md shows a
 * bare `llm_vision_model = ...` as an alternative) names no `section.key` and is
 * skipped rather than misattributed to whatever section preceded it.
 *
 * WHAT THIS GUARD IS NOT. It checks that the key is in the registry, not that its
 * documented default, type or comment is right: a page can show `max_per_hour = 9999`
 * with a wrong comment and pass. A green run means the key is settable, nothing more.
 */
test('every config key the docs show exists in the settings registry', () => {
  const pages = loadDocPages();
  assert.ok(pages.length > 0, 'no pages to check; the test has lost its subject');

  const ids = new Set(SETTINGS.map((setting) => setting.id));
  let documentedKeys = 0;

  for (const page of pages) {
    for (const block of tomlBlocks(page.text)) {
      let parsed;
      try {
        parsed = parseToml(block);
      } catch {
        // An illustrative block may not stand alone as valid TOML (a fragment, a
        // placeholder). It cannot be a registry key, so it is not this guard's subject.
        continue;
      }
      for (const path of keyPaths(parsed)) {
        if (!path.includes('.')) continue; // a section-less fragment names no section.key
        documentedKeys += 1;
        assert.ok(
          ids.has(path),
          `${page.name} documents "${path}", but no such setting exists in SETTINGS (src/ui/settings.js), so the editor and \`config set\` cannot change it.`
        );
      }
    }
  }

  assert.ok(documentedKeys > 0, 'no docs show a section.key; the test has lost its subject');
});

/**
 * The mirror of the guard above: not just that a documented key is settable, but that
 * every settable key is documented somewhere a reader will look. #133's check runs only
 * one way, so a registry key the docs never show is invisible to it - which is how
 * `[ocr]` and `[ui]` came to be omitted from a list headed "Every option" (#138).
 *
 * The canonical reference (`docs/configuration.md`, the block under "Every ... key") is
 * held to the strong form, and against both sources of truth: **every leaf key in
 * `DEFAULTS`** (a key can be validated and defaulted without a registry descriptor) and
 * **every non-secret `SETTINGS` entry** must appear there as a `section.key`, with a
 * default - not merely be named in prose elsewhere. A secret has no `path` by design (it
 * lives in the credential store), so the strong form cannot apply; each is instead
 * required to be named by its literal id in the docs, which is how the page explains
 * where it goes.
 *
 * WHAT THIS GUARD IS NOT. It checks that the key is listed, not that its default or
 * comment is right - a wrong default passes. And "documented" is satisfied by the id
 * appearing as a `section.key` in the canonical block, not by the surrounding prose
 * making sense. A green run means a reader can find the key and a value; the reader
 * still has to read the line.
 */
test('every setting in the registry is documented in the configuration reference', () => {
  const pages = loadDocPages();
  const configurationPath = join(repoRoot, 'docs', 'configuration.md');
  assert.ok(existsSync(configurationPath), 'docs/configuration.md is missing; the test cannot find its subject');
  const configuration = readFileSync(configurationPath, 'utf8');

  // The canonical block: the first TOML block after the "Every ... key" heading.
  const heading = configuration.match(/^##\s+Every\b[^\n]*\n/m);
  assert.ok(heading, 'docs/configuration.md has no "Every ... key" heading; the test has lost its subject');
  const block = tomlBlocks(configuration.slice(heading.index))[0];
  assert.ok(block, 'the "Every ... key" heading is not followed by a TOML block; the test has lost its subject');

  const canonical = new Set(keyPaths(parseToml(block)));
  const prose = pages.map((page) => page.text).join('\n');

  const schemaKeys = keyPaths(DEFAULTS);
  assert.ok(schemaKeys.length > 0, 'DEFAULTS is empty; the test has lost its subject');

  for (const key of schemaKeys) {
    assert.ok(
      canonical.has(key),
      `"${key}" is in DEFAULTS (src/config.js), but docs/configuration.md's "Every ... key" block does not list it, so a reader cannot find its default. A key can be defaulted and validated without a registry descriptor, which is why this direction is checked against DEFAULTS rather than SETTINGS alone.`
    );
  }

  assert.ok(SETTINGS.length > 0, 'SETTINGS is empty; the test has lost its subject');

  for (const setting of SETTINGS) {
    if (setting.path) {
      assert.ok(
        canonical.has(setting.id),
        `"${setting.id}" is a config.toml setting (it has a path in SETTINGS), but docs/configuration.md's "Every ... key" block does not list it, so a reader cannot find its default.`
      );
    } else {
      assert.ok(
        prose.includes(setting.id),
        `"${setting.id}" is a secret with no config.toml path, and no docs page names it, so a reader cannot find where it goes.`
      );
    }
  }
});

/** Backticked tokens inside a bullet body, in order. */
function backticks(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

/**
 * The prose enumeration of `[live]` / `[restart]` settings, checked against the same
 * registry the two key-existence guards use. Those guards read fenced TOML blocks and
 * key *existence* only, so a setting missing from this enumeration is outside their
 * reach by construction - which is how `storage.max_images` (restart: true, captured at
 * `src/app.js` build time) and the auto-router policy came to be absent from the page
 * whose section title is the enumeration (issue #152).
 *
 * The **live** list must match the `restart: false` set exactly, because it is short and
 * every entry is a full `section.key`. The **restart** list may group a whole block as
 * `section.*`, so coverage is what is asserted there: every `restart: true` setting is
 * named by id or covered by its block wildcard, and no live setting is listed as
 * restart-bound. The reverse (a setting named in neither list) is already caught by the
 * exact live check.
 */
test("the configuration reference's restart enumeration matches the registry", () => {
  const configuration = readFileSync(join(repoRoot, 'docs', 'configuration.md'), 'utf8');
  const section = configuration.slice(configuration.indexOf('## Some settings need a restart'));
  assert.ok(section.length > 0, 'docs/configuration.md has no restart section; the test has lost its subject');

  const liveMatch = section.match(/^- \*\*live\*\* — ([\s\S]*?)(?=^- \*\*restart\*\*)/m);
  const restartMatch = section.match(/^- \*\*restart\*\* — ([\s\S]*?)\n\n/m);
  assert.ok(liveMatch, 'the restart section has no `**live**` bullet; the test has lost its subject');
  assert.ok(restartMatch, 'the restart section has no `**restart**` bullet; the test has lost its subject');

  const byId = new Map(SETTINGS.map((setting) => [setting.id, setting]));
  const expectedLive = SETTINGS.filter((setting) => setting.path && !setting.restart).map((setting) => setting.id);
  const liveTokens = new Set(backticks(liveMatch[1]));

  assert.deepEqual(
    [...liveTokens].sort(),
    [...expectedLive].sort(),
    'the `[live]` enumeration must list exactly the settings the registry tags `restart: false`'
  );

  const restartTokens = new Set(backticks(restartMatch[1]));
  const covered = (setting) =>
    restartTokens.has(setting.id) || (setting.path && restartTokens.has(`${setting.path[0]}.*`));
  const missing = SETTINGS.filter((setting) => setting.restart && !covered(setting)).map((setting) => setting.id);

  assert.deepEqual(
    missing,
    [],
    `the \`[restart]\` enumeration omits settings the registry tags restart-bound: ${missing.join(', ')}`
  );

  const misplaced = [...restartTokens].filter((token) => byId.get(token)?.path && !byId.get(token).restart);
  assert.deepEqual(
    misplaced,
    [],
    `the \`[restart]\` enumeration lists settings the registry says apply live: ${misplaced.join(', ')}`
  );
});
