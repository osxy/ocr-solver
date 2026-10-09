/**
 * Upgrade-review tests (issue #67).
 *
 * The feature exists so an install upgrading into a release that added settings is
 * told about them once, without ever being blocked or nagged. These tests hold the
 * parts that are easy to get subtly wrong:
 *
 *   - the offer is exactly the settings whose `since` is after the reviewed version,
 *     security-relevant first - not merely "something was offered";
 *   - a repeated start, a fresh install, and a downgrade offer nothing;
 *   - a skipped version still includes every intermediate release's additions;
 *   - a dismissal silences the prompt but leaves the editor's `[new]` badges;
 *   - the startup path opens no browser and does not touch `config.toml`;
 *   - the state lives in the store's `kv`, never in the config file.
 *
 * The mutation for each guard is recorded in the test name so a reviewer can revert
 * the guard and watch that one test go red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp, runApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';
import { memoryStore, openStore } from '../src/state/db.js';
import { SETTINGS, createSettingsEditor } from '../src/ui/settings.js';
import {
  PROMPTED_VERSION_KEY,
  REVIEWED_VERSION_KEY,
  baselineVersion,
  computeSettingsReview,
  newSettingsSince,
  planStartupReview,
  recordDismissal,
} from '../src/ui/settings-review.js';
import { renderSettingsPage, defaultWebSettingsDialog } from '../src/ui/web-config.js';
import { APP_VERSION, compareVersions } from '../src/version.js';

const repoRoot = join(import.meta.dirname, '..');

/** The v0.3.0 additions, in the security-first order the review emits. */
const V030 = Object.freeze([
  'http.allow_image_url',
  'http.image_url_hosts',
  'web_ui.bind',
  'web_ui.port',
  'web_ui.allowed_cidrs',
  'web_ui.allowed_hosts',
  'web_ui.password',
  'solver.cost_tier',
  'solver.allowed_models',
  'solver.excluded_models',
  'ui.stats_recent_solves',
]);

/** The v0.4.0 additions, in the offer's security-first order. Both are optional. */
const V040 = Object.freeze(['storage.keep_images', 'storage.max_images']);

/**
 * What an install last reviewed at v0.2.0 is offered now: the v0.3.0 security
 * settings first, then every non-security addition from v0.3.0 and v0.4.0 in
 * registry order. Spelled out so a reordering of the registry is caught.
 */
const SINCE_020 = Object.freeze([
  'http.allow_image_url',
  'http.image_url_hosts',
  'web_ui.bind',
  'web_ui.port',
  'web_ui.allowed_cidrs',
  'web_ui.allowed_hosts',
  'web_ui.password',
  'storage.keep_images',
  'storage.max_images',
  'solver.cost_tier',
  'solver.allowed_models',
  'solver.excluded_models',
  'ui.stats_recent_solves',
]);

/**
 * The same set in *registry* order. The editor and `config list` walk `SETTINGS` in
 * declaration order and mark the new ones, so their output is registry order, not the
 * security-first order the offer uses.
 */
const SINCE_020_REGISTRY = Object.freeze([
  'storage.keep_images',
  'storage.max_images',
  'http.allow_image_url',
  'http.image_url_hosts',
  'web_ui.bind',
  'web_ui.port',
  'web_ui.allowed_cidrs',
  'web_ui.allowed_hosts',
  'web_ui.password',
  'solver.cost_tier',
  'solver.allowed_models',
  'solver.excluded_models',
  'ui.stats_recent_solves',
]);

/** The v0.2.0 additions, established from the v0.2.0 tag's DEFAULTS. */
const V020 = Object.freeze([
  'reply.unresolved_title',
  'reply.unresolved_text',
  'reply.unresolved_max_per_hour',
  'image.max_width',
  'image.max_pixels',
  'http.enabled',
  'http.token',
  'http.bind',
  'http.port',
  'http.rate_limit_per_min',
  'http.timeout_ms',
  'http.max_body_bytes',
  'http.max_queue',
]);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function collectingLogger() {
  const logs = [];
  const logger = { logs };
  logger.info = (...args) => logs.push({ level: 'info', text: args.join(' ') });
  logger.warn = (...args) => logs.push({ level: 'warn', text: args.join(' ') });
  logger.debug = () => {};
  logger.error = () => {};
  return logger;
}

function captureStream() {
  let text = '';
  return {
    write(chunk) {
      text += String(chunk);
      return true;
    },
    get text() {
      return text;
    },
  };
}

