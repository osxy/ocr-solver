/**
 * Settings editor tests. The point of this suite is the two failure modes that make
 * the editor worse than no editor:
 *
 *   1. an invalid value reaching disk - every rejection is asserted to happen before
 *      the writer or the credential store is touched;
 *   2. a secret taking the config path - a token save is asserted to leave the TOML
 *      file byte-identical (and absent when it was absent).
 *
 * The real `validateConfig` and the real atomic writer run here; only `saveSecrets`
 * is a double, so the credential store is not written by this suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, validateConfig } from '../src/config.js';
import { verifyWebUiPassword } from '../src/ui/access.js';
import {
  ConfigEditError,
  SETTINGS,
  SettingValueError,
  applyLiveSettings,
  configToOverrides,
  createSettingsEditor,
  editConfigInPlace,
  getSetting,
  parseSettingValue,
  writeConfigAtomically,
} from '../src/ui/settings.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-settings-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** An editor over the real defaults, with a config path that need not exist yet. */
function makeEditor(t, { configPath = null, secrets = null, saveSecrets = null, ...overrides } = {}) {
  const dir = tempDir(t);
  const path = configPath ?? join(dir, 'config.toml');
  const secretsWrites = [];
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: path,
    secrets,
    saveSecrets:
      saveSecrets ??
      (async ({ entries }) => {
        secretsWrites.push(entries);
        return { saved: Object.keys(entries), providers: ['fake'] };
      }),
    ...overrides,
  });
  return { editor, path, dir, secretsWrites };
}

// ---------------------------------------------------------------------------
// The schema covers the issue's settings
// ---------------------------------------------------------------------------

test('every setting the issue names is editable', () => {
  const ids = SETTINGS.map((s) => s.id);
  // #35: the settings added after #27's list - the HTTP ingress (including its
  // secret token), Tier 0, the OCR reading controls, the breaker knobs and [image].
  for (const expected of [
    'http.enabled',
    'http.token',
    'http.bind',
    'http.port',
    'http.rate_limit_per_min',
    'http.timeout_ms',
    'http.max_body_bytes',
    'http.max_queue',
    'http.allow_image_url',
    'http.image_url_hosts',
    'solver.tier0',
    'solver.breaker_threshold',
    'solver.breaker_cooldown_sec',
    'ocr.languages',
    'ocr.min_confidence',
    'image.max_width',
    'image.max_pixels',
    'reply.unresolved_max_per_hour',
  ]) {
    assert.ok(ids.includes(expected), `${expected} must be editable`);
  }
  for (const expected of [
    'pushbullet.token',
    'llm.api_key',
    'solver.offline_only',
    'solver.escalate_to_vision',
    'solver.self_consistency_n',
    'solver.llm_text_model',
    'solver.llm_vision_model',
    'solver.llm_base_url',
    'reply.enabled',
    // Two settings the #27 list omitted; the editor must not be a partial view (#35).
    'reply.strategy',
    'reply.min_interval_sec',
    'reply.require_confidence',
    'reply.title',
    'reply.prefix',
    'reply.unresolved_title',
    'reply.unresolved_text',
    'pushbullet.poll_interval_sec',
    'pushbullet.history_mode',
    'storage.retain_days',
    'storage.log_images',
    'ocr.variants',
    'ui.tray',
    'ui.notify_on_unresolved',
  ]) {
    assert.ok(ids.includes(expected), `${expected} must be editable`);
  }
});

test('the editor lists current values, and secrets by presence only', (t) => {
  const { editor } = makeEditor(t, {
    secrets: { pushbullet: { value: 'o.super-secret-token', source: 'file' }, llm: { value: null, source: null } },
  });
  const items = editor.list();
  assert.equal(items.find((i) => i.id === 'solver.self_consistency_n').value, 3);
  assert.equal(items.find((i) => i.id === 'reply.title').value, 'Antwoord');
  const token = items.find((i) => i.id === 'pushbullet.token');
  assert.equal(token.secret, true);
  assert.equal(token.value, null, 'a secret value must never be returned');
  assert.equal(token.display, 'o.s… (file)', 'only a three-character prefix is shown');
  assert.equal(JSON.stringify(items).includes('super-secret-token'), false);
});

