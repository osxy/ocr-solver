#!/usr/bin/env node
/**
 * Fail the build when the release tag and package.json disagree.
 *
 * Runs before any Windows-only work, so a mismatched tag is rejected in seconds and
 * the artifact never exists to be published. On a PR or a branch push there is no tag
 * to compare and this is a no-op that still prints what it saw.
 *
 *   GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.1.0 node packaging/check-version.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTagMatchesVersion } from './packaging.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

try {
  const result = assertTagMatchesVersion({
    refType: process.env.GITHUB_REF_TYPE ?? '',
    refName: process.env.GITHUB_REF_NAME ?? '',
    version,
  });
  if (result.checked) {
    console.log(`tag ${result.tag} matches package.json version ${version}`);
  } else {
    console.log(`no release tag (${process.env.GITHUB_REF_TYPE || 'no ref type'}); version guard skipped (package.json ${version})`);
  }
} catch (err) {
  console.error(`VERSION GUARD FAILED: ${err.message}`);
  process.exit(1);
}
