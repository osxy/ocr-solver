#!/usr/bin/env node
/**
 * Regenerate the web-UI screenshots that the README embeds (issue #92).
 *
 * A screenshot goes stale *silently*: it keeps showing a button that was renamed or
 * a column that was removed and nobody notices. This script is the answer to that -
 * run it and the committed images are regenerated from the current UI:
 *
 *     npm run screenshots
 *
 * It needs a real browser because the UI is an HTML page. Firefox is driven through
 * its built-in WebDriver BiDi endpoint (`--remote-debugging-port`) using Node's
 * built-in `WebSocket`, so no dependency is added and no external CDP client is
 * needed. BiDi is used rather than `firefox --headless --screenshot` because the
 * statistics page's thumbnails are `loading="lazy"`: the one-shot CLI captures at the
 * load event, before a lazy image has painted, while BiDi lets this script wait until
 * every image has loaded. Firefox is not installed on a plain Windows dev box or in
 * CI, which is exactly why this is **not** part of `npm test` - the offline suite stays
 * credential-free, network-free and browser-free.
 *
 * **The pages are captured from their live HTTP URLs** (#111). The previous version
 * saved the fetched HTML to a `file://` document and inlined each thumbnail as a
 * `data:` URL; a `file://` document carries no CSP header, so the render bypassed the
 * Content-Security-Policy that (before #111) refused every image. A screenshot that
 * bypasses the policy cannot catch a policy bug, and this one did not. Now the real
 * server answers the browser, so the real CSP applies, and `capture()` refuses to
 * write a page whose `<img>` elements did not actually render (`naturalWidth === 0`).
 *
 * The solve page is the one exception: its result only exists after a `POST`, and a
 * browser can only navigate with `GET`. Its captured response - body *and* headers,
 * CSP included - is replayed over loopback HTTP (`replay()`), so it is still a real
 * HTTP document rather than a `file://` one. Every other page is the live URL.
 *
 * Everything it captures is a fixture:
 *
 *   - the config file is written to a throwaway temp directory, never
 *     `~/.config/puzzlesolver/`;
 *   - the solve history is seeded into a throwaway SQLite database, never a real
 *     `state.db`;
 *   - no secret is read, written or rendered (the settings editor is given no
 *     credential store at all, so every secret row shows "not set");
 *   - the solve page runs the *real* offline solver over a committed corpus image,
 *     so the answer shown is genuine rather than a synthesised string;
 *   - Firefox runs against a throwaway profile inside the temp directory, so the
 *     capture touches no real browser profile or cookie store.
 *
 * See `docs/screenshots/README.md` for how to use these and what to do when the UI
 * changes.
 */
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { loadConfig } from '../src/config.js';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { createSolveCore } from '../src/solver/core.js';
import { openStore } from '../src/state/db.js';
import { createImageStore } from '../src/state/images.js';
import { createSettingsEditor } from '../src/ui/settings.js';
import { createWebSettingsServer } from '../src/ui/web-config.js';

import { buildHistory, FIXTURE_NOW } from './screenshot-fixture.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'docs', 'screenshots');
const fixtureDir = join(tmpdir(), 'puzzlesolver-screenshots');
const solveSample = join(repoRoot, 'corpus', '001-count-kleuren.png');

// Firefox captures the viewport, not the whole page, so it is given a canvas far
// taller than any page and the blank space is trimmed afterwards. `CAPTURE_WIDTH` is
// wide enough for the 60rem settings table.
const CAPTURE_WIDTH = 1000;
const CAPTURE_HEIGHT = 10000;

// The paths rendered at the top of every page. They are placeholders, not this
// machine's directories: the fixture never lives there, and a committed screenshot
// must not carry a real profile path (or a username inside a temp path).
const DISPLAY_CONFIG_PATH = '%APPDATA%\\PuzzleSolver\\config.toml';
const DISPLAY_CREDENTIAL_PATH = '%APPDATA%\\PuzzleSolver\\credentials.dpapi';

/**
 * The fixture config. Some values differ from the defaults so the settings page has
 * something real to show, and the comment says plainly that it is not a profile.
 */
