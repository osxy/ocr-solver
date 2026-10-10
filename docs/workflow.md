# Contributor workflow

How work gets from a branch to a release here. `AGENTS.md` holds the rules that apply on
every turn; this page holds the procedures — and the incidents that shaped them, because a
rule whose reason is forgotten gets re-litigated.

## The integration-branch shape

`main` is always the last released version: it is what users download. Unreleased work never
accumulates on it. It accumulates on a long-lived **integration branch**, and that branch
becomes the release.

The shape is the same for a milestone and for a hotfix:

- **The integration branch is created from `main`** when the work opens.
- **Every item branches off the integration branch**, not off `main`, and its pull request
  **targets the integration branch**.
- **The version bump, the README install link and the release notes live on the integration
  branch** — the content ends up there, delivered by a pull request from an item branch, not
  committed to the branch directly.
- **The integration branch is protected** like `main`: the `pre-push` hook refuses it, so work
  reaches it through pull requests.
- **CI must cover it.** The workflows trigger on `main` **and** on `milestone/**` and
  `hotfix/**`. A pull request's workflow file comes from its **base** branch, so a workflow
  that watched only `main` would leave an item into the integration branch with no checks at
  all — silently unverified rather than red.
- **A `Closes #n` reference does not fire** when a pull request merges into the integration
  branch: GitHub only auto-closes against the default branch. Close the issue by hand as the
  pull request merges, or it sits open with its work already in.
- **Keep the integration branch current with `main`**, so a hotfix released from `main` does
  not return as a conflict at release time.
- **When the work is finished, the integration branch merges to `main`.** That merge *is* the
  release: tag the merge commit and push the tag.

**A milestone** uses `milestone/v<major>.<minor>` — e.g. `milestone/v0.5`. Every issue in the
milestone branches off it.

**A hotfix** uses `hotfix/v<major>.<minor>.<patch>` — e.g. `hotfix/v0.45.2` — created from
`main` when a fix is needed on a released version. Each fix branches off it as
`hotfix/<short-slug>`; both carry the `hotfix/` prefix, and the `v` is what makes the
integration branch the one that becomes a release. An ordinary `hotfix/<slug>` item branch
stays pushable, because that is how a fix gets reviewed.