// ---------------------------------------------------------------------------
// Rejection happens before any write
// ---------------------------------------------------------------------------

test('an unparseable value is rejected and touches neither store', async (t) => {
  const { editor, path, secretsWrites } = makeEditor(t);
  assert.throws(() => editor.set('solver.self_consistency_n', 'zero'), SettingValueError);
  assert.throws(() => editor.set('pushbullet.history_mode', 'ignore-history'), SettingValueError);
  assert.throws(() => editor.set('ocr.variants', 'adaptive_25_020,not-a-variant'), SettingValueError);
  assert.throws(() => editor.set('nope.nope', 'true'), SettingValueError);
  assert.equal(editor.pending.size, 0, 'a rejected value must not become pending');
  const outcome = await editor.save();
  assert.deepEqual(outcome, { saved: false, reason: 'no-changes', changed: [] }, 'nothing pending means nothing to save');
  assert.equal(existsSync(path), false, 'no rejection may create a config file');
  assert.deepEqual(secretsWrites, []);
});

test('the assembled config is passed through validateConfig before the writer runs', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  let writerCalls = 0;
  let secretsCalls = 0;
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: path,
    saveSecrets: async () => {
      secretsCalls += 1;
      return { saved: [] };
    },
    // A rejecting validator stands in for "the loader would refuse this"; nothing
    // may be written when it throws.
    validate: () => {
      throw new ConfigError('solver.self_consistency_n must be >= 1, got 0');
    },
    writeConfig: () => {
      writerCalls += 1;
      return { path, backedUp: false };
    },
  });
  editor.set('solver.offline_only', 'true');
  await assert.rejects(() => editor.save(), /self_consistency_n must be >= 1/);
  assert.equal(writerCalls, 0, 'the writer must not run after validation failed');
  assert.equal(secretsCalls, 0, 'the credential store must not be touched either');
});

test('a rejected value leaves the existing file byte-identical', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const original = '[solver]\noffline_only = false\n';
  writeFileSync(path, original);
  const { editor } = makeEditor(t, { configPath: path });
  assert.throws(() => editor.set('pushbullet.poll_interval_sec', '-5'), SettingValueError);
  assert.equal(readFileSync(path, 'utf8'), original, 'the original file must be untouched');
});

test('the whole config is re-validated, not just the changed field, before any write', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  // Simulate a corrupt in-memory config: the edited field is valid, but the assembled
  // object is not, so the loader's gate must refuse it and the writer must not run.
  const invalidConfig = validateConfig({}).config;
  invalidConfig.solver.self_consistency_n = 0;
  let writerCalls = 0;
  const editor = createSettingsEditor({
    config: invalidConfig,
    configPath: path,
    saveSecrets: async () => ({ saved: [] }),
    writeConfig: () => {
      writerCalls += 1;
      return { path, backedUp: false };
    },
  });
  editor.set('solver.offline_only', 'true');
  await assert.rejects(() => editor.save(), /self_consistency_n must be >= 1/);
  assert.equal(writerCalls, 0, 'the writer must not run after validation failed');
  assert.equal(existsSync(path), false);
});

// ---------------------------------------------------------------------------
// A valid change is atomic and backed up
// ---------------------------------------------------------------------------

test('a config change is written atomically, keeps a backup, and round-trips through loadConfig', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const previous = '[solver]\nself_consistency_n = 3\n';
  writeFileSync(path, previous);

  const { editor } = makeEditor(t, { configPath: path });
  editor.set('solver.self_consistency_n', '5');
  editor.set('ui.notify_on_unresolved', 'false');
  const result = await editor.save();

  assert.equal(result.saved, true);
  assert.equal(result.backupPath, `${path}.bak`);
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), previous, 'the previous file is the backup');
  assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'config.toml.bak'], 'no temp file is left behind');

  const reloaded = loadConfig({ explicitPath: path, env: {} });
  assert.equal(reloaded.config.solver.self_consistency_n, 5);
  assert.equal(reloaded.config.ui.notify_on_unresolved, false);
});

