/**
 * Tests for the CI packaging decisions.
 *
 * The Windows-only execution (wscript, PowerShell, the actual zip/expand) cannot run
 * here; what is asserted is the logic that decides whether a release is allowed, what
 * the pinned runtime URL is, and that a checksum actually describes the bytes it
 * claims to. The version guard and the checksum are exercised through the same entry
 * points the workflow calls, so a broken guard fails this suite rather than only CI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertTagMatchesVersion,
  bundledNodeUrl,
  checksumLine,
  parseChecksum,
  tagVersion,
  BUNDLED_NODE_VERSION,
  REQUIRED_PAYLOAD,
  FORBIDDEN_PAYLOAD,
} from '../packaging/packaging.js';
import { emit, verify, sidecarPath } from '../packaging/checksum.mjs';

const repoRoot = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Version guard
// ---------------------------------------------------------------------------

test('the bundled runtime is a pinned Windows node.exe', () => {
  assert.match(BUNDLED_NODE_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(bundledNodeUrl(), `https://nodejs.org/dist/v${BUNDLED_NODE_VERSION}/win-x64/node.exe`);
});

test('only a v* tag yields a version to compare', () => {
  assert.equal(tagVersion('tag', 'v0.1.0'), '0.1.0');
  assert.equal(tagVersion('branch', 'main'), null);
  assert.equal(tagVersion('tag', 'release-0.1.0'), null);
  assert.equal(tagVersion('', ''), null);
});

test('a tag that disagrees with package.json is refused', () => {
  assert.throws(
    () => assertTagMatchesVersion({ refType: 'tag', refName: 'v0.2.0', version: '0.1.0' }),
    /v0\.2\.0 claims version 0\.2\.0 but package\.json says 0\.1\.0/
  );
});

test('a matching tag passes and a non-tag is deliberately skipped', () => {
  assert.deepEqual(
    assertTagMatchesVersion({ refType: 'tag', refName: 'v0.1.0', version: '0.1.0' }),
    { checked: true, tag: 'v0.1.0', version: '0.1.0' }
  );
  assert.deepEqual(
    assertTagMatchesVersion({ refType: 'branch', refName: 'main', version: '0.1.0' }),
    { checked: false, tag: null, version: '0.1.0' }
  );
});

test('the check-version CLI fails on a mismatched tag and passes on a branch', () => {
  const run = (env) =>
    spawnSync(process.execPath, [join(repoRoot, 'packaging', 'check-version.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });

  const mismatched = run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v9.9.9' });
  assert.equal(mismatched.status, 1, 'a mismatched tag must fail the build');
  assert.match(mismatched.stderr, /VERSION GUARD FAILED/);

  const matching = run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.0' });
  assert.equal(matching.status, 0);
  assert.match(matching.stdout, /matches package\.json version 0\.1\.0/);

  const branch = run({ GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'feat/x' });
  assert.equal(branch.status, 0);
  assert.match(branch.stdout, /version guard skipped/);
});

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

test('a checksum line is sha256sum-compatible and round-trips', () => {
  const digest = 'a'.repeat(64);
  assert.equal(checksumLine(digest, 'x.zip'), `${digest}  x.zip\n`);
  assert.equal(parseChecksum(`${digest}  x.zip\n`), digest);
  assert.throws(() => parseChecksum('not a digest'), /does not begin with a sha256 digest/);
});

test('emit writes a checksum that verify accepts, and verify fails when the file changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-checksum-'));
  const artifact = join(dir, 'artifact.zip');
  writeFileSync(artifact, 'the artifact bytes');

  const { digest, sidecar } = emit(artifact);
  assert.equal(sidecar, sidecarPath(artifact));
  assert.equal(verify(artifact).digest, digest);

  // Break the artifact after the checksum was written: the sidecar is now a lie, and
  // verify must say so rather than passing because the file merely exists.
  writeFileSync(artifact, 'different bytes');
  assert.throws(() => verify(artifact), /checksum mismatch/);
});

// ---------------------------------------------------------------------------
// Payload manifest
// ---------------------------------------------------------------------------

test('the required payload includes the app, the Windows sharp binary and the traineddata', () => {
  assert.ok(REQUIRED_PAYLOAD.includes('node.exe'));
  assert.ok(REQUIRED_PAYLOAD.includes('app/src/cli.js'));
  assert.ok(
    REQUIRED_PAYLOAD.includes('node_modules/@tesseract.js-data/nld/4.0.0/nld.traineddata.gz'),
    'the offline language file must travel in the zip'
  );
  assert.ok(!REQUIRED_PAYLOAD.some((entry) => entry.includes('config/')), 'config/ must not ship');
  assert.ok(FORBIDDEN_PAYLOAD.includes('config/llm.env'));
  assert.ok(FORBIDDEN_PAYLOAD.includes('credentials.json'));
});

// ---------------------------------------------------------------------------
// Workflow shape
// ---------------------------------------------------------------------------

test('the package workflow triggers on PRs, main pushes, v* tags and dispatch', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');

  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\[main\]/, 'a PR must build without publishing');
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]\s*\n\s*tags:\s*\['v\*'\]/, 'one push block, branches and tags');
  assert.match(workflow, /workflow_dispatch:/);

  // Only the release job may write; the rest of the workflow is read-only.
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
});

test('the CI workflow is reusable and keeps its original triggers', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main\]/);
});
