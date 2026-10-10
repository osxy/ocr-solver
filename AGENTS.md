# AGENTS.md — working rules for this repository

Rules for any agent or human working here. Read this before making changes.

`DESIGN.md` is the architecture reference — it records what was decided and *why*.
`docs/workflow.md` is the contributor playbook — the milestone, hotfix and release
procedures, and the incidents behind them. This file records the rules that must hold on
**every** turn; procedures live in the playbook.

---

## 1. Never push to `main`

**`main` is protected. Every change goes through a branch and a pull request.**

```bash
git switch -c <type>/<short-slug>   # branch off main; then commit your work
git push -u origin <type>/<short-slug>
gh pr create --fill                 # or open the PR; merge only through it
```

Branch type prefixes: `feat/`, `fix/`, `docs/`, `chore/`, `test/`.

Never run `git push origin main`. A `pre-push` hook enforces this (see §2).

If you have already committed to `main`, move the commits to a branch instead of pushing:

```bash
git branch <type>/<slug>          # name the branch at the current commit
git reset --hard origin/main      # rewind main, keeping the branch
git switch <type>/<slug>
```

Prefer small, single-purpose branches, so a review can answer "what does this change and why"
without reading a mixed diff.

Milestone and hotfix work does not land on `main` under its own name either: it accumulates on
a protected **integration branch** (`milestone/v*`, `hotfix/v*`) that becomes the release. The
shape, the branch names and the release sequence are in
[docs/workflow.md](./docs/workflow.md).

---

## 2. The `pre-push` hook

`scripts/git-hooks/pre-push` refuses to push to `main`, `master`, a `milestone/*` branch, or a
`hotfix/v*` integration branch. `npm install` installs it (the `prepare` script); to push to
one of them deliberately, the hook prints the override
`ALLOW_MAIN_PUSH=1 git push origin main`. Reaching for it should be rare enough to be worth
explaining in the PR or commit message afterwards.

**Enforcement is local.** There is no server-side branch protection on `main`: the guardrail is
the hook plus this document. A clone that has not run `npm install` has no hook, and a token
with contents-write can still push to `main` directly. That is a deliberate choice, not an
oversight — turn on branch protection in the repository settings if it stops being acceptable.

---

## 3. Never commit a secret

Keys are read from the environment and are **never** written to disk by the app. The model
provider key lives at `~/.config/puzzlesolver/env` (mode 600) and the GitHub token at
`~/.config/puzzlesolver/github-token` (mode 600) — all of it **outside the repository**. Do not
paste a secret into an issue, a commit, a PR description, or a chat session; a chat transcript
is a file on disk like any other.

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
- **Prefer the raw evidence.** `finish_reason` and `completion_tokens` revealed that an apparent
  prompt problem was actually a token-budget problem (`DESIGN.md` §14). Without them, the wrong
  thing gets rewritten.
- **Reproduce before declaring.** A verification that could not have failed is not a
  verification.

### Never weaken an assertion to make a test pass

If a test fails, find out which of the test or the code is wrong. Adjusting an expectation to
match observed behaviour hides the bug — and doing it silently is worse than failing. If a test
genuinely encoded a wrong expectation (this has happened), fix it *and say so*, with the reason.

### Every fixed bug gets a regression test

The `max_tokens` truncation bug and the accepted-`onbekend` bug each have tests that fail on the
old code (`DESIGN.md` §14). Behaviour that took live testing to find must not be able to come
back silently.

---

## 5. Tests

```bash
npm test              # offline: no network, no token, no key
npm run test:unit     # fast subset
npm run test:corpus   # real images through real OCR, ~4s
npm run test:live     # opt-in; skips itself unless LLM_API_KEY is set
```

`npm test` prints its own pass/skip summary; do not copy that number into a document. A test
count in prose goes stale the moment it is rebased — two individually-correct counts merge into
a third nobody recomputed (§10).

The offline suite must stay runnable with **no credentials of any kind** — that is what makes it
usable in CI and by a contributor who has no provider account. Live tests must always skip
cleanly rather than fail when a key is absent. Never make the offline suite depend on a network
call.

Live-testing setup and the developer CLI recipes (`--fake-answer`, `--dump-masks`,
`--store`/`--attempts`, the invalid-key plumbing check) are in
[docs/workflow.md](./docs/workflow.md#live-provider-testing).

---

## 6. Design document vs. issue tracker

- **`DESIGN.md` is the architecture reference.** It holds the decisions and the reasoning: the
  measurements, the rejected alternatives, the traps found. Keep it readable as a whole; do not
  turn it into a changelog.
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
  transcript (`DESIGN.md` §2).

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

**Use `ghx`, not `gh`.** GitHub operations (issues, PRs, releases, run status) go through
`~/.local/bin/ghx`; a bare `gh` is not on the PATH of a non-login shell. **Verify by SHA via
check-runs**, never by scanning "the latest run on the branch": ask
`scripts/ci-status.mjs <full-40-char-sha>`, whose exit-code contract **is** the verdict — `0`
green, `1` failed, `2` unknown/timeout, `3` usage. **A timeout exits `2`, never `0`** — "not
finished" is not "green".

**Bound every wait and every mutation test** under a short command-level `timeout`: a mutation
can turn a bounded test into an unbounded one, and an unbounded wait is indistinguishable from a
hang (issue #37).

```bash
timeout 30 node scripts/ci-status.mjs "$sha" --wait --timeout-sec 300
```

The API traps (`head_sha` needs the full 40-character SHA; `GET /commits/{sha}/status` reports
zero statuses when CI is check runs), the polling rule and the stale-read rule are in
[docs/workflow.md](./docs/workflow.md#verifying-ci).

---

## 10. Documentation placement, and the README budget

The README is a **front door**, not a manual. It has been rewritten twice for carrying
repository trivia; this rule is what stops a third.

**What each document owns:**

| Document | Owns |
|---|---|
| **`README.md`** | what it is; install; verify the download; the secrets; run it — the common path; the failure modes people actually hit; known limitations; pointers |
| **`DESIGN.md`** | how it works and why; measured findings; testing; the architecture reference |
| **`docs/`** | one page per secondary mode (the HTTP API, the solve page, the statistics page, exposing the UI beyond loopback, configuration, OpenRouter) and the contributor playbook |
| **`AGENTS.md`** | how to work on the repo |

**The README has a length budget, enforced by `tests/markdown.test.js`**; the number lives in
the test, not in prose that would go stale. If a change would cross it, move detail to
`DESIGN.md` or `docs/`, and do not raise the budget without saying why in the commit message.
**`AGENTS.md` has the same budget and the same test**, because every agent turn loads it.

**Every relative link and anchor in the README must resolve**, enforced by the same file. When a
section moves to `docs/`, the README gets a link to its new home; a moved section with no link
is as bad as a deletion.

**Describing configuration means mentioning the web UI.** Any page that shows a `config.toml`
block, a `config set` command, or individual setting keys must also say the same settings can be
changed in the web UI — the tray's **Settings** item, or `config edit --gui`. The editor is the
path most users take, and a page that describes a key without it reads as "edit this file by
hand." Enforced by the same test, along with "every config key the docs show exists in the
settings registry".

**Never hand-maintain a test count in a document.** `npm test` prints its own number, and a
count copied into prose goes stale faster than it can be re-measured. Report the count when you
are asked for it, from the run you actually did.
