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

  // Derive the matching tag from package.json rather than pinning it. A hardcoded
  // release version makes this test fail on every version bump (it did at v0.2.0)
  // without testing anything the pure-function test above does not already cover.
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const matching = run({ GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: `v${version}` });
  assert.equal(matching.status, 0);
  assert.match(matching.stdout, new RegExp(`matches package\\.json version ${version.replaceAll('.', '\\.')}`));

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

  assert.match(workflow, /pull_request:\s*\n\s*branches:\s*\[main, 'milestone\/\*\*'\]/, 'a PR into main or a milestone branch must build without publishing');
  assert.match(workflow, /push:\s*\n\s*branches:\s*\[main\]\s*\n\s*tags:\s*\['v\*'\]/, 'one push block, main and tags; a milestone branch is covered by its PR');
  assert.match(workflow, /workflow_dispatch:/);

  // The milestone branch must not creep back into the push trigger: its PR already
  // built the branch, and repeating it on every push is the redundant Windows spend
  // this change removes. The PR coverage above is what must stay.
  const pushBlock = workflow.match(/\n {2}push:\n([\s\S]*?)\n {2}workflow_dispatch:/);
  assert.ok(pushBlock, 'the push trigger must remain, followed by workflow_dispatch');
  assert.ok(!pushBlock[1].includes('milestone'), 'a milestone push must not rebuild Windows; its PR does');

  // The release step is the only publishing path, and it still requires a `v*` tag:
  // adding the milestone branch to `push:` must not let a branch push release.
  assert.match(
    workflow,
    /release:\s*\n\s*needs:\s*\[package, deploy\]\s*\n\s*if:\s*startsWith\(github\.ref, 'refs\/tags\/v'\)/,
    'the release job must stay gated on a v* tag'
  );

  // Only the release job may write; the rest of the workflow is read-only.
  assert.equal((workflow.match(/contents:\s*write/g) ?? []).length, 1);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
});

test('the package workflow cancels a superseded branch run but never a tag build', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');

  // Queued Windows runs are billed, so a repeated push cancels its predecessor — but
  // only for a branch ref: a tag build publishes a release and must run to completion.
  assert.match(
    workflow,
    /concurrency:\s*\n\s*group:\s*package-\$\{\{\s*github\.ref\s*\}\}\s*\n\s*cancel-in-progress:\s*\$\{\{\s*!startsWith\(github\.ref, 'refs\/tags\/'\)\s*\}\}/,
    'cancel superseded branch runs, never a tag'
  );
});

test('the CI workflow is reusable and answers pushes and PRs only for main and milestone', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /workflow_call:/);
  // A bare `push:` runs the suite on every leg branch; restricting it means the PR is
  // what verifies a leg branch, which is the run that was already going to happen.
  assert.match(workflow, /on:\s*\n\s*push:\s*\n\s*branches:\s*\[main, 'milestone\/\*\*'\]\s*\n\s*pull_request:\s*\n\s*branches:\s*\[main, 'milestone\/\*\*'\]/);
});

test('the CI workflow cancels a superseded run on the same ref', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  // `github.workflow` keeps this group off the reusable-workflow call Package
  // (Windows) makes into this same file, so a fresh CI push cannot cancel that run.
  assert.match(
    workflow,
    /concurrency:\s*\n\s*group:\s*ci-\$\{\{\s*github\.workflow\s*\}\}-\$\{\{\s*github\.ref\s*\}\}\s*\n\s*cancel-in-progress:\s*true/,
    'a superseded CI run on the same ref must cancel'
  );
});

test('the package workflow executes the deployment glue against the artifact it built', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');

  // A deploy job that reuses the package artifact rather than paying for a second build.
  assert.match(workflow, /deploy:\s*\n\s*needs:\s*package/, 'deploy must run after package');
  assert.match(workflow, /download-artifact@v4/);
  assert.match(workflow, /name:\s*windows-package/);
  assert.match(workflow, /\.\/packaging\/run-deploy\.ps1 -Zip \$zip/);
  // Bounded, so a wedged start cannot hold a Windows runner (issue #37).
  assert.match(workflow, /timeout-minutes:\s*15/);
  // A broken installer must block the release, not merely warn after it.
  assert.match(workflow, /release:\s*\n\s*needs:\s*\[package, deploy\]/);
});