test('a first save with no existing file creates no backup and a valid file', async (t) => {
  const { editor, path } = makeEditor(t);
  editor.set('reply.title', 'Answer');
  const result = await editor.save();
  assert.equal(result.backupPath, null);
  assert.equal(existsSync(`${path}.bak`), false);
  assert.equal(loadConfig({ explicitPath: path, env: {} }).config.reply.title, 'Answer');
});

test('only values that differ from the defaults are written', async (t) => {
  const { editor, path } = makeEditor(t);
  editor.set('solver.self_consistency_n', '5');
  await editor.save();
  const text = readFileSync(path, 'utf8');
  assert.match(text, /self_consistency_n = 5/);
  assert.equal(text.includes('poll_interval_sec'), false, 'untouched defaults are not pinned in the file');
  assert.equal(text.includes('min_interval_sec'), false);
});

test('configToOverrides keeps the differences and drops the defaults', () => {
  const config = validateConfig({}).config;
  config.solver.self_consistency_n = 5;
  config.reply.prefix = '>> ';
  const overrides = configToOverrides(config);
  assert.deepEqual(overrides, { solver: { self_consistency_n: 5 }, reply: { prefix: '>> ' } });
});

// ---------------------------------------------------------------------------
// Secrets take the credential path, never the TOML file
// ---------------------------------------------------------------------------

test('rotating the token writes the credential store and leaves config.toml absent', async (t) => {
  const { editor, path, secretsWrites } = makeEditor(t);
  editor.set('pushbullet.token', 'o.rotated-token');
  const result = await editor.save();

  assert.deepEqual(result.changed, ['pushbullet.token']);
  assert.deepEqual(secretsWrites, [{ pushbullet: 'o.rotated-token' }]);
  assert.equal(result.configPath, null, 'a secret-only save writes no config file');
  assert.equal(existsSync(path), false, 'the token must not create config.toml');
});

test('a secret-only save leaves an existing config file byte-identical', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const previous = '[reply]\ntitle = "Antwoord"\n';
  writeFileSync(path, previous);
  const { editor } = makeEditor(t, { configPath: path });
  editor.set('llm.api_key', 'sk-rotated');
  await editor.save();
  assert.equal(readFileSync(path, 'utf8'), previous, 'rotating a key must not rewrite the config');
});

test('the config file never contains the token, even in a mixed save', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const { editor } = makeEditor(t, { configPath: path });
  editor.set('pushbullet.token', 'o.TOKEN-MUST-NOT-APPEAR');
  editor.set('solver.offline_only', 'true');
  await editor.save();

  const text = readFileSync(path, 'utf8');
  assert.equal(text.includes('TOKEN-MUST-NOT-APPEAR'), false);
  assert.equal(/token|api[_-]?key|secret|password/i.test(text), false, 'no secret-shaped key is written');
  assert.match(text, /offline_only = true/);
});

test('#35: the HTTP token goes to the credential store, never config.toml, in a mixed save', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const { editor, secretsWrites } = makeEditor(t, { secrets: { http: { value: null, source: null } }, configPath: path });
  const token = 'a-long-random-enough-token';
  editor.set('http.token', token);
  editor.set('http.enabled', 'true');
  const result = await editor.save();

  assert.deepEqual(secretsWrites, [{ http: token }], 'the token reaches the credential-store seam');
  assert.deepEqual(result.secretsSaved, ['http']);
  const text = readFileSync(path, 'utf8');
  assert.equal(text.includes(token), false, 'the token must never appear in config.toml');
  assert.equal(/token|secret|password/i.test(text), false, 'no secret-shaped key is written');
  assert.match(text, /enabled = true/, 'the non-secret http setting is written');

  // And it round-trips as a non-secret setting via the loader (the token is not in it).
  const reloaded = loadConfig({ explicitPath: path, env: {} });
  assert.equal(reloaded.config.http.enabled, true);
});