async function makeReviewApp(t, { configText = null, store = memoryStore(), logger = collectingLogger(), ...overrides } = {}) {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  if (configText != null) writeFileSync(configPath, configText);
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const app = await createApp({
    configPath,
    env: {},
    providers: [],
    client: { token: 'o.review' },
    listener: { start: async () => {}, stop: () => {}, status: () => ({}) },
    reasoner: null,
    responder: { respond: async () => ({ sent: false }) },
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    logger,
    store,
    ...overrides,
  });
  t.after(async () => {
    try {
      await app.stop();
    } catch {
      // already stopped
    }
  });
  return { app, configPath, store, logger, dir };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test('#67: every descriptor carries a valid since covered by APP_VERSION', () => {
  for (const setting of SETTINGS) {
    assert.match(String(setting.since), /^\d+\.\d+\.\d+$/, `${setting.id} must have a since`);
    assert.ok(compareVersions(APP_VERSION, setting.since) >= 0, `${setting.id} since ${setting.since} is newer than APP_VERSION ${APP_VERSION}`);
  }
});

test('#67: APP_VERSION agrees with package.json so the registry cannot drift', () => {
  const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(APP_VERSION, version);
});

test('#67: the offer is exactly the settings introduced since the reviewed version', () => {
  // The precise assertion the issue asks for: the set, not "something was offered".
  // Revert the per-setting `since` comparison (e.g. compare releases only) and this
  // fails on the skipped-release test below; revert a `since` and it fails here.
  assert.deepEqual(newSettingsSince('0.2.0').map((setting) => setting.id), SINCE_020);
});

test('#67: the v0.4.0 additions are offered after a v0.3.0 review', () => {
  assert.deepEqual(newSettingsSince('0.3.0').map((setting) => setting.id), [...V040]);
});

test('#67: a skipped version includes both releases additions', () => {
  const ids = newSettingsSince('0.1.0').map((setting) => setting.id);
  for (const id of V020) assert.ok(ids.includes(id), `${id} (v0.2.0) must be included when 0.2.0 was skipped`);
  for (const id of V030) assert.ok(ids.includes(id), `${id} (v0.3.0) must be included`);
  // Nothing from the baseline release is "new": the baseline is not skipped.
  assert.equal(ids.includes('solver.tier0'), false);
  assert.equal(ids.includes('ui.tray'), false);
});

test('#67: security-relevant additions are ordered first', () => {
  // The baseline release's additions include non-security settings (the reply
  // wording) ahead of security ones in registry order. This test therefore catches a
  // removed `securityFirst` sort; the v0.3.0-only set happens to already be ordered.
  const offered = newSettingsSince('0.1.0');
  assert.equal(offered[0].securityRelevant, true);
  assert.equal(offered[0].id, 'http.enabled');
  const firstNonSecurity = offered.findIndex((setting) => setting.securityRelevant !== true);
  const lastSecurity = offered.reduce((last, setting, index) => (setting.securityRelevant === true ? index : last), -1);
  assert.ok(lastSecurity < firstNonSecurity, 'every security setting must precede every optional one');
  // #67 names the SSRF switch; in the v0.3.0-only set it is first and the optional
  // statistics knob is last.
  const latest = newSettingsSince('0.2.0');
  assert.equal(latest[0].id, 'http.allow_image_url');
  assert.equal(latest.at(-1).id, 'ui.stats_recent_solves');
});

test('#67: no recorded version falls back to the oldest release, not the current one', () => {
  assert.equal(baselineVersion(), '0.1.0');
  const ids = newSettingsSince(null).map((setting) => setting.id);
  assert.ok(ids.includes('image.max_pixels'), 'an existing install predating the registry still sees the v0.2.0 additions');
  assert.equal(ids.includes('solver.tier0'), false, 'the baseline release itself is not "new"');
});

// ---------------------------------------------------------------------------
// Offer semantics
// ---------------------------------------------------------------------------

test('#67: a second start does not re-offer (idempotent)', () => {
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  const logger = collectingLogger();

  const first = planStartupReview({ store, configLoaded: true, logger });
  assert.ok(first, 'the first start offers');
  assert.deepEqual(first.newSettings.map((setting) => setting.id), SINCE_020);
  assert.equal(logger.logs.filter((entry) => entry.text.includes('new setting')).length, 1);
  assert.equal(store.get(PROMPTED_VERSION_KEY), APP_VERSION, 'the offered baseline advances');

  const second = planStartupReview({ store, configLoaded: true, logger });
  assert.equal(second, null, 'the same start twice offers once');
  assert.equal(logger.logs.filter((entry) => entry.text.includes('new setting')).length, 1, 'no second log line');
});

test('#67: a fresh install does not trigger, even after first-run writes a config', () => {
  const store = memoryStore();
  const logger = collectingLogger();
  assert.equal(planStartupReview({ store, configLoaded: false, logger }), null);
  assert.equal(store.get(REVIEWED_VERSION_KEY), APP_VERSION, 'the fresh install is marked reviewed');
  assert.equal(store.get(PROMPTED_VERSION_KEY), APP_VERSION);
  // A later start now has a config file; it must not treat the registry as an upgrade.
  assert.equal(planStartupReview({ store, configLoaded: true, logger }), null);
  assert.equal(logger.logs.length, 0, 'a fresh install is never announced');
});

test('#67: a downgrade does not trigger', () => {
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '9.9.9');
  store.set(PROMPTED_VERSION_KEY, '9.9.9');
  const logger = collectingLogger();
  assert.equal(planStartupReview({ store, configLoaded: true, logger }), null);
  assert.deepEqual(computeSettingsReview({ store }).newSettings, []);
  assert.equal(logger.logs.length, 0);
});

