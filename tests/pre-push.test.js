/**
 * Tests for scripts/git-hooks/pre-push (AGENTS.md §1/§2).
 *
 * The hook is the only thing enforcing "never push to a protected branch" outside the
 * document itself, and it had no test while its matching logic changed from the exact
 * names `main master` to those plus the `milestone/*` pattern. It is run as a
 * subprocess with the stdin git hands it, so what is asserted is the real exit status
 * and the real message, not a reimplementation of the pattern.
 *
 * Nothing here touches git or the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const HOOK = join(repoRoot, 'scripts', 'git-hooks', 'pre-push');

const ZERO = '0000000000000000000000000000000000000000';
const SHA = '1111111111111111111111111111111111111111';

// The hook is POSIX sh; a host without `sh` cannot run it at all, so skip cleanly
// rather than report a green that never exercised the guard.
const noSh = spawnSync('sh', ['-c', 'exit 0']).error;

/**
 * Run the hook exactly as git would: one `<local ref> <local sha> <remote ref>
 * <remote sha>` line on stdin. Returns the spawn result so callers assert on
 * `status` and `stderr`.
 */
function push(remoteRef, { allow = false } = {}) {
  const line = `refs/heads/work ${SHA} ${remoteRef} ${ZERO}\n`;
  const env = { ...process.env };
  // Never let the ambient environment silently turn a refusal test into an allow.
  if (allow) env.ALLOW_MAIN_PUSH = '1';
  else delete env.ALLOW_MAIN_PUSH;
  return spawnSync('sh', [HOOK], { input: line, env, encoding: 'utf8' });
}

test('the hook refuses a push to main', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');
  const result = push('refs/heads/main');
  assert.notEqual(result.status, 0, 'main must be refused');
});

test('the hook refuses a push to master', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');
  const result = push('refs/heads/master');
  assert.notEqual(result.status, 0, 'master must be refused');
});

test('the hook refuses a push to a milestone branch', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');
  const result = push('refs/heads/milestone/v0.5');
  assert.notEqual(result.status, 0, 'a milestone branch is protected like main');
});

test('the hook allows an ordinary feature branch', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');
  const result = push('refs/heads/feat/thing');
  assert.equal(result.status, 0, `feat/thing must be allowed to push: ${result.stderr}`);
});

test('ALLOW_MAIN_PUSH=1 allows a protected push', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');
  const result = push('refs/heads/milestone/v0.5', { allow: true });
  assert.equal(result.status, 0, `the documented override must work: ${result.stderr}`);
  assert.match(result.stderr, /ALLOW_MAIN_PUSH=1 set/);
});

test('the refusal message names the branch it refused', (t) => {
  if (noSh) return t.skip('no POSIX sh available to run the hook');

  const main = push('refs/heads/main');
  assert.match(main.stderr, /refusing to push to 'main'/);

  const milestone = push('refs/heads/milestone/v0.5');
  assert.match(milestone.stderr, /refusing to push to 'milestone\/v0\.5'/);
  // The guidance must point at the pull-request path for that branch, not at nothing.
  assert.match(milestone.stderr, /pull request against 'milestone\/v0\.5'/);
});
