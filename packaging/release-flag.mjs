#!/usr/bin/env node
/**
 * Print the `gh release create` flag for the tag being published.
 *
 *   GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.46.0-pre.1 node packaging/release-flag.mjs
 *   -> --prerelease
 *
 * A plain `vX.Y.Z` tag prints an empty line, so it is created as a normal release. The
 * decision is the pure `isPrereleaseTag` in `packaging.js`, asserted by
 * `tests/packaging.test.js`, so the release job carries no untested glob. The tag has
 * already passed `check-version.mjs` in the package job, so it agrees with
 * package.json; a suffix here is a deliberate semver pre-release.
 */
import { isPrereleaseTag } from './packaging.js';

const flag = isPrereleaseTag(process.env.GITHUB_REF_TYPE ?? '', process.env.GITHUB_REF_NAME ?? '')
  ? '--prerelease'
  : '';
console.log(flag);
