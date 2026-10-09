# PuzzleSolver

A Windows background app that watches Pushbullet for incoming puzzle images, reads
them, solves the Dutch-language puzzle, and replies with the answer as a Pushbullet
note.

The puzzles are Dutch natural-language captchas: low-resolution coloured text on
coloured noise, asking things like *"Hoeveel kleuren in lijst wit kiwi hoofd paars
olifant aap?"* (answer `2`) or *"Wat is acht min een?"* (answer `7`). Most are solved
locally and offline; a language model is consulted only when the offline lexicon and
arithmetic cannot answer.

The same solver can also be called over HTTP (`POST /v1/solve`), so any script or
service can send a puzzle and get the validated answer in the response - no Pushbullet
account needed. It is off by default and locked to loopback with a bearer token (see
[Solve over HTTP](#solve-over-http-no-pushbullet-needed)).

It does **not** type the answer into a form, does not solve image-grid ("select all
bicycles") captchas, and never sends an answer it could not validate. A puzzle it
cannot answer is acknowledged with a configurable "could not solve" reply, never with a
guess (see [What happens to a puzzle](#what-happens-to-a-puzzle)).

## Status

**0.1.0 — a pre-release.** The offline solver, model tiers, Pushbullet listener and
reply path are implemented and tested. The Windows install/tray/autostart path ships
but has never run on a real Windows machine (see [Known limitations](#known-limitations)).
Work is tracked in the [issue tracker](https://github.com/osxy/ocr-solver/issues); the
design and its reasoning live in [DESIGN.md](./DESIGN.md).

## Install

Install from a **release**, not from source. From the
[v0.1.0 pre-release](https://github.com/osxy/ocr-solver/releases/tag/v0.1.0) download
`PuzzleSolver-0.1.0-win-x64.zip` (~81 MiB) and its `.sha256` checksum. The ZIP carries
its own pinned `node.exe`, so Node does not have to be installed.

The binary is **unsigned**, so **Windows SmartScreen will warn on first run** and the
SHA256 checksum is the only integrity signal. Verify it before extracting:

```powershell
Get-FileHash .\PuzzleSolver-0.1.0-win-x64.zip -Algorithm SHA256
Get-Content .\PuzzleSolver-0.1.0-win-x64.zip.sha256
```

The two hashes must match. (On Linux or macOS:
`sha256sum -c PuzzleSolver-0.1.0-win-x64.zip.sha256`.) If Windows flags the download,
`Unblock-File .\PuzzleSolver-0.1.0-win-x64.zip` first.

Then extract the ZIP and, from the extracted folder, run the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It installs per-user — no administrator prompt, nothing in `Program Files` or `HKLM`:
it copies the app to `%LOCALAPPDATA%\Programs\PuzzleSolver`, writes
`PuzzleSolver.vbs` (a launcher with no console window), and registers a Task Scheduler
task named `PuzzleSolver` that starts the app at logon (20 s delay, restart on failure).

> The install, tray and task registration have **never executed on a real Windows
> machine**. See [Known limitations](#known-limitations).

## Configure

**A missing config file is normal.** Every setting has a working default, so the app
starts with no config at all. When you want to change something, the file is
`%APPDATA%\PuzzleSolver\config.toml` on Windows or
`${XDG_CONFIG_HOME:-~/.config}/PuzzleSolver/config.toml` elsewhere; `--config <path>`
(or `$PUZZLESOLVER_CONFIG`) overrides it. An unknown key warns and is ignored; a *bad*
value (wrong type, unknown enum, negative interval) fails loudly and names the key.

The options that matter, with their defaults:

```toml
[pushbullet]
poll_interval_sec = 60          # the stream is primary; this is the fallback poll
history_mode = "ignore"         # "ignore" pre-existing pushes, or "watermark"
[solver]
tier0 = true                    # offline lexicon + arithmetic
offline_only = false            # true = never call a model; no image leaves the machine
escalate_to_vision = true
llm_text_model = "gpt-4o-mini"
llm_vision_model = "gpt-4o"
llm_base_url = "https://api.openai.com/v1"
self_consistency_n = 3          # samples for the voting classes (ordinal-pick, unknown)
breaker_threshold = 3           # consecutive model failures before a tier is skipped
breaker_cooldown_sec = 600
[reply]
enabled = true
require_confidence = true       # only send answers every tier agreed on
title = "Antwoord"
unresolved_title = "Puzzel niet opgelost"
unresolved_text = """
Deze puzzel kon niet automatisch worden opgelost, dus er is geen antwoord gegeven.
This puzzle could not be solved automatically, so no answer is given."""
min_interval_sec = 3
max_per_hour = 20
[storage]
retain_days = 7
log_images = false              # opt-in reference to an UNRESOLVED image only
[image]
max_width = 2000                # the shared gate rejects wider images as a 413
max_pixels = 1000000            # ~14x the largest corpus puzzle; bounds buildVariants
[http]
enabled = false                 # an HTTP endpoint that solves captchas is an oracle
bind = "127.0.0.1"             # never 0.0.0.0 unless you mean it; it warns if you do
port = 8765
rate_limit_per_min = 20         # 0 disables the limit
timeout_ms = 30000      # a solve past this is a 504; nothing is sent
max_body_bytes = 5242880        # 5 MiB, the same cap as a Pushbullet image
```

`DEFAULTS` in [`src/config.js`](./src/config.js) is the full schema; `DESIGN.md` §4.13
explains the defaults.

### Secrets go in the environment or the credential store

The Pushbullet token and the model key are **not** config keys. A config key whose name
looks like a secret (`*token*`, `*key*`, `*secret*`, `*password*`) is rejected at load,
because a config file ends up in backups and support threads. Set them in the
environment:

```powershell
$env:PUSHBULLET_TOKEN = "o.xxxxxxxx"
$env:LLM_API_KEY       = "sk-xxxxxxxx"
```

…or write the credential-store file at `%APPDATA%\PuzzleSolver\credentials.json` on
Windows or `${XDG_CONFIG_HOME:-~/.config}/puzzlesolver/credentials.json` elsewhere:

```json
{ "pushbullet_token": "o.xxxxxxxx", "llm_api_key": "sk-xxxxxxxx" }
```

The Pushbullet token is required *unless* the HTTP ingress is enabled, in which case
the app can run without a Pushbullet account at all. In tray mode a missing Pushbullet
token opens the first-run prompt (token, optional model key, **Test connection**) and
stores what you enter in the credential store; cancel it and nothing starts.
`--headless` has no prompt, so a missing token exits non-zero naming both
`PUSHBULLET_TOKEN` and the credential-store file. The model key is optional: with none,
the app runs offline-only (Tier 0). On Windows the Credential Manager is tried before
the file, but its provider is **unverified** (see
[Known limitations](#known-limitations)); the file store is the tested fallback.

When `[http] enabled = true`, a second secret is required: the bearer token for the
HTTP endpoint. Set `HTTP_AUTH_TOKEN` in the environment, or add `http_auth_token` to the
same `credentials.json`:

```json
{ "pushbullet_token": "o.xxxxxxxx", "llm_api_key": "sk-xxxxxxxx", "http_auth_token": "a-long-random-string" }
```

There is **no anonymous mode**: with `enabled = true` and no token the service refuses
to start rather than listen unprotected.

## Run

### Tray / service mode (the Windows default)

The logon task starts the app at logon. To start it now, run the launcher
`%LOCALAPPDATA%\Programs\PuzzleSolver\PuzzleSolver.vbs`. The tray menu:

| Item | What it does |
|---|---|
| **Status** | Logs the current connection / listener / accuracy state |
| **Accuracy** | Shows the corpus and recorded-traffic summary |
| **Pause** / **Resume** | Stops / starts the *listener*, not the process |
| **Solve last image** | Re-runs the pipeline on the newest image in the inbox — tuning without a live push |
| **Open log** / **Open config** | Opens `app.log` / `config.toml` |
| **Settings** | Opens the settings editor (below) |
| **Quit** | Shuts down cleanly |

The icon is **normal (coloured)** while the listener is in contact with Pushbullet, and
turns **grey after 10 minutes with no contact** — no socket event and no completed poll.
Grey means "the listener may be dead", so a silently dropped socket is visible instead
of invisible. It does **not** mean "no puzzle arrived": a quiet week with a healthy
socket stays normal, and a paused listener never greys, because an explicitly paused
listener is not a silently dead one.

### Headless mode

For an unattended machine, or when the tray cannot start:

```powershell
%LOCALAPPDATA%\Programs\PuzzleSolver\node.exe %LOCALAPPDATA%\Programs\PuzzleSolver\app\src\cli.js listen --headless
```

`--headless` skips the tray and every notification. `ui.tray = false` in the config does
the same for the launcher.

### Settings (change configuration without editing files)

The tray's **Settings** item opens an editor that lists the current values, validates
every change, and routes it to the right store. `--headless` has the same editor behind a
command, so an unattended machine is not a second-class mode:

```bash
node src/cli.js config list                  # every editable setting and its current value
node src/cli.js config get reply.title
node src/cli.js config set solver.offline_only true
node src/cli.js config edit                  # the guided editor over stdin
```

Secrets go to the credential store, never to `config.toml`: `config set pushbullet.token
o.xxxxxxxx` writes `credentials.json` (or the Windows Credential Manager) and leaves the
TOML file alone. Everything else is checked with the same `validateConfig` the loader
uses, then written **atomically** — a temp file renamed over the old one, with the
previous file kept as `config.toml.bak`. Only values that differ from the built-in
defaults are written, so the file stays an override rather than pinning every default. A rejected value names the setting and writes
nothing at all, so the editor cannot leave a config that stops the app from starting.

**Some settings need a restart.** The editor marks each one `[live]` or `[restart]`, and
the headless command prints which applies:

- **live** — `storage.log_images` and `ui.notify_on_unresolved`, which the running
  process reads again for every solve/push;
- **restart** — the models and base URL, `offline_only`, `escalate_to_vision`,
  `self_consistency_n`, the reply switch/wording, `poll_interval_sec`, `history_mode`,
  `ocr.variants`, `storage.retain_days`, `ui.tray`, and **both secrets**, because the
  listener, reasoner and responder capture them when they are built. The running service
  keeps the old value until it is restarted; the editor says so rather than appearing to
  save something that does nothing.

### Solve a local image (no Pushbullet needed)

This is the easiest way to check an install: it needs no token and no network. From a
source checkout:

```bash
node src/cli.js corpus                       # solve the sample puzzles
node src/cli.js "path/to/puzzle.png"         # one image
node src/cli.js corpus/needs-model --fake-answer Amsterdam   # model path, no key
```

Each solved image prints its OCR transcript and the winning tier; e.g.
`001-count-kleuren.png` ends with `=>   answer "2" via tier0:count (1/1 agree)`.

With the packaged app, replace `node src/cli.js` with
`%LOCALAPPDATA%\Programs\PuzzleSolver\node.exe %LOCALAPPDATA%\Programs\PuzzleSolver\app\src\cli.js`.

### Solve over HTTP (no Pushbullet needed)

The HTTP ingress is a second way in: post a puzzle image and get the answer in the
response. It needs no Pushbullet account, which is also what makes the whole solve path
verifiable end to end.

Turn it on in `config.toml` and provide a token:

```toml
[http]
enabled = true
bind = "127.0.0.1"      # loopback only; see the warning below before changing this
port = 8765
```

```powershell
$env:HTTP_AUTH_TOKEN = "a-long-random-string"
```

Start the service (`listen --headless` is the usual unattended form) and post an image:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'Content-Type: image/png' \
  --data-binary @puzzle.png
```

```json
{
  "status": "solved",
  "answer": "2",
  "method": "tier0:count",
  "confident": true,
  "puzzleClass": "count",
  "transcript": "hoeveel kleuren in lijst wit ...",
  "cost": { "escalated": false, "tier": "tier0", "model": null }
}
```

Accepted bodies: `image/*` (raw bytes, as above), `multipart/form-data` with a file
field, or JSON with `image_base64` (a data URL is fine) or `image_url`:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"image_base64":"'"$(base64 -w0 puzzle.png)"'"}'
```

**Status codes are honest, not approximate.** `200` is a validated answer; `422` is a
puzzle that could not be solved (the body has `"answer": null` and a `reason` - nothing
is guessed). A `422` also carries `unresolvedReply` with the configured human wording
when one is set, so a caller can relay it; the structured fields are never replaced by
prose. `401` is a missing or wrong bearer token; `400`/`413`/`415` is a bad, too
large, or non-image body; `429` is the rate limit; `504` means the solve passed
`timeout_ms`. A model-escalated solve says so in `cost.escalated`, because it
bills your provider credits.

**It is synchronous.** An offline solve is ~1 s and a vision escalation can pass 10 s,
so the answer is returned in the same request and `timeout_ms` (default 30 s)
bounds it; there is no job id and no polling. If the budget is exceeded the request gets
the `504` and the abandoned solve is discarded - nothing is delivered later.

It coexists with the Pushbullet listener in one process (two ingresses, one solve core).
**An HTTP request replies over HTTP and sends no Pushbullet push by default** - Pushbullet
delivery is opt-in, not the default. To exercise the *note-push* path without a real
Pushbullet push, add `"deliver": "pushbullet"` to a JSON body; only then does the
configured responder run and the response report `delivery`.

> **Binding beyond loopback.** `bind = "0.0.0.0"` exposes a CAPTCHA solver to your
> network. The token is still required, but anyone who has it can spend your provider
> credits. The app logs a warning when the bind is not loopback. Keep it on
> `127.0.0.1` unless you have a specific reason.

### Check accuracy, and read the caveat

`node src/cli.js accuracy` runs the committed corpus through real OCR plus whatever
real traffic the store has recorded (`--no-images --no-store` is the fast, text-only
form). The report is grouped by provenance and **never blended**, because the numbers
mean different things. Of the 287 corpus items, 281 are **synthetic** images and text
from our own generator — which refuses to write an image the pipeline cannot read — so
the synthetic figure is a **regression guard, not real-world accuracy**. The only real
evidence is 3/3 on the three real images. The CLI prints this caveat; the tray blends
corpus and recorded traffic into one line (a known follow-up).

## What happens to a puzzle

A file push arrives over the Pushbullet stream (a 60 s poll is the fallback), or an
image arrives in an HTTP request body. Either way the image is verified (size, magic
bytes, a real decode, a sane height), cleaned (adaptive threshold → denoise → upscale),
read by offline Tesseract in Dutch, repaired, and parsed into a puzzle class. **Tier 0** answers offline
for the classes the lexicon and arithmetic cover; anything else escalates to a **text
model**, then a **vision model** over the image itself if OCR failed. Every answer,
offline or model, must pass the validator for its class, and model answers are
*opinions* needing a strict majority. The validated answer is posted back as a note
push, subject to rate and idempotency guards.

### Why a reply may be missing, or is not an answer

A reply that is not a solution is deliberate, not a bug:

- **Unresolved is acknowledged, never answered.** If no tier produces a valid answer, the
  puzzle is reported unresolved locally and the configured acknowledgement
  (`reply.unresolved_title` / `reply.unresolved_text`) is sent. It has a distinct title and
  a sentence body, so it cannot be read as a solution; no answer is ever guessed.
- **`reply.require_confidence = true` (the default)** additionally suppresses a reply for an
  answer that passed validation but was never corroborated — for example an offline count
  whose word list contained an unreadable entry. That case stays silent (no answer and no
  acknowledgement), because a candidate exists but no tier confirmed it. Setting it to
  `false` sends the answer and trades accuracy for coverage.
- **`reply.enabled = false`** means the app still solves locally but never replies.
- **`history_mode = "ignore"` (the default)** ignores pushes that existed before the
  app started. Set `"watermark"` to answer from a stored mark.

## Troubleshooting

**The tray does not start.** Run `listen --headless` (the fallback that needs no display
and no `systray2`), or set `ui.tray = false`. The error itself names `--headless` when
`systray2` cannot be loaded.

**The HTTP ingress will not start.** With `[http] enabled = true` and no token the app
refuses to start, naming `HTTP_AUTH_TOKEN` and `http_auth_token`. A `401` from a running
server means the `Authorization: Bearer ...` header is missing or does not match. A
`422` is not an error: the puzzle was read but no tier produced a validated answer, so
no answer is returned - the same invariant as the Pushbullet path. The response carries
`answer: null`, plus the configured `unresolvedReply` wording when replies are enabled.

**No replies at all.** Check, in order: (1) a Pushbullet token is present
(`PUSHBULLET_TOKEN`, `--token`, or `credentials.json`) — without it the service refuses
to start; (2) `reply.enabled` is `true` and `reply.require_confidence` is not
suppressing a merely validated answer; (3) the log and the listener state — a **grey
tray icon** means the listener has been quiet for 10 minutes, and the stream reconnects
with backoff while the 60 s poll is the second path; (4) the hourly cap (`max_per_hour`)
has not been reached — a burst of unsolvable puzzles can exhaust it; (5) a model tier
needs a key, and `offline_only = true` disables the model tiers entirely.

**A setting changed but nothing happened.** The editor and `config set` print which
changes apply live and which need a restart (see
[Settings](#settings-change-configuration-without-editing-files)). The models, the
offline switches, the reply wording, the poll interval, the OCR variants and both secrets
are read at startup, so restart the service (Quit and relaunch, or restart the scheduled
task). If a hand-edited `config.toml` now blocks startup, the loader names the offending
key; the editor keeps the previous file as `config.toml.bak`, so copying that back is the
way out.

**Where things live.**

| What | Windows | Linux/macOS |
|---|---|---|
| Install | `%LOCALAPPDATA%\Programs\PuzzleSolver` | — |
| Config | `%APPDATA%\PuzzleSolver\config.toml` | `${XDG_CONFIG_HOME:-~/.config}/PuzzleSolver/config.toml` |
| Credentials | `%APPDATA%\PuzzleSolver\credentials.json` | `${XDG_CONFIG_HOME:-~/.config}/puzzlesolver/credentials.json` |
| Log | `%LOCALAPPDATA%\PuzzleSolver\logs\app.log` | `${XDG_STATE_HOME:-~/.local/state}/puzzlesolver/logs/app.log` |
| State DB | `%LOCALAPPDATA%\PuzzleSolver\state.db` | `${XDG_DATA_HOME:-~/.local/share}/puzzlesolver/state.db` |
| Inbox | `%LOCALAPPDATA%\PuzzleSolver\inbox` | `${XDG_DATA_HOME:-~/.local/share}/puzzlesolver/inbox` |

The log rotates at 5 MB × 3. `storage.retain_days` (default 7) prunes the inbox and old
attempt rows on startup.

**Uninstall.**

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\PuzzleSolver\uninstall.ps1"
```

It removes the scheduled task first, then the install folder and the two per-user data
folders. Manually: `schtasks /Delete /TN PuzzleSolver /F`, then delete
`%LOCALAPPDATA%\Programs\PuzzleSolver`, `%LOCALAPPDATA%\PuzzleSolver` and
`%APPDATA%\PuzzleSolver`.

## Known limitations

- **Pre-release.** 0.1.0 is a pre-release: expect rough edges and no stability promise.
- **The Windows-specific paths have never executed on a real Windows machine.** The
  tray widget, the `schtasks` registration and restart behaviour, the Credential
  Manager, the install/uninstall PowerShell and the packaged `node.exe` are written and
  tested at their seams, but this project is developed on Linux. Treat the first Windows
  install as unverified; `--headless` is the supported fallback.
- **The first-run setup dialog and the settings editor are terminal prompts, not native
  widgets.** In tray mode with no token, startup presents the first-run prompt (Pushbullet
  token, optional model key, **Test connection**) before the listener starts; a cancelled
  dialog or a failed save exits without starting. `--headless` never prompts — it exits
  non-zero naming both `PUSHBULLET_TOKEN` and the credential-store file. The **Settings**
  item runs the same kind of prompt in-process, so a tray launched without a console may
  have no stdin to read; use `puzzlesolver config edit` (or `node src/cli.js config edit`)
  in a terminal — it is the identical editor and is exercised as a command in
  `tests/config-cli.test.js`. The prompt is reached through an injected provider in tests;
  a graphical tray dialog has never run on a real Windows machine, and the tray-launched
  (no-console) path has not been exercised there either.
- **Synthetic accuracy is not real accuracy.** See
  [Check accuracy](#check-accuracy-and-read-the-caveat).
- **No form typing, no image grids.** It reads an image and replies; it does not act in
  a browser.

## How it works

```
image ──▶ adaptive threshold ──▶ connected-component filter ──▶ upscale
      ──▶ Tesseract (nld, offline) ──▶ OCR repair ──▶ parse ──▶ solve ──▶ validate
```

Three measurements drive the design: local adaptive thresholding beats a global cut
(the noise darkens toward one side), denoising happens before upscaling (upscaling first
turns single-pixel noise into blobs), and a per-class validation gate is what stops a
confidently wrong answer. The offline lexicon is what lets the common puzzles be solved
with no model call at all.

The full architecture diagram, the tier and escalation rules, the auto-router decisions
and the numbers behind them are in **[DESIGN.md](./DESIGN.md)** (§2–§5, §4.7–4.8). That
reasoning lives in one place rather than being duplicated here.

## Development

Requires **Node.js ≥ 22.13.0** (`node:sqlite` is unflagged from 22.13.0). No build step;
plain ESM.

```bash
npm install
npm test              # 454 tests (448 pass, 6 skip), offline: no network, no token, no key
npm run test:unit     # fast subset
npm run test:corpus   # real images through real OCR, ~4s
npm run test:live     # opt-in; skips unless LLM_API_KEY is set
```

The Windows package is built by CI (`.github/workflows/package.yml`, on
`windows-latest`): it assembles `dist\payload`, zips it, checks the checksum and
smoke-tests the extracted artifact. See `packaging/` and `DESIGN.md` §11.

[`AGENTS.md`](./AGENTS.md) holds the repo rules and the test/verification workflow;
[`DESIGN.md`](./DESIGN.md) is the architecture reference.

## License

[Apache License 2.0](./LICENSE).