test('#35: a weak HTTP token is rejected before anything is written', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const original = '[http]\nenabled = false\n';
  writeFileSync(path, original);
  const { editor, secretsWrites } = makeEditor(t, { configPath: path });
  // The same rule the server enforces at startup (#47): too short, a well-known
  // value, and too little variation.
  assert.throws(() => editor.set('http.token', 'short'), /http\.token is not usable/);
  assert.throws(() => editor.set('http.token', 'changeme'), /weak value/);
  assert.throws(() => editor.set('http.token', 'aaaaaaaaaaaaaaaaaa'), /variation/);
  assert.equal(editor.pending.size, 0);
  assert.deepEqual(secretsWrites, []);
  assert.equal(readFileSync(path, 'utf8'), original, 'a rejected token leaves the file byte-identical');
});

test('#35: every new non-secret setting round-trips through the real loader', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const { editor } = makeEditor(t, { configPath: path });
  const changes = [
    ['solver.tier0', 'false'],
    ['solver.breaker_threshold', '5'],
    ['solver.breaker_cooldown_sec', '120'],
    ['ocr.languages', 'nld, eng'],
    ['ocr.min_confidence', '42'],
    ['image.max_width', '1234'],
    ['image.max_pixels', '7654321'],
    ['http.enabled', 'true'],
    ['http.bind', '0.0.0.0'],
    ['http.port', '9999'],
    ['http.rate_limit_per_min', '7'],
    ['http.timeout_ms', '12345'],
    ['http.max_body_bytes', '1048576'],
    ['http.max_queue', '3'],
    ['http.allow_image_url', 'true'],
    ['http.image_url_hosts', 'images.example.test, 127.0.0.1'],
    ['reply.unresolved_max_per_hour', '90'],
    ['reply.strategy', 'clipboard+notify'],
    ['reply.min_interval_sec', '10'],
  ];
  for (const [id, value] of changes) editor.set(id, value);
  const result = await editor.save();
  assert.equal(result.saved, true);

  const config = loadConfig({ explicitPath: path, env: {} }).config;
  assert.equal(config.solver.tier0, false);
  assert.equal(config.solver.breaker_threshold, 5);
  assert.equal(config.solver.breaker_cooldown_sec, 120);
  assert.deepEqual(config.ocr.languages, ['nld', 'eng']);
  assert.equal(config.ocr.min_confidence, 42);
  assert.equal(config.image.max_width, 1234);
  assert.equal(config.image.max_pixels, 7654321);
  assert.equal(config.http.enabled, true);
  assert.equal(config.http.bind, '0.0.0.0');
  assert.equal(config.http.port, 9999);
  assert.equal(config.http.rate_limit_per_min, 7);
  assert.equal(config.http.timeout_ms, 12345);
  assert.equal(config.http.max_body_bytes, 1048576);
  assert.equal(config.http.max_queue, 3);
  assert.equal(config.http.allow_image_url, true);
  assert.deepEqual(config.http.image_url_hosts, ['images.example.test', '127.0.0.1']);
  assert.equal(config.reply.unresolved_max_per_hour, 90);
  assert.equal(config.reply.strategy, 'clipboard+notify');
  assert.equal(config.reply.min_interval_sec, 10);
});

