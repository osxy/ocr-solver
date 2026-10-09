/**
 * Guard against a class of bug that bit this repository once.
 *
 * `secrets.*` in `.gitignore` silently ignored `src/secrets.js`. Every local test
 * passed because the file existed in the working tree; it would only have broken in
 * a fresh clone or CI, where the import would fail. A `.gitignore` pattern is a claim
 * about what is ignored, and the only way that claim stays true is to compare the
 * working tree against the index.
 *
 * This test walks `src/` and `tests/` and fails if any file on disk is not tracked by
 * git. It skips gracefully when git is unavailable (a source tarball, a sandbox with
 * no git binary), because then the check cannot mean anything.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths git knows about, relative to the repo root, or null when git is absent. */
function trackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', 'src', 'tests'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map((path) => path.split(sep).join('/'))
    );
  } catch {
    return null;
  }
}

/** Every regular file under a directory, recursively. */
function filesUnder(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

test('every src/ and tests/ file on disk is tracked by git', (t) => {
  const tracked = trackedFiles();
  if (tracked == null) {
    t.skip('git is not available; the tracked-file check cannot run');
    return;
  }

  const onDisk = [...filesUnder(join(root, 'src')), ...filesUnder(join(root, 'tests'))].map((path) =>
    relative(root, path).split(sep).join('/')
  );
  const untracked = onDisk.filter((path) => !tracked.has(path));

  assert.deepEqual(
    untracked,
    [],
    `these source/test files exist on disk but are not tracked by git, so a fresh ` +
      `clone or CI would not have them:\n  ${untracked.join('\n  ')}\n` +
      `Check .gitignore for a pattern that hides them (the secrets.* trap).`
  );
});
