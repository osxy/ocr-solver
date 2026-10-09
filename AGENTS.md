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

`scripts/git-hooks/pre-push` refuses to push to `main`. Enable it in a clone with:

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
npm test              # 363 tests (357 pass, 6 skip), fully offline: no network, no token, no key
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
