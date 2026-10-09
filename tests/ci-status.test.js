/**
 * ci-status helper tests (issue #38).
 *
 * The script itself talks to the network. These tests never do: `runCli` takes an
 * injected `fetch` and an injected clock, so the two traps that made CI verification
 * unreliable are exercised literally:
 *   - a short SHA must reach `/commits/{sha}/check-runs` and produce a per-job table;
 *   - an incomplete set must not report green, and `--wait` must keep polling to its
 *     cap and then exit non-zero saying the state is unknown.
 *
 * A timeout that reported success would be worse than no verdict, so the exit codes
 * are asserted, not only the text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCli, classify, parseArgs, parseRepo, EXIT } from '../scripts/ci-status.mjs';

const FULL = 'd13ca6e0000000000000000000000000000000aa';

function response({ status = 200, body = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/** A fetch that records every URL and replays one body each call. */
function scriptedFetch(bodies) {
  const queue = Array.isArray(bodies) ? [...bodies] : null;
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const body = queue ? queue.shift() : bodies;
    return response({ body });
  };
  return { fetchImpl, urls };
}

function fakeClock({ stepMs = 0 } = {}) {
  let t = 0;
  const sleeps = [];
  return {
    now: () => t,
    async sleep(ms) {
      sleeps.push(ms);
      t += ms + stepMs;
    },
    sleeps,
  };
}

function run(argv, deps = {}) {
  let out = '';
  let err = '';
  const promise = runCli(argv, {
    stdout: (s) => (out += s),
    stderr: (s) => (err += s),
    detectRepo: () => 'osxy/ocr-solver',
    readToken: () => null,
    ...deps,
  });
  return promise.then((code) => ({ code, out, err }));
}

const run_ = (name, status, conclusion) => ({ name, status, conclusion, head_sha: FULL });

test('a short SHA reaches the check-runs endpoint and every job is reported', async () => {
  const { fetchImpl, urls } = scriptedFetch({
    total_count: 2,
    check_runs: [
      run_('test / test (22.13.0)', 'completed', 'success'),
      run_('package', 'completed', 'success'),
    ],
  });
  const { code, out } = await run(['d13ca6e'], { fetchImpl });

  assert.equal(code, EXIT.GREEN);
  assert.equal(urls.length, 1, 'one read answers a resolved commit');
  assert.match(urls[0], /\/commits\/d13ca6e\/check-runs/);
  assert.doesNotMatch(urls[0], /head_sha=/, 'the short-SHA trap is avoiding this endpoint');
  assert.match(out, /test \/ test \(22\.13\.0\)/);
  assert.match(out, /package/);
  assert.match(out, /CI green/);
});

test('an incomplete check-run set is not green, and --wait keeps polling until the cap', async () => {
  const { fetchImpl, urls } = scriptedFetch({
    total_count: 2,
    check_runs: [
      run_('test / test (22.13.0)', 'completed', 'success'),
      run_('package', 'in_progress', null),
    ],
  });
  const clock = fakeClock();
  const { code, out } = await run(['d13ca6e', '--wait', '--timeout-sec', '10'], {
    fetchImpl,
    clock,
  });

  assert.equal(code, EXIT.UNKNOWN, 'not finished is not green');
  assert.ok(urls.length > 1, 'the wait re-read until the cap');
  assert.ok(clock.sleeps.length > 0, 'the wait backed off between reads');
  assert.doesNotMatch(out, /CI green/);
  assert.match(out, /unknown/);
});

test('a single-shot read of an incomplete set is unknown, never green', async () => {
  const { fetchImpl } = scriptedFetch({
    total_count: 2,
    check_runs: [
      run_('test / test (22.13.0)', 'completed', 'success'),
      run_('package', 'queued', null),
    ],
  });
  const { code, out } = await run(['d13ca6e'], { fetchImpl });
  assert.equal(code, EXIT.UNKNOWN);
  assert.doesNotMatch(out, /CI green/);
});

test('a wait that reaches its cap exits non-zero and says unknown, not failed', async () => {
  const { fetchImpl } = scriptedFetch({ total_count: 0, check_runs: [] });
  const clock = fakeClock();
  const { code, out } = await run(['d13ca6e', '--wait', '--timeout-sec', '5'], {
    fetchImpl,
    clock,
  });

  assert.notEqual(code, 0);
  assert.equal(code, EXIT.UNKNOWN);
  assert.match(out, /unknown/i);
  assert.match(out, /not failed/i);
  assert.doesNotMatch(out, /CI failed/);
  assert.ok(clock.sleeps.length > 0);
});