test('#67: a dismissal suppresses the prompt but leaves the editor badges', () => {
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  recordDismissal(store, APP_VERSION);

  const review = computeSettingsReview({ store });
  assert.deepEqual(review.promptedSettings, [], 'the prompt is silenced');
  assert.deepEqual(review.newSettings.map((setting) => setting.id), SINCE_020, 'the settings stay visible as new');
});

// ---------------------------------------------------------------------------
// The editor surface
// ---------------------------------------------------------------------------

test('#67: the editor flags new settings and leaves the others unflagged', () => {
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: '/tmp/does-not-matter/config.toml',
    saveSecrets: async () => ({ saved: [] }),
    newSettingIds: ['http.allow_image_url'],
  });
  const items = editor.list();
  assert.equal(items.find((item) => item.id === 'http.allow_image_url').isNew, true);
  assert.equal(items.find((item) => item.id === 'solver.tier0').isNew, false);
  assert.equal(items.find((item) => item.id === 'http.allow_image_url').since, '0.3.0');
  assert.equal(items.find((item) => item.id === 'http.allow_image_url').securityRelevant, true);
});

test('#67: the web page marks new and security-relevant settings with a banner', () => {
  const items = [
    {
      id: 'ui.stats_recent_solves',
      label: 'Recent solves shown on the statistics page',
      secret: false,
      restart: true,
      type: 'integer',
      value: 5,
      display: '5',
      isNew: true,
      securityRelevant: false,
    },
    {
      id: 'http.allow_image_url',
      label: 'Allow image_url fetching (SSRF risk)',
      secret: false,
      restart: true,
      type: 'boolean',
      value: false,
      display: 'false',
      isNew: true,
      securityRelevant: true,
    },
    {
      id: 'solver.tier0',
      label: 'Use the offline tier (Tier 0)',
      secret: false,
      restart: false,
      type: 'boolean',
      value: true,
      display: 'true',
      isNew: false,
      securityRelevant: false,
    },
  ];
  const html = renderSettingsPage({ items, session: 'session-token' });
  assert.match(html, /setting\(s\) added since your last review/);
  // Row-level markers, so a removed badge is caught even though the banner also says
  // "[new]".
  assert.match(html, /<th>http\.allow_image_url<\/th>[^\n]*\[new\]/);
  assert.match(html, /<th>http\.allow_image_url<\/th>[^\n]*\[security\]/);
  // The offer summary is security-relevant first even though the optional setting is
  // first in the list (and therefore first in the rows) - #67's ordering rule.
  const bannerStart = html.indexOf('added since your last review');
  const banner = html.slice(bannerStart, html.indexOf('</div>', bannerStart));
  assert.ok(banner.includes('http.allow_image_url'), 'the security setting is in the banner');
  assert.ok(
    banner.indexOf('http.allow_image_url') < banner.indexOf('ui.stats_recent_solves'),
    'the security setting must be listed before the optional one'
  );
});

// ---------------------------------------------------------------------------
// The startup path in the assembled app
// ---------------------------------------------------------------------------