test('#35: out-of-range new values are rejected and write nothing', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  const original = '[solver]\noffline_only = false\n';
  writeFileSync(path, original);
  const { editor } = makeEditor(t, { configPath: path });
  assert.throws(() => editor.set('http.port', '70000'), /http\.port must be <= 65535/);
  assert.throws(() => editor.set('ocr.min_confidence', '101'), /ocr\.min_confidence must be <= 100/);
  assert.throws(() => editor.set('solver.breaker_threshold', '0'), /solver\.breaker_threshold must be >= 1/);
  assert.throws(() => editor.set('image.max_pixels', '0'), /image\.max_pixels must be >= 1/);
  assert.throws(() => editor.set('reply.unresolved_max_per_hour', 'soon'), /must be an integer/);
  assert.equal(editor.pending.size, 0);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('#35: the HTTP token has no connection to test', async (t) => {
  const { editor } = makeEditor(t);
  const item = editor.list().find((i) => i.id === 'http.token');
  assert.equal(item.secret, true);
  assert.equal(item.testable, false, 'the editor must not offer a probe the token cannot answer');
  await assert.rejects(() => editor.test('http.token'), /no connection to test/);
});

test('the editor refuses an empty or whitespace-bearing secret', (t) => {
  const { editor } = makeEditor(t);
  assert.throws(() => editor.set('pushbullet.token', '   '), SettingValueError);
  assert.throws(() => editor.set('pushbullet.token', 'o.abc def'), /whitespace/);
  assert.throws(() => editor.set('llm.api_key', 'sk-a\nb'), /whitespace/);
});

// ---------------------------------------------------------------------------
// Test connection reuses the setup probes
// ---------------------------------------------------------------------------

test('the editor Test connection reuses the setup probe seam', async (t) => {
  const calls = [];
  const dir = tempDir(t);
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: join(dir, 'config.toml'),
    secrets: { pushbullet: { value: 'o.stored', source: 'file' } },
    saveSecrets: async () => ({ saved: [] }),
    testPushbullet: async (token) => {
      calls.push(token);
      return { ok: true, detail: 'accepted' };
    },
  });
  const result = await editor.test('pushbullet.token');
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['o.stored'], 'with no pending edit the stored value is probed');

  editor.set('pushbullet.token', 'o.pending');
  await editor.test('pushbullet.token');
  assert.deepEqual(calls, ['o.stored', 'o.pending'], 'a pending edit is probed before it is saved');
});

test('#79: the editor probes the configured provider, including a pending edit', async (t) => {
  const seen = [];
  const config = validateConfig({
    solver: { llm_base_url: 'https://openrouter.ai/api/v1', llm_text_model: 'openrouter/auto' },
  }).config;
  const editor = createSettingsEditor({
    config,
    configPath: join(tempDir(t), 'config.toml'),
    secrets: { llm: { value: 'sk-stored', source: 'file' } },
    saveSecrets: async () => ({ saved: [] }),
    testModel: async (key, options) => {
      seen.push({ key, ...options });
      return { ok: true, detail: 'ok' };
    },
  });

  await editor.test('llm.api_key');
  assert.deepEqual(seen[0], {
    key: 'sk-stored',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
  });

  // Testing before saving should report on the provider the user is about to use,
  // not the one still on disk.
  editor.set('solver.llm_base_url', 'https://api.example.test/v1');
  editor.set('solver.llm_text_model', 'example-model');
  await editor.test('llm.api_key');
  assert.deepEqual(seen[1], {
    key: 'sk-stored',
    baseUrl: 'https://api.example.test/v1',
    model: 'example-model',
  });
});

// ---------------------------------------------------------------------------
// Live versus restart
// ---------------------------------------------------------------------------