test('a failed job exits non-zero and names the failure', async () => {
  const { fetchImpl } = scriptedFetch({
    total_count: 1,
    check_runs: [run_('test / test (24.x)', 'completed', 'failure')],
  });
  const { code, out } = await run(['d13ca6e'], { fetchImpl });
  assert.equal(code, EXIT.FAILED);
  assert.match(out, /CI failed/);
  assert.match(out, /test \/ test \(24\.x\)/);
});

test('a cancelled job counts as a failure, not as green', async () => {
  const { fetchImpl } = scriptedFetch({
    total_count: 1,
    check_runs: [run_('package', 'completed', 'cancelled')],
  });
  const { code } = await run(['d13ca6e'], { fetchImpl });
  assert.equal(code, EXIT.FAILED);
});

test('--wait returns as soon as a failure is seen', async () => {
  const { fetchImpl, urls } = scriptedFetch({
    total_count: 1,
    check_runs: [run_('package', 'completed', 'failure')],
  });
  const clock = fakeClock();
  const { code } = await run(['d13ca6e', '--wait', '--timeout-sec', '600'], {
    fetchImpl,
    clock,
  });
  assert.equal(code, EXIT.FAILED);
  assert.equal(urls.length, 1, 'waiting cannot fix a failure');
  assert.equal(clock.sleeps.length, 0);
});

test('a transient API error is retried and can still reach green', async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return response({ status: 502, body: { message: 'Bad gateway' } });
    return response({
      body: {
        total_count: 1,
        check_runs: [run_('test / test (22.13.0)', 'completed', 'success')],
      },
    });
  };
  const clock = fakeClock();
  const { code } = await run(['d13ca6e', '--wait', '--timeout-sec', '10'], {
    fetchImpl,
    clock,
  });
  assert.equal(code, EXIT.GREEN);
  assert.ok(call >= 2);
});

test('--json emits a machine-readable verdict with per-job entries', async () => {
  const { fetchImpl } = scriptedFetch({
    total_count: 2,
    check_runs: [
      run_('test / test (22.13.0)', 'completed', 'success'),
      run_('package', 'completed', 'success'),
    ],
  });
  const { code, out } = await run(['d13ca6e', '--json'], { fetchImpl });
  assert.equal(code, EXIT.GREEN);
  const parsed = JSON.parse(out);
  assert.equal(parsed.state, 'green');
  assert.equal(parsed.headSha, FULL);
  assert.equal(parsed.checkRuns.length, 2);
  assert.deepEqual(parsed.counts, { total: 2, failed: 0, pending: 0 });
});

test('classify treats completed-with-null-conclusion as pending, not success', () => {
  const verdict = classify([{ status: 'completed', conclusion: null }], 1);
  assert.equal(verdict.state, 'pending');
});

test('classify refuses to call a partial page green', () => {
  const verdict = classify([{ status: 'completed', conclusion: 'success' }], 5);
  assert.equal(verdict.state, 'unknown');
});

test('a full 40-character SHA is passed through unchanged', async () => {
  const { fetchImpl, urls } = scriptedFetch({
    total_count: 1,
    check_runs: [run_('package', 'completed', 'success')],
  });
  await run([FULL], { fetchImpl });
  assert.match(urls[0], new RegExp(`/commits/${FULL}/check-runs`));
});

test('missing SHA and bad timeout are usage errors', async () => {
  assert.equal((await run([])).code, EXIT.USAGE);
  assert.equal((await run(['d13ca6e', '--timeout-sec', '0'])).code, EXIT.USAGE);
});

test('parseArgs understands the documented flags and rejects noise', () => {
  const opts = parseArgs(['abc1234', '--wait', '--json', '--timeout-sec', '30', '--repo', 'o/r']);
  assert.equal(opts.sha, 'abc1234');
  assert.equal(opts.wait, true);
  assert.equal(opts.json, true);
  assert.equal(opts.timeoutSec, 30);
  assert.equal(opts.repo, 'o/r');
  assert.throws(() => parseArgs(['--nope']), /unknown argument/);
});

test('parseRepo handles the ssh and https remote forms', () => {
  assert.equal(parseRepo('git@github.com:osxy/ocr-solver.git'), 'osxy/ocr-solver');
  assert.equal(parseRepo('https://github.com/osxy/ocr-solver.git'), 'osxy/ocr-solver');
  assert.equal(parseRepo('https://github.com/osxy/ocr-solver'), 'osxy/ocr-solver');
  assert.equal(parseRepo('not a url'), null);
});
