#!/usr/bin/env node
/**
 * Is this commit green? Ask GitHub Actions for the check-runs on that commit.
 *
 * Why check-runs and not the obvious alternatives (issue #38):
 *
 *   - `GET /commits/{sha}/status` answers 200 with zero statuses here, because this
 *     repository's CI is entirely GitHub Actions and Actions reports *check runs*,
 *     not commit statuses. A green status feed would be a confident wrong verdict.
 *   - `GET /actions/runs?head_sha=<sha>` silently returns zero runs for a short SHA
 *     and two for the full 40 characters. Empty is indistinguishable from "CI has
 *     not started", so a poller built on it waits forever and reports nothing.
 *
 * `GET /commits/{sha}/check-runs` accepts the short SHA and aggregates every
 * workflow for that commit. That matters: one push triggers both `CI` and
 * `Package (Windows)`, so a single workflow run is not a verdict.
 *
 *   node scripts/ci-status.mjs <sha>                 # read once, print the table
 *   node scripts/ci-status.mjs <sha> --wait          # poll until green/failed/cap
 *   node scripts/ci-status.mjs <sha> --json          # machine-readable verdict
 *   node scripts/ci-status.mjs <sha> --timeout-sec 300
 *
 * Exit codes:
 *   0  green   - every check-run completed without a failure
 *   1  failed  - at least one check-run failed, was cancelled or timed out
 *   2  unknown - not finished, no check-runs yet, or a timeout / API error.
 *                This is deliberately distinct from "failed": a timeout must never
 *                masquerade as success. "Not finished" is not "green".
 *   3  usage   - bad arguments
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const API = 'https://api.github.com';

export const EXIT = { GREEN: 0, FAILED: 1, UNKNOWN: 2, USAGE: 3 };

/** A completed run whose conclusion is any of these is a failure, not a pass. */
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

export const HELP = `Usage: node scripts/ci-status.mjs <sha> [options]

Answers "is this commit green?" from GitHub Actions check-runs.

Options:
  --wait               poll with bounded exponential backoff until green/failed/cap
  --timeout-sec <n>    hard cap for --wait, in seconds (default 120)
  --json               print the verdict as JSON instead of a table
  --repo <owner/name>  repository (default: origin remote / GITHUB_REPOSITORY)
  --token <token>      GitHub token (default: GITHUB_TOKEN / GH_TOKEN / token file)
  -h, --help           this text

Exit codes: 0 green, 1 failed, 2 unknown/timeout, 3 usage.
`;

/**
 * The API accepts a short SHA here, and the whole point is to use it - the short
 * SHA is what a leg records. Exported so the choice is asserted by a test.
 */
export function requestSha(sha) {
  return String(sha ?? '').trim();
}

/**
 * Classify a check-run set into one of green / failed / pending / unknown.
 *
 * `unknown` is the safe fallback, and gets there in two ways that both look like
 * "nothing is wrong" to a careless reader:
 *   - zero check-runs: an early SHA, before Actions has registered any job;
 *   - a partial page: the API says there are more runs than it returned.
 * Neither may be reported as green.
 */
export function classify(checkRuns = [], totalCount = checkRuns?.length ?? 0) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const failed = runs.filter(
    (r) => r.status === 'completed' && FAILURE_CONCLUSIONS.has(String(r.conclusion))
  );
  // `completed` with a null conclusion is unresolved, not a pass.
  const pending = runs.filter((r) => r.status !== 'completed' || r.conclusion == null);

  if (runs.length === 0) {
    return { state: 'unknown', reason: 'no check-runs exist yet', failed, pending };
  }
  if (totalCount > runs.length) {
    return {
      state: 'unknown',
      reason: `only ${runs.length} of ${totalCount} check-runs returned`,
      failed,
      pending,
    };
  }
  if (failed.length) return { state: 'failed', reason: null, failed, pending };
  if (pending.length) return { state: 'pending', reason: null, failed, pending };
  return { state: 'green', reason: null, failed, pending };
}

function buildHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'puzzlesolver-ci-status',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/** One read of `/commits/{sha}/check-runs`. Throws on a non-2xx response. */
export async function readCheckRuns({ sha, repo, token = null, fetchImpl = globalThis.fetch }) {
  const url = `${API}/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`;
  const res = await fetchImpl(url, { headers: buildHeaders(token) });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.message ?? '';
    } catch {
      // A non-JSON error body is not useful; the status carries the signal.
    }
    throw new Error(`GitHub API ${res.status} for ${url}${detail ? `: ${detail}` : ''}`);
  }
  const body = await res.json();
  const checkRuns = body.check_runs ?? [];
  return {
    checkRuns,
    totalCount: body.total_count ?? checkRuns.length,
    headSha: checkRuns[0]?.head_sha ?? null,
    url,
  };
}

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Poll until the set resolves to green or failed, or the hard cap is reached.
 *
 * On the cap it returns `state: 'unknown'` with `timedOut: true`; it never turns
 * "I ran out of time" into success. A failed set returns immediately - waiting
 * cannot fix it.
 */
export async function waitForVerdict({
  sha,
  repo,
  token,
  fetchImpl,
  timeoutSec,
  clock = realClock,
  intervalStartMs = 2000,
  intervalMaxMs = 15000,
}) {
  const deadline = clock.now() + timeoutSec * 1000;
  let interval = intervalStartMs;
  let last = null;

  for (;;) {
    try {
      const { checkRuns, totalCount, headSha } = await readCheckRuns({
        sha,
        repo,
        token,
        fetchImpl,
      });
      last = { ...classify(checkRuns, totalCount), checkRuns, headSha, error: null };
      if (last.state === 'green' || last.state === 'failed') {
        return { verdict: last, timedOut: false };
      }
    } catch (err) {
      // An API error is "unknown", and it is retryable until the cap.
      last = {
        state: 'unknown',
        reason: err.message,
        failed: [],
        pending: [],
        checkRuns: [],
        headSha: null,
        error: err.message,
      };
    }

    const now = clock.now();
    if (now >= deadline) {
      return {
        verdict: {
          ...last,
          state: 'unknown',
          timedOut: true,
          reason: last?.reason ?? 'check-runs did not resolve before the timeout',
        },
        timedOut: true,
      };
    }
    await clock.sleep(Math.min(interval, deadline - now));
    interval = Math.min(interval * 2, intervalMaxMs);
  }
}

export function parseRepo(url) {
  if (!url) return null;
  const ssh = url.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  const https = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
  const match = ssh ?? https;
  return match ? match[1].replace(/\.git$/, '') : null;
}

export function detectRepo(cwd = process.cwd()) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return parseRepo(url);
  } catch {
    return null;
  }
}

export function readToken(env = process.env) {
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    const file = join(homedir(), '.config', 'puzzlesolver', 'github-token');
    if (existsSync(file)) return readFileSync(file, 'utf8').trim() || null;
  } catch {
    // No token is fine for a public repo; the read is best-effort.
  }
  return null;
}

