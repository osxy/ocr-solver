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
- `redact` keeps only a three-character key prefix, so log lines never carry a usable key.

`src/model/fake.js` provides a scripted client. This is what makes the entire reasoning path
testable without a provider key: self-consistency, the escalation ladder and the validator
gate are all exercised deterministically offline.

**OpenRouter auto routing** is supported for the **text tier only** (`openrouter/auto`,
`cost_tier: low` or `medium`). Reading a transcript and emitting JSON is easy work, so
letting the router pick per request is sensible and cheap.

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
- **Never send an unvalidated answer.** Unresolved puzzles notify locally and stay silent on
  Pushbullet.
- **`require_confidence` (default true)** suppresses answers that passed validation but were
  never corroborated, e.g. an offline count whose word list contained an unreadable entry.
  Setting it false trades accuracy for coverage.
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
require_confidence = true        # only send answers every tier agreed on
min_interval_sec = 3
max_per_hour = 20

[storage]
retain_days = 7
log_images = false               # opt-in: a file reference for UNRESOLVED puzzles only

[ui]
tray = true
notify_on_unresolved = true
```

**Secrets are never written to `config.toml`.** The Pushbullet token and LLM key go to the
Windows Credential Manager through a napi binding, with an ACL-restricted file as fallback,
and environment variables (`PUSHBULLET_TOKEN`, `LLM_API_KEY`) for development on Linux. The
logger redacts anything matching `o\.[A-Za-z0-9]{20,}`.

**Runtime resolution, settled in M2 leg 2.** Two points the schema above left implicit are now
fixed by the implementation and its tests:

- **`solver.self_consistency_n` scopes to the voting classes only** (`ordinal-pick`, `unknown`).
  `count` and `arithmetic` stay at one sample, because M1-5 records them as deterministic and
  sampling `9 - 4` would add cost for no information. The default of 3 is therefore exactly the
  M1-5 default for the voting classes, not a new policy.
- **The credential store is a provider interface**, not one hardcoded mechanism. The Windows
  Credential Manager provider is loaded lazily and is **unverified** (this project is developed
  on Linux); the cross-platform fallback is an ACL-restricted JSON file at
  `%APPDATA%\PuzzleSolver\credentials.json` or `${XDG_CONFIG_HOME:-~/.config}/puzzlesolver/credentials.json`.
  A group/world-readable file still resolves but reports a warning. Resolution order is
  explicit option → environment → provider → `null`, and `describeSecret()` exposes only
  `{ present, source, hint }`.

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
- Menu: **Status / Pause / Solve last image / Open log / Open config / Quit**. "Solve last
  image" re-runs the pipeline on the newest image — essential for tuning without a live push.
- First run: a small setup dialog (token, key, **Test connection**).
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
Credential-Manager providers. There is no second credential file. The Windows dialog itself is
not built here; its logic is, and that is what is tested.

**Watchdog.** `src/ui/watchdog.js` is a pure, clock-injectable state machine. The listener now
exposes `lastActivityAt` (advanced by a socket `open`, any stream message, or a completed poll)
and the tray feeds it in on a timer; ten minutes without evidence flips the icon to grey. The
signal is contact, not a puzzle, so a quiet week does not look like death.

**As built in M2 leg 2.** The rotating logger already exists; the tray/notifications/setup dialog
remain M3. On non-Windows platforms the log lives at
`${XDG_STATE_HOME:-~/.local/state}/puzzlesolver/logs/app.log` (same 5 MB × 3 rotation). Every
record passes through both existing redactors (`redact` and `redactPushbullet`) rather than a
third copy, and a file sink that fails disables itself instead of throwing, matching the attempts
store's rule that logging must never break solving.

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
        └── no  ──▶ unresolved: nothing is sent
        │
   outbox insert (idempotent) → note push → notify ✔ → status=solved
```

**Why opinions instead of a fallback ladder.** A *non-confident* Tier 0 answer — one whose
word list contains unrecognised tokens — is precisely the case most likely to be a miscount.
Under a plain ladder it would have been returned unverified simply because it existed. Making
Tier 0 just another opinion means it can be confirmed, outvoted (`hoofd` from tier0 + vision
beats a hallucinated text answer), or deadlocked — and a deadlock reports **unresolved**
rather than guessing. A one-against-one split deliberately sends nothing.

**Measured latency:** ~0.3–1.4 s per image offline, including OCR and worker startup
(see the corpus test timings). A text-tier sample adds roughly 1–3 s and a vision sample
rather more, so a fully escalated puzzle lands well inside the 10 s budget — and the common
case, where the lexicon already knows the answer, pays nothing at all.

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
| Secrets | Windows Credential Manager via napi binding | native protection; env fallback for dev |
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
- Secrets in the Windows Credential Manager, never logged, `secrets.*` gitignored.
- Transcripts are logged (needed for debugging); image bytes are not, unless
  `log_images = true` for unresolved puzzles specifically.
- The app posts nothing except a validated answer, and only in response to the originating push.

### Threat model (M2 leg 3)

What each artefact gives a reader, and what was done about it:

| Artefact | What it contains | What an attacker learns | Mitigation |
|---|---|---|---|
| **Log file** | operational lines, OCR transcripts, model failure text | the puzzles seen, the answers, and — if redaction failed — keys | every line passes through the single `redactRecord` (`redact` + `redactPushbullet` + `stripImageBytes`); image bytes are stripped |
| **State database** | `attempts` rows (transcripts, model replies, error bodies), `pushes` (file names/URLs), `outbox` (answer hashes, delivery responses) | the puzzle history and what each tier answered | the same `redactRecord` runs inside `store.record` and the outbox writers, so a key in an upstream error body cannot persist |
| **Config file** | non-secret settings only | the models, base URL, retention, and whether logging is on | secrets are rejected at load; every credential lives in the environment or the credential store |
| **Credential store** | the Pushbullet token and the LLM key | the account, if the file is not `0600` | `describeSecret` exposes only `{ present, source, hint }`; a world-readable fallback file warns |

**Retention is enforced, not just documented.** On startup the app prunes inbox files and
`attempts` rows older than `storage.retain_days`. `pushes` and `outbox` are deliberately kept:
they are the durable dedupe and duplicate-send guards, and deleting either risks answering a
puzzle twice — a worse outcome than keeping a row that contains no secret and no image.

**Image-byte policy.** Image bytes are never written to the log or the attempts table; the
sinks strip any inline `data:image/...;base64,...` URL or serialised `Buffer` that reaches them.
`log_images = true` is the only way image data is remembered, and it records just a file
reference, only for puzzles that ended unresolved — a resolved puzzle has no debugging value.

**`offline_only` is airtight, and treated as structural.** When it is set, no chat client and
no reasoner are constructed at all, so there is no object through which an image or transcript
could leave. The test replaces `fetch` with one that throws and runs the real preprocessing, OCR
and offline solver over a corpus image, asserting zero outbound requests.

## 9. Layout

```
captchasolver/
├─ DESIGN.md                  this document
├─ README.md
├─ package.json
├─ config/prompts/{solve,vision}.txt   editable without a rebuild  ✅
├─ corpus/                    sample puzzles + expected.json   ✅
├─ corpus/needs-model/        a puzzle outside the lexicon (exercises the model path)  ✅
├─ scripts/tune-preprocessing.js   parameter sweep            ✅
├─ src/
│  ├─ cli.js                  command line entry point         ✅
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
│  ├─ deploy/{launcher,autostart,install,uninstall}.js        ✅ M3 (install/uninstall unverified)
│  └─ config.js, secrets.js, logging.js                       ✅
├─ tests/                     23 unit files + live-model + corpus end-to-end  ✅
└─ packaging/                 PuzzleSolver.vbs + install/uninstall.ps1  ✅ M3 (unverified)
```

## 10. Testing

**Working now — 312 tests (306 pass, 6 skip), none needing a network or an API key:**

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

**Planned:**

7. **Fake Pushbullet:** a local HTTP + WebSocket stub so the full pipeline runs with no token.
8. **Accuracy metric:** `% valid answers / puzzles seen`, target ≥95%, surfaced in the tray.
   This, not "does it start", is the success criterion.

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

Install layout: `packaging/install.ps1` locates `%LOCALAPPDATA%\Programs\PuzzleSolver`, copies
the payload, then hands off to `app/src/deploy/install.js` (run by the bundled `node.exe`) to
write the shim + XML and call `schtasks`. `packaging/uninstall.ps1` delegates the task deletion
the same way, then removes the three per-user folders. All path and task decisions live in the
Node modules; the PowerShell is locator/launcher glue.

**Unverifiable on the Linux development host:** `wscript` execution, `schtasks` registration and
restart-on-failure behaviour, the Credential-Manager `set`, the `_ps1` scripts end to end,
Explorer opening a log, and the actual tray widget. Every one of those has a testable seam
(content, arguments or an injected loader) which is asserted; the native execution is not, and is
labelled as such in each module.

## 12. Extension points (v2+)

Deferred deliberately. Each is tracked as an issue under the
[v2 milestone](https://github.com/osxy/ocr-solver/milestone/6); none is scheduled, because each
needs a design decision before it becomes work.

- **HTTP ingress** — [issue #15](https://github.com/osxy/ocr-solver/issues/15): accept a puzzle over
  HTTP and return the answer in the response, instead of arriving as a Pushbullet push. Worth
  prioritising over the rest of v2 for a non-obvious reason: it provides a **genuine end-to-end
  path with no Pushbullet account**, which is the one M2 claim that cannot otherwise be verified.
  The real architectural point is that it is an *ingress seam*, not a second listener — ingress
  supplies an image, the unchanged core solves and validates it, egress delivers the answer
  (note push or response body). Building that seam once is cheaper than the three special cases
  that grids (#9) and Playwright (#12) would otherwise each need. Security is the risk: a CAPTCHA
  solver on a network is an oracle, so localhost-only and mandatory auth.
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
`redact` helper additionally guarantees a key can never reach a log line even inside an
upstream error body.
