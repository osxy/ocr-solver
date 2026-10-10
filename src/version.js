/**
 * The application version, and the comparison the settings-review flow needs.
 *
 * This is a constant rather than a read of `package.json` because the packaged
 * Windows build runs from a `pkg` snapshot where relative path reads are a trap;
 * `tests/settings-review.test.js` asserts it agrees with `package.json`, so the two
 * cannot drift silently. Bump both together.
 *
 * Versions are the plain `major.minor.patch` strings the release tags use. The
 * settings registry stores one `since` per descriptor (`src/ui/settings.js`), and the
 * review flow compares them per setting rather than per release, so a user who skips
 * `0.1.0 -> 0.3.0` still sees the `0.2.0` additions (issue #67).
 */
export const APP_VERSION = '0.45.1';

/** A `major.minor.patch` tuple, or `null` for anything else. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two versions: `-1`, `0`, `1`, or `null` when either side is not a
 * `major.minor.patch` string. A `null` is deliberately *not* treated as "equal" -
 * the caller decides what an unreadable version means, so an absent or corrupt
 * stored version cannot look like "already reviewed".
 */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
