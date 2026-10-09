# PuzzleSolver

A Windows background app that watches Pushbullet for puzzle images, reads them,
solves them, and replies with the answer.

The puzzles are Dutch natural-language captchas: low-resolution coloured text on
coloured noise, asking things like *"Hoeveel kleuren in lijst wit kiwi hoofd paars
olifant aap?"* (answer `2`) or *"Wat is acht min een?"* (answer `7`).

See **[DESIGN.md](./DESIGN.md)** for the full design.

## Status

**M0 complete (offline solver) and M1 complete (model reasoner tiers), verified live.**
126 tests: 120 pass offline with no network or key, 6 more pass against a real provider.

All three sample puzzles are solved correctly with no network access, no Pushbullet
token and no API key — the lexicon supplies the semantics:

| Puzzle | Class | Answer |
|---|---|---|
| `Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?` | count | `2` |
| `In de lijst lijst hoofd buik citroen borst olifant paard wat is de/het eerste lichaamsdeel?` | ordinal-pick | `hoofd` |
| `Wat is acht min een?` | arithmetic | `7` |

A puzzle outside the lexicon falls through to the model tiers — see "Model tiers" below.

Measured against a real provider on the real corpus images (`scripts/live-eval.js`):

| Tier | Result |
|---|---|
| Offline (lexicon + arithmetic) | **3/3**, zero model calls |
| Text model, on transcripts carrying real OCR errors | **3/3** |
| Vision model, OCR suppressed — reads the raw noisy 44px puzzle | **3/3** |

Not built yet: the Pushbullet listener, the reply path, and the Windows
packaging/tray (M2–M3).

## Quick start

```bash
npm install
npm test                                                    # all 41 tests
node src/cli.js corpus                                      # solve the sample puzzles
node src/cli.js corpus --json                               # machine-readable output
node src/cli.js "corpus/001-count-kleuren.png" --dump-masks /tmp/masks

# model tiers, without needing a provider key
node src/cli.js corpus/needs-model --fake-answer Amsterdam

# real model tiers
LLM_API_KEY=sk-... node src/cli.js corpus --use-model

# record every attempt, then read them back
node src/cli.js corpus/needs-model --fake-answer Amsterdam --store run.db
node src/cli.js --attempts run.db
```

Example output:

```
001-count-kleuren.png
  ocr  adaptive_25_020      psm6   83%  Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?
  cand count         tier0=2 valid=true
  =>   answer "2" via tier0:count
```

`--dump-masks` writes the cleaned black-and-white bitmaps so you can see exactly
what OCR was given.

## How it works

```
image ──▶ adaptive threshold ──▶ connected-component filter ──▶ upscale
      ──▶ Tesseract (nld, offline) ──▶ OCR repair ──▶ parse ──▶ solve ──▶ validate
```

Three things make it work, each established by measurement rather than assumption
(details and numbers in DESIGN.md):

1. **Local adaptive thresholding, not a global one.** The noise gets darker toward
   one side of the image, so no single global cut point separates ink everywhere.
2. **Connectivity-based denoising last, upscaling before OCR.** Noise is isolated
   pixels; glyph strokes are connected components with many neighbours.
