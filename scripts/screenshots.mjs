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
 * It needs a real browser because the UI is an HTML page. Firefox's native headless
 * screenshot (`firefox --headless --screenshot`) is used rather than Playwright or
 * Puppeteer, so no dependency is added. Firefox is not installed on a plain Windows
 * dev box or in CI, which is exactly why this is **not** part of `npm test` - the
 * offline suite stays credential-free, network-free and browser-free.
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
 *     so the answer shown is genuine rather than a synthesised string.
 *
 * The script fetches the real pages from a loopback server and screenshots the
 * returned HTML. That is deliberate: `firefox --screenshot` can only issue a GET,
 * and the solve result only exists after a POST, so the result markup is fetched by
 * this process (exactly what a browser would receive) and then rendered. No external
 * resource is referenced by the pages, so the file:// render is identical to the
 * live one.
 *
 * See `docs/screenshots/README.md` for how to use these and what to do when the UI
 * changes.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { loadConfig } from '../src/config.js';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { createSolveCore } from '../src/solver/core.js';
import { openStore } from '../src/state/db.js';
import { createSettingsEditor } from '../src/ui/settings.js';
import { createWebSettingsServer } from '../src/ui/web-config.js';

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
[ui]
stats_recent_solves = 5
[http]
enabled = true
bind = "127.0.0.1"
port = 8765
`;

/**
 * Seed a synthetic solve history. The subjects are `demo/...` names, not Pushbullet
 * idents, and every answer/timing is invented - the only thing taken from the real
 * project is the shape of a row. One row is unresolved and one was solved by a model
 * so the page shows all three delivery verdicts.
 */
function seedHistory(store, setClock) {
  const base = Math.floor(Date.now() / 1000) - 6 * 3600;
  const rows = [
    { subject: 'demo/001-count-kleuren.png', answer: '2', method: 'tier0:count', klass: 'count', confident: true, ms: 1180, at: base, respond: { sent: true } },
    { subject: 'demo/003-arithmetic-acht-min-een.png', answer: '7', method: 'tier0:arithmetic', klass: 'arithmetic', confident: true, ms: 940, at: base + 1800, respond: { sent: true } },
    { subject: 'demo/002-ordinal-lichaamsdeel.png', answer: 'derde', method: 'model:text', klass: 'ordinal', confident: true, ms: 6120, at: base + 3600, respond: { sent: true } },
    { subject: 'demo/needs-model-001.png', answer: null, method: null, klass: 'unknown', confident: false, ms: 8420, at: base + 5400, respond: { sent: false, reason: 'no tier produced a valid answer' } },
    { subject: 'demo/needs-model-004.png', answer: 'Amsterdam', method: 'model:vision', klass: 'unknown', confident: true, ms: 15340, at: base + 7200, respond: { sent: true } },
    { subject: 'demo/005-count-vruchten.png', answer: '4', method: 'tier0:count', klass: 'count', confident: true, ms: 1020, at: base + 9000, respond: null },
  ];
  for (const row of rows) {
    setClock(row.at);
    store.record({
      subject: row.subject,
      stage: 'validate',
      payload: { answer: row.answer, method: row.method, class: row.klass, confident: row.confident, disputed: false },
      ok: row.answer != null,
      ms: row.ms,
    });
    if (row.respond) {
      setClock(row.at + 1);
      store.record({ subject: row.subject, stage: 'respond', payload: row.respond });
    }
  }
  // Two model stages so the page's "model calls made" figure is not zero.
  setClock(base + 3600);
  store.record({ subject: 'demo/002-ordinal-lichaamsdeel.png', stage: 'model-text', variant: 'openrouter/auto', payload: { ok: true } });
  setClock(base + 7200);
  store.record({ subject: 'demo/needs-model-004.png', stage: 'model-vision', variant: '~google/gemini-flash-latest', payload: { ok: true } });
  setClock(Math.floor(Date.now() / 1000));
}

/** Run Firefox's native headless screenshot. Absolute paths, no shell. */
function screenshot(url, pngPath) {
  const result = spawnSync(
    'firefox',
    ['--headless', '--screenshot', pngPath, `--window-size=${CAPTURE_WIDTH},${CAPTURE_HEIGHT}`, url],
    { encoding: 'utf8' }
  );
  if (result.error) {
    throw new Error(`could not run firefox (is it installed and on PATH?): ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`firefox exited ${result.status}: ${result.stderr || result.stdout}`);
  }
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

  let clock = Math.floor(Date.now() / 1000);
  const store = openStore({ path: join(fixtureDir, 'state.db'), now: () => clock });
  seedHistory(store, (value) => {
    clock = value;
  });

  let worker = null;
  let server = null;
  const rawFiles = [];
  const written = [];
  try {
    worker = await createOcrWorker();
    const core = createSolveCore({ worker, store, config });
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
      corpusReport: null,
      webUi: { bind: '127.0.0.1', port: 0 },
    });
    await server.start();
    const base = `http://127.0.0.1:${server.port}`;

    // Opening the launch URL both returns the settings page and opens the one-time
    // session the other pages need. `server.url` carries the launch token.
    const settings = await fetch(server.url);
    const settingsHtml = await settings.text();
    if (settings.status !== 200) throw new Error(`settings page returned ${settings.status}: ${settingsHtml}`);
    const session = /name="session" value="([^"]+)"/.exec(settingsHtml)?.[1];
    if (!session) throw new Error('the settings page carried no session token');

    const stats = await fetch(`${base}/stats?session=${encodeURIComponent(session)}`);
    const statsHtml = await stats.text();
    if (stats.status !== 200) throw new Error(`statistics page returned ${stats.status}: ${statsHtml}`);

    // The solve page runs the real offline solver over the committed corpus sample.
    const image = readFileSync(solveSample);
    const form = new FormData();
    form.append('image', new Blob([image], { type: 'image/png' }), '001-count-kleuren.png');
    const solve = await fetch(`${base}/solve?session=${encodeURIComponent(session)}`, { method: 'POST', body: form });
    const solveHtml = await solve.text();
    if (solve.status !== 200) throw new Error(`solve page returned ${solve.status}: ${solveHtml}`);
    if (!/Solved\./.test(solveHtml)) throw new Error('the committed corpus sample did not solve offline; refusing a misleading screenshot');

    // GET /login is always rendered, so the credential requirement is visible without
    // configuring a non-loopback bind.
    const login = await fetch(`${base}/login`);
    const loginHtml = await login.text();
    if (login.status !== 200) throw new Error(`login page returned ${login.status}: ${loginHtml}`);

    // Render each captured page and screenshot it.
    const pages = [
      ['settings', settingsHtml, 'settings.png'],
      ['statistics', statsHtml, 'statistics.png'],
      ['solve', solveHtml, 'solve.png'],
      ['login', loginHtml, 'login.png'],
    ];
    for (const [name, html, file] of pages) {
      const htmlPath = join(fixtureDir, `${name}.html`);
      const rawPath = join(fixtureDir, `${name}.raw.png`);
      writeFileSync(htmlPath, html);
      rawFiles.push(rawPath);
      screenshot(`file://${htmlPath}`, rawPath);
      const info = await writeTrimmedPng(rawPath, join(outDir, file));
      written.push({ file, ...info });
    }

    for (const entry of written) {
      console.log(`wrote docs/screenshots/${entry.file} (${entry.width}x${entry.height}, ${Math.round(entry.bytes / 1024)} KiB)`);
    }
  } finally {
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
