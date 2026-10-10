# AGENTS.md — working rules for this repository

Rules for any agent or human working here. Read this before making changes.

`DESIGN.md` is the architecture reference — it records what was decided and *why*.
This file records how work gets done.

---

## 1. Never push to `main`

**`main` is protected. Every change goes through a branch and a pull request.**

```bash
git switch -c <type>/<short-slug>     # branch off main
# ...commit your work...
git push -u origin <type>/<short-slug>
gh pr create --fill                    # or open the PR in the browser
# merge only through the PR
```

Branch type prefixes: `feat/`, `fix/`, `docs/`, `chore/`, `test/`.

Never run `git push origin main`. A `pre-push` hook enforces this (see §2).

If you have already committed to `main`, move the commits to a branch instead of pushing:

```bash
git branch <type>/<slug>          # name the branch at the current commit
git reset --hard origin/main      # rewind main, keeping the branch
git switch <type>/<slug>
```

Prefer small, single-purpose branches. A review should be able to answer "what does this
change and why" without reading a mixed diff.

### Milestones: a long-lived branch, so `main` is always the released state

`main` is what users download, so **it must always be the last released version**. Milestone work
therefore does not happen on it.

- **A milestone gets a long-lived branch**, `milestone/v<major>.<minor>` — e.g. `milestone/v0.5` —
  created from `main` when the milestone opens.
- **Every issue in that milestone branches off the milestone branch**, not off `main`, and its pull
  request targets the milestone branch.
- **The version bump, the README install link and the release notes live on the milestone branch.**
- When the milestone's work is finished *and* its peer review's findings are fixed, the **milestone
  branch merges to `main`**. That merge *is* the release: tag the merge commit and push the tag.

```bash
git switch -c milestone/v0.5 main                 # when the milestone opens
git switch -c feat/thing milestone/v0.5           # per issue
gh pr create --base milestone/v0.5                # into the milestone, not main
# ...work, review, findings fixed...
gh pr create --base main --head milestone/v0.5    # the release merge
git switch main && git pull
git tag -a v0.5.0 -m 'PuzzleSolver v0.5.0' && git push origin v0.5.0
```