test('the web UI password is hashed to a scrypt verifier before it is stored (#65)', async (t) => {
  const { editor, secretsWrites, path } = makeEditor(t);
  editor.set('web_ui.password', 'hunter2');
  await editor.save();
  const stored = secretsWrites[0].web_ui;
  assert.match(stored, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(stored.includes('hunter2'), false, 'the password itself is never stored');
  assert.equal(verifyWebUiPassword('hunter2', stored), true);
  assert.equal(existsSync(path), false, 'a credential save does not create config.toml');
});

test('only settings the running process re-reads are marked live', () => {
  const live = SETTINGS.filter((s) => s.restart === false).map((s) => s.id).sort();
  // Each of these is read from the shared config object per solve/push/request:
  // `core.solve` re-reads tier0, variants, min_confidence and max_pixels;
  // `handlePush` and the HTTP request path re-read the image caps; `core.solve` and
  // `handlePush` re-read log_images and notify_on_unresolved. Everything captured at
  // listener/reasoner/responder/HTTP-server construction is `[restart]`.
  assert.deepEqual(live, [
    'image.max_pixels',
    'image.max_width',
    'ocr.min_confidence',
    'ocr.variants',
    'solver.tier0',
    'storage.log_images',
    'ui.notify_on_unresolved',
  ]);
  // `ocr.languages` is restart-bound even though it sits next to ocr.min_confidence:
  // the Tesseract worker is created once at startup, and the bundled traineddata is
  // `nld` only. The HTTP ingress and the breaker knobs are captured at construction.
  assert.equal(getSetting('ocr.languages').restart, true);
  assert.equal(getSetting('http.bind').restart, true);
  assert.equal(getSetting('http.port').restart, true);
  assert.equal(getSetting('solver.breaker_threshold').restart, true);
  assert.equal(getSetting('pushbullet.poll_interval_sec').restart, true);
  assert.equal(getSetting('pushbullet.token').restart, true);
});

test('applyLiveSettings copies the live values and leaves the rest for a restart', () => {
  const target = validateConfig({}).config;
  target.storage.log_images = false;
  target.solver.offline_only = false;
  const next = validateConfig({}).config;
  next.storage.log_images = true;
  next.solver.offline_only = true;

  const applied = applyLiveSettings(target, next, ['storage.log_images', 'solver.offline_only']);
  assert.deepEqual(applied, ['storage.log_images']);
  assert.equal(target.storage.log_images, true, 'the live value is applied in place');
  assert.equal(target.solver.offline_only, false, 'a restart-only value is not applied');
});

// ---------------------------------------------------------------------------
// The atomic writer itself
// ---------------------------------------------------------------------------

test('writeConfigAtomically refuses a missing path', () => {
  assert.throws(() => writeConfigAtomically({ path: '', config: {} }), /needs a path/);
});

test('a failing rename does not leave a temp file and does not clobber the original', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  writeFileSync(path, 'keep me\n');
  assert.throws(
    () =>
      writeConfigAtomically({
        path,
        config: { solver: { offline_only: true } },
        rename: () => {
          throw new Error('EXDEV');
        },
      }),
    /EXDEV/
  );
  assert.equal(readFileSync(path, 'utf8'), 'keep me\n');
  assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'config.toml.bak'], 'no temp file survives a failed rename');
});

// ---------------------------------------------------------------------------
// parseSettingValue directly
// ---------------------------------------------------------------------------

test('parseSettingValue accepts the human spellings and rejects the rest', () => {
  const boolean = getSetting('solver.offline_only');
  for (const yes of ['true', 'TRUE', '1', 'yes', 'on', true]) assert.equal(parseSettingValue(boolean, yes), true);
  for (const no of ['false', '0', 'no', 'off', false]) assert.equal(parseSettingValue(boolean, no), false);
  assert.throws(() => parseSettingValue(boolean, 'maybe'), /true or false/);

  const interval = getSetting('pushbullet.poll_interval_sec');
  assert.equal(parseSettingValue(interval, '30'), 30);
  assert.equal(parseSettingValue(interval, '0'), 0);
  assert.throws(() => parseSettingValue(interval, '-1'), />= 0/);
  assert.throws(() => parseSettingValue(interval, 'soon'), /must be a number/);

  const variants = getSetting('ocr.variants');
  assert.deepEqual(parseSettingValue(variants, 'adaptive_25_020, adaptive_15_020'), ['adaptive_25_020', 'adaptive_15_020']);
  assert.throws(() => parseSettingValue(variants, 'nope'), /unknown value/);

  const prefix = getSetting('reply.prefix');
  assert.equal(parseSettingValue(prefix, ''), '', 'the prefix is allowed to be empty');
  assert.throws(() => parseSettingValue(getSetting('reply.title'), '   '), /must not be empty/);
});

test('the multiline acknowledgement keeps its interior newlines', () => {
  const setting = getSetting('reply.unresolved_text');
  assert.equal(parseSettingValue(setting, '  line one\nline two  '), 'line one\nline two');
});

// ---------------------------------------------------------------------------
// Editing the config in place (#69): comments, blank lines and order survive
// ---------------------------------------------------------------------------

/** A file with comments, blank lines, unusual spacing, non-alphabetical order, a
 * commented-out key and a value containing `key =` inside a string. */