test('#67: startup offers the new settings, logs them, and leaves config.toml untouched', async (t) => {
  const original = '[solver]\n# a comment the user wrote\nself_consistency_n = 5\n';
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  const logger = collectingLogger();

  const { app, configPath } = await makeReviewApp(t, { configText: original, store, logger });

  assert.deepEqual(app.settingsReview?.newSettings?.map((setting) => setting.id), SINCE_020);
  assert.match(logger.logs.map((entry) => entry.text).join('\n'), /new setting\(s\) since 0\.2\.0/);
  assert.match(logger.logs.map((entry) => entry.text).join('\n'), /http\.allow_image_url/);
  // The offer is a notification, not a write. A save still has to go through the
  // editor's in-place writer, and only the user's own save changes the file.
  assert.equal(readFileSync(configPath, 'utf8'), original, 'the notification never rewrites config.toml');
});

test('#67: reviewing through the editor clears the badges and records the version in kv', async (t) => {
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  let seenNew = null;

  const { app } = await makeReviewApp(t, {
    configText: '[solver]\nself_consistency_n = 5\n',
    store,
    settingsDialog: async ({ editor }) => {
      seenNew = editor.list().filter((item) => item.isNew).map((item) => item.id);
      return { saved: false, cancelled: true };
    },
  });

  const outcome = await app.openSettings();
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(seenNew, SINCE_020_REGISTRY, 'the editor is shown exactly the new settings');
  assert.equal(store.get(REVIEWED_VERSION_KEY), APP_VERSION, 'the reviewed version is app state in kv');
  assert.deepEqual(app.settingsReview.newSettings, [], 'the badges are cleared after the review');
});

test('#87: a web UI that is never fetched keeps the badges but silences the prompt', async (t) => {
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  const { app } = await makeReviewApp(t, {
    configText: '[solver]\nself_consistency_n = 5\n',
    store,
    // The real dialog, but the browser never opened and nobody redeemed the URL, so
    // the server times out with `sessionOpened: false`. That is exactly the case that
    // used to clear the `[new]` badges without the settings ever being shown (#87).
    settingsDialog: (opts) =>
      defaultWebSettingsDialog({
        ...opts,
        openBrowser: async () => ({ opened: false }),
        timeoutMs: 30,
      }),
  });

  // createApp's startup offer already advanced the prompt baseline.
  assert.equal(store.get(PROMPTED_VERSION_KEY), APP_VERSION, 'the startup offer silences the prompt');

  const outcome = await app.openSettings();
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.sessionOpened, false, 'the launch link was never redeemed');
  // The two kv keys are the whole design: the prompt advances, the badge baseline does not.
  assert.equal(store.get(REVIEWED_VERSION_KEY), '0.2.0', 'the badges must survive a UI nobody saw');
  assert.equal(store.get(PROMPTED_VERSION_KEY), APP_VERSION, 'the prompt baseline stays advanced');
  assert.deepEqual(
    app.settingsReview.newSettings.map((setting) => setting.id),
    SINCE_020,
    'the settings are still offered as new'
  );
});

test('#67: headless startup opens no browser and no dialog, but logs and exposes the set', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '[solver]\nself_consistency_n = 5\n');
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const store = memoryStore();
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  const logger = collectingLogger();

  let browserCalls = 0;
  let dialogCalls = 0;
  let setupCalls = 0;
  const app = await runApp({
    configPath,
    env: {},
    providers: [],
    client: { token: 'o.review' },
    listener: { start: async () => {}, stop: () => {}, status: () => ({}) },
    reasoner: null,
    responder: { respond: async () => ({ sent: false }) },
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    store,
    logger,
    tray: false,
    openBrowser: async () => {
      browserCalls += 1;
      return { opened: true };
    },
    settingsDialog: async () => {
      dialogCalls += 1;
      return { saved: false, cancelled: true };
    },
    setupDialog: async () => {
      setupCalls += 1;
      return { saved: false, cancelled: true };
    },
  });
  t.after(() => app.stop());

  assert.equal(browserCalls, 0, 'no browser without a session');
  assert.equal(dialogCalls, 0, 'the offer does not auto-open the editor');
  assert.equal(setupCalls, 0);
  assert.match(logger.logs.map((entry) => entry.text).join('\n'), /config review/);
  assert.equal(app.settingsReview.newSettings.length, SINCE_020.length, 'the same set is inspectable headlessly');
});