const FIXTURE_CONFIG = `# Fixture written by scripts/screenshots.mjs. NOT a real profile - it lives in a
# temporary directory and is deleted when the script finishes.
[solver]
llm_base_url = "https://openrouter.ai/api/v1"
llm_text_model = "openrouter/auto"
llm_vision_model = "~google/gemini-flash-latest"
cost_tier = "medium"
allowed_models = ["openai/*", "google/gemini-*"]
[reply]
title = "Antwoord"
unresolved_title = "Puzzel niet opgelost"
[storage]
retain_days = 7
keep_images = true
max_images = 200
[ui]
stats_recent_solves = 5
[http]
enabled = true
bind = "127.0.0.1"
port = 8765
`;

/**
 * Seed the synthetic solve history that `buildHistory` plans. The subjects are
 * `demo/...` names, not Pushbullet idents, and every answer/timing is invented - the only
 * thing taken from the real project is the shape of a row. The plan's timestamps come
 * from the fixed clock (see `screenshot-fixture.mjs`), so a re-run records the same rows.
 */
function seedHistory(store, setClock) {
  for (const { at, entry } of buildHistory(FIXTURE_NOW)) {
    setClock(at);
    store.record(entry);
  }
  // Leave the clock at the fixed instant so anything recorded after seeding (the stored
  // review copies) carries a reproducible timestamp too.
  setClock(FIXTURE_NOW);
}

/** An ephemeral loopback port, for Firefox's WebDriver BiDi endpoint. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createHttpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Replay one captured response over loopback HTTP with the exact headers the app sent
 * (the CSP included). `firefox` can only navigate with GET, and the solve result only
 * exists after a POST, so this is the one page that cannot come from its live URL.
 */
function replay(html, headers) {
  const body = Buffer.from(html);
  const server = createHttpServer((req, res) => {
    res.writeHead(200, { ...headers, 'content-length': String(body.length) });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}

/** Connect to Firefox's BiDi WebSocket, retrying while the browser starts. */
async function connectBidi(port, firefoxState) {
  const endpoint = `ws://127.0.0.1:${port}/session`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (firefoxState.error) {
      throw new Error(`could not run firefox (is it installed and on PATH?): ${firefoxState.error.message}`);
    }
    try {
      const ws = new WebSocket(endpoint);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('the BiDi endpoint is not ready yet')), { once: true });
      });
      return ws;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`firefox did not open a WebDriver BiDi endpoint on ${endpoint}`);
}

/** A minimal BiDi request/response client over the WebSocket. */
function bidiClient(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id == null || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.type === 'error') reject(new Error(`${message.error}: ${message.message}`));
    else resolve(message.result);
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
}

/**
 * Trim the blank canvas Firefox captured and write the final PNG. A page taller than
 * `CAPTURE_HEIGHT` would be silently cut off, so that case is an error rather than a
 * half-rendered image in the repository.
 */
async function writeTrimmedPng(rawPath, outPath) {
  const { data, info } = await sharp(rawPath).trim({ threshold: 12 }).png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true });
  if (info.height >= CAPTURE_HEIGHT - 2) {
    throw new Error(`${outPath} filled the whole capture height; raise CAPTURE_HEIGHT in scripts/screenshots.mjs`);
  }
  writeFileSync(outPath, data);
  return { width: info.width, height: info.height, bytes: data.length };
}