**Why:** under the old scheme the version bump happened on `main`, so `main` advertised a
version that did not exist yet and the README's pinned download link 404'd for the whole
development cycle (issue #106). For hotfixes, fixes merged after a release were accumulating on
`main` with no branch to land on, so the patch release could not be prepared, tested or tagged
at a single commit. An integration branch keeps unreleased state off `main` and gives a set of
fixes one place to land before it becomes the next release.

**"The version bump, the README install link and the release notes live on the integration
branch" means the content lands there, not that it is committed there.** The integration
branch is protected, so a direct push is refused; the bump, the README install link and the
release notes are prepared on an item branch and reach the integration branch through a pull
request. That pull request is not ceremony. A push to `hotfix/**` runs no workflow at all, and
a push to `milestone/**` runs only the offline suite; the Windows packaging job — the only
place `packaging/check-version.mjs` and the deployment smoke test execute — triggers on a pull
request into either integration branch, never on a push. So the pull request is the only run
that covers the assembled release state in full, and it is where `tests/packaging.test.js`
cross-checks the version bump, the README asset and the install link together. The product
owner was asked directly and chose to keep the pull request, with this wording clarified.

**A sync of `main` into an integration branch is a real merge, never a squash.** `main`
contains merge commits — every release is one — and squashing a branch that contains a merge
discards ancestry: the content arrives, but the branch still reports itself N commits behind
`main`, so the next sync or the release merge sees history that does not match reality. The
v0.45.2 sync into `milestone/v0.46` was squash-merged and had to be repaired for exactly this
reason: the milestone read "4 behind main" while holding every file from it, and the ancestry
was restored with a real merge through the API. Prove a sync afterwards:

```bash
git rev-list --count <branch>..main         # must be 0
git merge-base --is-ancestor main <branch>  # must exit 0
```

**Dependabot opens against the default branch, so its pull requests need retargeting.** There
is no `.github/dependabot.yml` in this repository, so only security updates appear — and they
open against `main`, because that is the default branch. `main` is always the released
version, so a dependency change landing there would alter what users download without a
release. Retarget such a pull request into the current milestone (or the open hotfix) before
considering it. This is manual: dependabot's `target-branch` is a fixed setting and the
current integration branch changes.

**Creating the milestone branch is the one exception to the hook.** The `pre-push` hook
refuses `milestone/*` from a clone, deliberately — work reaches the milestone through a pull
request. The branch itself is not work, so it is created with the API
(`POST /repos/:owner/:repo/git/refs`) instead of by pushing; from then on every change branches
off it and is pushed normally, and only the release merge into `main` is a separate, deliberate
pull request.

## Running a milestone

```bash
git switch -c milestone/v0.5 main                 # when the milestone opens
git switch -c feat/thing milestone/v0.5           # per issue
ghx pr create --base milestone/v0.5               # into the milestone, not main
# ...work, review, findings fixed...
ghx pr create --base main --head milestone/v0.5   # the release merge
git switch main && git pull
git tag -a v0.5.0 -m 'PuzzleSolver v0.5.0' && git push origin v0.5.0
```

A `Closes #n` in an item's description does not fire when it merges into the milestone branch;
close the issue by hand.

## The peer review gates the release

**A milestone's peer review runs after every other item in it has been merged**, and it gates
the release. The ordering is not cosmetic: a review is only worth running against a finished
state, and one that runs early reviews a moving target while giving the release a false sense
of coverage.

- **Every milestone item is merged before the review starts.** If new work is added to the
  milestone after the review has begun, the review is **restarted** — a release must not ship
  work the review never saw.
- **The reviewer is a different model from the one that wrote the code, and it fixes
  nothing.** Every finding goes back to the regular model, one branch per finding, through the
  normal verify-and-merge gate. A reviewer that also fixes is not a reviewer.
- **Nothing is released until every finding is fixed and merged.** Fixing findings *after* the
  review is expected: the review is the last *original* work, and its findings are the last
  *fixes*.
- **A finding may add scope.** That scope is either fixed in this milestone or moved to the
  next one **explicitly** — never quietly dropped, and never merged unreviewed.
- **A milestone with more than one review orders them**, so each reviews a state that has
  absorbed the previous one's fixes. In v0.45 the documentation review (#131) runs after the
  code review (#130) for exactly that reason.
- The milestone branch merges to `main` only once the findings are in.

**The fixes are a phase of the milestone, not an afterthought.** The sequence is `original
work → peer review → every finding fixed and merged → release`. The review is the last
*original* work; the fixes are the last *work*. Both phases belong to the milestone, and it is
not finished when the review is filed.

- **Which path a finding takes is already decided for you.** Reviewers classify each finding as
  a **defect in delivered work** or **new scope**. A defect is fixed in this milestone — no
  exceptions. New scope may be deferred, and the deferral is recorded as its own issue rather
  than left in a comment. Silence is not a decision: a finding that is neither fixed nor
  recorded has been dropped.
- **The fixes go back through the same gate as everything else**: one branch per finding,
  verified, mutation-tested where a guard is involved, merged into the milestone branch — not
  hot commits made because the release is waiting. A fix that skips verification is a second
  defect.
- **The release waits for them.** Not "fixed after the tag", not "known issues in the notes". A
  release that ships its own review findings unfixed has published work it knows to be wrong,
  which is the thing the whole review cycle exists to prevent.
- **A fix that turns out to be too large** is deferred explicitly, like any other new scope —
  and the reason is written down. "Too big" is a legitimate answer; treating it as one is what
  keeps the rest of the answers honest.

**Why:** v0.3's review found a DPAPI proof that never called `Unprotect`, and v0.4's found
thumbnails blocked by the page's own CSP. Both had passed a green suite and a design review,
neither was visible from a diff, and both would have shipped had the review run early or not at
all. (The DPAPI round trip is in `DESIGN.md` §4.13; the CSP finding in §4.15.)

## Cutting a release

**Merging through a PR is expected. Say in the PR description *what was verified and how* —
not just what changed. If the change was not verified, say so explicitly.**

**Merge policy:** the agent may merge its own PR once the tests pass, without waiting for
review. Nothing else does — an unverified change waits.

The release is the integration branch's merge into `main`: tag the merge commit and push the
tag (the command block under [Running a milestone](#running-a-milestone)). For a patch release
the integration branch is `hotfix/v<major>.<minor>.<patch>` and the tag is the same version.

The `release` job decides the GitHub pre-release flag from the tag, never by hand:
`packaging/release-flag.mjs` flags a tag with a semver pre-release suffix (`v0.46.0-pre.1`)
and publishes a plain `vX.Y.Z` tag as a normal release. The choice is written into the
version string, so "pre-release" is opt-in rather than a property of every 0.x tag (#216).
An already-published release keeps the flag it shipped with.

Because `main` is reached through a PR rather than a local merge, the `pre-push` hook is never
in the way of the normal path. If you ever do need to update `main` locally, that is exactly
the case the hook is there to stop; use the override only if you mean it.

## Verifying CI

**Use `ghx`, not `gh`.** `gh` is **not on the PATH of a non-login, non-interactive shell** —
which is what a tool-run shell is — so a bare `gh` fails with "command not found" even though
it works when typed into a login shell. `ghx` resolves the binary absolutely and reads the
token from the shared token file, so there is no second credential store and `gh auth login`
is never needed.

**Verify by SHA via check-runs.** Ask `scripts/ci-status.mjs <sha>` — it reads
`GET /commits/{sha}/check-runs` and prints a per-job table plus one verdict, and its exit-code
contract **is** the verdict: `0` green, `1` failed, `2` unknown/timeout, `3` usage. Do **not**
scan "the latest run on the branch": one push triggers both `CI` and `Package (Windows)`, so no
single run means green, and `workflow_runs[0]` can be the wrong or an older run.

**The two API traps** (measured in issue #38):

- `GET /actions/runs?head_sha=<sha>` needs the **full 40-character** SHA. A short one returns
  an empty list, not an error, which is indistinguishable from "CI has not started"; a poller
  built on it waits forever. Do not use this endpoint to answer "is this commit green?".
- `GET /commits/{sha}/status` answers `200` with **zero** statuses here, because this
  repository's CI is entirely GitHub Actions and Actions reports *check runs*, not commit
  statuses. Use check-runs.

`--wait` polls with bounded backoff and a hard `--timeout-sec` cap; **a timeout exits `2`,
never `0`** — "not finished" is not "green".

**Do not poll for something a leg already waited on.** Every leg reports its run ids and
conclusions, so by the time it reports, its CI has finished. Verification reads the recorded SHA
afterwards instead of waiting live; the largest improvement is polling *less*, not polling
better.

**A read that contradicts a write just performed is a stale read, not a failed write.** Closing
an issue and immediately listing it can still show it open; a new issue can be missing from its
milestone for a moment. Both look like the write failed. Re-read once before concluding it did.

**Bound every wait and every mutation test.** Run waits — and any test where a behaviour is
reverted to prove the test catches it — under a short command-level `timeout`, because a
mutation can turn a bounded test into an unbounded one. An unbounded wait is indistinguishable
from a hang (issue #37).

```bash
# capped at the shell and by the script; a timeout is exit 2, never success
timeout 30 node scripts/ci-status.mjs "$sha" --wait --timeout-sec 300
```

## Live provider testing

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
skips cleanly when `LLM_API_KEY` is unset, so a normal run never needs it. `scripts/live-eval.js`
measures the text and vision tiers against the real corpus images instead of the clean
synthetic fixture, with `--verbose` to print every raw reply.

To exercise the model tiers without a key at all use `--fake-answer`; to see the OCR bitmaps
use `--dump-masks <dir>`; to record a run and read it back use `--store run.db` then
`--attempts run.db`. To check the wiring without spending anything, point the client at the
real endpoint with a deliberately invalid key:
`LLM_API_KEY=sk-invalid-key-for-plumbing-check node src/cli.js corpus/needs-model --use-model`.
