# Pushbullet Puzzle Solver — Design

A small Windows background app that watches Pushbullet for incoming puzzle images,
reads the image, solves the puzzle, and answers back on Pushbullet.

Status: **M1 complete** (offline solver + model reasoner tiers, verified live).
Decisions confirmed — see §13.

**This document is the architecture reference.** It records what was decided and *why* — the
measurements, the rejected alternatives, the traps — and deliberately stays readable as a whole.
Individual work items are tracked separately in the
[issue tracker](https://github.com/osxy/ocr-solver/issues), grouped into milestones. Where the two
disagree, the issues say what is being *done* and this document says how it *fits together*.

---

## 1. Goal & scope

**In scope**

- Connect to Pushbullet with a personal access token.
- Receive image/file pushes in near-real-time.
- Download the image, read it, solve the Dutch-language puzzle.
- Post the solution back as a Pushbullet note push.
- Run unattended on Windows: tray icon *and* a headless mode.

**Out of scope (v1)**

- Multi-user / SaaS hosting.
- Image-grid ("select all bicycles") CAPTCHAs — different pipeline, see §12.
- Browser automation that types the answer into a form. This app reads and replies only.

---

## 2. Observed input, and what was measured

Three real samples drive the whole design.

| Sample | Transcript | Class | Answer |
|---|---|---|---|
| 522×44 | `Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?` | count-of-property over a word list | `2` |
| 819×44 | `In de lijst lijst hoofd buik citroen borst olifant paard wat is de/het eerste lichaamsdeel?` | first-of-category pick | `hoofd` |
| 180×44 | `Wat is acht min een?` | arithmetic in number words | `7` |

Shared properties, all of which drive the design:

- **Language: Dutch**, informal. Number words (`acht min een`), article variants (`de/het`).
- **Rendering:** 1–2 lines, ~15–20 px cap height, total height **44 px**. Width 180–819 px.
- **Noise:** dense random coloured noise across the full width, and the ink is close to it
  in luminance and saturation.
- **No rotation or warping.** This is a *readability* puzzle, not a distortion puzzle, so
  careful preprocessing recovers the text rather than a distortion model.

### Measured findings

These were established by experiment (`scripts/tune-preprocessing.js`), and each one
overturned an initial assumption:

| Finding | Evidence | Consequence |
|---|---|---|
| Saturation does **not** separate ink from noise | mean saturation 0.20–0.23 in all three images; 9–10% of pixels exceed 0.4 in both ink and noise | abandoned a saturation/hue-based mask |
| A **global** luminance threshold cannot work | image 3's noise darkens toward the right; one cut point cleans the left and floods the right | use local adaptive (Bradley) thresholding |
| Denoising must happen at **native resolution** | upscaling first turns single-pixel noise into 4×4 blocks that no median filter can distinguish from strokes; the first pipeline scored 28–57% confidence | order is: threshold → denoise → **then** upscale |
| Connectivity is the strongest noise filter | noise is isolated pixels; glyph strokes are connected components with many neighbours | component-size + neighbour-count filtering before OCR |
| `win=25, t=0.20, minComponent=4` is optimal | sweep: 3/3 solved, 3/3 *exact* transcripts; `t=0.15` drops to 1/3 exact and `t=0.10` to 0/3 | these are the shipped constants |
| **Tesseract reports ~95% confidence for empty output** | `gray_clahe` variant returned 95% with a blank transcript | confidence is never trusted alone; empty text is a hard failure |

### Puzzle taxonomy → validation rules

| Class | Trigger | Expected answer | Offline-solvable? |
|---|---|---|---|
| `count` | `hoeveel <categorie> in lijst …` | `^\d+$`, 0–20 | yes, via the lexicon |
| `arithmetic` | `wat is <getal> <operator> <getal>` | `^-?\d+$` | yes, fully deterministic |
| `ordinal-pick` | `… <ordinal> <categorie>` | one lowercase Dutch word, present in the puzzle's own list | yes, via the lexicon |
| `unknown` | anything else | non-empty, ≤40 chars, one line | no — needs the model |

This table is the **acceptance gate**. An answer failing its class validator is never
sent; it escalates instead. A wrong answer on a rate-limited form is worse than silence.
An unresolved puzzle is no longer silence either: it gets the acknowledgement of §4.11,
which is explicitly *not* an answer.

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    PuzzleSolver (Node.js, tray or --headless)            │
│                                                                          │
│  ┌────────────┐  push   ┌──────────────┐  bytes  ┌────────────────────┐  │
│  │ Listener   │────────▶│ Image Fetcher│────────▶│ Preprocess (sharp) │  │
│  │ WS + poll  │         │ (S3 GET)     │         │ adaptive + denoise │  │
│  └─────┬──────┘         └──────────────┘         └─────────┬──────────┘  │
│        │ tickle                                             │ mask PNG    │
│        ▼                                                    ▼             │
│  ┌────────────┐                                  ┌────────────────────┐  │
│  │ Dispatcher │                                  │ OCR  (tesseract.js)│  │
│  │ dedupe +   │                                  │  nld, N variants   │  │
│  │ idempotency│                                  └─────────┬──────────┘  │
│  └─────┬──────┘                                            │ text        │
│        │                                                   ▼             │
│        │                                          ┌────────────────────┐ │
│        │                                          │ Repair + parse     │ │
│        │                                          │ lexicon, taxonomy  │ │
│        │                                          └─────────┬──────────┘ │
│        │                                                    │             │
│        │                          ┌─────────────────────────┴──────────┐  │
│        │                          ▼                                    ▼  │
│        │                 ┌─────────────────┐              ┌──────────────┐│
│        │                 │ Tier 0 offline  │  unresolved  │ Tier 1 model ││
│        │                 │ lexicon + maths │─────────────▶│ text→vision  ││
│        │                 └────────┬────────┘              └──────┬───────┘│
│        │                          └───────────┬──────────────────┘        │
│        │                                      ▼                           │
│        │                             ┌─────────────────┐                  │
│        │                             │ Validator gate  │                  │
│        │                             └────────┬────────┘                  │
│        │                                      ▼                           │
│        └────────────────────────────▶┌─────────────────┐                  │
│                                      │ Responder       │                  │
│                                      │ note push back  │                  │
│                                      └─────────────────┘                  │
│                                                                          │
│  ┌──────────────┐ ┌──────────┐ ┌───────────┐ ┌───────────────────────┐   │
│  │ node:sqlite  │ │ config   │ │ logger    │ │ tray (systray2) +     │   │
│  │ state        │ │ TOML     │ │ rotating  │ │ notifications         │   │
│  └──────────────┘ └──────────┘ └───────────┘ └───────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
```

**Concurrency:** one WebSocket listener feeding a queue; a single worker processes
puzzles serially. Volume is low, serial processing keeps logs and state ordered, and
`node:sqlite` then has exactly one writer.

**The ingress seam (issue #15, v2).** The diagram above is Pushbullet-shaped, but the
transport is not the architecture. The solve-and-validate path from "adaptive threshold"
to "Validator gate" is transport-agnostic and now lives behind `src/solver/core.js`:

| Concern | Pushbullet ingress | HTTP ingress |
|---|---|---|
| **ingress** supplies | a file push (`fetchImage`) | a request body (`validateImageBuffer`) |
| **core** runs | `createSolveCore().solve(path)` | the same `solve(path)` |
| **egress** delivers | a note push (`respond.js`) | a JSON response body (`http/server.js`) |

The two ingresses coexist in one process and either can be absent: with no Pushbullet
token and `[http] enabled = true` the app runs HTTP-only. The tray's "solve last
image" and the CLI already call the same core, so there is one place where the pipeline
options are wired. Grids (#9) and Playwright (#12) each add another ingress/egress pair,
which is why the seam was built once here rather than as a second special case.

---

## 4. Component design

### 4.1 Imaging — `src/imaging/preprocess.js` ✅ built

Produces a clean black-on-white bitmap, then upscales it for OCR. Order is
significant and was chosen by measurement:

1. **Flatten** onto white (discard alpha).
2. **Luminance** (Rec.601).
3. **Bradley adaptive threshold** via a summed-area table: a pixel is ink if it is
   `t` darker than the mean of its `win × win` neighbourhood. `win=25, t=0.20`.
   Handles the horizontal brightness gradient that defeats a global threshold.
4. **Connected-component filter** (`minComponent=4`): discard blobs smaller than N
   pixels. Random noise never forms a 4-pixel blob; glyph strokes always do.
5. **Neighbour-count despeckle** (optional): drop ink with <2 ink neighbours.
6. **Upscale 4×** (Lanczos) and add an 8 px white border.

Cost is trivial: integral image + union-find over 36k pixels, well under 10 ms per image.

### 4.2 OCR — `src/ocr/recognize.js` ✅ built

- `tesseract.js` with the `nld` traineddata **bundled in `node_modules`** via
  `@tesseract.js-data/nld` — no CDN fetch, fully offline.
- Runs every preprocessing variant at PSM 6 (uniform block) and PSM 7 (single line).
- `rankResults()` **demotes empty transcripts below every non-empty one regardless of
  reported confidence**, and `bestResult()` adds a small bonus for transcripts that
  contain real Dutch question words, because a slightly lower-confidence full sentence
  is far more useful than a high-confidence fragment.

### 4.3 Repair — `src/solver/transcript.js` ✅ built

Tesseract's residue here is small but real: `Wat js acht min een?` (a broken `s` read as
`j`), `hoof d` (a split glyph), `cen` for `een`. Three conservative, offline repairs:

1. **Re-join** a single stray character onto the previous token when the result is a real
   word (`hoof d` → `hoofd`).
2. **Confusion substitution** from a table of mistakes this OCR actually makes
   (`j`→`i`, `1`→`i`/`l`, `rn`→`m`, `5`→`s`). Safe at *any* token length, because it only
   rewrites along a confusion that really occurs.
3. **Edit-distance snap** to the nearest known word, only for tokens of length ≥3 and
   only within distance 1 (≤4 chars) or 2 (≥5 chars).

Anything still unrecognised is **left alone** and reported in `unknownTokens`. Force-fitting
an unknown word into the lexicon would silently change a word count, which is the one
failure mode that produces a confidently wrong answer.

### 4.4 Puzzle logic — `src/solver/puzzle.js` ✅ built

Classifies and parses into a plain object, then solves offline:

- `count` — count list items belonging to the named category.
- `ordinal-pick` — pick the first/second/last list item belonging to the category.
  Parsing correctly treats `In de lijst` as scaffolding *and* `lijst` as a legitimate
  list item, which the corpus requires.
- `arithmetic` — delegated to `numbers.js`.
- anything else — `unknown`, defers to the model.

`confident: false` is returned whenever the list contains unrecognised tokens, so a
possibly-miscounted answer can never masquerade as certain. The pipeline then prefers a
*confident* answer from a lower-confidence OCR variant over a merely *valid* one from a
higher-confidence variant.

### 4.5 Dutch numbers — `src/solver/numbers.js` ✅ built

Number words 0–999 including compounds (`eenentwintig`, `driehonderdvijf`, `drieënveertig`),
the four operators (`plus`, `min`, `keer`/`maal`, `gedeeld door`), digits, and glued forms
like `8-1`. Left-to-right evaluation with `*` and `/` precedence. Division by zero returns
`null` rather than `Infinity`. This path is deterministic and doubles as an independent
cross-check on any model answer.

### 4.6 Validator — `src/solver/validate.js` ✅ built

Applies the §2 taxonomy table, canonicalises the answer (word answers lowercased to match
the generated puzzles), and strips model chatter (`Het antwoord is: 7` → `7`). Rejects empty
answers on their own merits, never on confidence.

### 4.7 Model client — `src/model/client.js` ✅ built

A ~150-line OpenAI-compatible chat client over the built-in `fetch`, **not** the vendor SDK.
The app needs exactly one POST with retries, and owning it means any OpenAI-compatible
endpoint works by changing `baseUrl`, there is no dependency to track, and tests can swap
`fetchImpl` for a fake without touching the reasoning logic.

- Retries transient failures (408/409/425/429/5xx and network errors) with exponential
  backoff plus jitter; a 401 fails immediately rather than burning retries on a bad key.
- If a server rejects `response_format: json_object` (many compatible endpoints do), the
  request is retried once without it instead of failing.
- `extractJson` accepts bare JSON, fenced JSON and JSON embedded in prose, because models
  reliably emit all three.
- `redact` keeps only a short, identifying prefix of a key, so a log line never carries a
  usable one. The rule is no longer pattern-only: the shapes below are covered, *and* the app
  registers every configured secret by value, so a key whose provider shape is not listed is
  still redacted from the sinks (issue #45). What remains uncovered is named in §8.

`src/model/fake.js` provides a scripted client. This is what makes the entire reasoning path
testable without a provider key: self-consistency, the escalation ladder and the validator
gate are all exercised deterministically offline.

**OpenRouter auto routing** is supported for the **text tier only** (`openrouter/auto`,
`cost_tier: low` or `medium`). Reading a transcript and emitting JSON is easy work, so
letting the router pick per request is sensible and cheap. The cost band, the allowlist and
the blocklist are `[solver] cost_tier / allowed_models / excluded_models` config keys, and
the service passes them to the client it builds just as the CLI does (issue #78); an empty
band sends no `cost_tier`.

**The vision tier is a deliberately chosen model, not a routed one.** It runs only when
OCR failed, so it is the single tier where model choice matters most — and an unset cost
band defaults to the cheapest, the opposite of what this tier needs. `--auto` therefore
refuses to proceed without an explicit `LLM_VISION_MODEL`/`--vision-model`, printing
verified options rather than guessing.

**Durability without version rot.** A dated model name eventually gets retired, so:

- **Rolling aliases (`~`)** carry an `alias_target` and always redirect to the newest model
  in their family (verified via `GET /v1/models`), so the pin stays a deliberate choice of
  *family* without going stale. `~google/gemini-flash-latest`, `~anthropic/claude-sonnet-latest`
  and `~openai/gpt-mini-latest` all accept images and support structured outputs.
- **Fallback chains.** Any model variable accepts a comma-separated list, sent as
  OpenRouter's `models` array in priority order (max 3). The first entry is the deliberate
  choice; the rest run only on error, rate limit or downtime. When a chain is present the
  request sends `models` and omits `model`, because the docs warn the two spellings cannot
  be combined.

**Cost is not predictable from a model list.** An auto slug reports a variable price, since
it depends on what gets chosen; cap it with OpenRouter's `provider.max_price` if that
matters. A pinned vision model has a known price.

Three consequences are designed for rather than discovered later:

1. **Slug/plugin-id pairing.** Each auto slug reads settings *only* under its own plugin id
   (`auto-router` / `auto-beta-router`); the other slug's id is *accepted but silently
   ignored*. A hardcoded plugin id would therefore look functional while doing nothing. The
   mapping lives in one tested place (`AUTO_ROUTER_SLUGS`).
2. **Samples may route to different models.** For the 3-sample vote this is arguably a
   feature — agreement across *different* models is stronger evidence than agreement within
   one. It does make `temperature: 0` non-repeatable, so the attempts log records the resolved
   model, provider and routing report per sample, which is the only way to reconstruct what
   disagreed.
3. **`allowed_models` can yield a 404** when nothing matches. That is non-retryable by
   design, so it surfaces immediately and the puzzle is reported unresolved instead of
   burning retries on a configuration error.

### 4.8 Reasoner — `src/solver/reason.js` ✅ built

Two tiers over the same validator:

- **Text tier** — reasons over the OCR transcript, and is responsible for repairing OCR
  damage the offline layer could not (it fixes wording before solving).
- **Vision tier** — reasons over the preprocessed mask itself, used when the transcript is
  missing, garbled, or contradicted.

**Sample counts.** `count` and `arithmetic` take one sample; `ordinal-pick` and `unknown`
take three. A single sample runs at `temperature: 0` (a deterministic lookup); multiple
samples run at `temperature: 0.3`, because identical samples would make the vote meaningless.
Vision samples are capped at 2 regardless of class, since each one costs an image.

**A model answer is not trusted to be self-consistent; it is trusted to produce the shape its
puzzle demands.** Three specific rules make that real:

1. **Strict class holding.** When the offline parser already identified the puzzle shape, the
   model is held to that shape and `unknown` is *not* a fallback. Without this, a model
   answering `"twee"` to a `hoeveel` question would quietly validate as a loose free-text
   answer and be posted. The model only names the class when the parser genuinely could not.
2. **Structural check.** An `ordinal-pick` answer must appear in the puzzle's own word list,
   so a plausible-but-invented word like `voet` is rejected.
3. **Deterministic cross-check.** If the model calls a puzzle arithmetic, the corrected
   transcript is handed to the offline calculator, which overrules it on disagreement. The
   calculator cannot be wrong about `9 - 4`.

Prompts live in `config/prompts/{solve,vision}.txt`, loaded with mtime caching so an edit
applies to the next puzzle without a restart, with built-in fallbacks for packaged builds.

> **Note on prompt examples.** The few-shot examples in `solve.txt` are deliberately *unlike*
> the corpus puzzles (`hond blauw kat`, `peer arm fiets`, `negen min vier`). Using the corpus
> puzzles as examples would inflate measured accuracy on the only test set available.

### 4.9 Listener — `src/pushbullet/listener.js` ⬜ M2

Pushbullet has **no webhooks**. Two mechanisms, used together:

1. **Stream (primary):** `wss://stream.pushbullet.com/websocket/<token>` using Node's
   built-in global `WebSocket` — no dependency. Messages are `{"type":"tickle","subtype":"push"}`,
   an inline `{"type":"push",…}`, or `{"type":"nop"}` keepalive. On a tickle, fetch over REST.
2. **Poll (fallback):** every 60 s, `GET /v2/pushes?modified_after=<watermark>`, in case the
   socket dropped silently. A watchdog turns the tray icon grey if no tickle has arrived in
   10 minutes, so a silently dead listener is visible rather than invisible.

Keeps a persisted watermark, deduplicates by push `iden`, reconnects with exponential backoff
and jitter, and (by default) ignores pre-existing history rather than answering a backlog.

### 4.10 Image fetcher — `src/pushbullet/files.js` ⬜ M2

`file_url` is a pre-signed S3 URL, so a plain `fetch` works. Verifies magic bytes and that
Pillow-equivalent decoding succeeds, enforces a size cap, saves to
`%LOCALAPPDATA%\PuzzleSolver\inbox\<iden>.<ext>`, and prunes by age (default 7 days).

### 4.11 Responder — `src/pushbullet/respond.js` ⬜ M2

**Delivery path confirmed: the puzzle arrives as a file push from another user or device, and
a new note push back is an acceptable answer.** The Pushbullet API offers a true threaded reply
*only* for mirrored SMS (`POST /v2/texts/{thread_id}`); for a plain file push no reply endpoint
exists. So:

```js
POST /v2/pushes
{ "type": "note", "title": "Antwoord", "body": "<answer>", "device_iden": "<source device>" }
```

Rules:

- **Idempotency first:** insert `(push_iden, answer_hash)` into `outbox` *before* sending.
  Never send twice, even across restarts.
- **Rate limit:** minimum 3 s between outgoing pushes, maximum 20/hour, 429 → back off once.
- **Answer formatting:** the canonical form from the validator (digits as digits, words
  lowercase). Optional prefix/`**bold**` per config.
- **Never send an unvalidated answer.** An *unresolved* puzzle - one where no tier produced
  a valid answer - is acknowledged with `reply.unresolved_title` / `reply.unresolved_text`:
  a distinct title and a sentence body that cannot be read as a solution. A guess is still
  never sent (issue #29).
- **Dutch first, English second.** The default acknowledgement is Dutch, because the puzzle
  arrives in Dutch and its sender is the most likely reader; the English line covers an
  operator or recipient who cannot read Dutch. Both lines are replaceable with
  `reply.unresolved_text`, so a non-Dutch deployment is a config change, not a fork.
- **No coalescing.** A burst of unsolvable puzzles produces one acknowledgement each, under
  the same 3 s minimum interval as answers, but a **separate hourly budget**
  (`reply.unresolved_max_per_hour`, default 60). Counting them under the answer budget
  let a burst of junk images exhaust `max_per_hour` and drop a real answer as
  `rate-limited` - the app went silent exactly when it had something worth sending (#48).
  The acknowledgement budget is looser because an acknowledgement is cheap and expected,
  and bounded so a junk-image flood cannot turn the account into a note-spammer. Merging
  replies was rejected for the original reason: it would either skip the first puzzle of a
  burst or address one conversation from another.
- **A rate-limited answer is still not auto-retried.** #48 separates the budgets and removes
  the false-starvation cause, but a genuine hit on `reply.max_per_hour` leaves that one
  answer unsent: the Pushbullet listener claims a push once and the poll does not replay it,
  so a retry would need a durable retry queue that does not exist. The refusal is recorded
  (`respond`, `reason: rate-limited`) and the outbox claim is deliberately not taken, so a
  future retry path has the row to work from; building that path is a feature, not part of
  this fix.
- **No templating.** `unresolved_text` is sent literally. A placeholder for the failure
  reason or the OCR transcript would leak internals into a conversation and add a
  substitution surface; an operator who wants that detail reads the log or the attempts
  store.
- **Idempotent by a marker, not a hash.** An acknowledgement has no answer to key on, so it
  claims `outbox` under the literal `UNRESOLVED_MARKER` (`"unresolved"`), which no
  `answerHash()` can produce. A restart or duplicate tickle therefore sends it exactly once,
  and a later real answer for the same push still gets its own row.
- **`require_confidence` (default true)** suppresses answers that passed validation but were
  never corroborated, e.g. an offline count whose word list contained an unreadable entry.
  This case stays silent - neither the answer nor the acknowledgement - because a candidate
  exists and the setting deliberately withholds it. Setting it false sends the answer and
  trades accuracy for coverage.
- **Pluggable:** the responder is an interface with `sms-thread`, `note-push`, and
  `clipboard+notify` strategies, so switching later is a config change.

### 4.12 State — `src/state/db.js` ✅ built

`node:sqlite` is built into Node 22+, so this needs no dependency. The `attempts` table and
`kv` are in use now; `pushes` and `outbox` are created and used from M2.

```sql
CREATE TABLE pushes (
  iden TEXT PRIMARY KEY, created REAL, modified REAL,
  type TEXT, file_name TEXT, file_url TEXT,
  status TEXT,              -- new|downloaded|solved|unresolved|ignored|error
  created_at REAL, updated_at REAL
);
CREATE TABLE attempts (
  id INTEGER PRIMARY KEY, push_iden TEXT, stage TEXT,   -- ocr|reason|validate|respond
  variant TEXT, psm TEXT, payload TEXT, confidence REAL, ms INTEGER, created_at REAL
);
CREATE TABLE outbox (
  push_iden TEXT, answer_hash TEXT, sent_at REAL, response TEXT,
  PRIMARY KEY (push_iden, answer_hash)
);
CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);   -- watermark, schema_version
```

`attempts` records **every** OCR variant and every model answer, so a failure can be
replayed offline from the corpus instead of guessed at.

### 4.13 Config & secrets ⬜ M2

`%APPDATA%\PuzzleSolver\config.toml`:

```toml
[pushbullet]
poll_interval_sec = 60
history_mode = "ignore"          # ignore | watermark

[solver]
tier0 = true                     # offline lexicon + arithmetic path
self_consistency_n = 3
escalate_to_vision = true
llm_text_model = "gpt-4o-mini"
llm_vision_model = "gpt-4o"
llm_base_url = "https://api.openai.com/v1"
cost_tier = ""                   # OpenRouter auto-router band: low|medium|high|xhigh|max; "" sends none
allowed_models = []              # wildcard patterns the auto router may choose from
# excluded_models = []           # wildcard patterns it must avoid
offline_only = false
breaker_threshold = 3            # consecutive transient failures before a tier opens
breaker_cooldown_sec = 600       # how long an open tier waits before one probe

[ocr]
languages = ["nld"]
min_confidence = 0
variants = ["adaptive_25_020", "adaptive_25_020_c8", "adaptive_15_020"]

[reply]
enabled = true
strategy = "note-push"           # note-push | sms-thread | clipboard+notify
title = "Antwoord"
prefix = ""
unresolved_title = "Puzzel niet opgelost"
unresolved_text = """
Deze puzzel kon niet automatisch worden opgelost, dus er is geen antwoord gegeven.
This puzzle could not be solved automatically, so no answer is given."""
require_confidence = true        # only send answers every tier agreed on
min_interval_sec = 3
max_per_hour = 20                # answers per hour
unresolved_max_per_hour = 60     # acknowledgements, counted separately (#48)

[storage]
retain_days = 7
log_images = false               # opt-in: a file reference for UNRESOLVED puzzles only

[image]
max_width = 2000                 # gate: wider images are a 413
max_pixels = 1000000             # gate: more decoded pixels are a 413

[ui]
tray = true
notify_on_unresolved = true
stats_recent_solves = 5       # bounded 1-100; how many solves the statistics page lists
```

**Secrets are never written to `config.toml`.** The Pushbullet token, the model key, the
HTTP bearer token and the web UI verifier go to the platform credential store (or environment
variables — `PUSHBULLET_TOKEN`, `LLM_API_KEY`, `HTTP_AUTH_TOKEN` — for development on Linux).
On Windows that is **DPAPI at `CurrentUser` scope**, reached through PowerShell's
`[System.Security.Cryptography.ProtectedData]`, writing `%APPDATA%\PuzzleSolver\credentials.dpapi`;
a legacy plaintext `credentials.json` is read once, migrated and removed, and the file store
remains the fallback (and is named as such) when the protected call fails (issue #60). Off
Windows the `0600` JSON file is unchanged. The
logger redacts the configured secrets by value and the documented shapes (`sk-`, `gsk_`,
`AIza`, `ghp_`/`github_pat_`, `sk_live_`/`pk_live_`, `xox…`, `AKIA`, `o.`, `Bearer`), plus
values following a credential key name (`api_key=`, `Authorization:`, `token:`).

**Runtime resolution, settled in M2 leg 2.** Two points the schema above left implicit are now
fixed by the implementation and its tests:

- **`solver.self_consistency_n` scopes to the voting classes only** (`ordinal-pick`, `unknown`).
  `count` and `arithmetic` stay at one sample, because M1-5 records them as deterministic and
  sampling `9 - 4` would add cost for no information. The default of 3 is therefore exactly the
  M1-5 default for the voting classes, not a new policy.
- **The credential store is a provider interface**, not one hardcoded mechanism. On Windows it
  is DPAPI at `CurrentUser` scope (a `credentials.dpapi` blob written through PowerShell's
  `ProtectedData`), behind an injectable runner; off Windows it is an ACL-restricted JSON file
  at `${XDG_CONFIG_HOME:-~/.config}/puzzlesolver/credentials.json`. A legacy
  `%APPDATA%\PuzzleSolver\credentials.json` is migrated to DPAPI on first read and removed.
  A group/world-readable file still resolves but reports a warning. Resolution order is
  explicit option → environment → provider → `null`, and `describeSecret()` exposes only
  `{ present, source, hint }` — including which store answered (`windows-dpapi`/`file`).
  A `set` is a **read-modify-write**: it decrypts the protected file on disk immediately before
  merging, so a `config set` from a second process is not wiped by the service's cached copy
  (issue #84). Residual: two writers racing at the same instant are still last-writer-wins; the
  window is narrowed and documented rather than closed with a lock file, because writes come from
  short-lived CLI calls and one service. The Windows round trip is proven by **two separate `node`
  processes** — one migrates and writes, a fresh one decrypts from disk and asserts `Unprotect`
  ran (issue #83); a single-process check could be served by the cache and prove nothing.

A missing config file is not an error: every value has a working default, so the app starts with
no config at all. A *bad* value (unknown enum, negative or non-numeric interval, unknown OCR
variant, a secret-looking key) throws and names the key; an unknown key from a newer version only
warns. `ocr.languages` is validated but the bundled traineddata is `nld` only, and `ui.tray` /
`ui.notify_on_unresolved` are accepted and stored as the M3 seam.

**M2 leg 3 additions.** `solver.breaker_threshold` / `solver.breaker_cooldown_sec` parameterise
§7's per-tier circuit breaker, and `storage.log_images` is the opt-in in §8. `log_images`
defaults to `false`; it never writes image bytes anywhere (that is refused at the sinks), it only
records a durable file reference for puzzles that ended unresolved.

### 4.14 UI & logging ✅ M3

- Tray via `systray2`, notifications via `node-notifier`; `--headless` skips both.
- Menu: **Status / Accuracy / Pause / Solve last image / Open log / Open config / Settings /
  Restart / Quit**. "Solve last image" re-runs the pipeline on the newest image — essential for
  tuning without a live push. "Accuracy" reports the live recorded-traffic rate plus the cached
  offline-corpus number, and the same summary is appended to the status text and tray tooltip
  (M4). "Settings" opens the editor below (issue #27), as a loopback web UI since #56; when a save
  reports that a setting needs a restart, that editor offers **Restart now** and the **Restart**
  item performs the same graceful restart (#128, §11).
- First run: a small setup dialog (token, key, **Test connection**), a loopback web UI since #56.
- Rotating log at `%LOCALAPPDATA%\PuzzleSolver\logs\app.log` (5 MB × 3).

**As built in M3.** The widget and the logic are split so the logic is testable on Linux: the
`src/ui/tray.js` controller holds the menu, pause/status/solve-last/open/quit actions and the
watchdog bridge, and `src/ui/tray-systray.js` is a forwarder that only renders `menu()` and
translates a click back by action id. Pause stops and starts the *listener* rather than the
process, so the database, worker and icon survive; while paused the watchdog is deliberately
ignored, because an explicitly paused listener is not a silently dead one. `--headless` is the
default-off switch at the library level (`runApp` starts no tray unless `tray: true`); the CLI
turns it on, and `ui.tray = false` or `--headless` vetoes it. Notifications default off at the
`createApp` layer and are installed by `runApp` only in tray mode, which is what makes
`--headless` skip them *structurally* rather than by a flag checked at each call site.

**First run** is `src/ui/setup.js`: validation (internal whitespace rejected, a trailing newline
trimmed), an injected `Test connection` probe per field, and a write through the **existing**
provider interface — `saveSecrets` calls `provider.set`, which M3 added to the file and
Windows providers. There is no second credential file. The Windows dialog itself is
not built here; its logic is, and that is what is tested.

**Wiring (issue #25).** The dialog was built and tested but imported by nothing — a tested
function with no caller, the `pruneInbox` pattern again. It is now reached from `createApp`:
when tray mode is on (`resolveTrayMode`, so `ui.tray = false` still vetoes) and no Pushbullet
token resolves, `createApp` builds a `createSetup` over the *same* injected providers and calls
the `setupDialog` seam **before** the client, worker and listener are built. The dialog writes
through `saveSecrets`; `createApp` then re-resolves through `loadSecrets`, so a broken write
cannot masquerade as a configured app. `runApp` supplies the default web setup dialog
(`defaultWebSetupDialog`, issue #56; the old terminal prompt was deleted as dead code in #90) and
forwards the tray request. `--headless` passes no dialog, and a cancel or a failed save throws
`SetupCancelledError`/`SetupFailedError`, which the CLI prints as the exit line rather than a
stack. Because the credential is resolved before the dialog is ever considered, a second start with
a stored token does not prompt. The dialog itself is injectable, which is what makes the startup
path testable on Linux without `systray2` or a display; the native tray widget remains unverified
(see **§11**).

**Settings editor (issue #27).** Guided setup captured the token and key once; after that
changing anything meant hand-editing TOML, and the token was not even in that file. The editor
is `src/ui/settings.js` (schema + logic), `src/ui/settings-dialog.js` (the terminal prompt) and
`src/config-cli.js` (`config list|get|set|edit`), not a third prompt implementation:
`createSettingsEditor` builds on `src/ui/setup.js` — the same `hasInternalWhitespace` check and
the same **Test connection** probes (through `createSetup`'s `testConnection`), so first-run and
settings cannot drift.

The two failure modes the issue names are handled by construction rather than by care:

- **Validation before writing, and the loader is the validator.** Each value is parsed and
  rejected at `set()` — nothing becomes pending. `save()` then assembles the whole candidate and
  passes it through the loader's own `validateConfig`; a `ConfigError` names the offending key and
  the writer never runs. There is no second, drifting notion of validity.
- **Secrets take the credential path only.** A descriptor is either a config `path` or a `secret`
  name, never both; `saveSecrets` handles the latter. A secret-only save (the token rotation case,
  the most likely reason to open the editor) does not call the writer at all, so `config.toml` is
  never created or rewritten — asserted by byte-equality of an existing file and by the absence of
  a new one.

The write is atomic (temp file in the same directory, then rename) and the previous file is copied
to `config.toml.bak` first, so a bad edit is recoverable without a hand-kept copy. Only values
that differ from `DEFAULTS` are written (`configToOverrides`), because the file is documented as an
override of the defaults: copying every key would pin today's defaults in the file, so a later
release could not change one.

**The editor edits the file in place (issue #69).** Re-serialising the parsed config discarded
every comment, blank line, key order and spacing choice the user made — and the file is documented
as hand-editable, so the first GUI save destroyed the user's annotations. `writeConfigAtomically`
now locates the changed key in the raw bytes with a TOML-aware scanner and replaces only that
value; every other byte is preserved. The scanner (`locateConfigStatements` / `editConfigInPlace`)
tracks the current `[section]`, skips comment lines and the inside of strings, and jumps whole
multi-line values, so a commented-out key (`# port = 8765`) is not the real one and a `key =`
inside a value string is not an assignment. A key absent from the file is inserted at the end of
its section (the header is created when needed), and a missing file is still written with
`stringify` because there is nothing to preserve. When the scanner meets a construct it cannot
locate safely — a value that spans more than one line, an array of tables (`[[...]]`), a duplicate
key — it throws `ConfigEditError` and the writer leaves the file untouched. It never falls back to
re-serialising, because a silent rewrite is exactly the bug. The single-difference test in
`tests/settings.test.js` ("changing one setting leaves every other line byte-identical") compares
the two files line by line and requires exactly one changed line; its mutation (re-serialising in
the writer) is confirmed red.

**Restart semantics are labelled, not guessed.** The descriptors carry `restart`, and the editor,
the dialog and `config set` all name which changes apply. A setting is `restart: false` only when
the running process re-reads it from the shared config object per operation: `storage.log_images`
and `solver.tier0`, `ocr.variants`, `ocr.min_confidence`, `image.max_pixels` (`core.solve`),
`image.max_width`/`image.max_pixels` on the Pushbullet path (`handlePush`) and the HTTP request
path, and `ui.notify_on_unresolved` (`handlePush`). The HTTP gate's image limits are read per
request rather than captured at server construction for exactly this reason (#35), so the
`[live]` label is true on both ingresses. Everything else — models, base URL, `offline_only`,
`escalate_to_vision`, `self_consistency_n`, the breaker knobs, the whole `http.*` block,
`ocr.languages`, the reply switch/wording/budgets, poll interval, `history_mode`, `retain_days`,
`ui.tray` and all three secrets — is captured when the Tesseract worker, listener, reasoner,
responder or HTTP server is built, so the editor says "restart" rather than appearing to save
something that silently does nothing. The live ones are copied into the live config by
`applyLiveSettings` after a successful save.

**The editor covers the settings added after #27 (#35).** `http.enabled`, `http.bind`,
`http.port`, `http.rate_limit_per_min`, `http.timeout_ms`, `http.max_body_bytes`, `http.max_queue`,
`http.allow_image_url`, `http.image_url_hosts`,
`solver.tier0`, `solver.breaker_threshold`, `solver.breaker_cooldown_sec`, `ocr.languages`,
`ocr.min_confidence`, `image.max_width`, `image.max_pixels` and `reply.unresolved_max_per_hour`
all have descriptors, so `config list` and both editors see them. The same pass closes two
settings #27's list had always omitted (`reply.strategy` and `reply.min_interval_sec`) rather
than leaving the editor a quiet partial view. The HTTP bearer token is a
**secret**: `http.token` is stored through `saveSecrets` and never reaches `config.toml`, the same
rule and the same tested guarantee as the Pushbullet token — including a mixed save where a
non-secret `http` key is written in the same call. The token has no endpoint to probe, so its
descriptor carries `testable: false`; it is validated against the same strength rule the server
enforces at startup (`httpTokenProblem`, moved to the leaf `http/defaults.js` so the editor does
not import the image gate), which is what stops the editor from storing a token the app then
refuses to start with.

**Headless is the same editor, not a second path.** `--headless` has no tray, so
`node src/cli.js config ...` is the non-interactive route and the guided prompt is also runnable
over stdin. `tests/config-cli.test.js` exercises it **as a command** (a child process, real files,
real exit codes) for the reason #25 and `pruneInbox` exist in this record: a tested function is not
a delivered feature. The tray wiring is proven the same way — `runApp` passes `openSettings` into
`startTray`, the controller's `settings` action calls it, and a test fails if that link is removed
(the `setupDialog`/`createSetup` pattern, now closed for the editor too).

**The graphical surface is a loopback web UI (issue #56).** The Windows launcher runs the tray with
the window hidden (`shell.Run ..., 0, False`), so the process has no console and both `readline`
prompts have nowhere to appear: the tray's **Settings** item could not work, and a fresh install with
no token could not be configured except from a terminal. The fix is `src/ui/web-config.js` — a
`node:http` server on an ephemeral `127.0.0.1` port, opened in the default browser. The alternative
(native PowerShell/WinForms) was rejected on the criterion this project keeps paying for: a real
HTTP request, a form post and an assertion run on Linux in CI, while a native window can only be
checked by a person at Windows — which is how the tray, `schtasks` and the installers stayed
unverified for three releases. No dependency was added; the page is plain HTML rendered by
`renderSettingsPage`.

**One source of truth, and a test that fails without it.** The UI owns no setting knowledge. It
renders whatever `controller.list()` returns and persists through `controller.set()`/`save()`, and
the tray's settings dialog and `config edit --gui` both use the same `createSettingsEditor` the
terminal editor uses. `tests/web-config.test.js` asserts every descriptor in `settings.js` appears
in the served page, and a synthetic descriptor injected through `controller.list()` must appear
with no second edit — so a new setting cannot surface in the terminal editor and vanish from the
GUI. First-run uses the same descriptors through `createSetupSettingsController`, which wraps
`createSetup` (`pushbullet.token`, `llm.api_key`), so the first-run labels and validation cannot
drift either.

**The theme is a cookie plus a server-side render, and CSS owns the OS default (issue #99).**
The served CSP is `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'` — it
forbids scripts and external assets. (`img-src 'self'` is the minimal widening for the
statistics page's review copies: `img-src` falls back to `default-src`, so without the
directive the `default-src 'none'` forbade every same-origin `/images/<id>` thumbnail,
which is exactly what #111 was. `data:` and external hosts stay refused.) A
`localStorage` + inline-script toggle would have to relax that with `script-src
'unsafe-inline'`, and a JS-off visitor would silently get the default. The cookie approach
needs neither: the server validates `?theme=light|dark|auto` against an allowlist, sets a
`theme` cookie, and writes `data-theme` into `<html>` before any HTML is sent, so there is
no flash and no script. `auto` (and no cookie at all) leaves the attribute off, and CSS
`@media (prefers-color-scheme: dark)` supplies the palette, so an OS-dark visitor is dark
on the first load with no toggle. The dark palette is declared once and interpolated into
both the media query and the explicit `[data-theme="dark"]` rule, because CSS cannot apply
a media query to an attribute selector. The cookie value is never read back as text — only
the two known values reach the attribute — so a theme cookie cannot inject markup. Both
themes' foreground/background pairs were measured against WCAG AA rather than judged by
eye; the ratios are in the issue's PR body.

**The UI is drawn from one token layer, and the settings page is grouped by topic (issue #104).**
The appearance used to be a collection of locally sensible values; the defect was that no two
rules agreed on a spacing or a radius. `src/ui/web-config.js` now declares the colour roles, the
spacing scale, the radii, the border widths and the type ramp once, as JavaScript objects that
generate the `:root` and dark-variable blocks, and every rule consumes `var(--token)`. Because the
palette is data rather than text, `tests/web-tokens.test.js` asserts that both themes define the
same roles, that every recorded pair meets WCAG AA, that every reference resolves, and that no
page function emits a literal colour, radius or spacing. The ~50 settings rows are grouped by the
`id` prefix (topic, not lifecycle) with a jump list of anchors; the lifecycle tags stay on every
row and are counted per group, because grouping is a finding aid, not a replacement for the
metadata. A solve result renders as one of three shaped cards - solved (check), withheld (pause),
unresolved (question) - plus the word, so the outcome is readable without colour. Empty states
(no solves, no traffic, no corpus) and refusals are designed components rather than bare
paragraphs. There is no client-side loading state to design: every page is server-rendered and
there is no script; the only asynchronous paint is a lazy thumbnail, which uses a sized
panel-coloured placeholder so it does not reflow. `prefers-reduced-motion` collapses the
transitions to nothing. The token layer could not be a build step: there is no bundler, and the
CSP (`default-src 'none'; img-src 'self'`) still forbids scripts and external assets.

**Screenshots are captured over HTTP, with the real CSP in force (issue #111).**
`scripts/screenshots.mjs` used to write the fetched HTML to a `file://` document and inline
the thumbnails as `data:` URLs. A `file://` document carries no CSP header, so the render
bypassed the policy and the committed statistics images showed thumbnails that a real
browser refused. That is a verification path that cannot catch the class of bug
it exists for: when the policy forbids images, the screenshot does not notice. It now
drives Firefox through its built-in WebDriver BiDi endpoint and captures the **live loopback
URLs**, so the served policy applies and Firefox enforces it. The script waits for every
`<img>` and refuses to write a page whose images did not render (`naturalWidth === 0`), so a
reintroduced `img-src` regression fails the screenshot build rather than producing a
flattering image. BiDi is used (Node's built-in `WebSocket`, no new dependency) because the
thumbnails are `loading="lazy"` and the one-shot `firefox --headless --screenshot` captures
before a lazy image has painted. The solve page is the one page whose result only exists
after a `POST`; its captured response body *and* headers are replayed over loopback HTTP, so
it is still a real HTTP document rather than a `file://` one.

**The screenshot fixture is a function of a fixed clock, and the command exits by itself (issue #114).**
Two defects made `npm run screenshots` unusable as a non-interactive guard. Its `finally`
called `session.end` a second time after the `try` had already ended the session; a duplicate
BiDi `session.end` is never answered, so the process awaited it for ever (all six `wrote …`
lines appeared, then nothing). It now ends the session exactly once, closes the BiDi
`WebSocket` with a bound, and lets the event loop drain instead of calling `process.exit()`
before writes have flushed. The fixture history was seeded relative to `Date.now()`, so every
run produced a byte-different `statistics.png` / `statistics-dark.png` and a real UI change was
indistinguishable from clock noise; the fixture now derives every timestamp from a fixed
`FIXTURE_NOW` in `scripts/screenshot-fixture.mjs`, a pure function of the instant it is handed
asserted offline by `tests/screenshots-fixture.test.js`. `solve.png` is the deliberate
exception: it shows a genuine solve with that run's real duration, and
`docs/screenshots/README.md` names it as the one file expected to differ on a re-run.

**The upgrade review registry (issue #67).** A new release can add a setting an existing install
silently never sees. The enabling change is a `since` field on each descriptor in
`src/ui/settings.js` — the release that introduced the setting — and `securityRelevant` for a
setting whose default being ignored has a security consequence (`http.allow_image_url` and the
`image_url_hosts` allowlist, the HTTP ingress/bind/rate/limits, and the whole `web_ui.*` access
block). The values are the real release boundaries, read from the tags rather than remembered:
v0.1.0's `DEFAULTS` is `0.1.0`; the `reply.unresolved_*`, `image.*` and the first `http.*` block
landed in v0.2.0; `http.allow_image_url`, `http.image_url_hosts`, `web_ui.*` and
`ui.stats_recent_solves` are the `0.3.0` additions. `src/version.js` holds `APP_VERSION` (kept in
step with `package.json`, asserted by a test) and the comparison the flow needs.

The comparison is **per setting**, not per release, so a user who skips `0.1.0 -> 0.3.0` is shown
the `0.2.0` additions *and* the `0.3.0` additions; the alternative — compare release numbers —
would silently drop everything from the skipped release. When no version has been recorded the
baseline is the oldest `since` in the registry, so an existing install that predates the registry
is offered every addition after the first release exactly once, rather than nothing.

The reviewed state is **app state in the `kv` table of the state database**, never in
`config.toml`: the file is the user's and belongs hand-editable, the state must survive upgrades,
and a notification must not rewrite it. Two keys, deliberately:

- `settings_prompted_version` is the last version whose additions were announced at startup. It
  advances the moment the offer is logged, so a repeated start does not nag and an unattended
  install is left alone after one line. `config review --dismiss` (and an editor review) can set it
  explicitly.
- `settings_reviewed_version` is the last version whose settings were actually shown in the editor
  or through `config review`. It is the baseline for the `isNew` badges, and is **not** advanced by
  the startup offer: dismissing the prompt silences it, but the settings stay marked `[new]` in
  the terminal editor, the web page and `config list`, so a user who dismisses can still find them.

That distinction is enforced, not just documented (#87). A web UI that times out, or whose URL is
printed to a terminal nobody reads, resolves with `sessionOpened === false`; `openSettings` (and the
GUI branch of `config review`) then calls `recordDismissal`, advancing only
`settings_prompted_version`. The `[new]` badges stay, so the settings that motivated the review -
including the `web_ui.*` security settings - are still offered on the next look instead of being
cleared by a page that never rendered.

The offer is a startup log line and the badged editor; it **never opens a browser on its own** and
never blocks startup. `planStartupReview` catches its own store errors and returns `null`, so a
store that cannot be read leaves the app running on defaults. A fresh install (no config file)
records the current version and skips — first-run setup already covers it — and a downgrade (a
stored version at or beyond the running one) produces nothing. Headless gets the same set from the
log and from `config review`; the command runs the editor with the new settings marked and records
the review when it finishes.

**The security is the point, because this endpoint writes the config *and* the secrets.** Non-negotiables,
each enforced in code and in a test:

- It binds `127.0.0.1` by default on an ephemeral port (`web_ui.port`, default `0`); the
  bind and the port are configurable since #65 and #85. The loopback tests assert the bound
  address and family, and that a configured `web_ui.port` is the port that listens.
- The URL the app opens carries a **one-time launch token**: 32 random bytes, single-use, and valid
  for 5 minutes. It is redeemed for a per-session token embedded in the page, so the launch token is
  not replayed by the form posts and does not have to survive in browser state. A reused or expired
  token is a `403` naming the reason; the token is compared in constant time.
- The `Host` header is matched against the enumerated names before anything else. A
  DNS-rebinding page makes the browser send the attacker's hostname while the connection
  lands on 127.0.0.1; rejecting a non-loopback `Host` is the control that stops it. The
  **name** is what is compared, not the port (#85): a proxy forwarding `Host:
  ui.example.com` or `ui.example.com:443` to a different internal port is admitted, while a
  foreign name is still refused. `isAllowedHostHeader` never degrades to "any host".
- Every response (page, save, `404`, `403`, `500`) carries `Cache-Control: no-store`, plus a
  `Content-Security-Policy` that forbids scripts and outside resources.
- A secret value is never rendered — presence and source only, exactly as `config list` does. The
  value is validated by the same `parseSettingValue` and routed by the same editor, so an invalid
  value is rejected before the writer or the credential store is touched.
- The listener is closed and the port released on save, cancel or timeout, so the window of exposure
  is the editing session rather than the process uptime.

**Issue #65 widens the bind and adds a solve page, under one access rule.** The UI can now be
reached from a configured CIDR range (`web_ui.allowed_cidrs`) and can solve an upload. Both are
gated by a single check that runs before `Host`, before any token and before any handler, so a route
added later cannot ship with a weaker rule by accident. The address is the **socket's** remote
address; `X-Forwarded-For` is caller-supplied and is never read. The matcher (`src/ui/access.js`) parses
addresses to bytes and compares bits, so the #47 hole (`isLoopbackHost('127.evil.example')` was true
because it compared a string prefix) cannot recur in a CIDR. It folds `::ffff:192.168.1.5` down to
`192.168.1.5` and a mapped CIDR to its IPv4 form, so a client cannot bypass an IPv4 allowlist by
connecting through the mapped spelling. `0.0.0.0/0` and `::/0` are refused at config load with a
message that points at an authenticated reverse proxy; a range wider than loopback is warned about at
the same time. The refusal is about **effective coverage**, not the literal `/0` (#89): two half-space
ranges (`0.0.0.0/1` + `128.0.0.0/1`, or `::/1` + `8000::/1`) cover the same space and are refused
too, via `cidrsCoverAddressSpace`, which merges the configured ranges as intervals and asks whether
any family is fully covered. It is a guard against "reachable from everywhere", not a width ceiling:
a single wide-but-partial range is allowed, because the operator asked for it and the configured
credential is the control that actually protects the UI.

**Widening the bind does not loosen the `Host` check.** A session is scoped to a hostname, so a page
that resolves its own name to the UI's address would have the browser send that name (and any cookie)
to it. The legitimate names therefore stay **explicitly enumerated** - the bound address, the loopback
names, and `web_ui.allowed_hosts` (default deny) - and a wildcard bind contributes no name at all; the
operator must list the name they actually type. The port is deliberately not part of the comparison:
a reverse proxy legitimately forwards the public name on a different port than it connects to
(`Host: ui.example.com` or `:443` versus an internal `127.0.0.1:8443`), and it is the name that a DNS
rebinding page would have to forge. This is the opposite of "accept any `Host` once the
bind is non-loopback", which would reopen the DNS-rebinding attack the check exists to stop.

**Remote access requires a credential configured outside `config.toml`.** Loopback keeps the one-time
token. A non-loopback range additionally requires a **salt + `scrypt` verifier** in the credential
store (`web_ui_password_hash`); the app **refuses to start** if a range is admitted without one, naming
`web_ui.password`. **It also refuses to start a non-loopback range when `web_ui.port` is `0`** (#85):
an ephemeral port is fine on loopback, where the app opens the URL itself, but a remote client or a
reverse proxy has no stable port to reach, so the error names `web_ui.port` rather than exposing an
unreachable UI. The `Host` comparison is name-only (above), which is exactly what lets the documented
topology work: the proxy connects to the fixed `web_ui.port` and forwards the public `Host` name.
The verifier is created by `hashWebUiPassword` (the editor's `prepare` hook, so the
password itself never reaches a store) and checked by `verifyWebUiPassword` in constant time via
`node:crypto`. Failed logins reuse the #47 backoff, a success clears the record, and the refusal is the
same generic message whether the verifier is malformed or the password is wrong. An authenticated
session is bound to the address that authenticated, so a leaked session URL does not work from another
host. **The honest limit:** the UI is plain HTTP, so a password on a non-loopback connection is
cleartext and the session cannot be `Secure`; the credential raises the bar against casual LAN browsing
and is not transport security. A TLS reverse proxy is the answer on an untrusted network, and the
README says exactly that.

**The solve page is the ingress, not a second path.** `POST /solve` reuses `classifyRequest` and
`resolveImage` from `src/http/server.js` (raw body, multipart and base64 - #61 made the declared
`Content-Type` advisory) and calls the same shared core, so one solve lock, the admission bound (#43)
and the body/pixel/width caps (#41) are the ones already tested. The result is rendered from
`formatSolveResponse`, the ingress's serialiser, so the answer, method, confidence and timing agree
with the statistics page by construction. An unresolved or withheld answer shows the acknowledgement
wording and never a guess, so the one invariant holds on this egress too. The admission counter itself
moved into `createSolveCore` so the HTTP ingress and the solve page meter the same bound; a scripted
test core without slots falls back to a local counter.

**The statistics page is read-only and honest about what the numbers are.** `GET /stats` (issue
#64) reads the recorded `attempts` store and renders it, behind the same single access gate as
every other route and with no POST branch, so a write is unreachable from the page. It does not
run `storeReport`'s old shape, which called `attemptsFor` for every subject (O(subjects x attempts));
instead `store.latestValidationRows()` reduces to one SQL-aggregated row per subject and
`store.recentSolves(limit)` is a `LIMIT`ed query backed by a new `idx_attempts_created_at` index
(the only index was on `subject`). The totals therefore come from SQL aggregation plus the shared
`buildReport`/`summarize`, not a second implementation of the same numbers. The page lists the last
`ui.stats_recent_solves` (default 5, bounded 1-100) solves and passes each stored verdict through
`formatSolveResponse`, the same serialiser the solve page uses, so answer/method/confidence/reason
cannot drift between the two pages. Each solve's **took** is the wall time the pipeline records on
that solve's own `validate` row (`ms`), not the span between the subject's first and last attempt:
a re-solve therefore reports its own duration instead of the whole subject history, and a row with
no recorded time renders as `unknown` rather than a fabricated number (#86). The recorded-traffic
totals count **distinct puzzles** (one latest `validate` row per subject) and are labelled that way,
so re-solving the same image counts once there while the recent-solves list above shows each solve
(#86). Recorded traffic (real, no ground truth, headlined as the
sent-able rate) and the offline corpus (our own generated fixtures) are rendered as **two separate
labelled figures** and are never blended; the corpus is called a regression guard, not real-world
accuracy. The page names the `storage.retain_days` window so a moving window does not look like
vanished data, refreshes only on request (no auto-poll), and never renders the OCR transcript or
image bytes, which stay debugging detail behind the store's policy.

**The terminal path is unchanged and a failed UI does not take the tray down.** `runApp`'s default
`settingsDialog` is `defaultWebSettingsDialog`, but an injected dialog still wins, so the reachability
test and a fake UI keep working; `src/config-cli.js` still defaults `config edit` to the terminal
prompt and selects the web dialog only for `config edit --gui`. `openWebSettingsDialog` turns a bind
failure into `{ saved: false, failed: true, detail }` instead of a throw, which the tray controller
reports and then leaves the listener running. The one seam that remains unverifiable on this host is
the browser hand-off (`explorer.exe`/`xdg-open`); everything behind it is a real HTTP test.

**Watchdog.** `src/ui/watchdog.js` is a pure, clock-injectable state machine. The listener now
exposes `lastActivityAt` (advanced by a socket `open`, any stream message, or a completed poll)
and the tray feeds it in on a timer; ten minutes without evidence flips the icon to grey. The
signal is contact, not a puzzle, so a quiet week does not look like death.

**As built in M2 leg 2.** The rotating logger already exists; the tray/notifications/setup dialog
remain M3. On non-Windows platforms the log lives at
`${XDG_STATE_HOME:-~/.local/state}/puzzlesolver/logs/app.log` (same 5 MB × 3 rotation). Every
record passes through the single `redactRecord` (`redact` + `redactPushbullet` +
`stripImageBytes`) rather than a third copy, and a file sink that fails disables itself instead
of throwing, matching the attempts store's rule that logging must never break solving. The
redactor is layered (registered secrets by value, then key-name assignments, then documented
key shapes, then image bytes) rather than one regex; the false positive that mangled
`task-assignment-failed` to `task-ass…` is fixed by a word-boundary lookbehind on the `sk-` rule.

### 4.15 HTTP ingress — `src/http/server.js` ✅ v2 (#15)

`POST /v1/solve`, response body as egress. The choices, each with the reason it was made:

- **Versioned from the start (`/v1`).** The response schema and the `200`/`422` contract
  are an interface; versioning is free now and avoids a flag day later. There is no second
  version yet.
- **Synchronous, with a documented budget.** Offline solves are ~1 s (measured ~0.8 s end
  to end over HTTP, including Tesseract cold start) and a vision escalation can pass 10 s.
  An async `202` + job id would add a store of in-flight jobs, a poll endpoint and a GC for
  results a caller may never collect; the common case is a script that wants the answer now.
  `http.timeout_ms` (default 30 s) bounds a request, **and the budget includes queue wait**.
  If it is exceeded the caller gets a `504` and the abandoned solve keeps running on the
  worker but its result is discarded - nothing is delivered later, so a timeout can never
  produce an answer out of band. The one thing that *is* stopped is a task that has not
  started when its deadline passes: the lock evaluates the task's `canStart` predicate at
  dequeue and skips the pipeline, so a request that expired while queued does not spend
  CPU or provider credits on an answer nobody will read. Cancellation **once Tesseract is
  running is not possible**; the code does not claim otherwise, and `#43` records the gap
  rather than hiding it. A record that ends with a `504` therefore means "no answer was
  produced for you", not "no work was done".
- **Two ingresses, one core, in one process.** `createApp` starts the Pushbullet listener
  and the HTTP server independently; requiring both would make the "no Pushbullet account"
  path impossible. The **shared solve lock lives inside `createSolveCore`** (issue #44),
  not in an ingress: Pushbullet, HTTP and the tray's "solve last image" all call `solve`,
  so there is one promise chain per worker regardless of which path arrived. A Tesseract
  worker is not safe to drive concurrently - `recognize.js` calls `setParameters({psm})`
  and `recognize` as two steps, so interleaved solves would OCR with each other's PSM.
  The lock is intentionally the *only* serialisation point; the old per-ingress queues
  are gone. The HTTP server keeps a per-ingress **admission bound** (below), which is a
  different thing from serialisation.
- **Pushbullet egress is an opt-in extra.** A JSON body may set `"deliver":"pushbullet"`
  to run the solved result through the existing responder with a synthetic push iden
  (`http-<sha256 of the image>`), so the note-push path can be exercised end to end without
  a real push. It is off by default: the response body is the honest HTTP egress, and a
  second delivery per request would double the failure modes (a `200` answer plus a
  suppressed or failed note push). The default - no `deliver` field, or `deliver: null` -
  is HTTP-only egress: the responder is never invoked and no Pushbullet host is fetched.
  `tests/http.test.js` guards that default with a throwing responder spy and a fetch that
  rejects Pushbullet hosts, across the raw, multipart and JSON body shapes.
- **Fixed-window rate limit** (`http.rate_limit_per_min`, default 20; `0` disables). The
  Pushbullet responder's rate limit guards *sending*; this guard is on *spending* - a
  model-escalated request costs provider credits even though it sends nothing.
- **Bounded HTTP queue** (`http.max_queue`, default 8). The rate limit bounds admission
  *per minute*; it does not bound the backlog behind one worker. A vision escalation can
  take ~10 s, so a caller that issues requests faster than they drain (or retries on
  `504`) could otherwise leave an unbounded backlog that keeps spending credits after it
  has gone. The server counts requests running or waiting on the shared lock and refuses
  the next with `503` + `Retry-After` rather than enqueuing it. This is **per ingress on
  purpose**: a Pushbullet push is not retried by a buggy loop and must not be dropped, so
  the bound applies to HTTP only. It is a deliberate behaviour change users will notice:
  a legitimate burst larger than the bound is refused where it used to be queued. Eight
  is one running solve plus a short burst of waiters.
- **`require_confidence` is honoured on HTTP too (issue #42).** An answer that passed the
  class validator but was never corroborated is **withheld**, exactly as the Pushbullet
  responder withholds it: the response is `422` with `answer: null` and
  `reason: "unconfirmed"`. The unpicked candidate is deliberately **not** echoed under an
  adjacent field, because a caller that could read it would be one line from using it.
  This applies even with `reply.enabled = false` - that switch stops sending, it does not
  change what is safe to send. Setting `reply.require_confidence = false` returns the
  answer with `confident: false`, matching the Pushbullet behaviour.
- **Cost is labelled, not hidden.** Every response carries `cost: { escalated, tier,
  model }`; a model tier is named in the same payload as the answer.
- **The unresolved human reply is an extra field, not prose.** A `422` keeps its structured
  shape (`answer: null`, `reason`) and adds `unresolvedReply: { title, text }` with the
  configured wording (issue #29), so a programmatic caller can relay it without the
  response contract becoming a sentence. A `200` response never carries the field.

**Reuse, not reimplementation.** `validateImageBuffer` in `src/pushbullet/files.js` is the
one size-cap/magic-byte/decode/height gate; `downloadImage` and the HTTP resolver both call
it. The HTTP body cap is enforced while streaming before that gate runs.

---

## 5. End-to-end flow

```
other user sends image ──▶ Pushbullet
                              │  tickle over WSS (fallback: 60 s poll)
   GET /v2/pushes?modified_after=W ┘
        │ new push: type=file, image/png
        ▼
   dedupe by iden → row status=new
        │
   GET file_url (S3) → inbox/<iden>.png
        │
   adaptive threshold → component filter → upscale ×4
        │
   Tesseract nld × {variants} × {psm 6,7}
        │
   rank (empty results demoted) → repair → parse
        │
   collect opinions about the answer
        │
        ├── Tier 0 confident?  ── yes ──▶ done, no model call at all
        │
        ▼ no / uncorroborated
   opinion: Tier 0 (if any)
   opinion: text model  (1 sample, or 3 for ordinal-pick/unknown)
   opinion: vision model  (only when the opinions disagree)
        │
   strict majority of opinions?
        │
        ├── yes ──▶ answer, confident = unanimous
        └── no  ──▶ unresolved: acknowledged, never answered
        │
   outbox insert (idempotent) → note push → notify ✔ → status=solved
```

**Why opinions instead of a fallback ladder.** A *non-confident* Tier 0 answer — one whose
word list contains unrecognised tokens — is precisely the case most likely to be a miscount.
Under a plain ladder it would have been returned unverified simply because it existed. Making
Tier 0 just another opinion means it can be confirmed, outvoted (`hoofd` from tier0 + vision
beats a hallucinated text answer), or deadlocked — and a deadlock reports **unresolved**
rather than guessing. A one-against-one split deliberately sends no answer; since #29 it
sends the unresolved acknowledgement instead of going silent.

**Measured latency:** ~0.3–1.4 s per image offline, including OCR and worker startup
(see the corpus test timings). A text-tier sample adds roughly 1–3 s and a vision sample
rather more, so a fully escalated puzzle lands well inside the 10 s budget — and the common
case, where the lexicon already knows the answer, pays nothing at all. The HTTP ingress
measures the whole path end to end (real loopback server, real request, real OCR over a
corpus image) at **~0.8 s**, which is the same offline cost plus the HTTP and image-gate
overhead; this is the end-to-end evidence the Pushbullet path could not provide without an
account.

---

## 6. Technology choices

**Node.js (confirmed).** Verified available: Node 26 with `fetch`, `WebSocket` and
`node:sqlite` built in, so the Pushbullet client and the state layer need **zero**
dependencies.

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js ≥22 | `fetch`, global `WebSocket`, `node:sqlite` built in |
| Pushbullet REST/stream | built-in `fetch` + `WebSocket` | no dependency at all |
| HTTP client | built-in `fetch` | — |
| Imaging | `sharp` (libvips) | integral-image work done directly on raw pixels; native, prebuilt for Windows x64 |
| OCR | `tesseract.js` + `@tesseract.js-data/nld` | WASM, offline, bundled traineddata, per-word confidence |
| Model | `openai` SDK against any OpenAI-compatible base URL | swap providers by config |
| State | `node:sqlite` | built in, no dependency |
| Config | `smol-toml` | tiny pure-JS TOML parser |
| Tray | `systray2` + `node-notifier` | no Electron; ~200 MB saved; both declared, both imported lazily (M3) |
| Secrets | Windows DPAPI (`CurrentUser`) via PowerShell; else ACL-restricted JSON file (mode 600) | no native dependency and no key to manage; the round trip is executed on `windows-latest` (#60) |
| Tests | `node:test` + `node:assert` | built in |

**Trade-off accepted:** Node makes Windows packaging more awkward than .NET, mainly around
native modules (`sharp`) and the WASM traineddata. The primary plan is therefore to ship a
folder containing a pinned `node.exe`, `node_modules` and a `wscript` launcher shim that
starts the app without a console window, with Node's SEA single-executable as a stretch goal.

**Rejected:** Electron (hundreds of MB for a tray icon), a Windows Service (cannot show a
tray icon, harder to debug — and the tray form factor was requested).

**Tray dependency, settled in M3.** `systray2` and `node-notifier` are ordinary
`dependencies`, not optional and not left to a manual install. The concern was CI: `systray2`
ships prebuilt `tray_windows_release.exe` / `tray_linux_release` / `tray_darwin_release`
binaries inside the package and has **no install or build script**, so `npm ci` on Ubuntu only
downloads and unpacks it — measured here as a clean exit 0. Declaring them is what lets a
packaging build produce a working payload with `npm ci --omit=dev`. The offline concern is
handled on the import side instead: both are loaded through dynamic `import()` inside
`tray-systray.js` / `notifications.js`, so the test suite and `--headless` never load a native
tray binary, and a missing module produces an actionable `--headless` message rather than a
stack trace.

---

## 7. Reliability

- Retries with backoff on all network calls; manual backoff for the WebSocket.
- **A broken provider never loses an answer and never crashes the worker.** Every model call
  is wrapped: on failure the tier records the error and returns nothing, the opinions that
  remain are still arbitrated, and an offline answer survives untouched (just unconfirmed).
- Strict-majority arbitration means agreement is required to publish; disagreement is a
  reported outcome, not a coin flip.
- Circuit breaker on the model: 3 consecutive failures → Tier 0 only for 10 minutes, notify once.
- **Circuit breaker, as built (M2 leg 3).** One breaker per tier (`text`, `vision`), because a
dead text route must not disable the vision fallback. States are `closed` → `open` →
`half-open`; three consecutive transient failures open it, and `half-open` admits exactly one
probe, so recovery is automatic without a thundering herd. **Permanent** failures — 401/403, a
404 (unknown model, or an `allowed_models` set that matched nothing) and a bad cost tier — open
it on the first occurrence rather than burning the budget on something that will never fix
itself. The clock is injectable, so the 10-minute cooldown is tested by advancing a number
rather than sleeping. Transitions are written to the `attempts` store under the
`circuit-breaker` subject, and a trip notifies **once**; while open, calls are skipped before
the provider is reached, which is what bounds a dead provider to `breaker_threshold` calls per
cooldown instead of one per puzzle.
- Graceful degradation: if the model is unreachable, arithmetic still works, and `count` /
  `ordinal-pick` still work whenever the lexicon covers the vocabulary.
- Watchdog heartbeat; grey tray icon when the listener has gone quiet.
- Disk caps: 5 MB per image, inbox pruned by age and count.
- All timestamps stored as UTC epoch floats, matching Pushbullet's `modified`.

## 8. Security & privacy

- Images leave the machine **only** if a cloud model is used; `solver.offline_only = true`
  restricts everything to Tier 0 + local OCR.
- Secrets in the platform credential store, never logged, `secrets.*` gitignored. On Windows
  that is DPAPI at `CurrentUser` scope (a `credentials.dpapi` blob); elsewhere an
  ACL-restricted per-user JSON file. A legacy plaintext Windows file is migrated on first read
  and removed. `config list` names the store that answered (`windows-dpapi`/`file`), so a
  fallback to the plaintext file is never silent (issues #50, #60).
- Transcripts are logged (needed for debugging); image bytes are not, unless
  `log_images = true` for unresolved puzzles specifically. Separately, `keep_images = true`
  stores a bounded review copy of every solve's image under the app data directory
  (`storage.keep_images`, issue #100).
- The app posts nothing except a validated answer, and only in response to the originating push.

### Threat model (M2 leg 3)

What each artefact gives a reader, and what was done about it:

| Artefact | What it contains | What an attacker learns | Mitigation |
|---|---|---|---|
| **Log file** | operational lines, OCR transcripts, model failure text | the puzzles seen, the answers, and — if redaction failed — keys | every line passes through the single `redactRecord` (`redact` + `redactPushbullet` + `stripImageBytes`); image bytes are stripped |
| **State database** | `attempts` rows (transcripts, model replies, error bodies), `pushes` (file names/URLs), `outbox` (answer hashes, delivery responses), `images` (review-copy metadata) | the puzzle history and what each tier answered | the same `redactRecord` runs inside `store.record` and the outbox writers, so a configured key or a documented shape in an upstream error body cannot persist |
| **Stored images** (only when `keep_images = true`) | bounded WebP review copies of solved images, keyed to the solve row | the puzzles themselves | off by default; a bounded, re-encoded copy rather than the original; pruned by `retain_days` + `max_images`; served only behind the web UI's address/Host/session gate, addressed by row id |
| **Config file** | non-secret settings only | the models, base URL, retention, and whether logging is on | secrets are rejected at load; every credential lives in the environment or the credential store |
| **Credential store** | the Pushbullet token, the model key, the HTTP token and the web UI verifier | the account and the provider balance | Windows: DPAPI `CurrentUser` (`credentials.dpapi`), so a copy of the file on another account or machine is useless; elsewhere a `0600` JSON file. `describeSecret` exposes only `{ present, source, hint }`; the source names the store that answered (`windows-dpapi`/`file`); a world-readable fallback file warns and is tightened to `0600` on the next write; a file that cannot be parsed is reported and never overwritten (issue #46). **Residual: any process running as the user can ask the OS to unprotect the DPAPI blob.** |

**Redaction is enforced, but it is not omniscience (issue #45).** Both sinks call the one
`redactRecord`, so there is no second rule set to drift. It redacts, in order: the exact values
of every secret this process resolved (`registerSecrets`, applied longest-first), values that
follow a credential key name (`Authorization`, `x-api-key`, `api_key=`, `token:`, …), and the
documented value shapes (`sk-`, `gsk_`, `AIza`, `ghp_`/`github_pat_`, `sk_live_`/`pk_live_`,
`xox…`, `AKIA`, `o.`). The `sk-` rule carries a word-boundary lookbehind, so ordinary
hyphenated words are not corrupted. **The residual gap, stated honestly:** a secret that was
never resolved by this process (so it was never registered) and that neither follows a known
key name nor matches a known shape can still pass. Values shorter than eight characters are not
registered by value because replacing them would shred ordinary text; every real credential is
longer. The guarantee is therefore “a configured key cannot reach the log or the store”, not the
older “no key of any kind can”.

**Retention is enforced, not just documented.** On startup the app prunes inbox files and
`attempts` rows older than `storage.retain_days`. `pushes` and `outbox` are deliberately kept:
they are the durable dedupe and duplicate-send guards, and deleting either risks answering a
puzzle twice — a worse outcome than keeping a row that contains no secret and no image. Stored
review copies are pruned on the same window plus a count cap (`storage.max_images`), and an
explicit `images purge` is available; see the image-byte policy below.

**Image-byte policy.** Image bytes are never written to the log or the attempts table; the
sinks strip any inline `data:image/...;base64,...` URL or serialised `Buffer` that reaches them.
There are now **two** ways image data is remembered, and they mean different things:

- `log_images = true` records a **file reference** to the retained inbox image, only for
  puzzles that ended unresolved — a resolved puzzle has no debugging value. It never stores
  bytes.
- `keep_images = true` stores a **bounded, re-encoded copy** (WebP, longest edge 512 px) of
  **every** solve's image, so the recent-solves page can show what was solved. It is off by
  default; the original bytes are not kept, and the copies are pruned by `retain_days` and
  `max_images`. The files live in the app data directory: mode `0700`/`0600` on POSIX, and on
  Windows protected only by the per-user profile ACL — there is no encryption, and the README
  says so rather than implying otherwise.

**`offline_only` is airtight, and treated as structural.** When it is set, no chat client and
no reasoner are constructed at all, so there is no object through which an image or transcript
could leave. The test replaces `fetch` with one that throws and runs the real preprocessing, OCR
and offline solver over a corpus image, asserting zero outbound requests.

**HTTP ingress threat model (v2, #15).** An endpoint that solves CAPTCHAs is an oracle: its
value is the answer, and its cost is paid in provider credits. The controls, in order of
execution:

| Control | What it stops | Where |
|---|---|---|
| Bind `127.0.0.1` by default; loud warning otherwise | reachability from the network | `config.http.bind`, `createHttpServer.start`, `isLoopbackHost` |
| Mandatory `Authorization: Bearer`, compared with `timingSafeEqual` | anonymous use, token guessing | `tokenMatches` |
| Minimum token length and weak-value rejection at startup | a guessable one-character or dictionary token | `httpTokenProblem`, `createApp`, `createHttpServer` (#47) |
| Bounded failed-auth count with doubling backoff per client -> `429` + `Retry-After` | unlimited 401s against a bound endpoint | `createAuthThrottle` (#47) |
| Streaming body cap (default 5 MiB) | memory exhaustion | `readBodyCapped` |
| Shared magic-byte/decode/width/pixel gate | a body that is not a real image, or a tiny file that decodes to a pixel bomb | `validateImageBuffer` |
| Fixed-window rate limit | credit burn from a loop | `createRateLimiter` |
| Bounded queue (`http.max_queue`) -> `503` + `Retry-After` | an unbounded backlog spending credits after the caller has gone | `createHttpServer` admission |
| `image_url` off by default; when on, a host allowlist, and redirects not followed | a token-holder using the server as an SSRF pivot into the server's own network position (#57) | `assertImageUrlAllowed`, `downloadImage({ redirect: 'manual' })` |
| `http.timeout_ms` -> `504`, plus skip-at-dequeue | a stuck solve holding a request open, and a queued solve outliving its caller | `withTimeout`, `createSolveCore` lock |
| `reply.require_confidence` on the body | returning an uncorroborated answer the Pushbullet path would withhold (#42) | `formatSolveResponse` |

The token is resolved through the existing `src/secrets.js` provider interface as a fourth
secret (`HTTP_AUTH_TOKEN` / `http_auth_token`), not a second mechanism. The response never
echoes the image, a key or an upstream error body: image errors are reported by reason tag
(`magic`/`decode`/`height`/`width`/`pixels`/`size`), and an unexpected error is a generic
`500` with a random id while the redacted detail goes to the log.

**Content type is advisory, not a gate (issue #61).** A body that is neither JSON nor
multipart is treated as a raw candidate and handed to the same magic-byte gate, so
`application/octet-stream` (the conventional type for a binary upload) and a missing
`Content-Type` (curl's default `application/x-www-form-urlencoded`) both work. There is no
enumerated list of accepted types to guess: the decision is made on the bytes, a non-image
is still `415` (with the more accurate `reason: "magic"` instead of
`unsupported_media_type`), and the streaming body cap, auth and the pixel/width caps are
unchanged. This matters because uploading is the normal path once `image_url` is off by
default (#57), and the primary path should not have an avoidable trap on it.

**Pixel-bomb caps (issue #41).** The shared gate reads `sharp` metadata and rejects on
`width` or `width*height` before any pixel is decoded (`extractMask` also passes the same
limit to `limitInputPixels`, so a future ingress that skips the gate still cannot decode
one). The caps were chosen by measuring `buildVariants` (all three default variants) on a
compressible white PNG, the cheapest file per pixel:

| decoded input | pixels | `buildVariants` | peak RSS |
|---|---|---|---|
| 1000x1000 (at the cap) | 1.00 Mpx | 2.1 s | 155 MB |
| 1500x1500 | 2.25 Mpx | 4.7 s | 192 MB |
| 2000x2000 | 4.0 Mpx | 9.6 s | 236 MB |
| 3000x3000 | 9.0 Mpx | 17.7 s | 361 MB |
| 6000x6000 (the report) | 36 Mpx | ~70 s | ~873 MB |

The largest real corpus image is 820x90 = 73,800 px, so `max_pixels = 1000000` leaves
~14x headroom and keeps the worst admitted image inside the same few-second envelope as a
normal solve. `max_width = 2000` (~2.4x the widest corpus image) catches the wide-and-short
case the pixel cap alone would allow; a 3000x100 image is 0.3 Mpx but is still a 413.
`sharp`'s own default `limitInputPixels` is ~268 Mpx - above even the reported 36 Mpx case -
so it is raised only as a second layer, never as the defence.

**`image_url` is off by default and host-allowlisted when on (issue #57).** A JSON body may
name `image_url`, which makes the server fetch a caller-supplied URL. Auth is mandatory and the
bind defaults to loopback, which genuinely limits the blast radius - but SSRF's danger is that
the server sits in a different network position from the caller, so a token-holder on the same
host can make it probe services only that host can reach, and a non-loopback bind widens that to
anything the server can route to. Link-local metadata endpoints (`169.254.169.254`) are the
classic target.

The controls, in order of execution:

- `http.allow_image_url` defaults to `false`; a body with `image_url` is refused `403`
  (`image_url_disabled`) and the reason points at uploading the image instead. Uploading is the
  normal path, so the safe default costs most callers nothing.
- When it is on, the URL's host must be named in `http.image_url_hosts` (default deny, exact
  match, case and a trailing dot normalised, port ignored). This is the load-bearing control: the
  operator chooses the *names*, so a name the operator did not choose cannot be reached even if
  its DNS points inward, and `evil.example.com` is not admitted by an entry for `example.com`.
- The shared magic-byte/decode/width/pixel gate and the streaming byte cap still run on the
  fetched bytes - this adds no second image path (#41).
- Redirects are not followed. The HTTP ingress fetches with `redirect: 'manual'` and refuses any
  `3xx` (`403`, `image_url_redirect`); the Pushbullet path keeps `follow`, because a pre-signed S3
  URL is not caller-supplied. A public URL that `302`s to `169.254.169.254` therefore cannot walk
  past the check applied to the first URL.

**Residual, named.** There is no post-resolution private/loopback/link-local range check, and
that is deliberate. `fetch` re-resolves the hostname at connect time, so checking the resolved
address and then fetching by name is a check DNS rebinding walks straight past - it would only
look like protection. Doing it correctly means connecting to the address that was validated (a
custom `Agent`/`lookup`), which is more than this ingress needs once the allowlist is the gate.
The honest statement is: **an allowlisted hostname that resolves to an internal address is
fetched.** The operator's allowlist is the trust boundary; a name only gets on it because the
operator put it there. Keep the list to names you control, and prefer `image_base64`/upload.

## 9. Layout

```
captchasolver/
├─ DESIGN.md                  this document
├─ README.md
├─ package.json
├─ config/prompts/{solve,vision}.txt   editable without a rebuild  ✅
├─ corpus/                    real puzzles + expected.json   ✅
├─ corpus/needs-model/        a puzzle outside the lexicon (exercises the model path)  ✅
├─ corpus/synthetic/          36 generated images, answers known by construction  ✅ M4
├─ corpus/manifest.json       every item labelled real | synthetic | derived  ✅ M4
├─ corpus/recorded/           push/images promoted by record-corpus.js  ✅ M4
├─ scripts/tune-preprocessing.js   parameter sweep            ✅
├─ scripts/generate-corpus.js      render + self-verify the synthetic corpus  ✅ M4
├─ scripts/record-corpus.js        solved/unresolved -> a regression entry  ✅ M4
├─ scripts/accuracy.js             dev entry point for the accuracy report  ✅ M4
├─ src/
│  ├─ cli.js                  command line entry point         ✅
│  ├─ accuracy.js             the one place the metric is computed  ✅ M4
│  ├─ accuracy-cli.js         `accuracy` command implementation  ✅ M4
│  ├─ corpus/{render,build,observed}.js  generator + shared damage list  ✅ M4
│  ├─ imaging/preprocess.js                                   ✅
│  ├─ ocr/recognize.js                                        ✅
│  ├─ model/client.js         OpenAI-compatible chat over fetch  ✅
│  ├─ model/fake.js           scripted client for offline tests   ✅
│  ├─ solver/{lexicon,transcript,numbers,puzzle,validate}.js  ✅
│  ├─ solver/{prompts,reason,pipeline}.js  model tiers + arbitration  ✅
│  ├─ state/db.js             node:sqlite attempts log         ✅
│  ├─ pushbullet/{client,listener,filter,files,respond}.js    ✅
│  ├─ ui/{tray,setup,watchdog,notifications,icons,mode}.js    ✅ M3
│  ├─ ui/{tray-systray,open-path}.js   native/platform seam   ✅ M3 (unverified on Windows)
│  ├─ deploy/{launcher,autostart,install,uninstall}.js        ✅ M3 (executed on Windows in CI, #59)
│  └─ config.js, secrets.js, logging.js                       ✅
├─ tests/                     unit + live-model + real and synthetic corpus end-to-end  ✅
└─ packaging/                 PuzzleSolver.vbs + install/uninstall.ps1  ✅ M3 (executed on Windows in CI, #59)
```

## 10. Testing

**Working now — 760 tests (754 pass, 6 skip), none needing a network or an API key:**

1. **Offline unit (37):** Dutch number words and compounds including diaereses, all four
   operators, precedence, division by zero; transcript normalisation and every repair rule;
   puzzle classification, parsing and offline solving for all three classes; the validator
   gate including the empty-answer trap.
2. **Model client (11):** JSON extraction from bare/fenced/prose replies, request shape,
   retry-on-429 vs immediate failure on 401, falling back when `response_format` is
   unsupported, non-JSON HTTP bodies, key redaction, vision message construction.
3. **Reasoner (19):** strict class holding, the structural list check, the arithmetic
   overrule, majority voting including the lone-survivor and two-way-split cases, sample
   counts and temperatures per class, store recording.
4. **Tier arbitration (12):** end to end through the pipeline with scripted OCR and a scripted
   model — a confident offline answer making zero model calls, model rescue of an unknown
   puzzle, agreement upgrading an uncorroborated answer, disagreement triggering vision, an
   unresolvable three-way split reporting unresolved, a dead provider preserving the offline
   answer, and OCR producing nothing at all.
5. **State and prompts (10)** and **corpus end-to-end (4):** the real images through real
   preprocessing, real Tesseract and the real solver, asserting the final answer
   (`2`, `hoofd`, `7`), the class, the parsed word list, confidence, and a transcript ≥90%
   similar to expected. Runs in ~4 s.

The corpus end-to-end test doubles as the regression guard for the offline tiers, and the
scripted-model tests cover the model tiers — which matters, because **the model tiers have not
been exercised against a real provider** (no API key was available while building them).

6. **Live model smoke test (opt-in, 6 tests):** `tests/live-model.test.js`, skipped unless
   `LLM_API_KEY` is set. Asserts a real text model answers the `needs-model` fixture, that the
   reply honours the JSON contract, that the vision tier reads the preprocessed image when OCR
   yields nothing, that a confident offline answer still costs zero model calls, that the API
   reports the resolved model rather than the routing slug, and that the key never appears in
   recorded call data. **Run live: 6/6 pass.**
7. **Live accuracy evaluation:** `scripts/live-eval.js` measures what the pipeline achieves on
   the *real* corpus images rather than the clean synthetic fixture.

   | Tier | Result |
   |---|---|
   | Offline (Tier 0) | **3/3**, with zero model calls |
   | Text tier, on transcripts carrying real observed OCR errors | **3/3** |
   | Vision tier, OCR suppressed entirely (reads the real noisy 44px puzzle) | **3/3** |

**M2 leg 3 hardening tests (offline, credential-free).** `tests/breaker.test.js` exercises
the circuit breaker with an injected clock (trip, cooldown, one probe, recovery) and asserts
through the real reasoner that a dead provider costs at most N calls per cooldown and that a
tripped breaker still lets Tier 0 answer. `tests/security.test.js` proves `offline_only`
makes zero outbound requests with a throwing `fetch`, that retention runs on startup, that
image bytes never reach the log or the attempts table, and that a key in an upstream error
body cannot be stored. `tests/tracked.test.js` fails if any `src/` or `tests/` file on disk
is not tracked by git — the `secrets.*`-hid-`src/secrets.js` trap can no longer come back.

**M3 tests (offline, credential-free).** `tests/watchdog.test.js` drives the quiet rule with an
injected clock, including the exact boundary. `tests/tray.test.js` exercises every menu action
against a fake listener. `tests/tray-systray.test.js` asserts the actionable `--headless` failure
with an injected loader and the click forwarding with a fake `SysTray`. `tests/deploy.test.js`
asserts the launcher text, the task XML (20 s delay, restart-on-failure, quoted paths), the
`schtasks` arguments and the PowerShell content, plus the install/uninstall runners against
injected fs/spawn. `tests/setup.test.js` covers validation, the connection probes and the real
credential-file round-trip at mode 0600. The whole suite runs on Linux with no tray, no display
and no key; what a Windows build would do is listed as unverified in §11.

**M4 corpus and accuracy (offline, credential-free).** `corpus/manifest.json` labels every
item with its provenance, and `src/accuracy.js` is the one place the number is computed:

- **Provenance is never blended.** Every report groups `real` | `synthetic` | `derived` and
  `image` | `text`. The overall percentage is only ever printed next to its breakdown.
- `validRate` = validator-accepted answers / puzzles seen, which works without ground truth.
  `sentableRate` = validator-accepted **and corroborated** answers / seen, which is what the
  default responder (`require_confidence = true`) would actually send; the difference is
  `withheld`. The tray's traffic headline is the sent-able figure, not `validRate`, because the
  old headline counted answers that `require_confidence` never sent (#49). `accuracy` = correct /
  gradeable, which needs known answers and is null on real traffic. A recorded unresolved puzzle
  (expected null) counts in `seen`/`validRate` but not in `accuracy`, so a failure cannot vanish
  from the denominator.
- **`failures` means graded failures only.** A report row is a failure when it has known ground
  truth and did not match it. Recorded traffic has no ground truth, so listing `!correct` rows as
  failures put every solved traffic puzzle under "failures"; an ungraded puzzle that produced no
  answer is reported under `unresolved` instead (#49).
- `npm run accuracy` runs the committed corpus (deterministic, ~30 s through real OCR) plus the
  recorded `attempts` store. The corpus report is cached to `accuracy.json` beside the state
  database, which the tray reads; the tray's live number comes straight from the store.
- The corpus is generated by `scripts/generate-corpus.js`, which **solves every synthetic image
  through the real pipeline before writing it** — a fixture the pipeline cannot read would
  silently depress the metric and look like a pipeline bug. `npm run corpus:verify` re-checks
  the committed images.
- `scripts/record-corpus.js` promotes a solved or unresolved puzzle into `corpus/recorded/`.
  A pipeline-derived expected answer is labelled `expectedSource: "pipeline"` because using the
  pipeline's own output as ground truth is circular.

**Planned:**

7. **Fake Pushbullet:** built as `tests/fake-pushbullet.js` (a local HTTP + WebSocket stub).

## 11. Windows packaging & deployment

1. Ship a folder: pinned `node.exe`, `node_modules`, `app/`, and `PuzzleSolver.vbs` (a
   `wscript` shim that launches `node src/cli.js` hidden — no console window flashes).
2. Install to `%LOCALAPPDATA%\Programs\PuzzleSolver\` — no admin rights needed.
3. **Autostart:** a Task Scheduler task at logon with a 20 s delay and "restart on failure",
   preferred over the `Run` registry key because it survives a crash loop and uninstalls cleanly.
4. First run: setup dialog → secrets stored → tray icon appears.
5. Stretch goal: Node SEA single executable. Native `sharp` and the WASM traineddata make
   this fiddly, which is why it is not the primary plan.

**As built in M3.** The task is generated as **XML**, not from `schtasks` switches, because
`schtasks` has no command-line switch for restart-on-failure — it exists only in the XML schema.
`src/deploy/autostart.js` builds the XML (logon trigger with `<Delay>PT20S</Delay>`,
`<RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>`,
`<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`, `<ExecutionTimeLimit>PT0S</…>`)
and the `schtasks /Create|/Delete` argument lists; `src/deploy/launcher.js` builds the `wscript`
shim. Both are asserted as literal text, with a path that contains spaces. The shim is
location-independent (everything derives from `WScript.ScriptFullName`), which is why the
checked-in `packaging/PuzzleSolver.vbs` can be asserted byte-for-byte against the generator.

**Requested restarts are explicit, never `RestartOnFailure` (issue #128).** The task's
`<RestartOnFailure>` fires on a **non-zero** exit after `PT1M`, so it is crash recovery with a
delay and a retry count, not a restart API. A deliberate restart (`src/deploy/restart.js`)
quiesces the ingresses, drains the in-flight solve on the shared core lock, calls `app.stop()` so
the HTTP port and the SQLite file are released *before* the successor starts, launches exactly one
successor through the `wscript` shim (`wscript.exe "<PuzzleSolver.vbs>"`, which keeps the console
hidden) and exits **0** — so the scheduler never sees a failure and never starts a second process.
The launcher exports its own path as `PUZZLESOLVER_LAUNCHER`; when neither that marker nor a shim
beside the bundled `node.exe` exists (a shell run, a dev checkout, `config edit`), the app prints
the exact command instead of pretending. `process.execPath` re-exec was rejected: it loses the
hidden window and replays an argv that is not necessarily the task's configured mode. `schtasks
/End` + `/Run` was rejected: `/End` hard-terminates the running instance and cannot run the
graceful drain. `RestartOnFailure` is never used intentionally. The decision is a pure function
(`planRestart`) with injected `fileExists`/`spawn`, asserted offline in `tests/restart.test.js`,
including that a restart exits `0` and that an in-flight solve delays the release. The settings
done page offers `Restart now` (responding to the browser before the process goes down) and the
tray has a **Restart** item; both route through the same `createShutdownHandler`.

Install layout: `packaging/install.ps1` locates `%LOCALAPPDATA%\Programs\PuzzleSolver`, copies
the payload, then hands off to `app/src/deploy/install.js` (run by the bundled `node.exe`) to
write the shim + XML and call `schtasks`. `packaging/uninstall.ps1` delegates the task deletion
the same way, then removes the three per-user folders. All path and task decisions live in the
Node modules; the PowerShell is locator/launcher glue.

**Unverifiable on the Linux development host:** `wscript` execution, `schtasks` registration and
restart-on-failure behaviour, the `_ps1` scripts end to end, Explorer opening a log, and the
actual tray widget. Every one of those has a testable seam (content, arguments or an injected
loader) which is asserted. Since issue #59 the installer, task registration and inspection, the
`--headless` start, the `wscript` launcher and uninstall are also executed on `windows-latest`,
and since #60 the real DPAPI round trip is (`packaging/run-dpapi.ps1`), run as two processes so the
read must decrypt from disk and the job asserts `Unprotect` ran (#83); what remains native-only
is the interactive-desktop behaviour (tray, toast, Explorer hand-off).

**CI packaging and release (issue #19).** `.github/workflows/package.yml` builds and publishes the
Windows package; `ci.yml` gained `workflow_call` and is the gate, so the Node matrix still has one
home. Decided here, additively:

- **The packaging job runs on `windows-latest`.** `sharp` is native; a `node_modules` installed on
  Ubuntu contains Linux binaries and cannot load on Windows. Cross-installing with
  `--os=win32 --cpu=x64` is fragile, so the payload is built on the platform it ships to — exactly
  the constraint issue #19 names.
- **The bundled runtime is pinned to Node 22.13.0**, the floor the test matrix and `engines`
  already exercise. `packaging/build-payload.mjs` downloads the bare `win-x64/node.exe` from
  nodejs.org rather than using the runner's Node.
- **The payload is assembled, zipped, then smoke-tested after extraction.**
  `packaging/run-smoke.ps1` unzips into a temp directory and runs the artifact's own `node.exe`
  against the offline corpus from outside the repository; `packaging/smoke-test.mjs` asserts the
  three known answers (`2`, `hoofd`, `7`). A failure stops the job before the release job runs, so
  a broken tree publishes nothing. This is the check that a build inside the repo habitually skips:
  native binaries that did not travel, a bundled Node not running the bundled code, traineddata
  missing from the zip, and cwd assumptions that only hold in the repo.
- **A tag must agree with `package.json`.** `packaging/check-version.mjs` refuses a `v*` tag whose
  version differs, before any Windows-only work; a non-tag ref has no version and is skipped.
- **The checksum is verified, not merely written.** `packaging/checksum.mjs` emits a
  sha256sum-compatible sidecar and re-hashes the file after writing; `--verify` fails if the
  artifact and sidecar drift.
- **No third-party release action.** The Release is created with the runner's preinstalled `gh` and
  the default token, so there is nothing extra to pin; `contents: write` is set on the release job
  only, and the rest of the workflow is `contents: read`.
- **Pre-1.0 tags (`v0.*`) are published as GitHub pre-releases**, so the first build is not offered
  as the project's "latest".
- **`main`/PR runs upload a workflow artifact but never publish.** Only a `v*` tag creates a
  Release; workflow artifacts expire after 14 days, release assets do not.
- **No credentials can travel.** The payload is copied from an explicit allowlist (`src/`,
  `package.json`, the three packaging scripts) plus `npm ci --omit=dev`; `config/`, `.env` and
  credential files are not on the list and `build-payload.mjs` asserts they are absent.

**The deployment glue is executed (issue #59).** A `deploy` job in `package.yml` downloads the
artifact the `package` job built, extracts it into a temp tree with `%LOCALAPPDATA%`/`%APPDATA%`
redirected there, and runs `packaging/run-deploy.ps1`. It executes `install.ps1`; queries the
registered task with `schtasks /Query /XML` and asserts the logon trigger (`PT20S`) and
restart-on-failure (`PT1M`/`3`); starts the packaged `node.exe` under `--headless` and asserts the
documented exit-1 refusal rather than a stack trace; runs `PuzzleSolver.vbs` and asserts a
`node.exe` process appears; then runs `uninstall.ps1` and asserts the task and all three per-user
folders are gone. The `release` job now needs it too, so a broken installer blocks a release. It is
bounded at 15 minutes and runs on the same triggers as `package` because it costs a fraction of the
Windows build it reuses, and an installer regression belongs on the PR that introduces it.

What an interactive desktop would be needed for is still unverified: the native `systray2` tray
widget and the `node-notifier` toast need a window station, and the `explorer.exe` browser hand-off
(#56) is likewise unexercised. Restart-on-failure is inspected as a task *property*; a crash loop
has not been observed restarting it. The DPAPI credential round trip, by contrast, *is* executed
on the runner as two processes: the writer migrates and saves, the reader decrypts from disk and
asserts `Unprotect` was called (see [§8](#8-security--privacy)); what it cannot cover is a process
running as the same user.

**Unverifiable on the Linux development host:** `Compress-Archive`/`Expand-Archive`, running the
bundled `node.exe`, and the release job's `gh` call. The decisions with a judgement in them (the
version guard, the checksum round-trip, the payload manifest) are asserted by
`tests/packaging.test.js`; the PowerShell and the publish path are exercised only by an actual
workflow run.

## 12. Extension points (v2+)

Deferred deliberately. Each is tracked as an issue under the
[v2 milestone](https://github.com/osxy/ocr-solver/milestone/6); none is scheduled, because each
needs a design decision before it becomes work.

- **HTTP ingress** — [issue #15](https://github.com/osxy/ocr-solver/issues/15): **✅ built (v2).** See
  [§4.15](#415-http-ingress--srchttpserverjs--v2-15). It provides a genuine end-to-end path with no
  Pushbullet account and established the ingress seam (`src/solver/core.js`) that grids (#9) and
  Playwright (#12) will reuse. Security, as designed: loopback by default, mandatory bearer token,
  shared image gate, rate limit, synchronous timeout.
- **Image-grid CAPTCHAs** ("select all bicycles") — [issue #9](https://github.com/osxy/ocr-solver/issues/9):
  grid splitter, vision model with grounding output (`[[0,2,5]]`), and a click/applier backend.
  A different responder entirely — do not fold into v1.
- **Phone-side reply** — [issue #10](https://github.com/osxy/ocr-solver/issues/10): if a real
  threaded reply is ever needed, a `Tasker`/`Join` flow on the phone can read our note push and
  inject the answer into the originating app. More robust than any desktop automation, and it
  works where the API has no reply endpoint.
- **Local model** — [issue #11](https://github.com/osxy/ocr-solver/issues/11): route the text tier
  to Ollama/vLLM for fully offline operation, including the puzzle classes the lexicon does not
  cover.
- **Playwright applier** — [issue #12](https://github.com/osxy/ocr-solver/issues/12): type the
  answer into the page instead of replying, if the puzzle always appears in a browser.
- **Bigger lexicon** — folded into [M4 / issue #5](https://github.com/osxy/ocr-solver/issues/5):
  every category added converts another `unknown` puzzle into a free, offline, deterministic
  Tier 0 solve.

## 13. Decisions

| # | Decision | Choice |
|---|---|---|
| Q1 | Solver engine | **Hybrid** — Tesseract `nld` + lexicon/arithmetic offline, escalating to a text model, then a vision model |
| Q2 | Puzzle classes | The three observed: `count`, `ordinal-pick`, arithmetic |
| Q3 | Form factor | **Both** — tray app with `--headless` mode |
| Q4 | Runtime | **Node.js ≥22** + `sharp` + `tesseract.js`, tray via `systray2` |
| Q5 | How the image arrives | A **file push from another user or device** |
| Q6 | How the answer goes back | A **new note push** (`POST /v2/pushes`), since no reply endpoint exists for non-SMS pushes |

Decisions taken during M1:

| # | Decision | Choice |
|---|---|---|
| M1-1 | Model client | Plain `fetch` against any OpenAI-compatible endpoint, not the vendor SDK |
| M1-7 | Auto routing | **Text tier** auto-routed; **vision tier** an explicitly chosen model, optionally with a fallback chain (§4.7) |
| M1-2 | Arbitration | Tier 0, text and vision are **opinions** needing a strict majority; a tie reports unresolved |
| M1-3 | Class authority | When the offline parser knows the shape, the model is held to it; `unknown` is not a fallback |
| M1-4 | Arithmetic | The offline calculator overrules the model on disagreement |
| M1-5 | Sample policy | 1 sample for `count`/`arithmetic`, 3 for `ordinal-pick`/`unknown`, max 2 for vision |
| M1-6 | Confidence units | Model self-reports are 0–1 in code, stored on the same 0–100 scale as OCR |

Decisions taken during M4:

| # | Decision | Choice |
|---|---|---|
| M4-1 | Corpus provenance | Every item is labelled `real` \| `synthetic` \| `derived`; reports group by it and never blend it. Synthetic data must not statistically swamp the three real images. |
| M4-2 | Synthetic rendering | Committed PNGs generated by `scripts/generate-corpus.js`, not rendered at test time. Font rendering is the one non-hermetic input; the committed bytes are what tests consume. |
| M4-3 | Corpus self-verification | The generator solves every synthetic image through the real pipeline before writing it, and `npm run corpus:verify` re-checks the committed set. A fixture the pipeline cannot read would look like a pipeline bug. |
| M4-4 | Metric definitions | `validRate` = accepted answers / seen (works without ground truth); `accuracy` = correct / gradeable (needs known answers). Pending recorded failures count in the denominator of `validRate` only. |
| M4-5 | Checked-in corpus | Text fixtures and 36 synthetic images are committed (~0.9 MB total), so `npm test` stays offline, deterministic and credential-free. The full OCR accuracy run is `npm run accuracy`, not the default suite. |
| M4-6 | Trays vs. corpus | The tray never re-runs OCR: it reads the cached corpus report plus a live store query. The packaged app ships `src/` but not `corpus/` or `scripts/`, so with no corpus it degrades to the recorded-traffic number. |

Decisions taken for the v2 HTTP ingress (#15):

| # | Decision | Choice |
|---|---|---|
| v2-1 | Solve model | **Synchronous** with `http.timeout_ms` (default 30 s, including queue wait); a breach is a `504`, and a task not yet started is skipped at dequeue |
| v2-2 | Process model | Two ingresses (Pushbullet + HTTP), one `createSolveCore`; either can be absent |
| v2-3 | Path versioning | **`/v1/solve`** from the start |
| v2-4 | Pushbullet egress from HTTP | **Opt-in** via `"deliver":"pushbullet"`, using the existing responder and a synthetic iden |
| v2-5 | Auth | **Mandatory** bearer token via the `secrets.js` provider, constant-time compared |
| v2-6 | Bind | **`127.0.0.1`** default; any other bind logs a loud warning |
| v2-7 | Image gate | **Shared** `validateImageBuffer`, not a second copy |
| v2-8 | Concurrency | **One shared solve lock inside `createSolveCore`** (#44); HTTP adds a per-ingress admission bound, not a second queue |
| v2-9 | Confidence policy | **`reply.require_confidence` applies to HTTP** (#42): uncorroborated answers are a `422` with `reason: "unconfirmed"` |

## 14. Milestones

Design intent below; **live status lives in the
[milestone tracker](https://github.com/osxy/ocr-solver/milestones)**. M0 and M1 are closed as
delivered, so this table is now historical for those two.

| M | Deliverable | Status |
|---|---|---|
| **M0** | Offline core: preprocess + OCR + repair + lexicon/Tier 0 + validator + CLI | **✅ done** — [milestone](https://github.com/osxy/ocr-solver/milestone/1) · [issue #1](https://github.com/osxy/ocr-solver/issues/1) |
| **M1** | Model reasoner: text tier, vision escalation, self-consistency, `attempts` logging | **✅ done** — [milestone](https://github.com/osxy/ocr-solver/milestone/2) · [issue #2](https://github.com/osxy/ocr-solver/issues/2) |
| **M2** | Pushbullet listener, fetcher, sqlite state, note-push responder, config + secrets | [milestone](https://github.com/osxy/ocr-solver/milestone/3) · [#3](https://github.com/osxy/ocr-solver/issues/3) listener/responder · [#6](https://github.com/osxy/ocr-solver/issues/6) test infra · [#7](https://github.com/osxy/ocr-solver/issues/7) circuit breaker · [#8](https://github.com/osxy/ocr-solver/issues/8) security pass |
| **M3** | Windows packaging: tray, headless mode, autostart, rotating logs | [milestone](https://github.com/osxy/ocr-solver/milestone/4) · [#4](https://github.com/osxy/ocr-solver/issues/4) |
| **M4** | Corpus growth + accuracy reporting | [milestone](https://github.com/osxy/ocr-solver/milestone/5) · [#5](https://github.com/osxy/ocr-solver/issues/5) |
| **v2** | Deferred extension points (§12), each needing a design decision first | [milestone](https://github.com/osxy/ocr-solver/milestone/6) · [#9](https://github.com/osxy/ocr-solver/issues/9) grids · [#10](https://github.com/osxy/ocr-solver/issues/10) phone delivery · [#11](https://github.com/osxy/ocr-solver/issues/11) local model · [#12](https://github.com/osxy/ocr-solver/issues/12) Playwright |

### M0 results

```
001-count-kleuren.png
  ocr  adaptive_25_020      psm6   83%  Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?
  cand count         tier0=2 valid=true
  =>   answer "2" via tier0:count

002-ordinal-lichaamsdeel.png
  ocr  adaptive_25_020      psm6   95%  In de lijst lijst hoofd buik citroen borst olifant paard wat is de/het eerste lichaamsdeel?
  cand ordinal-pick  tier0=hoofd valid=true
  =>   answer "hoofd" via tier0:ordinal-pick

003-arithmetic-acht-min-een.png
  ocr  adaptive_25_020      psm6   82%  Wat is acht min een?
  cand arithmetic    tier0=7 valid=true
  =>   answer "7" via tier0:arithmetic

solved 3/3 offline
```

All three are answered with **no network access, no Pushbullet token, no API key** — the
lexicon supplies the semantics, so a model is needed only for puzzle shapes it does not cover.

### M1 results

A puzzle outside the lexicon's categories, run through the real pipeline with a scripted model
reply (`--fake-answer`, so no key is needed):

```
$ node src/cli.js corpus/needs-model/004-unknown-hoofdstad.png        # offline only
  ocr  adaptive_25_020      psm6   95%  Wat Is de hoofdstad van Nederland?
  cand unknown       tier0=- valid=n/a
  =>   unresolved: no tier produced a valid answer

$ node src/cli.js corpus/needs-model/004-unknown-hoofdstad.png --fake-answer Amsterdam
  ocr  adaptive_25_020      psm6   95%  Wat Is de hoofdstad van Nederland?
  cand unknown       tier0=- valid=n/a
  model:text  answer="Amsterdam" agreement=3/3
  =>   answer "Amsterdam" via model:text (1/1 agree)
```

The offline tiers correctly refuse, the model tier is consulted, and its answer passes the
same validator as an offline one. `--store`/`--attempts` then shows all 14 recorded attempts:
6 OCR variants, 3 raw model replies, 3 per-sample verdicts, the tier summary and the final
validation.

**Live verification (done).** Once a provider key was available, all three tiers were measured
against the real corpus: offline **3/3** (zero model calls), text tier on real OCR damage
**3/3**, vision tier reading the raw noisy image with OCR suppressed **3/3**.

### What live testing actually found

Two genuine bugs, neither of which any offline test could have caught:

**1. The completion budget was sized for the answer, not the narration.** `max_tokens: 300`
looked generous for a ~20-token answer. Live, a routed reasoning model spent all 300 tokens
narrating as ordinary `content` (*"We need answer JSON only. Need solve…"*) and was cut off
with `finish_reason: "length"` **before ever emitting the JSON** — while its reasoning was
correct throughout. `reasoning_tokens` was 0, so this was not hidden thinking; the model simply
talks. Consequences and fixes:

- Default raised to 1500 tokens. Text-on-damaged went **1/3 → 3/3** and vision **2/3 → 3/3**
  from this single change: the vision failure had the same root cause.
- A truncated reply now triggers one retry at 3× the budget, instead of being treated as a
  malformed reply and escalated. There is a regression test per behaviour.
- `finishReason`, `truncated` and `completionTokens` are recorded per sample, and a truncated
  rejection says so specifically. Before this, a cut-off reply was indistinguishable from a
  model that had simply answered badly — which is exactly why the first live run looked like
  a prompt problem rather than a budget problem.

**2. A model declining to answer was postable.** Asked to solve from an unusable transcript, a
model replied `onbekend` (Dutch for "unknown"). The `unknown` class validator only checked
length and single-line shape, so *"onbekend"* passed and would have been sent as the answer.
A refusal list now rejects these for every class.

**Also observed:** auto routing picked a reasoning model for a strict-JSON task, which is what
exposed bug 1. The router's task classification has no knowledge of an application's output
contract, so budget and JSON-shape handling must be robust across whatever it picks — which is
now what the retry and `extractJson` fallbacks provide.

**Plumbing pre-flight.** Pointing the client at the real endpoint with a deliberately invalid
key confirmed the wiring without spending anything: the 401 was surfaced, recorded per sample as
a failure, and the pipeline degraded to `unresolved` instead of crashing or losing state. The
dummy key appeared in none of stdout, stderr or the attempts database. Note OpenRouter answers
a malformed key with *"Missing Authentication header"*, which reads like a client bug; verified
against `curl` that it is their generic message, not a dropped header.

### Secrets handling

Keys are read from the environment only and never written to disk by the app. The
tracked template `config/llm.env.example` holds no secrets, and `.gitignore` excludes
`*.env` and `llm.env`. For live testing the key file lives outside the repository
(`~/.config/puzzlesolver/env`, mode 600) and is sourced for a single command, so it
reaches neither the project directory, shell history, nor a session transcript. The
`redactRecord` helper guarantees that a *configured* key cannot reach a log line or the
attempts table, including inside an upstream error body: every secret this process resolves is
registered by value, and the documented key shapes are matched by pattern as a second layer.
The residual gap is stated in §8.

### M4 results (corpus growth and accuracy)

**What was built.** A provenance-labelled corpus, a single accuracy module, an on-demand CLI
report, a tray status item, and `scripts/record-corpus.js`. The corpus is deliberately split by
provenance because the question "what did you actually measure?" has a different answer for
each part.

| Corpus | Items | What it measures | Accuracy |
|---|---|---|---|
| `real` images | 3 | the real generator, through real OCR | **3/3 (100%)** |
| `synthetic` images | 36 | the pipeline against *our* noise model | **36/36 (100%)** |
| `synthetic` text | 245 | lexicon, parser and repair (broad vocabulary) | **245/245 (100%)** |
| `derived` text | 3 | the repair layer on real observed OCR errors | **3/3 (100%)** |
| **total** | **287** | | **287/287 (100.0%)**, confident 286/287 (99.7%) |

One failure therefore moves the overall metric by `1/287 = 0.35%`, under the 1% acceptance
criterion. By class: count 102/102, ordinal-pick 92/92, arithmetic 93/93. By kind: images
39/39, text 248/248.

**The limitation, stated plainly.** The synthetic corpus reproduces the *measured visual
properties* of the real artwork (44 px tall, coloured text on dense per-pixel noise that dies in
the component filter) and nothing else. It does **not** model the real generator's font, palette
or noise distribution, and no synthetic image has ever been compared against a real one by the
generator's author. Accuracy on it is a regression guard for the pipeline, not real-world
accuracy; the only real-world evidence remains the three `real` images. The report groups by
provenance for exactly this reason and never prints a blended headline without it.

**Lexicon growth, measured rather than asserted.** Four categories were added -- `kleding`,
`meubel`, `beroep`, `vervoer` -- plus singular/plural aliases. Against the same committed corpus,
with the previous lexicon:

| Corpus | Before | After |
|---|---|---|
| full (287) | 203/287 correct (70.7%), 208/287 valid (72.5%) | **287/287 (100%)** |
| text only (248) | 178/248 correct (71.8%), 182/248 valid (73.4%) | **248/248 (100%)** |

79 of the 287 items sit in the new categories (66 text, 13 image); the rest of the movement is
items the old lexicon parsed into the wrong class and answered incorrectly.

**The metric moves -- deliberately broken, then restored.** These were run against the text-only
corpus (the full set is the same arithmetic) to show the number is not decoration:

- baseline: **248/248 (100%)**;
- one fixture's expected answer set to a wrong value: **247/248 correct (99.6%)**, validator rate
  still 248/248 -- the metric distinguishes "answered" from "correct";
- the `j -> i` OCR-repair confusion removed from `transcript.js`: **245/248 correct (98.8%),
  245/248 valid (98.8%)**, and the `derived` group fell to 2/3 -- the metric moves when the
  *pipeline* is broken, not only when the fixture is;
- restored: **248/248 (100%)**.

**Two reporting sources.** `npm run accuracy` computes the offline corpus and reads the recorded
`attempts` store. The store has no ground truth, so it reports `validRate` and leaves `accuracy`
null; the corpus is the only place correctness is known. The same module backs the tray's
"Accuracy" action and its tooltip, so the number is visible without reading a log. The corpus
report is cached to `accuracy.json` beside the state database; the tray re-reads it every poll
and never re-runs OCR.

**Model drift (optional, unchanged).** `scripts/live-eval.js` still measures the text and vision
tiers against the real images and real observed OCR damage; it needs a key and is never part of
`npm test`. Its `OBSERVED_OCR_DAMAGE` now lives in `src/corpus/observed.js` so the derived
fixtures and the live evaluation cannot drift apart. Re-running it and comparing the per-tier
counts is the drift check; the reference result remains offline 3/3, text-on-damage 3/3,
vision 3/3 (DESIGN 10). **Re-run for M4:** offline 3/3, text-on-damage 3/3, vision 3/3, 6 model
calls and 0 failures (the router picked `deepseek-v4.1-flash` and `gemini-3.7/3.8-flash`), so the
rolling aliases still answer the three real puzzles correctly on this date.