const FIDELITY_CONFIG = [
  '# my note about the file',
  '',
  '[solver]',
  '# keep the voting sample count',
  'self_consistency_n = 3   # inline note on the changed line',
  'llm_text_model    = "gpt-4o-mini"    # unusual spacing',
  '',
  '[reply]',
  'enabled = true',
  '# port = 8765',
  'note = "see port = 8765 above"',
  '',
  '[http]',
  'enabled = false',
  'port = 8765  # the real port',
  '',
].join('\n');

/** Assert the two texts differ on exactly one line, and return that line. */
function assertSingleLineDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  assert.equal(a.length, b.length, 'the edit must not add or remove a line');
  const differing = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) differing.push(i);
  assert.equal(
    differing.length,
    1,
    `expected exactly one differing line, got ${differing.length}: ${JSON.stringify(differing.map((i) => [a[i], b[i]]))}`
  );
  return { index: differing[0], before: a[differing[0]], after: b[differing[0]] };
}

/** Assert every line of `before` still appears, in order, in `after`. */
function assertLinesPreserved(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let cursor = 0;
  for (const line of a) {
    while (cursor < b.length && b[cursor] !== line) cursor += 1;
    assert.ok(cursor < b.length, `original line ${JSON.stringify(line)} is missing from the edited file`);
    cursor += 1;
  }
}

/** An editor over a written config file, so the writer can read it back. */
function editorOverConfig(t, text, overrides = {}) {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  writeFileSync(path, text);
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: path,
    saveSecrets: async () => ({ saved: [] }),
    ...overrides,
  });
  return { editor, path, dir };
}