async function main() {
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const fixtureConfigPath = join(fixtureDir, 'config.toml');
  writeFileSync(fixtureConfigPath, FIXTURE_CONFIG);
  const { config } = loadConfig({ explicitPath: fixtureConfigPath });

  let clock = FIXTURE_NOW;
  const store = openStore({ path: join(fixtureDir, 'state.db'), now: () => clock });
  seedHistory(store, (value) => {
    clock = value;
  });

  let worker = null;
  let server = null;
  let firefox = null;
  let bidi = null;
  let ws = null;
  let sessionEnded = false;
  let replayServer = null;

  /**
   * End the BiDi session exactly once. A second `session.end` after the browser has
   * already closed the session is never answered, and awaiting it hung this command for
   * ever (#114) - the hang was here, in `finally`, not in the event loop. Ending it once
   * lets the process reach its cleanup and exit.
   */
  const endSession = async () => {
    if (sessionEnded || !bidi) return;
    sessionEnded = true;
    try {
      await bidi('session.end');
    } catch {
      // The session may already be gone; the browser is killed below either way.
    }
  };
  try {
    worker = await createOcrWorker();
    // #100: the fixture's stored review copies come from the committed corpus sample,
    // never a real uploaded image. The image column is populated for three of the
    // synthetic solves so the screenshot shows a real thumbnail through the real
    // gated route.
    const imageStore = createImageStore({ store, dir: join(fixtureDir, 'images') });
    for (const subject of [
      'demo/001-count-kleuren.png',
      'demo/003-arithmetic-acht-min-een.png',
      'demo/needs-model-004.png',
    ]) {
      const row = store.db
        .prepare("SELECT id FROM attempts WHERE subject = ? AND stage = 'validate' ORDER BY id DESC LIMIT 1")
        .get(subject);
      if (row) await imageStore.save({ subject, attemptId: row.id, imagePath: solveSample });
    }

    const core = createSolveCore({ worker, store, config, imageStore });
    const editor = createSettingsEditor({
      config,
      configPath: fixtureConfigPath,
      secrets: null,
      saveSecrets: async () => ({ saved: [], providers: [] }),
    });
    server = createWebSettingsServer({
      controller: editor,
      // Display-only, so the committed image carries no real profile path.
      configPath: DISPLAY_CONFIG_PATH,
      credentialPath: DISPLAY_CREDENTIAL_PATH,
      config,
      inboxDir: join(fixtureDir, 'inbox'),
      solveCore: core,
      store,
      imageStore,
      corpusReport: null,
      webUi: { bind: '127.0.0.1', port: 0 },
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    // Pin the explicit light theme on the captured requests so the committed images do
    // not depend on the capture machine's OS colour preference. The dark variant is
    // captured separately, chosen with the same cookie/param the toggle sets.
    const light = { headers: { cookie: 'theme=light' } };

    // Opening the launch URL both returns the settings page and opens the one-time
    // session the other pages need. `server.url` carries the launch token.
    const settings = await fetch(server.url, light);
    const settingsHtml = await settings.text();
    if (settings.status !== 200) throw new Error(`settings page returned ${settings.status}: ${settingsHtml}`);
    const session = /name="session" value="([^"]+)"/.exec(settingsHtml)?.[1];
    if (!session) throw new Error('the settings page carried no session token');
    const sessionParam = encodeURIComponent(session);

    // Validate each page server-side before pointing the browser at it. The browser
    // capture below is the real check; these stop a 404 or an unexpected theme from
    // being committed as a screenshot.
    const stats = await fetch(`${base}/stats?session=${sessionParam}`, light);
    const statsHtml = await stats.text();
    if (stats.status !== 200) throw new Error(`statistics page returned ${stats.status}: ${statsHtml}`);
    if (!/src="\/images\/\d+\?/.test(statsHtml)) {
      throw new Error('the statistics page carried no thumbnail; refusing a screenshot without the image feature');
    }

    const statsDark = await fetch(`${base}/stats?session=${sessionParam}&theme=dark`);
    const statsDarkHtml = await statsDark.text();
    if (statsDark.status !== 200) throw new Error(`dark statistics page returned ${statsDark.status}: ${statsDarkHtml}`);
    if (!/data-theme="dark"/.test(statsDarkHtml)) throw new Error('the dark statistics capture did not render dark');

    // GET /login is always rendered, so the credential requirement is visible without
    // configuring a non-loopback bind.
    const login = await fetch(`${base}/login`, light);
    const loginHtml = await login.text();
    if (login.status !== 200) throw new Error(`login page returned ${login.status}: ${loginHtml}`);

    const dark = await fetch(`${base}/?session=${sessionParam}&theme=dark`);
    const darkHtml = await dark.text();
    if (dark.status !== 200) throw new Error(`dark settings page returned ${dark.status}: ${darkHtml}`);
    if (!/data-theme="dark"/.test(darkHtml)) throw new Error('the dark settings capture did not render dark');

    // Start Firefox against a throwaway profile, on a throwaway port, and drive it with
    // BiDi so this script can wait for lazy images before capturing.
    const bidiPort = await freePort();
    const profileDir = join(fixtureDir, 'firefox-profile');
    mkdirSync(profileDir, { recursive: true });
    const firefoxState = { error: null };
    firefox = spawn(
      'firefox',
      ['--headless', '--profile', profileDir, '--remote-debugging-port', String(bidiPort), `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`, 'about:blank'],
      { stdio: 'ignore' }
    );
    firefox.once('error', (error) => {
      firefoxState.error = error;
    });
    ws = await connectBidi(bidiPort, firefoxState);
    bidi = bidiClient(ws);
    await bidi('session.new', { capabilities: {} });
    const { context } = await bidi('browsingContext.create', { type: 'tab' });
    await bidi('browsingContext.setViewport', { context, viewport: { width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT } });

    /**
     * Navigate to `url`, wait until every `<img>` has loaded or errored, refuse a page
     * whose images did not actually render, then screenshot the viewport. The refusal
     * is the point: with the live URL, a CSP that blocks images now fails this script
     * instead of being papered over by a `file://` render.
     */
    const capture = async (name, url) => {
      await bidi('browsingContext.navigate', { context, url, wait: 'complete' });
      const evaluated = await bidi('script.evaluate', {
        expression:
          'Promise.all(Array.from(document.images).map((img) => img.complete ? true : new Promise((resolve) => {' +
          'img.addEventListener("load", () => resolve(true), { once: true });' +
          'img.addEventListener("error", () => resolve(false), { once: true });' +
          '}))).then(() => Array.from(document.images).map((img) => img.naturalWidth).join(","))',
        target: { context },
        awaitPromise: true,
        resultOwnership: 'none',
      });
      const widths = String(evaluated?.result?.value ?? '');
      const failed = widths === '' ? [] : widths.split(',').filter((width) => Number(width) === 0);
      if (failed.length > 0) {
        throw new Error(`${name}: ${failed.length} image(s) did not render (blocked by the CSP, or a 404); naturalWidth list: ${widths}`);
      }
      const { data } = await bidi('browsingContext.captureScreenshot', { context });
      const rawPath = join(fixtureDir, `${name}.raw.png`);
      writeFileSync(rawPath, Buffer.from(data, 'base64'));
      return rawPath;
    };

    const written = [];
    const shoot = async (name, url, file) => {
      const rawPath = await capture(name, url);
      const info = await writeTrimmedPng(rawPath, join(outDir, file));
      written.push({ file, ...info });
    };

    // Capture the pages that must show only the seeded history *before* the solve below
    // records its own row: the live statistics URL reflects the database at the moment
    // the browser navigates, not when it was fetched for validation. Every route
    // carries the session so it is admitted, and the theme so the capture does not
    // depend on the browser's OS preference.
    await shoot('settings', `${base}/?session=${sessionParam}&theme=light`, 'settings.png');
    await shoot('settings-dark', `${base}/?session=${sessionParam}&theme=dark`, 'settings-dark.png');
    await shoot('statistics', `${base}/stats?session=${sessionParam}&theme=light`, 'statistics.png');
    await shoot('statistics-dark', `${base}/stats?session=${sessionParam}&theme=dark`, 'statistics-dark.png');

    // The solve page runs the real offline solver over the committed corpus sample.
    const image = readFileSync(solveSample);
    const form = new FormData();
    form.append('image', new Blob([image], { type: 'image/png' }), '001-count-kleuren.png');
    const solve = await fetch(`${base}/solve?session=${sessionParam}`, { method: 'POST', body: form, ...light });
    const solveHtml = await solve.text();
    if (solve.status !== 200) throw new Error(`solve page returned ${solve.status}: ${solveHtml}`);
    if (!/Solved\./.test(solveHtml)) throw new Error('the committed corpus sample did not solve offline; refusing a misleading screenshot');

    // The solve result is a POST response, so it cannot be navigated to. Replay the
    // exact body and headers (CSP included) over loopback HTTP.
    replayServer = await replay(solveHtml, Object.fromEntries(solve.headers.entries()));
    await shoot('solve', replayServer.url, 'solve.png');

    // GET /login is always rendered, so the credential requirement is visible without
    // configuring a non-loopback bind.
    await shoot('login', `${base}/login?theme=light`, 'login.png');

    await bidi('browsingContext.close', { context });
    await endSession();

    for (const entry of written) {
      console.log(`wrote docs/screenshots/${entry.file} (${entry.width}x${entry.height}, ${Math.round(entry.bytes / 1024)} KiB)`);
    }
  } finally {
    await replayServer?.close();
    await endSession();
    // Close the BiDi WebSocket, bounded, while Firefox is still alive so the close
    // handshake is answered promptly. An open `WebSocket` is itself a live handle;
    // leaving it to chance made a hang indistinguishable from a successful run. The
    // bound keeps a stuck close from turning cleanup into an unbounded wait.
    if (ws && ws.readyState === 1 /* OPEN */) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        ws.addEventListener('close', done, { once: true });
        try {
          ws.close();
        } catch {
          done();
        }
      });
    }
    firefox?.kill('SIGKILL');
    await server?.stop();
    await worker?.terminate();
    store.close();
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`screenshots failed: ${err?.message ?? err}`);
  process.exitCode = 1;
});
