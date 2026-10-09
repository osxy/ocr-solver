/**
 * Pure decisions behind the Windows CI package — no filesystem, no network.
 *
 * Everything here is asserted by `tests/packaging.test.js` on the Linux host, so the
 * parts of the release pipeline that encode a judgement (which Node, which tag, what
 * the checksum file must say) are provable without a Windows runner.
 */

/**
 * The bundled runtime, pinned. It is the same floor the test matrix exercises
 * (`node:sqlite` is unflagged from 22.13.0), so the artifact is built against the
 * oldest Node the app promises to support rather than whatever the runner happens to
 * ship. `engines` in package.json is the range a *user's* Node must satisfy; this is
 * the exact binary we hand a user who has no Node at all.
 */
export const BUNDLED_NODE_VERSION = '22.13.0';

/** nodejs.org publishes a bare `node.exe` per platform; that is the smallest payload. */
export function bundledNodeUrl({ version = BUNDLED_NODE_VERSION, arch = 'x64' } = {}) {
  return `https://nodejs.org/dist/v${version}/win-${arch}/node.exe`;
}

/**
 * The version a tag claims, or `null` when the ref is not a `v*` release tag.
 * Returns the string after the leading `v`, so `refs/tags/v0.1.0` -> `0.1.0`.
 */
export function tagVersion(refType, refName) {
  if (refType !== 'tag') return null;
  const match = /^v(.+)$/.exec(refName ?? '');
  return match ? match[1] : null;
}

/**
 * Refuse to build an artifact whose tag and `package.json` version disagree.
 *
 * A non-tag ref (PR, branch, `workflow_dispatch`) has no version to compare, so it is
 * deliberately not an error — only a release tag can be wrong. The returned object
 * says which case happened so the caller can print it honestly.
 */
export function assertTagMatchesVersion({ refType, refName, version }) {
  const claimed = tagVersion(refType, refName);
  if (claimed === null) return { checked: false, tag: null, version };
  if (claimed !== version) {
    throw new Error(`tag ${refName} claims version ${claimed} but package.json says ${version}`);
  }
  return { checked: true, tag: refName, version };
}

/** sha256sum-compatible line: digest, two spaces, filename. */
export function checksumLine(digest, filename) {
  return `${digest}  ${filename}\n`;
}

/** Read the digest back out of a `.sha256` sidecar, ignoring the filename column. */
export function parseChecksum(text) {
  const match = /^([0-9a-f]{64})\b/.exec(text.trim());
  if (!match) throw new Error('the checksum file does not begin with a sha256 digest');
  return match[1];
}

/**
 * The files that make the extracted tree runnable. Listed here, not duplicated inside
 * the build script, so the smoke test and the tests agree on what "assembled" means.
 * Paths are relative to the payload root; the traineddata path is the one `nld`'s
 * `langPath` points at, so a missing language file is caught before the zip is built.
 */
export const REQUIRED_PAYLOAD = [
  'node.exe',
  'node_modules/sharp/package.json',
  'node_modules/@tesseract.js-data/nld/4.0.0/nld.traineddata.gz',
  'app/package.json',
  'app/src/cli.js',
  'install.ps1',
  'uninstall.ps1',
  'PuzzleSolver.vbs',
];

/**
 * The Windows `sharp` binary cannot be inferred from a file that exists on Linux, so
 * the platform package is checked by name. `npm ci` on windows-latest resolves the
 * optional dependency to this folder; a Linux tree would carry `sharp-linux-x64`
 * instead and fail the smoke test at import time.
 */
export const WINDOWS_SHARP_BINARY = 'node_modules/@img/sharp-win32-x64';

/** Payload entries that must never be present; the app gets secrets from the user's machine. */
export const FORBIDDEN_PAYLOAD = [
  'config/llm.env',
  'llm.env',
  '.env',
  'credentials.json',
  'node_modules/.cache',
];