**Why:** under the previous scheme the version bump happened on `main`, so `main` advertised a
version that did not exist yet and the README's pinned download link 404'd for the whole development
cycle (issue #106). A milestone branch keeps unreleased state off `main` entirely.

**Consequences that are easy to miss:**

- **CI must cover the milestone branch.** The workflows trigger on `main` **and** on `milestone/**`;
  a workflow that watches only `main` leaves milestone pull requests unverified.
- **The milestone branch is protected like `main`** — the `pre-push` hook refuses it too, so work
  reaches it through a pull request.
- Keep the milestone branch current with `main`, so a hotfix released from `main` does not return as
  a conflict at release time.
- **Hotfixes** to a released version go `hotfix/<slug>` → pull request to `main` → tag a patch
  release, and are then merged or cherry-picked into the open milestone branch.
- **A `Closes #n` reference does not fire when a pull request merges into the milestone branch** — GitHub
  only auto-closes against the default branch. Close the issue by hand as the pull request merges, or it
  will sit open with its work already in the milestone.

**Creating the milestone branch is the one exception to the hook.** The `pre-push` hook refuses
`milestone/*` from a clone, deliberately — work reaches the milestone through a pull request. The
branch itself is not work, so it is created with the API (`POST /repos/:owner/:repo/git/refs`)
instead of by pushing; from then on every change branches off it and is pushed normally, and only
the release merge into `main` is a separate, deliberate pull request.

**v0.4 is the last milestone done the old way.** It branches off `main` and bumps `package.json`
there, because it was already in flight when this rule was written. Do not "fix" `main` during v0.4.
The rule applies from the next milestone onward.

### The peer review is the last item of a milestone

**A milestone's peer review runs after every other item in it has been merged**, and it gates the
release. The ordering is not cosmetic: a review is only worth running against a finished state, and one
that runs early reviews a moving target while giving the release a false sense of coverage.

- **Every milestone item is merged before the review starts.** If new work is added to the milestone
  after the review has begun, the review is **restarted** — a release must not ship work the review never
  saw.
- **The reviewer is a different model from the one that wrote the code, and it fixes nothing.** Every
  finding goes back to the regular model, one branch per finding, through the normal verify-and-merge
  gate. A reviewer that also fixes is not a reviewer.
- **Nothing is released until every finding is fixed and merged.** Fixing findings *after* the review is
  expected: the review is the last *original* work, and its findings are the last *fixes*.
- **A finding may add scope.** That scope is either fixed in this milestone or moved to the next one
  **explicitly** — never quietly dropped, and never merged unreviewed.
- **A milestone with more than one review orders them**, so each reviews a state that has absorbed the
  previous one's fixes. In v0.45 the documentation review (#131) runs after the code review (#130) for
  exactly that reason.
- The milestone branch merges to `main` only once the findings are in.

**The fixes are a phase of the milestone, not an afterthought.** The sequence is `original work →
peer review → every finding fixed and merged → release`. The review is the last *original* work; the
fixes are the last *work*. Both phases belong to the milestone, and it is not finished when the review
is filed.

- **Which path a finding takes is already decided for you.** Reviewers classify each finding as a
  **defect in delivered work** or **new scope**. A defect is fixed in this milestone — no exceptions.
  New scope may be deferred, and the deferral is recorded as its own issue rather than left in a
  comment. Silence is not a decision: a finding that is neither fixed nor recorded has been dropped.
- **The fixes go back through the same gate as everything else**: one branch per finding, verified,
  mutation-tested where a guard is involved, merged into the milestone branch — not hot commits made
  because the release is waiting. A fix that skips verification is a second defect.
- **The release waits for them.** Not "fixed after the tag", not "known issues in the notes". A release
  that ships its own review findings unfixed has published work it knows to be wrong, which is the thing
  the whole review cycle exists to prevent.
- **A fix that turns out to be too large** is deferred explicitly, like any other new scope — and the
  reason is written down. "Too big" is a legitimate answer; treating it as one is what keeps the rest of
  the answers honest.

**Why:** v0.3's review found a DPAPI proof that never called `Unprotect`, and v0.4's found thumbnails
blocked by the page's own CSP. Both had passed a green suite and a design review, neither was visible
from a diff, and both would have shipped had the review run early or not at all.

### Merging

Merging through a PR is expected. Say in the PR description *what was verified and how* —
not just what changed. If the change was not verified, say so explicitly.

**Merge policy:** the agent may merge its own PR once the tests pass, without waiting for review.
Nothing else does — an unverified change waits.

Because `main` is reached through a PR rather than a local merge, the `pre-push` hook is never in
the way of the normal path. If you ever do need to update `main` locally, that is exactly the case
the hook is there to stop; use the override only if you mean it.

### Known limitation: enforcement is local

There is **no server-side branch protection** on `main`. The guardrail is the `pre-push` hook plus
this document. A clone that has not run `npm install` has no hook, and a token with contents-write
can still push to `main` directly.

That is a deliberate choice, not an oversight. If it stops being acceptable, turn on branch
protection in the repository settings — it is the only way the rule binds someone who never reads
this file.

---

## 2. The `pre-push` hook

`scripts/git-hooks/pre-push` refuses to push to `main`, `master`, or a `milestone/*` branch.
Enable it in a clone with:

```bash
git config core.hooksPath scripts/git-hooks
```

`npm install` does this for you (the `prepare` script). To push to `main` deliberately —
bootstrapping a repository, or an emergency — the hook prints the override:

```bash
ALLOW_MAIN_PUSH=1 git push origin main
```

Reaching for that override should be rare enough to be worth explaining in the PR or commit
message afterwards.

---

## 3. Never commit a secret

Keys are read from the environment and are **never** written to disk by the app.

| What | Where it lives |
|---|---|
| Model provider key | `~/.config/puzzlesolver/env` (mode 600) |
| GitHub token | `~/.config/puzzlesolver/github-token` (mode 600) |

All of it lives **outside the repository**. Do not paste a secret into an issue, a commit, a
PR description, or a chat session — a chat transcript is a file on disk like any other.

Before committing, prove the ignore rules actually work rather than trusting them:

```bash
git check-ignore -v config/llm.env .env secrets.json state.db   # expect all ignored
git grep --cached -nE "sk-[A-Za-z0-9]{20,}" || echo "clean"     # scan staged content
```

`config/llm.env.example` is intentionally tracked (the negation `!*.env.example`) and must
stay secret-free.

---

## 4. Verify; do not assume

This is the rule that has caught the most real bugs in this project.

- **Measure before asserting.** The preprocessing constants were chosen by a sweep, not by
  intuition, and the intuition was wrong several times.
- **Check the primary source, not your memory.** Model catalogues and APIs change; query them.
  Never hardcode a model name or ID from recall.
- **Distinguish "the tests pass" from "it works".** They are different claims and should be
  reported differently.
- **Prefer the raw evidence.** `finish_reason` and `completion_tokens` revealed that an
  apparent prompt problem was actually a token-budget problem. Without them, the wrong thing
  gets rewritten.
- **Reproduce before declaring.** A verification that could not have failed is not a
  verification.

### Never weaken an assertion to make a test pass

If a test fails, find out which of the test or the code is wrong. Adjusting an expectation to
match observed behaviour hides the bug — and doing it silently is worse than failing.

If a test genuinely encoded a wrong expectation (this has happened), fix it *and say so*, with
the reason.

### Every fixed bug gets a regression test

The `max_tokens` truncation bug and the accepted-`onbekend` bug each have tests that fail on
the old code. Behaviour that took live testing to find must not be able to come back silently.

---

## 5. Tests

```bash
npm test              # 810 tests (804 pass, 6 skip), fully offline: no network, no token, no key
npm run test:unit     # fast subset
npm run test:corpus   # real images through real OCR, ~4s
npm run test:live     # opt-in; skips itself unless LLM_API_KEY is set
```

The offline suite must stay runnable with **no credentials of any kind** — that is what makes
it usable in CI and by a contributor who has no provider account. Live tests must always skip
cleanly rather than fail when a key is absent.

Never make the offline suite depend on a network call.

### Live provider testing

The model tiers are covered offline by a scripted client, but that cannot tell you whether a
real model actually reads these puzzles. The live test is opt-in and needs a provider key.
Keep the key **outside** the repository, so it reaches neither the project directory, shell
history, nor a session transcript:

```bash
mkdir -p ~/.config/puzzlesolver
cp config/llm.env.example ~/.config/puzzlesolver/env
chmod 600 ~/.config/puzzlesolver/env
$EDITOR ~/.config/puzzlesolver/env      # paste key, set base URL + models
set -a; . ~/.config/puzzlesolver/env; set +a
npm run test:live
```

`config/llm.env.example` documents the model-side variables (`LLM_API_KEY`, `LLM_BASE_URL`,
`LLM_TEXT_MODEL`, `LLM_VISION_MODEL`, the cost band and the allow/deny lists). The live test
skips cleanly when `LLM_API_KEY` is unset, so a normal run never needs it.
`scripts/live-eval.js` measures the text and vision tiers against the real corpus images
instead of the clean synthetic fixture, with `--verbose` to print every raw reply.

To exercise the model tiers without a key at all use `--fake-answer`; to see the OCR bitmaps
use `--dump-masks <dir>`; to record a run and read it back use `--store run.db` then
`--attempts run.db`. To check the wiring without spending anything, point the client at the
real endpoint with a deliberately invalid key:
`LLM_API_KEY=sk-invalid-key-for-plumbing-check node src/cli.js corpus/needs-model --use-model`.

---

## 6. Design document vs. issue tracker

- **`DESIGN.md` is the architecture reference.** It holds the decisions and the reasoning:
  the measurements, the rejected alternatives, the traps found. Keep it readable as a whole;
  do not turn it into a changelog.
- **The issue tracker holds the work.** Milestones `M0`–`M4` plus `v2`; see
  <https://github.com/osxy/ocr-solver/milestones>.
- When a decision changes, update `DESIGN.md` **and** record the reason. A decision without its
  rationale gets re-litigated later.
- Prefer recording a finding where it will be read. A hard-won measurement belongs in
  `DESIGN.md` §2 or the relevant component section, not only in a commit message.

---

## 7. The one invariant

**Never send an answer that has not passed validation.**

A wrong answer on a rate-limited form is worse than no answer. If no tier produces a valid,
corroborated answer, report the puzzle unresolved and send nothing.

Corollaries:

- A model is not trusted to be self-consistent; it is trusted to produce the *shape* its puzzle
  demands, and only the validator decides whether that happened.
- Tier 0, text and vision are opinions needing a strict majority. A deadlock sends nothing.
- Never trust a confidence score alone. Tesseract reports ~95% confidence for an *empty*
  transcript.

---

## 8. Code conventions

- Plain ESM, no build step. Node ≥22, using built-in `fetch`, `WebSocket` and `node:sqlite`.
- Comment the *why*, not the *what*. The value of a comment here is a measurement, a trap, or a
  reason a rejected alternative was rejected.
- Keep `src/model/client.js` free of provider-specific reasoning logic so tests can inject a fake.
- No new dependency without a reason in `DESIGN.md` §6 — several were deliberately avoided.
- Never let logging break solving: the attempts store swallows its own errors by design.

---

## 9. Verifying CI

The API and the method both have traps. The method half is the larger share, so fix the
habit before reaching for a command.

**Use `ghx`, not `gh`.** GitHub operations (issues, PRs, releases, run status) go through
`~/.local/bin/ghx`. `gh` is **not on the PATH of a non-login, non-interactive shell** —
which is what a tool-run shell is. A bare `gh` fails with "command not found" even though
it works when typed into a login shell; `ghx` resolves the binary absolutely. `ghx` reads
the token from the shared token file, so there is no second credential store and
`gh auth login` is never needed. Keep using `scripts/ci-status.mjs` for CI verdicts: it is
tested, repo-aware and check-runs based, and its exit-code contract is the verdict
(`0` green, `1` failed, `2` unknown/timeout, `3` usage).

**Verify by SHA via check-runs.** Ask `scripts/ci-status.mjs <sha>` — it reads
`GET /commits/{sha}/check-runs` and prints a per-job table plus one verdict. Do **not**
scan "the latest run on the branch": one push triggers both `CI` and `Package (Windows)`,
so no single run means green, and `workflow_runs[0]` can be the wrong or an older run.
Its exit-code contract is the verdict: `0` green, `1` failed, `2` unknown/timeout, `3`
usage. `--wait` polls with bounded backoff and a hard `--timeout-sec` cap; **a timeout
exits `2`, never `0`** — "not finished" is not "green".

**Do not poll for something a leg already waited on.** Every leg reports its run ids and
conclusions, so by the time it reports, its CI has finished. Verification reads the
recorded SHA afterwards instead of waiting live. Most of the polling this session
did was re-deriving a result a leg had already reported — the largest improvement is
polling *less*, not polling better.

**The two API traps** (measured in issue #38):

- `GET /actions/runs?head_sha=<sha>` needs the **full 40-character** SHA. A short one
  returns an empty list, not an error, which is indistinguishable from "CI has not
  started"; a poller built on it waits forever. Do not use this endpoint to answer
  "is this commit green?".
- `GET /commits/{sha}/status` answers `200` with **zero** statuses here, because this
  repository's CI is entirely GitHub Actions and Actions reports *check runs*, not commit
  statuses. Use check-runs.

**A read that contradicts a write just performed is a stale read, not a failed write.**
Closing an issue and immediately listing it can still show it open; a new issue can be
missing from its milestone for a moment. Both look like the write failed. Re-read once
before concluding it did.

**Bound every wait and every mutation test.** Run waits — and any test where a behaviour
is reverted to prove the test catches it — under a short command-level `timeout`, because
a mutation can turn a bounded test into an unbounded one. An unbounded wait is
indistinguishable from a hang (issue #37).

```bash
# capped at the shell and by the script; a timeout is exit 2, never success
timeout 30 node scripts/ci-status.mjs "$sha" --wait --timeout-sec 300
```

---

## 10. Documentation placement, and the README budget

The README is a **front door**, not a manual. It has been rewritten twice for carrying
repository trivia; this rule is what stops a third.

**What each document owns:**

| Document | Owns |
|---|---|
| **`README.md`** | what it is; install; verify the download; the secrets; run it — the common path; the failure modes people actually hit; known limitations; pointers |
| **`DESIGN.md`** | how it works and why; measured findings; testing; the architecture reference |
| **`docs/`** | one page per secondary mode (the HTTP API, the solve page, the statistics page, exposing the UI beyond loopback, configuration, OpenRouter) |
| **`AGENTS.md`** | how to work on the repo |

**The README has a stated length budget: 430 lines and 3,400 words**, enforced by
`tests/readme.test.js` ("the README stays within its length budget"). If a change would
cross it, move detail to `DESIGN.md` or `docs/` — do not raise the budget to make room
without saying why in the commit message.

**Every relative link and anchor in the README must resolve**, enforced by the same file
("every relative link and anchor in the README resolves"). When a section moves to
`docs/`, the README gets a link to its new home; a moved section with no link is as bad
as a deletion.

**Describing configuration means mentioning the web UI.** Any page that shows a
`config.toml` block, a `config set` command, or individual setting keys must also say the
same settings can be changed in the web UI — the tray's **Settings** item, or
`config edit --gui`. The editor is the path most users take, and a page that describes a
key without it reads as "edit this file by hand." Enforced by `tests/readme.test.js`
("a page that describes configuration also says the settings editor can change it", and
its stronger half, "every config key the docs show exists in the settings registry").

**Never hand-maintain a test count in a user-facing document.** `npm test` prints its
own number; a count copied into prose goes stale faster than it can be re-measured (it
was wrong three times in one session). Report the count when you are asked for it, from
the run you actually did.
