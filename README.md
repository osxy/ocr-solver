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

**0.2.0 — a pre-release.** The offline solver, model tiers, Pushbullet listener and
reply path are implemented and tested. The Windows install/tray/autostart path ships
but has never run on a real Windows machine (see [Known limitations](#known-limitations)).
Work is tracked in the [issue tracker](https://github.com/osxy/ocr-solver/issues); the
design and its reasoning live in [DESIGN.md](./DESIGN.md).

## Install

Install from a **release**, not from source. From the
[v0.2.0 pre-release](https://github.com/osxy/ocr-solver/releases/tag/v0.2.0) download
`PuzzleSolver-0.2.0-win-x64.zip` (~81 MiB) and its `.sha256` checksum. The ZIP carries
its own pinned `node.exe`, so Node does not have to be installed.

The binary is **unsigned**, so **Windows SmartScreen will warn on first run** and the
SHA256 checksum is the only integrity signal. Verify it before extracting:

```powershell
Get-FileHash .\PuzzleSolver-0.2.0-win-x64.zip -Algorithm SHA256
Get-Content .\PuzzleSolver-0.2.0-win-x64.zip.sha256
```

The two hashes must match. (On Linux or macOS:
`sha256sum -c PuzzleSolver-0.2.0-win-x64.zip.sha256`.) If Windows flags the download,
`Unblock-File .\PuzzleSolver-0.2.0-win-x64.zip` first.

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
max_per_hour = 20               # answers per hour
unresolved_max_per_hour = 60    # acknowledgements have their own, looser budget (#48)
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
max_queue = 8                   # requests running/waiting at once; over this is a 503
allow_image_url = false         # off: image_url makes the server fetch a caller URL (SSRF)
image_url_hosts = []            # when on: the only hosts image_url may name (default deny)
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
the app runs offline-only (Tier 0).

**On Windows the file store is also what runs.** A Credential Manager provider exists in
`src/secrets.js` behind an injectable loader, but the `keytar` binding it needs is **not a
dependency** of this project, so `import('keytar')` fails and resolution falls through to
the file (`%APPDATA%\PuzzleSolver\credentials.json`, mode 600). The provider is
unverified code, not a shipped capability; do not expect a Windows Credential Manager
entry to appear.

When `[http] enabled = true`, a second secret is required: the bearer token for the
HTTP endpoint. Set `HTTP_AUTH_TOKEN` in the environment, or add `http_auth_token` to the
same `credentials.json`:

```json
{ "pushbullet_token": "o.xxxxxxxx", "llm_api_key": "sk-xxxxxxxx", "http_auth_token": "a-long-random-string" }
```

There is **no anonymous mode**: with `enabled = true` and no token the service refuses
to start rather than listen unprotected. The token must be at least 16 characters and
not an obvious weak value (a short or dictionary token is rejected at startup, because
a guessable key on a bound endpoint is an oracle). Generate one with
`openssl rand -hex 24`.

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
| **Settings** | Opens the settings editor in the browser (below) |
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
every change, and routes it to the right store. On a desktop session it opens as a
**loopback web UI in the default browser** (`config edit --gui` opens the same UI from a
console); this is what makes configuration possible on the shipped Windows install, where
the tray runs with the window hidden and has no console for a terminal prompt. The web UI
binds `127.0.0.1` on an ephemeral port, requires a single-use link token, validates the
`Host` header, serves every response with `Cache-Control: no-store`, never renders a secret
value, and closes its listener when you save or cancel. `--headless` has the same editor
behind a command, so an unattended machine is not a second-class mode:

```bash
node src/cli.js config list                  # every editable setting and its current value
node src/cli.js config get reply.title
node src/cli.js config set solver.offline_only true
node src/cli.js config edit                  # the guided editor over stdin
node src/cli.js config edit --gui            # the same editor as a loopback web UI
```

Secrets go to the credential store, never to `config.toml`. That covers all three of
them: `config set pushbullet.token o.xxxxxxxx`, `config set llm.api_key sk-xxxxxxxx` and
`config set http.token a-long-random-enough-token` each write `credentials.json` and leave
the TOML file alone (or uncreated). The HTTP token is checked against the same strength
rule the server enforces at startup, so the editor cannot store a token the app then
refuses to start with. Everything else is checked with the same `validateConfig` the
loader uses, then written **atomically** — a temp file renamed over the old one, with the
previous file kept as `config.toml.bak`. Only values that differ from the built-in
defaults are written, so the file stays an override rather than pinning every default. A
save **edits the file in place**: it changes only the line for the setting you changed and
leaves every comment, blank line, key order and spacing exactly as it was, so a
hand-annotated `config.toml` is safe to keep editing by hand. A value the editor cannot
locate safely — a value spanning more than one line, an array of tables — is refused with
the reason and the file is left untouched, never silently rewritten. A rejected value
names the setting and writes nothing at all, so the editor cannot leave a config that
stops the app from starting.

The editor covers the HTTP ingress too — `http.enabled`, `http.bind`, `http.port`,
`http.rate_limit_per_min`, `http.timeout_ms`, `http.max_body_bytes`, `http.max_queue`,
`http.allow_image_url`, `http.image_url_hosts` and
`http.token` — so enabling the endpoint no longer means hand-editing TOML **and** writing
the credential by some other route.

### Solve an uploaded image in the web UI

The same web UI has a **Solve an uploaded image** page. It is not a second solve path:
the upload goes through the HTTP ingress's own `classifyRequest`/`resolveImage` (a raw
body, a `multipart/form-data` file or a base64 body), and the solve runs on the same
shared core, so the one solve lock, the queue bound (`http.max_queue`) and the image caps
(`http.max_body_bytes`, `image.max_width`, `image.max_pixels`) all apply. The result
shows the **answer**, the **method** (`tier0`, `model:text` or `model:vision`),
**confidence** and **how long it took** — the same fields the HTTP response carries,
because it is the same serialiser. An unresolved puzzle shows the configured
acknowledgement text; a guess is never displayed.

### Exposing the web UI beyond loopback (read this before doing it)

By default the web UI binds `127.0.0.1` and only loopback may reach it. That is the
recommended setting. If you genuinely need it from another machine, two things must be
configured together, in `config.toml`:

```toml
[web_ui]
bind = "0.0.0.0"                 # or a specific LAN address
allowed_cidrs = ["192.168.1.0/24"]
allowed_hosts = ["puzzle.lan"]    # every Host name you will type, default deny
```

The access rule is a **single control for every page** (settings and solve alike): the
socket's remote address must be loopback or fall inside one of `allowed_cidrs`.
`X-Forwarded-For` is ignored — it is caller-supplied. `0.0.0.0/0` and `::/0` are refused
at load; if the UI must be reachable from everywhere, put it behind your own
authenticated reverse proxy. A range wider than loopback also **requires a credential**:
set it once with

```bash
node src/cli.js config set web_ui.password 'a long passphrase'
node src/cli.js config edit --gui        # or set it in the Settings page
```

That stores a **salt + `scrypt` verifier** in `credentials.json` (never the password,
never `config.toml`); a non-loopback client must sign in, and failed logins are
throttled. With a non-loopback range and no credential the service **refuses to start**,
naming `web_ui.password`, rather than listen unauthenticated.

**This is plain HTTP.** A password sent over a non-loopback connection travels in
cleartext, and the session token cannot be marked `Secure`. The credential raises the bar
against someone casually browsing the LAN; it does **not** make an untrusted network
safe, and it is not a substitute for transport encryption. For access from anywhere you
do not fully control, terminate TLS at a reverse proxy and reach the UI through that. A
LAN hostname or the proxy's `Host` must be listed in `allowed_hosts`, and the proxy's
address in `allowed_cidrs`.

**Some settings need a restart.** The editor marks each one `[live]` or `[restart]`, and
the headless command prints which applies:

- **live** — `storage.log_images`, `ui.notify_on_unresolved`, `solver.tier0`,
  `ocr.variants`, `ocr.min_confidence`, `image.max_width` and `image.max_pixels`. These
  are re-read from the shared config object for every solve, push or HTTP request, so a
  save takes effect without a restart.
- **restart** — the models and base URL, `offline_only`, `escalate_to_vision`,
  `self_consistency_n`, the breaker knobs (`breaker_threshold`, `breaker_cooldown_sec`),
  the reply switch/wording/budgets, `poll_interval_sec`, `history_mode`, `ocr.languages`,
  `storage.retain_days`, `ui.tray`, `ui.stats_recent_solves`, the whole `http.*` block, and **all
  three secrets**,
  because the listener, reasoner, responder or HTTP server capture them when they are
  built. The running service keeps the old value until it is restarted; the editor says
  so rather than appearing to save something that does nothing.

`ocr.languages` is restart-bound even though it sits next to `ocr.min_confidence`: the
Tesseract worker is created once at startup, and the bundled traineddata is `nld` only.

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

Start the service (`listen --headless` is the usual unattended form) and post an image.
The simplest form needs only the auth header:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  --data-binary @puzzle.png
```

The content type is **conventional, not required**: the server recognises the image
from its magic bytes, so a missing `Content-Type` (curl's default
`application/x-www-form-urlencoded`), `application/octet-stream`, and `image/png` are all
accepted. Declaring it is still the clearest, so this form works too:

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
  "cost": { "escalated": false, "tier": "tier0", "model": [] }
}
```

Accepted bodies: the raw image bytes (as above, whatever the declared `Content-Type`),
`multipart/form-data` with a file field, or JSON with `image_base64` (a data URL is
fine). A raw body that is not a real image is still refused with `415`
(`"error": "invalid_image"`, `"reason": "magic"`). JSON may also carry `image_url`,
but **fetching a URL is off by default** - see below.

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"image_base64":"'"$(base64 -w0 puzzle.png)"'"}'
```

**`image_url` is off by default (issue #57).** Making the server fetch a URL the caller
supplies is an SSRF surface: the server can reach services the caller cannot, including
link-local metadata endpoints. Since uploading the image is the normal path, the default is
to refuse it - `403` with `"error": "image_url_disabled"` and a reason pointing at
`image_base64` / multipart / the raw body. To enable it, name the hosts you trust (default deny):

```toml
[http]
allow_image_url = true
image_url_hosts = ["images.example.com", "cdn.example.com"]
```

When enabled, a URL whose host is not on that list is a `403` with
`"error": "image_url_host_not_allowed"`. Redirects are never followed: a public URL that
`302`s elsewhere is refused with `403` and `"error": "image_url_redirect"`, because the
redirect target is a second, unchecked host. Entries are exact host names (no wildcards or
ports). The residual: an allowlisted *hostname* that resolves to an internal address is
fetched, because `fetch` re-resolves at connect time - keep the list to names you control.

**Status codes are honest, not approximate.** `200` is a **corroborated** validated
answer; `422` is a puzzle that could not be solved, or an answer that passed validation
but was not corroborated (the body has `"answer": null` and a `reason` - nothing is
guessed). A `422` for an unresolved puzzle also carries `unresolvedReply` with the
configured human wording when one is set, so a caller can relay it; the structured fields
are never replaced by prose. A `422` for a withheld uncorroborated answer instead carries
`"reason": "unconfirmed"` and **no** `unresolvedReply`, because the Pushbullet path stays
silent for that case too. `401` is a missing or wrong bearer token; repeated wrong tokens
get a `429` with `Retry-After` (a bounded failure count with backoff, per client);
`400`/`413`/`415` is a bad, too large, or non-image body; `429` is the rate limit;
`503` (with `Retry-After`) means too many requests are already running or waiting on
the shared solver; `504` means the solve passed `timeout_ms`. A model-escalated solve
says so in `cost.escalated`, because it bills your provider credits.

**`reply.require_confidence` holds on HTTP too (issue #42).** An uncorroborated answer is
not returned as a solved `200`; it is withheld exactly as the Pushbullet responder
withholds it, so the two egresses cannot disagree about the same answer. Set
`require_confidence = false` to trade accuracy for coverage and get the answer with
`confident: false`.

**It is synchronous.** An offline solve is ~1 s and a vision escalation can pass 10 s,
so the answer is returned in the same request and `timeout_ms` (default 30 s) bounds it;
there is no job id and no polling. The budget includes queue wait. If it is exceeded the
request gets the `504` and the abandoned solve is discarded - nothing is delivered later.
A solve that has not *started* when its deadline passes is skipped before touching
Tesseract or a provider, so a request that expired in the queue does not bill you. Once
Tesseract is running it cannot be cancelled, and the app does not pretend otherwise.

**The queue is bounded (issue #43).** At most `max_queue` HTTP requests (default 8) may
be running or waiting on the solver at once; the next is refused with `503` and
`Retry-After` instead of being queued. This is a deliberate behaviour change: a burst
larger than the bound is refused where it used to be queued and billed. The rate limit
bounds admission per minute; `max_queue` bounds the backlog behind the one shared worker.

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
  `false` sends the answer and trades accuracy for coverage. **The HTTP ingress applies the
  same policy:** a withheld answer is a `422` with `reason: "unconfirmed"` and `answer: null`,
  not a solved `200` (issue #42).
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
`422` is not an error: either the puzzle was read but no tier produced a validated answer,
or one did and `reply.require_confidence` withheld it as uncorroborated. In both cases
`answer` is `null` - the same invariant as the Pushbullet path. An unresolved puzzle also
carries the configured `unresolvedReply` wording when replies are enabled; an uncorroborated
one carries `"reason": "unconfirmed"` instead (issue #42).

**No replies at all.** Check, in order: (1) a Pushbullet token is present
(`PUSHBULLET_TOKEN`, `--token`, or `credentials.json`) — without it the service refuses
to start; (2) `reply.enabled` is `true` and `reply.require_confidence` is not
suppressing a merely validated answer; (3) the log and the listener state — a **grey
tray icon** means the listener has been quiet for 10 minutes, and the stream reconnects
with backoff while the 60 s poll is the second path; (4) the hourly cap (`max_per_hour`)
has not been reached — answers and acknowledgements each have their own budget, so a
burst of unsolvable puzzles can no longer starve a real answer; (5) a model tier needs a
key, and `offline_only = true` disables the model tiers entirely.

**A setting changed but nothing happened.** The editor and `config set` print which
changes apply live and which need a restart (see
[Settings](#settings-change-configuration-without-editing-files)). The models, the
offline switches, the reply wording, the poll interval, `ocr.languages`, the breaker knobs,
the HTTP ingress and all three secrets are read at startup, so restart the service (Quit
and relaunch, or restart the scheduled
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

- **Pre-release.** 0.2.0 is a pre-release: expect rough edges and no stability promise.
- **The Windows-specific paths have never executed on a real Windows machine.** The
  tray widget, the `schtasks` registration and restart behaviour, the Credential Manager
  provider (which is not shipped at all - see
  [Secrets](#secrets-go-in-the-environment-or-the-credential-store)), the
  install/uninstall PowerShell and the packaged `node.exe` are written and tested at
  their seams, but this project is developed on Linux. Treat the first Windows install as
  unverified; `--headless` is the supported fallback.
- **The web UI is plain HTTP and its non-loopback credential is transport-unprotected.**
  A remote-access password is verified as a `scrypt` verifier and failed logins are
  throttled, but the HTTP connection itself is not encrypted and the session token cannot
  be `Secure`. On an untrusted network, use a TLS-terminating reverse proxy; the password
  is not a substitute for one. See [Exposing the web UI beyond loopback](#exposing-the-web-ui-beyond-loopback-read-this-before-doing-it).
- **The settings and first-run UI opens in the default browser; the browser hand-off itself
  is not exercised on Windows.** On a desktop session the tray's **Settings** item and the
  first-run setup (no token configured) start a loopback-only web UI on an ephemeral port and
  open it in the default browser, instead of prompting into a console the tray does not have.
  The HTTP server, the one-time link token, the `Host` check, the form post and the save path
  are exercised on Linux in `tests/web-config.test.js`; the one seam that cannot be checked
  here is the `explorer.exe`/`xdg-open` hand-off to a real browser. `config edit` (or
  `node src/cli.js config edit`) remains the terminal editor for a headless machine, and
  `config edit --gui` opens the web UI from a console; that command is exercised in
  `tests/config-cli.test.js`.
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
npm test              # 534 tests (528 pass, 6 skip), offline: no network, no token, no key
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