test('#69: changing one setting leaves every other line byte-identical', async (t) => {
  const { editor, path } = editorOverConfig(t, FIDELITY_CONFIG);
  editor.set('solver.self_consistency_n', '5');
  const result = await editor.save();
  assert.equal(result.saved, true);

  const after = readFileSync(path, 'utf8');
  const diff = assertSingleLineDiff(FIDELITY_CONFIG, after);
  assert.equal(diff.before, 'self_consistency_n = 3   # inline note on the changed line');
  assert.equal(diff.after, 'self_consistency_n = 5   # inline note on the changed line');
  // And the specific content the issue calls out is still there, not merely "a comment".
  assert.match(after, /^# my note about the file$/m);
  assert.match(after, /^# keep the voting sample count$/m);
  assert.match(after, /^# port = 8765$/m);
  assert.match(after, /^note = "see port = 8765 above"$/m);
  assert.match(after, /^llm_text_model    = "gpt-4o-mini"    # unusual spacing$/m);
  assert.match(after, /^port = 8765  # the real port$/m);
});

test('#69: an inline comment on the changed line survives', async (t) => {
  const { editor, path } = editorOverConfig(t, FIDELITY_CONFIG);
  editor.set('http.port', '9999');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  assert.match(after, /^port = 9999  # the real port$/m);
});

test('#69: a commented-out key is not mistaken for the real one', async (t) => {
  const text = '[http]\n# port = 8765\nenabled = false\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('http.port', '9999');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  assert.match(after, /^# port = 8765$/m, 'the comment must stay a comment');
  assert.match(after, /^port = 9999$/m, 'the real key must be inserted');
  assertLinesPreserved(text, after);
  // The commented-out line was not turned into the setting.
  assert.equal(after.includes('# port = 9999'), false);
});

test('#69: a same-named key in another section is untouched', async (t) => {
  const text = '[reply]\nenabled = true\n\n[http]\nenabled = false\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('http.enabled', 'true');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  const diff = assertSingleLineDiff(text, after);
  assert.equal(diff.after, 'enabled = true');
  assert.match(after, /\[reply\]\nenabled = true/, 'the reply section keeps its own enabled');
});

test('#69: a new setting is inserted at the end of its section', async (t) => {
  const text = '[ui]\ntray = true\n\n[reply]\ntitle = "Antwoord"\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('ui.notify_on_unresolved', 'false');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  assert.match(after, /\[ui\]\ntray = true\nnotify_on_unresolved = false\n/);
  assertLinesPreserved(text, after);
});

test('#69: a multi-line array value refuses instead of being collapsed', async (t) => {
  const text = '[ocr]\nlanguages = [\n  "nld",\n  "eng",\n]\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('ocr.languages', 'nld, eng');
  await assert.rejects(() => editor.save(), ConfigEditError);
  assert.equal(readFileSync(path, 'utf8'), text, 'a refused edit writes nothing');
  assert.equal(existsSync(`${path}.bak`), false, 'a refused edit takes no backup');
});

test('#69: an array-of-tables refuses instead of being rewritten', async (t) => {
  const text = '[[extra]]\nname = "one"\n\n[ui]\ntray = true\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('ui.notify_on_unresolved', 'false');
  await assert.rejects(() => editor.save(), /array of tables/);
  assert.equal(readFileSync(path, 'utf8'), text, 'a refused edit writes nothing');
  assert.equal(existsSync(`${path}.bak`), false);
});

test('#69: a multi-line string value refuses instead of being rewritten', async (t) => {
  const text = '[reply]\nunresolved_text = """\nline one\nline two\n"""\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('reply.unresolved_text', 'line one\nline two');
  await assert.rejects(() => editor.save(), /spans more than one line/);
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('#69: the locator ignores a commented key and a key = inside a string', () => {
  const text = '[http]\n# port = 8765\nnote = "see port = 8765 above"\nport = 8765  # real\n';
  const out = editConfigInPlace(text, [{ path: ['http', 'port'], value: 9999 }], { http: { port: 9999 } });
  assert.match(out, /^# port = 8765$/m);
  assert.match(out, /^note = "see port = 8765 above"$/m);
  assert.match(out, /^port = 9999  # real$/m);
});

test('#69: a nested [section.sub] header does not shadow the target section', () => {
  const text = '[solver]\ntier0 = true\n\n[solver.sub]\ntier0 = false\n';
  const out = editConfigInPlace(text, [{ path: ['solver', 'tier0'], value: false }], { solver: { tier0: false } });
  assert.match(out, /\[solver\]\ntier0 = false\n/);
  assert.match(out, /\[solver\.sub\]\ntier0 = false\n/, 'the nested table is untouched');
});

test('#69: a brand-new section is created without touching existing content', async (t) => {
  const text = '[solver]\ntier0 = false\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('ui.notify_on_unresolved', 'false');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  assertLinesPreserved(text, after);
  assert.match(after, /\[ui\]\nnotify_on_unresolved = false\n/);
  assert.equal(after.startsWith('[solver]\ntier0 = false\n'), true, 'the existing section is first, unchanged');
});

test('#69: a reset-to-default key absent from the file is not inserted', async (t) => {
  const text = '[reply]\nenabled = true\n';
  const { editor, path } = editorOverConfig(t, text);
  // `reply.min_interval_sec` defaults to 3; setting it back to 3 is not an override, so
  // the file must stay exactly as it was.
  editor.set('reply.min_interval_sec', '3');
  await editor.save();
  assert.equal(readFileSync(path, 'utf8'), text);
});

test('#69: CRLF line endings are preserved outside the changed line', async (t) => {
  const text = '# note\r\n[http]\r\nport = 8765  # inline\r\nenabled = true\r\n';
  const { editor, path } = editorOverConfig(t, text);
  editor.set('http.port', '9999');
  await editor.save();
  const after = readFileSync(path, 'utf8');
  assert.equal(after, '# note\r\n[http]\r\nport = 9999  # inline\r\nenabled = true\r\n');
});

test('ui.stats_recent_solves is a bounded integer in the editor too (#64)', (t) => {
  const { editor } = makeEditor(t);
  for (const bad of ['0', '-1', '1.5', '101', 'five']) {
    assert.throws(() => editor.set('ui.stats_recent_solves', bad), SettingValueError, `${bad} must be rejected`);
  }
  assert.equal(editor.set('ui.stats_recent_solves', '25').value, 25);
  assert.equal(editor.set('ui.stats_recent_solves', '1').value, 1);
  assert.equal(editor.set('ui.stats_recent_solves', '100').value, 100);
});
