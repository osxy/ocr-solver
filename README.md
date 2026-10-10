# PuzzleSolver

[![CI](https://github.com/osxy/ocr-solver/actions/workflows/ci.yml/badge.svg)](https://github.com/osxy/ocr-solver/actions/workflows/ci.yml)

A Windows background app that watches Pushbullet for incoming puzzle images, reads
them, solves the Dutch-language puzzle, and replies with the answer as a Pushbullet
note.

The puzzles are Dutch natural-language captchas: low-resolution coloured text on
coloured noise, asking things like *"Hoeveel kleuren in lijst wit kiwi hoofd paars
olifant aap?"* (answer `2`) or *"Wat is acht min een?"* (answer `7`). Most are solved
locally and offline; a language model is consulted only when the offline lexicon and
arithmetic cannot answer.

The same solver can also be called over HTTP (`POST /v1/solve`), so any script or
service can send a puzzle and get the validated answer in the response — no Pushbullet
account needed. It is off by default and locked to loopback with a bearer token (see
[Solve over HTTP](#solve-over-http)).

It does **not** type the answer into a form, does not solve image-grid ("select all
bicycles") captchas, and never sends an answer it could not validate. A puzzle it
cannot answer is acknowledged with a configurable "could not solve" reply, never with a
guess (see [Why a reply may be missing](#why-a-reply-may-be-missing-or-is-not-an-answer)).

The web UI (settings, solving an uploaded image, and statistics) is loopback-only by
default. Its screenshots and how they are regenerated are in
[`docs/screenshots/`](./docs/screenshots/README.md); the secondary modes have their own
pages under [`docs/`](./docs/):
[configuration](./docs/configuration.md) ·
[HTTP API](./docs/http-api.md) ·
[solve page](./docs/solve-page.md) ·
[statistics page](./docs/statistics-page.md) ·
[remote access](./docs/remote-access.md) ·
[OpenRouter](./docs/openrouter.md).

## Status

**0.45.0 — a pre-release.** The offline solver, model tiers, Pushbullet listener and
reply path are implemented and tested. The packaged Windows app, the installer, the
per-user Startup shim and the launcher are executed on `windows-latest` in CI, and a fresh
`node` process decrypts Windows secrets through DPAPI there; that runner also asserts the
packaged `systray2` class now resolves (the tray had never loaded, because a
CommonJS/Babel interop bug made the import resolve to an object). The native tray widget
itself and the notification toast need an interactive desktop and remain unverified (see
[Known limitations](#known-limitations)).

The **Pushbullet ingress — reading a real push, fetching its image, solving it and
replying — has never been executed against the real Pushbullet service**, because no
account or token exists (tracked and blocked as
[issue #3](https://github.com/osxy/ocr-solver/issues/3)). That is the app's primary
user-facing path, so **0.45.0 remains a pre-release**: the parts a runner can reach are
tested against fakes, but the main ingress is not *observed* end to end. Work is tracked
in the [issue tracker](https://github.com/osxy/ocr-solver/issues); the design and its
reasoning live in [DESIGN.md](./DESIGN.md).

## Install

Install from a **release**, not from source. From the
[releases page](https://github.com/osxy/ocr-solver/releases) download
`PuzzleSolver-0.45.0-win-x64.zip` and its `.sha256` checksum. The ZIP carries
its own pinned `node.exe`, so Node does not have to be installed.

The binary is **unsigned**, so **Windows SmartScreen will warn on first run** and the
SHA256 checksum is the only integrity signal. Verify it before extracting:

```powershell
Get-FileHash .\PuzzleSolver-0.45.0-win-x64.zip -Algorithm SHA256
Get-Content .\PuzzleSolver-0.45.0-win-x64.zip.sha256
```

The two hashes must match. (On Linux or macOS:
`sha256sum -c PuzzleSolver-0.45.0-win-x64.zip.sha256`.) If Windows flags the download,
`Unblock-File .\PuzzleSolver-0.45.0-win-x64.zip` first.

Then extract the ZIP and, from the extracted folder, run the installer:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

It installs per-user — no administrator prompt, nothing in `Program Files` or `HKLM`:
it copies the app to `%LOCALAPPDATA%\Programs\PuzzleSolver`, writes `PuzzleSolver.vbs`
(a launcher with no console window), drops a shim in your per-user Startup folder so the
app starts at logon (20 s delay), and **starts the app now** — a fresh install goes
straight to the setup page below. For an unattended install, `.\install.ps1 -NoStart`
starts nothing. Nothing is registered in Task Scheduler or `HKLM`.

> The installer, the per-user Startup shim, the launcher and the uninstaller are executed
> end to end on `windows-latest` in CI, and the packaged `systray2` class resolution is
> asserted there. The native tray widget drawing and the notification toast still need an
> interactive desktop and remain unverified. See
> [Known limitations](#known-limitations).

## Run it

### First run: the app asks

The installer starts it, and the per-user Startup entry starts it at logon. Running
`%LOCALAPPDATA%\Programs\PuzzleSolver\PuzzleSolver.vbs` yourself **opens a setup page in
your browser**: paste the Pushbullet token, optionally the model API key, and press
**Test connection**. What you enter is written straight to the DPAPI credential store,
`%APPDATA%\PuzzleSolver\credentials.dpapi`. Cancel it and the service does not start.
That page is the designed path: the tray runs with no console, so a browser is the only
place a prompt can appear.

The Pushbullet token is required *unless* the HTTP ingress is enabled, in which case the
app runs without a Pushbullet account at all. The model key is optional — the setup page
does not demand one, and with none the app runs offline-only (Tier 0). There is no
anonymous HTTP mode: see [the HTTP API](./docs/http-api.md) for its third secret,
`HTTP_AUTH_TOKEN`. How the secrets are protected, and what DPAPI does and does not defend
against, is in
[configuration](./docs/configuration.md#how-the-secrets-are-protected).

### Tray / service mode (the Windows default)

The per-user Startup entry starts the app at logon, and the installer starts it now.
`PuzzleSolver.vbs` is safe to double-click: a second copy takes a lock beside `state.db`
and exits without starting a listener. The tray menu:

| Item | What it does |
|---|---|
| **Status** | Logs the current connection / listener / accuracy state |
| **Accuracy** | Shows the corpus and recorded-traffic summary |
| **Pause** / **Resume** | Stops / starts the *listener*, not the process |
| **Solve last image** | Re-runs the pipeline on the newest image in the inbox — tuning without a live push |
| **Open log** / **Open config** | Opens `app.log` / `config.toml` |
| **Settings** | Opens the settings editor in the browser (below) |
| **Restart** | Restarts the service, draining an in-flight solve first |
| **Quit** | Shuts down cleanly |

When a saved setting needs a restart, the settings page offers **Restart now** instead of only
naming the setting, and the **Restart** item does the same thing.

The icon is **normal (coloured)** while the listener is in contact with Pushbullet, and
turns **grey after 10 minutes with no contact** — no socket event and no completed poll.
Grey means "the listener may be dead", so a silently dropped socket is visible instead
of invisible. It does **not** mean "no puzzle arrived": a quiet week with a healthy
socket stays normal, and a paused listener never greys.

### Headless mode

For an unattended machine, or when the tray cannot start:

```powershell
%LOCALAPPDATA%\Programs\PuzzleSolver\node.exe %LOCALAPPDATA%\Programs\PuzzleSolver\app\src\cli.js listen --headless
```

`--headless` skips the tray and every notification, and it **never opens the setup page**,
so the token has to reach it another way:

- `node src/cli.js config set pushbullet.token <value>`, or the tray's **Settings**
  editor (`config edit --gui`) — both write the credential store directly, never
  `config.toml`;
- `--token <value>` sets it for one run only;
- a **persistent** environment variable — `setx PUSHBULLET_TOKEN "o.xxxxxxxx"`, or System
  Properties → Environment Variables — which the app sees when it starts at the next logon. A
  session `$env:PUSHBULLET_TOKEN = "…"` does **not** count: it dies with the shell that
  set it, and the task never sees it.

With none of these the service refuses to start rather than run tokenless.
`ui.tray = false` in the config disables the tray for the launcher too.

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

### Configure it

Change a setting the way the app offers: the tray's **Settings** item, or
`config edit --gui`, opens an editor in the browser. It lists every setting with its
current value, validates each change, tags it `[live]` or `[restart]`, and routes
secrets to the credential store. `node src/cli.js config list|get|set|edit` is the same
editor for a terminal — see
[configuration](./docs/configuration.md#change-a-setting-with-the-editor).

**A missing `config.toml` is normal.** Every setting has a working default, so the app
starts with no config at all, and the file is for the advanced settings. It is
`%APPDATA%\PuzzleSolver\config.toml` on Windows or
`${XDG_CONFIG_HOME:-~/.config}/PuzzleSolver/config.toml` elsewhere; `--config <path>`
(or `$PUZZLESOLVER_CONFIG`) overrides it. An unknown key warns and is ignored; a *bad*
value fails loudly and names the key. Secrets are **not** config keys: a key whose name
looks like one (`*token*`, `*key*`, `*secret*`, `*password*`) is rejected at load, because
a config file ends up in backups and support threads.

```toml
[solver]
offline_only = false            # true = never call a model; no image leaves the machine
llm_text_model = "gpt-4o-mini"
llm_vision_model = "gpt-4o"
llm_base_url = "https://api.openai.com/v1"
[reply]
require_confidence = true       # only send answers every tier agreed on
[http]
# does not affect the web UI (web_ui has no enable flag)
enabled = false                 # an HTTP endpoint that solves captchas is an oracle
bind = "127.0.0.1"             # never 0.0.0.0 unless you mean it; it warns if you do
```

Every key and its default is in
[configuration](./docs/configuration.md#every-configtoml-key-with-its-default);
`DEFAULTS` in [`src/config.js`](./src/config.js) is the schema.

### The web UI

The settings editor, **Solve an uploaded image** page and **Statistics** page are one
loopback web UI, reachable only from `127.0.0.1` by default. The pages are described in
[solve page](./docs/solve-page.md) and [statistics page](./docs/statistics-page.md). To
reach them from another machine, read
[Exposing the web UI beyond loopback](./docs/remote-access.md) first — it is a security
decision, and it requires a credential.

**The web UI and the [HTTP ingress](#solve-over-http) are two different servers.**
`http.enabled` belongs to the second one only: setting it `false` never disables the web
UI, and the web UI has no enable flag at all.

| | HTTP ingress (`http.*`) | Web UI (`web_ui.*`) |
|---|---|---|
| What it is | the `POST /v1/solve` endpoint | the settings / solve / statistics UI |
| Default | `enabled = false`, deliberately | no `enabled` key exists; nothing gates it |
| Bind / port | `http.bind` : `http.port` (`8765`) | `web_ui.bind` : `web_ui.port` (`0` = ephemeral loopback) |
| Authentication | a bearer token, required | loopback only; `web_ui.password` for a non-loopback bind |

The web UI is not "always listening" either: it starts on demand — the tray's
**Settings** item, or `node src/cli.js config edit --gui` — serves that session, and
closes when you save or cancel. The automatic first-run prompt belongs to the tray;
`--headless` never shows it.

### Solve over HTTP

Turn on `[http]` and store the bearer token the way the other secrets are stored — the
tray's **Settings** editor, or `node src/cli.js config set http.token a-long-random-string`,
writes it to the credential store. Then post an image:

```bash
export HTTP_AUTH_TOKEN="a-long-random-string"   # this shell only
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  --data-binary @puzzle.png
```

The service reads the credential store, not this shell variable; a headless or unattended
run needs a **persistent** `HTTP_AUTH_TOKEN` (`setx`, or System Properties) instead,
because the app started at logon does not see a session assignment.

The response carries `answer`, `method`, `confident` and `cost`, or a `422` when no tier
produced a validated answer. The full contract — accepted bodies, status codes, the
`image_url` SSRF allowlist and its residual, the queue bound and the timeout — is in
[the HTTP API](./docs/http-api.md).

## What happens to a puzzle

A file push arrives over the Pushbullet stream (a 60 s poll is the fallback), or an
image arrives in an HTTP request body. Either way the image is verified (size, magic
bytes, a real decode, a sane height), cleaned (adaptive threshold → denoise → upscale),
read by offline Tesseract in Dutch, repaired, and parsed into a puzzle class. **Tier 0**
answers offline for the classes the lexicon and arithmetic cover; anything else escalates
to a **text model**, then a **vision model** over the image itself if OCR failed. Every
answer, offline or model, must pass the validator for its class, and model answers are
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
`systray2` cannot be loaded or its export shape is one the adapter does not recognize.

**The HTTP ingress will not start.** With `[http] enabled = true` and no token the app
refuses to start, naming `HTTP_AUTH_TOKEN` and `http_auth_token`. A `401` from a running
server means the `Authorization: Bearer ...` header is missing or does not match. A
`422` is not an error: either the puzzle was read but no tier produced a validated answer,
or one did and `reply.require_confidence` withheld it as uncorroborated. In both cases
`answer` is `null` - the same invariant as the Pushbullet path. See
[the HTTP API](./docs/http-api.md#status-codes-are-honest-not-approximate) for every
status code.

**No replies at all.** Check, in order: (1) a Pushbullet token is present
(`PUSHBULLET_TOKEN`, `--token`, or the credential store) — without it the service refuses
to start; (2) `reply.enabled` is `true` and `reply.require_confidence` is not
suppressing a merely validated answer; (3) the log and the listener state — a **grey
tray icon** means the listener has been quiet for 10 minutes, and the stream reconnects
with backoff while the 60 s poll is the second path; (4) the hourly answer budget
(`reply.max_per_hour`) has not been reached — acknowledgements have their own, looser cap
(`reply.unresolved_max_per_hour`), so a burst of unsolvable puzzles cannot starve a real
answer; both are editable in the settings editor; (5) a model tier needs a
key, and `offline_only = true` disables the model tiers entirely.

**A setting changed but nothing happened.** The editor and `config set` print which
changes apply live and which need a restart; the list is in
[configuration](./docs/configuration.md#some-settings-need-a-restart). The models, the
offline switches, the reply wording, the poll interval, `ocr.languages`, the breaker knobs,
the HTTP ingress and all three secrets are read at startup, so restart the service (Quit
and relaunch, or use the tray's **Restart** item). If a hand-edited `config.toml` now blocks
startup, the loader names the offending key; the editor keeps the previous file as
`config.toml.bak`, so copying that back is the way out.

### Where things live

| What | Windows | Linux/macOS |
|---|---|---|
| Install | `%LOCALAPPDATA%\Programs\PuzzleSolver` | — |
| Config | `%APPDATA%\PuzzleSolver\config.toml` | `${XDG_CONFIG_HOME:-~/.config}/PuzzleSolver/config.toml` |
| Credentials | `%APPDATA%\PuzzleSolver\credentials.dpapi` (DPAPI; a legacy `credentials.json` is migrated) | `${XDG_CONFIG_HOME:-~/.config}/puzzlesolver/credentials.json` |
| Log | `%LOCALAPPDATA%\Programs\PuzzleSolver\logs\app.log` | `${XDG_STATE_HOME:-~/.local/state}/puzzlesolver/logs/app.log` |
| State DB | `%LOCALAPPDATA%\PuzzleSolver\state.db` | `${XDG_DATA_HOME:-~/.local/share}/puzzlesolver/state.db` |
| Inbox | `%LOCALAPPDATA%\PuzzleSolver\inbox` | `${XDG_DATA_HOME:-~/.local/share}/puzzlesolver/inbox` |
| Stored images (opt-in) | `%LOCALAPPDATA%\PuzzleSolver\images` | `${XDG_DATA_HOME:-~/.local/share}/puzzlesolver/images` |

The log rotates at 5 MB × 3. `storage.retain_days` (default 7) prunes the inbox and old
attempt rows on startup.

**Stored review copies (`storage.keep_images`).** Off by default; when on, a bounded WebP
copy of each solve is kept for the recent-solves page, pruned with `storage.retain_days` /
`storage.max_images`. Sizes, file permissions and the serving route are in
[configuration](./docs/configuration.md#stored-review-copies).

**Uninstall.**

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\PuzzleSolver\uninstall.ps1"
```

It removes the per-user Startup entry first, then the install folder and the two per-user
data folders. Manually: delete
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PuzzleSolver-startup.vbs`, then
delete `%LOCALAPPDATA%\Programs\PuzzleSolver`, `%LOCALAPPDATA%\PuzzleSolver` and
`%APPDATA%\PuzzleSolver`.

## Known limitations

- **Pre-release.** 0.45.0 is a pre-release: expect rough edges and no stability promise.
  The **Pushbullet ingress has never run against the real Pushbullet service** — no
  account or token exists (issue #3) — so the app's primary path is exercised against
  fakes rather than observed end to end.
- **The native tray widget, the notification toast and the browser hand-off remain
  unverified on Windows.** The packaged `node.exe`, the app, `sharp`'s win32-x64 binary
  and the traineddata are smoke-tested on `windows-latest` by the package job, and the
  deploy job executes `install.ps1` (with and without `-NoStart`), observes the app it
  starts, inspects the per-user Startup shim, runs the packaged app's `--headless`
  start-and-refuse, checks `PuzzleSolver.vbs` launching a process, runs `uninstall.ps1`,
  and proves a failing installer exits non-zero without printing success.
  What a runner cannot provide is an interactive desktop: `systray2` needs a window
  station, so the **native tray widget** and the **notification toast** are still
  unverified, as is the `explorer.exe` browser hand-off for the settings UI (issue #56).
  The runner is an administrator, so the **unprivileged install path** (issue #163) has
  still never been exercised. The **DPAPI credential round trip** is executed on the
  runner: a plaintext file is migrated and removed by one process, and a second `node`
  process decrypts it from disk. What DPAPI cannot protect is a process running as the
  same user (see [First run](#first-run-the-app-asks)). `--headless` remains the
  supported fallback for an unattended machine.
- **A second start exits without listening.** The app takes a lock beside `state.db`, so a
  double-click (or the installer on a machine already running) refuses instead of starting
  a second listener that would answer every puzzle twice.
- **The web UI is plain HTTP and its non-loopback credential is transport-unprotected.**
  A remote-access password is verified as a `scrypt` verifier and failed logins are
  throttled, but the HTTP connection itself is not encrypted and the session token cannot
  be `Secure`. On an untrusted network, use a TLS-terminating reverse proxy; the password
  is not a substitute for one. See
  [Exposing the web UI beyond loopback](./docs/remote-access.md).
- **The settings and first-run UI opens in the default browser; the browser hand-off
  itself is not exercised on Windows.** The HTTP server, the one-time link token, the
  `Host` check, the form post and the save path are exercised on Linux in
  `tests/web-config.test.js`; the one seam that cannot be checked here is the
  `explorer.exe`/`xdg-open` hand-off to a real browser. `config edit` (or
  `node src/cli.js config edit`) remains the terminal editor for a headless machine.
- **Synthetic accuracy is not real accuracy.** Of the 287 corpus items, 281 are
  **synthetic** images and text from our own generator — which refuses to write an image
  the pipeline cannot read — 3 are real images, and 3 more are noisy transcripts derived
  from those same three images, so the synthetic figure is a **regression guard, not
  real-world accuracy** and the derived items are not independent evidence. The only real
  evidence is 3/3 on the three real images. Run `node src/cli.js accuracy` (or
  `npm run accuracy`) and read the provenance breakdown; the measured detail is in
  [DESIGN.md](./DESIGN.md) §10.
- **No form typing, no image grids.** It reads an image and replies; it does not act in
  a browser.

## Development

Requires **Node.js ≥ 22.13.0** (`node:sqlite` is unflagged from 22.13.0). No build step;
plain ESM.

```bash
npm install
npm test              # offline: no network, no token, no key
npm run test:corpus   # real images through real OCR, ~4s
npm run test:live     # opt-in; skips unless LLM_API_KEY is set
```

The Windows package is built by CI (`.github/workflows/package.yml`, on
`windows-latest`). [`AGENTS.md`](./AGENTS.md) holds the repo rules, the test/verification
workflow and what belongs in which document; [`DESIGN.md`](./DESIGN.md) is the
architecture reference.

## License

[Apache License 2.0](./LICENSE).