test('run-deploy.ps1 asserts every deployment surface and throws on the first mismatch', () => {
  const script = readFileSync(join(repoRoot, 'packaging', 'run-deploy.ps1'), 'utf8');

  assert.match(script, /function Assert/);
  // install lands the files, the per-user Startup shim exists with the documented delay,
  // the app refuses with the documented message, the launcher starts a process,
  // uninstall is clean, and a failing installer is propagated (#162).
  for (const marker of [
    'install.ps1',
    'PuzzleSolver-startup.vbs',
    'Sleep 20000',
    'process.exit(3)',
    "-notmatch 'Installed'",
    "'listen', '--headless'",
    'no Pushbullet token found',
    'PuzzleSolver.vbs',
    'Stop-Process',
    'uninstall.ps1',
  ]) {
    assert.ok(script.includes(marker), `run-deploy.ps1 no longer checks ${marker}`);
  }

  // The point of the job: results are asserted, not printed for a human to eyeball.
  const assertions = (script.match(/Assert \(/g) ?? []).length;
  assert.ok(assertions >= 12, `expected the deployment script to assert at least 12 things, found ${assertions}`);
});

// ---------------------------------------------------------------------------
// README install instructions vs. the version CI builds (#97, #106)
// ---------------------------------------------------------------------------

/**
 * The README's install commands are the first thing a user runs and nothing checked
 * them, so a version bump could leave a checksum command naming a file that does not
 * exist - which is worse than no command (it was found by hand at v0.3.0, where six
 * references still said `v0.2.0`).
 *
 * The asset name is derived from the workflow rather than hardcoded: `package.yml`
 * reads the version from `package.json` and passes it to `build-zip.ps1`, which
 * builds `PuzzleSolver-$Version-win-x64.zip`. Reading the name from the script is
 * what keeps this test from freezing today's version into a green-but-vacuous check.
 *
 * Honest limit: this cannot assert that the release EXISTS. At the moment of a version
 * bump the asset is named before the tag is pushed, and that is correct. What it
 * catches is a README left naming the PREVIOUS release after `package.json` has moved
 * on.
 *
 * The download *link* is a separate test below: it must not depend on a tag existing,
 * and keeping the two assertions apart is what lets each fail on its own (#106).
 */
function readmeInstallFacts() {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const buildZip = readFileSync(join(repoRoot, 'packaging', 'build-zip.ps1'), 'utf8');
  const template = /\$zip\s*=\s*Join-Path\s+\$OutDir\s+"([^"]*\$Version[^"]*)"/.exec(buildZip);
  assert.ok(template, 'build-zip.ps1 no longer builds a $Version-named zip; update this guard');
  const asset = template[1].replaceAll('$Version', version);
  assert.match(asset, /-win-x64\.zip$/, 'the asset is expected to be the win-x64 zip');
  return { version, asset };
}

test('the README install instructions name the asset CI builds (#97)', () => {
  const { version, asset } = readmeInstallFacts();
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  // The workflow must take that version from package.json and pass it through.
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'package.yml'), 'utf8');
  assert.match(
    workflow,
    /\(Get-Content package\.json -Raw \| ConvertFrom-Json\)\.version/,
    'package.yml must read the version from package.json'
  );
  assert.match(workflow, /build-zip\.ps1[^\n]*-Version \$version/, 'package.yml must pass that version to build-zip.ps1');

  // Every asset filename in the README names the current version - not just one of
  // them. A stale `Get-FileHash PuzzleSolver-0.2.0-...` beside a correct link is the
  // exact drift this guards against.
  const namedVersions = [...readme.matchAll(/PuzzleSolver-([0-9]+\.[0-9]+\.[0-9]+)-win-x64\.zip/g)].map((m) => m[1]);
  assert.ok(namedVersions.length >= 3, `expected the install commands to name the asset, found ${namedVersions.length}`);
  for (const named of new Set(namedVersions)) {
    assert.equal(named, version, `README names PuzzleSolver-${named}-win-x64.zip but package.json says ${version}`);
  }
  assert.ok(readme.includes(asset), `README must name the asset CI builds, ${asset}`);
});

/**
 * The download link must resolve on `main` at every point in the development cycle,
 * including the window between the version bump and the release (issue #106).
 *
 * #97 originally asserted the README linked `releases/tag/v<package.json version>`.
 * Because the bump necessarily precedes the tag, that pinned the documented download
 * to a URL that 404s for the whole cycle. `/releases` lists everything and cannot 404.
 *
 * Do not "tidy" this back to a pinned tag, and prefer `/releases` over
 * `/releases/latest`: the *web* `/releases/latest` currently only works by falling
 * back to `/releases` (every v0.x release is a pre-release), and the *API*
 * `repos/osxy/ocr-solver/releases/latest` genuinely 404s. The releases page depends on
 * neither fallback nor on a release existing.
 *
 * Honest limit: this cannot assert that a release EXISTS, only that the link does not
 * depend on one particular tag.
 */
test('the README download link points at the releases page, not a pinned version tag (#106)', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');

  assert.match(
    readme,
    /github\.com\/osxy\/ocr-solver\/releases(?!\/)/,
    'README must link the releases page so a version bump cannot 404 the download link'
  );
  assert.doesNotMatch(
    readme,
    /releases\/tag\/v[0-9]+\.[0-9]+\.[0-9]+/,
    'README must not pin the download link to a version tag that may not exist yet (#106)'
  );
});
