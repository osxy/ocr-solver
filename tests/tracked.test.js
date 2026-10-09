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

/** True when git's ignore rules cover `path` (relative to the repo root). */
function gitIgnored(path) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    // exit 1 means "not ignored"; any other failure is also not a reason to flag
    return false;
  }
}

/** Tracked file paths under `path`, relative to the repo root. */
function trackedUnder(path) {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--', path], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.split('\0').filter(Boolean);
  } catch {
    return [];
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

test('no stray top-level directory is left in the repository root', (t) => {
  // The companion gap to the tracked-file check: git does not track directories and
  // `git status` hides an *empty* one, so a test writing to a fake absolute path can
  // leave a directory like `C:\Users\Andre\AppData\Local` in the repo root without
  // any tracked-file guard noticing (issue #50). An empty directory is exactly the
  // case a file-based check cannot see, so this walks the root one level deep.
  if (trackedFiles() == null) {
    t.skip('git is not available; the stray-directory check cannot run');
    return;
  }

  const stray = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    if (gitIgnored(entry.name)) continue;
    // A real source directory has at least one tracked file under it. An empty one -
    // or one only a test happened to create - has none.
    if (trackedUnder(entry.name).length === 0) stray.push(entry.name);
  }

  assert.deepEqual(
    stray,
    [],
    `these top-level directories are neither ignored nor tracked by git, so they are ` +
      `stray test/build output and should not be in the repository root:\n  ${stray.join('\n  ')}`
  );
});

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
