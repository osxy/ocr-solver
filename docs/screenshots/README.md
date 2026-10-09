# README screenshots

The images in this directory are embedded in the top-level [`README.md`](../../README.md).
They show the loopback web UI, which is otherwise invisible until someone installs and
runs the app.

| File | Page it shows |
|---|---|
| `settings.png` | the settings editor (`Settings` in the tray, or `config edit --gui`), light theme |
| `settings-dark.png` | the same editor with the explicit dark theme selected (`?theme=dark`) |
| `statistics.png` | the read-only statistics page (recent solves with their solved / withheld / unresolved verdicts and the stored-image thumbnails, the recorded-traffic aggregates, and the designed empty offline-corpus state) |
| `statistics-dark.png` | the same statistics page with the explicit dark theme selected (`?theme=dark`) |
| `solve.png` | the **Solve an uploaded image** page showing the result of a genuine offline solve |
| `login.png` | the sign-in page a non-loopback client sees when a remote-access credential is configured |

## How they are produced

```bash
npm run screenshots        # -> node scripts/screenshots.mjs
```

The script needs **Firefox** on `PATH`. It drives Firefox's built-in WebDriver BiDi
endpoint (`--remote-debugging-port`) through Node's built-in `WebSocket`, so no
screenshot or automation dependency is added. Firefox is not installed on a plain
Windows dev box or in CI, which is why this is **not** part of `npm test`: the offline
suite stays credential-free, network-free and browser-free.

BiDi is used rather than the one-shot `firefox --headless --screenshot` because the
statistics thumbnails carry `loading="lazy"`: the one-shot CLI captures at the load
event, before a lazy image has painted, while BiDi lets the script wait until every
image has loaded.

The script:

1. writes a throwaway fixture to `$TMPDIR/puzzlesolver-screenshots` — a fake
   `config.toml` and a seeded SQLite `state.db` with a synthetic solve history;
2. starts the real web UI on a loopback ephemeral port (`createWebSettingsServer`);
3. opens the launch URL, then captures the real pages **from their live HTTP URLs** at a
   fixed width with Firefox and trims the blank canvas. The light pages carry
   `?theme=light` and the dark ones `?theme=dark`, so the committed images do not depend
   on the capture machine's OS colour preference. The solve page is the one exception
   (see below); it POSTs a **committed corpus image**
   (`corpus/001-count-kleuren.png`) through the real solve route, so the answer shown
   (`2`, `tier0:count`) is a genuine offline solve rather than a synthesised string;
4. writes the six PNGs here;
5. stops the server, kills Firefox, terminates the OCR worker, closes the store and
   deletes the temp directory — on success and on failure.

The pages are captured from their **live loopback URLs**, so the server's
`Content-Security-Policy` header applies and the browser is the same one a user gets.
This matters: an earlier version wrote the fetched HTML to a `file://` document with the
thumbnails inlined as `data:` URLs, and a `file://` document carries no CSP header — so
the capture bypassed the very policy that (before `img-src 'self'` was added) blocked
the images. `scripts/screenshots.mjs` now waits for every `<img>` and **refuses to
write a page whose images did not render** (`naturalWidth === 0`), so a future CSP
regression fails the screenshot build instead of producing a flattering image.

The solve page is the one page that cannot be captured from its live URL: its result
only exists after a `POST`, and a browser navigation is a `GET`. The captured POST
response — body **and** headers, CSP included — is replayed over loopback HTTP
(`replay()`), so it is still a real HTTP document rather than a `file://` one. Every
other page is the live URL. Firefox runs against a throwaway profile inside the temp
directory, so no real browser profile or cookie store is touched.

## What is in the fixture (and what is not)

Everything in the images is a fixture, not a real profile:

- **No real config.** The config file lives in the temp directory; the paths printed at
  the top of each page are the placeholders `%APPDATA%\PuzzleSolver\config.toml` and
  `%APPDATA%\PuzzleSolver\credentials.dpapi`, not this machine's directories.
- **No real solve history.** The subjects are `demo/...` names, and every answer and
  timing is invented in `scripts/screenshots.mjs`. No Pushbullet iden, no image name
  from a real user, and no real `state.db` is touched. The recent-solves list includes a
  **withheld** candidate so the screenshot shows all three outcomes (solved, withheld,
  unresolved). The recent-solves thumbnails are
  produced by running the fixture's stored-image path over the **committed corpus
  sample**, so no real uploaded image is ever embedded.
- **No secret is read or written.** The settings editor is given no credential store at
  all, so every secret row renders as `not set`; no token or key can appear.
- **The solve image is the committed corpus sample**, which is already public in this
  repository. The script refuses to write a solve screenshot unless that sample solves.

## They go stale silently — this is the reason this file exists

A screenshot lies *silently*. It keeps showing a button that was renamed or a column
that was removed, and nobody notices. If you change the UI — `renderSettingsPage`,
`renderStatsPage`, `renderSolvePage`, `renderLoginPage`, `STYLE`, or the `SETTINGS`
list in `src/ui/settings.js` — **re-run `npm run screenshots` and commit the result**.
A reviewer should open the changed images before merging, because there is no automated
guard: a browser is deliberately absent from the offline suite.

Current cost in the repository: six PNGs, about **1.2 MiB** total (the two settings
captures are the largest at roughly 360 KiB each; the topic grouping added height rather
than width). They are committed as PNGs because the
UI is text and flat colour, which compresses well; keep them under ~500 KiB each by
adjusting `CAPTURE_WIDTH` in `scripts/screenshots.mjs` rather than by lowering quality.