export function parseArgs(argv) {
  const opts = { sha: null, wait: false, json: false, timeoutSec: 120, repo: null, token: null, help: false };
  const value = (i, name) => {
    if (i + 1 >= argv.length) throw new Error(`${name} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') opts.wait = true;
    else if (a === '--json') opts.json = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '--timeout-sec') opts.timeoutSec = Number(value(i++, '--timeout-sec'));
    else if (a.startsWith('--timeout-sec=')) opts.timeoutSec = Number(a.slice('--timeout-sec='.length));
    else if (a === '--repo') opts.repo = value(i++, '--repo');
    else if (a.startsWith('--repo=')) opts.repo = a.slice('--repo='.length);
    else if (a === '--token') opts.token = value(i++, '--token');
    else if (a.startsWith('--token=')) opts.token = a.slice('--token='.length);
    else if (!a.startsWith('-') && opts.sha == null) opts.sha = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function verdictLine(verdict, sha, timeoutSec) {
  const runs = verdict.checkRuns ?? [];
  if (verdict.state === 'green') {
    return `CI green for ${sha}: ${runs.length} check-run(s), no failures`;
  }
  if (verdict.state === 'failed') {
    const names = verdict.failed.map((r) => r.name).join(', ');
    return `CI failed for ${sha}: ${verdict.failed.length} of ${runs.length} check-run(s) failed (${names})`;
  }
  if (verdict.timedOut) {
    return (
      `CI state unknown for ${sha}: not resolved within ${timeoutSec}s ` +
      `(state is unknown, not failed); rerun with a larger --timeout-sec or read again later`
    );
  }
  if (verdict.state === 'pending') {
    return (
      `CI pending for ${sha}: ${verdict.pending.length} of ${runs.length} check-run(s) not finished ` +
      `(no verdict yet, not green); use --wait to poll`
    );
  }
  return `CI state unknown for ${sha}: ${verdict.reason ?? 'no verdict'}`;
}

function render(verdict, opts, sha, stdout) {
  if (opts.json) {
    stdout(
      JSON.stringify(
        {
          sha,
          headSha: verdict.headSha ?? null,
          state: verdict.state,
          timedOut: verdict.timedOut === true,
          reason: verdict.reason ?? null,
          error: verdict.error ?? null,
          counts: {
            total: (verdict.checkRuns ?? []).length,
            failed: verdict.failed.length,
            pending: verdict.pending.length,
          },
          checkRuns: (verdict.checkRuns ?? []).map((r) => ({
            name: r.name,
            status: r.status,
            conclusion: r.conclusion ?? null,
          })),
        },
        null,
        2
      ) + '\n'
    );
    return;
  }
  if ((verdict.checkRuns ?? []).length) {
    stdout('STATUS     CONCLUSION  JOB\n');
    for (const run of verdict.checkRuns) {
      stdout(
        `${String(run.status).padEnd(10)} ${String(run.conclusion ?? '-').padEnd(11)} ${run.name}\n`
      );
    }
    stdout('\n');
  }
  stdout(verdictLine(verdict, sha, opts.timeoutSec) + '\n');
}

function exitFor(state) {
  if (state === 'green') return EXIT.GREEN;
  if (state === 'failed') return EXIT.FAILED;
  return EXIT.UNKNOWN;
}

export async function runCli(argv = [], deps = {}) {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const clock = deps.clock ?? realClock;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const env = deps.env ?? process.env;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    stderr(`error: ${err.message}\n`);
    return EXIT.USAGE;
  }
  if (opts.help) {
    stdout(HELP);
    return EXIT.GREEN;
  }
  const sha = requestSha(opts.sha);
  if (!sha) {
    stderr(`error: a commit SHA is required\n\n${HELP}`);
    return EXIT.USAGE;
  }
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) {
    stderr('error: --timeout-sec must be a positive number\n');
    return EXIT.USAGE;
  }
  const repo = opts.repo ?? deps.detectRepo?.() ?? detectRepo();
  if (!repo) {
    stderr('error: cannot determine the repository; pass --repo <owner/name>\n');
    return EXIT.USAGE;
  }
  const token = opts.token ?? deps.readToken?.() ?? readToken(env);

  if (opts.wait) {
    const { verdict } = await waitForVerdict({
      sha,
      repo,
      token,
      fetchImpl,
      timeoutSec: opts.timeoutSec,
      clock,
    });
    render(verdict, opts, sha, stdout);
    return exitFor(verdict.state);
  }

  try {
    const { checkRuns, totalCount, headSha } = await readCheckRuns({ sha, repo, token, fetchImpl });
    const verdict = { ...classify(checkRuns, totalCount), checkRuns, headSha };
    render(verdict, opts, sha, stdout);
    return exitFor(verdict.state);
  } catch (err) {
    const verdict = {
      state: 'unknown',
      reason: err.message,
      error: err.message,
      timedOut: false,
      failed: [],
      pending: [],
      checkRuns: [],
      headSha: null,
    };
    render(verdict, opts, sha, stdout);
    return EXIT.UNKNOWN;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