test('#67: config review --dismiss suppresses the prompt and keeps the badges', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '[solver]\nself_consistency_n = 5\n');
  const dataDir = join(dir, 'data');
  const statePath = join(dataDir, 'puzzlesolver', 'state.db');
  const seed = openStore({ path: statePath });
  seed.set(REVIEWED_VERSION_KEY, '0.2.0');
  seed.set(PROMPTED_VERSION_KEY, '0.2.0');
  seed.close();

  const { runConfig } = await import('../src/config-cli.js');
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runConfig(['review', '--dismiss', '--config', configPath], {
    stdout,
    stderr,
    env: { XDG_DATA_HOME: dataDir },
    platform: 'linux',
    homedir: () => join(dir, 'home'),
  });
  assert.equal(code, 0, stderr.text);
  assert.match(stdout.text, /Dismissed/);

  const afterDismiss = openStore({ path: statePath });
  assert.equal(afterDismiss.get(PROMPTED_VERSION_KEY), APP_VERSION, 'the prompt is silenced');
  assert.equal(afterDismiss.get(REVIEWED_VERSION_KEY), '0.2.0', 'the badges are untouched');
  afterDismiss.close();

  // The settings stay findable through the CLI after a dismissal.
  const listed = captureStream();
  const code2 = await runConfig(['review', '--json', '--config', configPath], {
    stdout: listed,
    stderr,
    env: { XDG_DATA_HOME: dataDir },
    platform: 'linux',
    homedir: () => join(dir, 'home'),
  });
  assert.equal(code2, 0, stderr.text);
  assert.deepEqual(JSON.parse(listed.text).map((item) => item.id), SINCE_020_REGISTRY);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test('#67: the reviewed version is stored in the state kv table, surviving reopen', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'state.db');
  const store = openStore({ path });
  store.set(REVIEWED_VERSION_KEY, '0.2.0');
  store.set(PROMPTED_VERSION_KEY, '0.2.0');
  store.close();

  const reopened = openStore({ path });
  t.after(() => reopened.close());
  assert.equal(reopened.get(REVIEWED_VERSION_KEY), '0.2.0');
  assert.deepEqual(
    computeSettingsReview({ store: reopened }).newSettings.map((setting) => setting.id),
    SINCE_020
  );
});

// ---------------------------------------------------------------------------
// The CLI command
// ---------------------------------------------------------------------------

test('#67: config review --json prints exactly the new set and records the review', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  const original = '[solver]\nself_consistency_n = 5\n';
  writeFileSync(configPath, original);
  const dataDir = join(dir, 'data');
  const seed = openStore({ path: join(dataDir, 'puzzlesolver', 'state.db') });
  seed.set(REVIEWED_VERSION_KEY, '0.2.0');
  seed.set(PROMPTED_VERSION_KEY, '0.2.0');
  seed.close();

  const { runConfig } = await import('../src/config-cli.js');
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runConfig(['review', '--json', '--config', configPath], {
    stdout,
    stderr,
    env: { XDG_DATA_HOME: dataDir },
    platform: 'linux',
    homedir: () => join(dir, 'home'),
  });
  assert.equal(code, 0, stderr.text);
  const items = JSON.parse(stdout.text);
  assert.deepEqual(items.map((item) => item.id), SINCE_020_REGISTRY);
  assert.ok(items.every((item) => item.isNew === true));
  assert.equal(readFileSync(configPath, 'utf8'), original, 'reviewing does not modify the config file');

  const after = openStore({ path: join(dataDir, 'puzzlesolver', 'state.db') });
  assert.equal(after.get(REVIEWED_VERSION_KEY), APP_VERSION);
  after.close();
});

test('#67: config review presents the new set to the editor, security first', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '[solver]\nself_consistency_n = 5\n');
  const dataDir = join(dir, 'data');
  const seed = openStore({ path: join(dataDir, 'puzzlesolver', 'state.db') });
  seed.set(REVIEWED_VERSION_KEY, '0.2.0');
  seed.set(PROMPTED_VERSION_KEY, '0.2.0');
  seed.close();

  const { runConfig } = await import('../src/config-cli.js');
  const stdout = captureStream();
  const stderr = captureStream();
  let seenNew = null;
  const code = await runConfig(['review', '--config', configPath], {
    stdout,
    stderr,
    env: { XDG_DATA_HOME: dataDir },
    platform: 'linux',
    homedir: () => join(dir, 'home'),
    dialog: async ({ editor }) => {
      seenNew = editor.list().filter((item) => item.isNew).map((item) => item.id);
      return { saved: false, cancelled: true };
    },
  });
  assert.equal(code, 0, stderr.text);
  assert.deepEqual(seenNew, SINCE_020_REGISTRY);
  assert.match(stdout.text, /New settings since 0\.2\.0/);

  const after = openStore({ path: join(dataDir, 'puzzlesolver', 'state.db') });
  assert.equal(after.get(REVIEWED_VERSION_KEY), APP_VERSION);
  after.close();
});