3. **A validation gate per puzzle class.** An answer is only accepted if it has the
   shape its question demands (`hoeveel` → a bare integer; `eerste <categorie>` → a
   word that actually appears in the puzzle's own list). This also defends against
   Tesseract reporting 95% confidence for a *blank* transcript.

The lexicon is what makes `count` and `ordinal-pick` solvable entirely offline: it
knows that `wit` and `paars` are colours and `hoofd`, `buik` and `borst` are body
parts. A language model is only needed for puzzle shapes the lexicon does not cover.

## Model tiers

When the offline tiers cannot answer, the puzzle escalates to a text model (reasoning
over the transcript) and then a vision model (reasoning over the image itself).

A model answer is **not** trusted to be self-consistent; it is trusted to produce the
shape its puzzle demands. So every model answer passes the same validator as an offline
one, plus three extra rules:

- **Strict class holding** — if the offline parser already identified the puzzle shape,
  the model is held to it, and `unknown` is never a fallback. Otherwise a model answering
  `"twee"` to a `hoeveel` question would slip through as loose free text.
- **Structural check** — an `ordinal-pick` answer must appear in the puzzle's own word list.
- **Deterministic cross-check** — if the model calls a puzzle arithmetic, the offline
  calculator recomputes it and overrules the model on disagreement.

Tier 0, text and vision are then treated as **opinions needing a strict majority**. A
non-confident offline answer (one whose word list contains an unreadable entry) must be
corroborated rather than posted on its own, and a two-way split sends nothing at all.

Sampling: one sample for `count`/`arithmetic` (at `temperature: 0`), three for
`ordinal-pick`/`unknown` (at `0.3`, so the vote means something). Prompts live in
`config/prompts/` and are re-read when their mtime changes, so they can be tuned without
a restart.

## Layout

```
src/
  cli.js                    command line entry point
  imaging/preprocess.js     adaptive threshold + connectivity denoise + upscale
  ocr/recognize.js          offline Tesseract wrapper, result ranking
  model/client.js           OpenAI-compatible chat over the built-in fetch
  model/fake.js             scripted client, so the model path tests offline
  solver/lexicon.js         Dutch domain words and categories
  solver/transcript.js      OCR repair (conservative, dictionary-guided)
  solver/numbers.js         Dutch number words, arithmetic
  solver/puzzle.js          classification, parsing, offline solving
  solver/validate.js        the acceptance gate
  solver/prompts.js         prompt loading with mtime caching
  solver/reason.js          text/vision tiers, self-consistency, arbitration
  solver/pipeline.js        end-to-end orchestration
  state/db.js               node:sqlite attempts log
config/prompts/             editable prompts (no rebuild needed)
corpus/                     sample puzzles + expected answers
corpus/needs-model/         a puzzle outside the lexicon (exercises the model path)
scripts/tune-preprocessing.js  parameter sweep for the preprocessing constants
```

## Testing against a real provider

Most tests need no key. The model tiers are covered by a scripted client, but that
cannot tell you whether a real model actually reads these puzzles. For that there is
an opt-in live test.

Put the key **outside** the repository, so it never lands in the project directory, in
shell history, or in a session transcript:

```bash
mkdir -p ~/.config/puzzlesolver
cp config/llm.env.example ~/.config/puzzlesolver/env
chmod 600 ~/.config/puzzlesolver/env
$EDITOR ~/.config/puzzlesolver/env      # paste key, set base URL + models
```

Then source it for a single command:

```bash
set -a; . ~/.config/puzzlesolver/env; set +a
npm run test:live
timeout 300 node src/cli.js corpus/needs-model --use-model   # same thing by hand
```

The live test skips cleanly when no key is set, so it never breaks a normal run. It
checks that a real text model answers the out-of-lexicon fixture, that the reply
honours the JSON contract, that the vision tier reads the preprocessed image when OCR
yields nothing, that a confident offline answer still costs zero model calls, and that
the key never appears in recorded call data.

Sample counts are pinned to 1 in the live test, so a full run is a handful of requests.
`scripts/live-eval.js` measures accuracy on the real corpus instead of the clean synthetic
fixture, with `--verbose` to print every raw reply.

### Two things live testing caught that offline tests could not

**The completion budget was sized for the answer, not the narration.** `max_tokens: 300`
looked ample for a ~20-token answer, but a routed reasoning model spent all of it narrating
as plain content and was cut off before emitting any JSON — while reasoning correctly the
whole time. Raising the budget to 1500 took text-on-damaged from **1/3 to 3/3** and vision
from **2/3 to 3/3**. Truncation now also retries once at 3× the budget, and `finishReason`
is recorded so a cut-off reply is distinguishable from a bad one.

**A model declining to answer was postable.** Replying `onbekend` ("unknown") passed the
loose `unknown` validator, which only checked length. Refusals are now rejected for every
puzzle class.

### Auto router: routed text tier, chosen vision model

OpenRouter's auto router (`openrouter/auto`) picks a model per request, classified by
task type against what the market actually spends on. It is wired up for the **text
tier only**:

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_TEXT_MODEL=openrouter/auto                    # routed
LLM_VISION_MODEL=~google/gemini-flash-latest      # chosen
LLM_COST_TIER=medium
```

Or from the CLI:

```bash
node src/cli.js corpus/needs-model \
  --auto --cost-tier medium \
  --vision-model '~google/gemini-flash-latest,~anthropic/claude-sonnet-latest'
```

**Why the text tier is routed.** Reading a transcript, reasoning in Dutch and emitting
JSON is easy work, so letting the router pick per request is sensible and cheap.

**Why the vision tier is chosen.** It runs *only* when OCR failed, so it is the single
tier where model choice matters most — and an unset cost band defaults to the
**cheapest** one, the opposite of what this tier needs. `--auto` therefore refuses to
guess: it requires `LLM_VISION_MODEL` (or `--vision-model`) and prints verified options
if it is missing.

### Pinning a model without pinning it to a version

A dated model name eventually gets retired. Two mechanisms avoid that:

**Rolling aliases (`~`).** A `~`-prefixed slug carries an `alias_target` and always
redirects to the newest model in its family, so `~google/gemini-flash-latest` stays
current without going stale. The three below accept images and support structured
outputs (verified against the live catalogue):

| Alias | Resolution at time of writing |
|---|---|
| `~google/gemini-flash-latest` | `google/gemini-3.8-flash` |
| `~anthropic/claude-sonnet-latest` | `anthropic/claude-sonnet-5.5` |
| `~openai/gpt-mini-latest` | `openai/gpt-5.4-mini` |

**Fallback chains.** Any model variable accepts a comma-separated list, which becomes
OpenRouter's ordered fallback chain: the first entry is the deliberate choice, the rest
run only on error, rate limit or downtime (max 3 — longer lists are rejected with a 400,
so the client refuses them before sending).

```bash
LLM_VISION_MODEL=~google/gemini-flash-latest,~anthropic/claude-sonnet-latest
```

When a chain is present the request sends `models` and omits `model`, since the docs
warn the two spellings cannot be combined.

Three behaviours worth knowing before you rely on it:

- **`allowed_models` can produce a `404`.** If the restrictions match no eligible
  model the request fails with *"No models match your request and model restrictions"*.
  That is treated as non-retryable, so it surfaces immediately rather than burning
  retries, and the puzzle is reported unresolved.
- **Self-consistency samples may land on different models.** For the 3-sample vote this
  is arguably a feature — three *different* models agreeing is stronger evidence than
  three samples of one. It does mean `temperature: 0` no longer implies repeatability,
  so the attempts log records the model that actually answered each sample (plus the
  provider and OpenRouter's routing report), which is the only way to tell what
  disagreed afterwards.
- **Cost is not predictable from the model list.** An auto slug reports a variable
  price, since it depends on what gets chosen. Cap it with OpenRouter's
  `provider.max_price` if that matters. A pinned vision model does have a known price.
- **`allowed_models` applies to routed slugs only.** A pinned vision model ignores it,
  which is intended — but worth knowing if you set it expecting it to constrain both.

A trap the client guards against: `openrouter/auto` and `openrouter/auto-beta` each
read their settings **only** under their own plugin id (`auto-router` and
`auto-beta-router`). Settings under the other slug's id are *accepted but silently
ignored*, so the wrong id looks like it worked and does nothing. The slug-to-plugin
mapping lives in one place in `src/model/client.js` and is unit tested.

**Checking the plumbing without spending anything.** Point the client at the real
endpoint with a deliberately invalid key. It proves the wiring, the error path and the
redaction are correct, and costs nothing:

```bash
LLM_API_KEY=sk-invalid-key-for-plumbing-check node src/cli.js corpus/needs-model --use-model
```

Secrets handling: `config/llm.env.example` contains no secrets and is the only env file
tracked; `.gitignore` excludes `*.env` and `llm.env`. The app reads keys from the
environment only and never writes them to disk.

## Requirements

Node.js >= 22 (developed against 26). Uses the built-in `fetch`, `WebSocket` and
`node:sqlite`, so the only dependencies are `sharp`, `tesseract.js` and the bundled
Dutch traineddata. OCR runs fully offline.
