# README screenshots

The images in this directory are embedded in the top-level [`README.md`](../../README.md).
They show the loopback web UI, which is otherwise invisible until someone installs and
runs the app.

| File | Page it shows |
|---|---|
| `settings.png` | the settings editor (`Settings` in the tray, or `config edit --gui`), light theme |
| `settings-dark.png` | the same editor with the explicit dark theme selected (`?theme=dark`) |
| `statistics.png` | the read-only statistics page (recent solves, including the stored-image thumbnails, and the recorded-traffic aggregates) |
| `statistics-dark.png` | the same statistics page with the explicit dark theme selected (`?theme=dark`) |
| `solve.png` | the **Solve an uploaded image** page showing the result of a genuine offline solve |
| `login.png` | the sign-in page a non-loopback client sees when a remote-access credential is configured |

## How they are produced

```bash
npm run screenshots        # -> node scripts/screenshots.mjs
```

The script needs **Firefox** on `PATH` (it uses Firefox's native
`firefox --headless --screenshot`, so no screenshot dependency is added). Firefox is not
installed on a plain Windows dev box or in CI, which is why this is **not** part of
`npm test`: the offline suite stays credential-free, network-free and browser-free.

The script:

1. writes a throwaway fixture to `$TMPDIR/puzzlesolver-screenshots` — a fake
   `config.toml` and a seeded SQLite `state.db` with a synthetic solve history;
2. starts the real web UI on a loopback ephemeral port (`createWebSettingsServer`);
3. fetches the real settings page and the real statistics page, and POSTs a **committed
   corpus image** (`corpus/001-count-kleuren.png`) through the real solve route, so the
   answer shown (`2`, `tier0:count`) is a genuine offline solve rather than a
   synthesised string. The light pages are fetched with an explicit `theme=light`
   cookie so the committed images do not depend on the capture machine's OS colour
   preference, and the settings and statistics pages are also captured with
   `?theme=dark`;
4. screenshots the fetched HTML with Firefox at a fixed width, trims the blank canvas,
   and writes the six PNGs here;
5. stops the server, terminates the OCR worker, closes the store and deletes the temp
   directory — on success and on failure.

The pages are fetched from the live loopback server and then rendered from the returned
HTML because `firefox --screenshot` can only issue a `GET`, while the solve result only
exists after a `POST`. The pages reference no external resource, so the render is the
same as the live one.

## What is in the fixture (and what is not)

Everything in the images is a fixture, not a real profile:

- **No real config.** The config file lives in the temp directory; the paths printed at
  the top of each page are the placeholders `%APPDATA%\PuzzleSolver\config.toml` and
  `%APPDATA%\PuzzleSolver\credentials.dpapi`, not this machine's directories.
- **No real solve history.** The subjects are `demo/...` names, and every answer and
  timing is invented in `scripts/screenshots.mjs`. No Pushbullet iden, no image name
  from a real user, and no real `state.db` is touched. The recent-solves thumbnails are
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

Current cost in the repository: six PNGs, about **900 KiB** total (the two settings
captures are the largest at roughly 250 KiB each). They are committed as PNGs because the
UI is text and flat colour, which compresses well; keep them under ~500 KiB each by
adjusting `CAPTURE_WIDTH` in `scripts/screenshots.mjs` rather than by lowering quality.
