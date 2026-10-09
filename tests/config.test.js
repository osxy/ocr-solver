/**
 * Config tests. They assert the real default paths, the real default values and
 * the real OCR variant list - not a copy - because the whole point of the config
 * layer is that the production defaults are what runs. No network, no credentials.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  ConfigError,
  CONFIG_ENV_VAR,
  DEFAULTS,
  defaultConfigPath,
  defaultStatePath,
  loadConfig,
  resolveConfigPath,
  validateConfig,
} from '../src/config.js';
import { VARIANTS } from '../src/imaging/preprocess.js';
import { HISTORY_MODES } from '../src/pushbullet/listener.js';

const home = () => '/home/andre';

// ---------------------------------------------------------------------------
// Real default paths
// ---------------------------------------------------------------------------

test('the Windows default config path is %APPDATA%\\PuzzleSolver\\config.toml', () => {
  const appdata = 'C:\\Users\\andre\\AppData\\Roaming';
  const path = defaultConfigPath({ platform: 'win32', env: { APPDATA: appdata }, homedir: home });
  assert.equal(path, join(appdata, 'PuzzleSolver', 'config.toml'));
  assert.equal(basename(path), 'config.toml');
  assert.equal(basename(dirname(path)), 'PuzzleSolver');
  assert.ok(path.startsWith(appdata), `${path} must live under %APPDATA%`);
});

test('the Windows path falls back to the profile when APPDATA is unset', () => {
  const path = defaultConfigPath({ platform: 'win32', env: {}, homedir: () => 'C:\\Users\\andre' });
  assert.equal(path, join('C:\\Users\\andre', 'AppData', 'Roaming', 'PuzzleSolver', 'config.toml'));
});

test('the XDG default config path is ${XDG_CONFIG_HOME}/PuzzleSolver/config.toml', () => {
  const path = defaultConfigPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg/config' }, homedir: home });
  assert.equal(path, join('/xdg/config', 'PuzzleSolver', 'config.toml'));
});

test('with no XDG_CONFIG_HOME the config lives under ~/.config', () => {
  const path = defaultConfigPath({ platform: 'linux', env: {}, homedir: home });
  assert.equal(path, join('/home/andre', '.config', 'PuzzleSolver', 'config.toml'));
});

test('PUZZLESOLVER_CONFIG beats the platform default and --config beats both', () => {
  const env = { [CONFIG_ENV_VAR]: '/from/env/config.toml' };
  assert.equal(resolveConfigPath({ env, platform: 'linux', homedir: home }), '/from/env/config.toml');
  assert.equal(
    resolveConfigPath({ explicit: '/from/flag.toml', env, platform: 'linux', homedir: home }),
    '/from/flag.toml'
  );
  // An empty env var is unset, not a path of "".
  assert.equal(
    resolveConfigPath({ env: { [CONFIG_ENV_VAR]: '  ' }, platform: 'linux', homedir: home }),
    join('/home/andre', '.config', 'PuzzleSolver', 'config.toml')
  );
});

test('the default state path follows the platform data directories', () => {
  assert.equal(
    defaultStatePath({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Local' }, homedir: home }),
    join('C:\\Local', 'PuzzleSolver', 'state.db')
  );
  assert.equal(
    defaultStatePath({ platform: 'linux', env: { XDG_DATA_HOME: '/data' }, homedir: home }),
    join('/data', 'puzzlesolver', 'state.db')
  );
  assert.equal(
    defaultStatePath({ platform: 'linux', env: {}, homedir: home }),
    join('/home/andre', '.local', 'share', 'puzzlesolver', 'state.db')
  );
});

// ---------------------------------------------------------------------------
// The defaults are the spec
// ---------------------------------------------------------------------------

test('the built-in defaults match DESIGN 4.13 value by value', () => {
  const { config } = validateConfig({});
  assert.deepEqual(config.pushbullet, { poll_interval_sec: 60, history_mode: 'ignore' });
  assert.equal(config.solver.tier0, true);
  assert.equal(config.solver.self_consistency_n, 3);
  assert.equal(config.solver.escalate_to_vision, true);
  assert.equal(config.solver.llm_text_model, 'gpt-4o-mini');
  assert.equal(config.solver.llm_vision_model, 'gpt-4o');
  assert.equal(config.solver.llm_base_url, 'https://api.openai.com/v1');
  assert.equal(config.solver.offline_only, false);
  assert.deepEqual(config.ocr.languages, ['nld']);
  assert.equal(config.ocr.min_confidence, 0);
  assert.deepEqual(config.ocr.variants, ['adaptive_25_020', 'adaptive_25_020_c8', 'adaptive_15_020']);
  assert.equal(config.reply.enabled, true);
  assert.equal(config.reply.strategy, 'note-push');
  assert.equal(config.reply.title, 'Antwoord');
  assert.equal(config.reply.prefix, '');
  assert.equal(config.reply.unresolved_title, 'Puzzel niet opgelost');
  assert.match(config.reply.unresolved_text, /niet automatisch worden opgelost/);
  assert.match(config.reply.unresolved_text, /could not be solved automatically/);
  assert.equal(config.reply.require_confidence, true);
  assert.equal(config.reply.min_interval_sec, 3);
  assert.equal(config.reply.max_per_hour, 20);
  assert.equal(config.storage.retain_days, 7);
  assert.equal(config.ui.tray, true);
  assert.equal(config.ui.notify_on_unresolved, true);
});

test('the default OCR variants are the real preset names', () => {
  const { config } = validateConfig({});
  for (const name of config.ocr.variants) {
    assert.ok(name in VARIANTS, `${name} must be a real preset exported by preprocess.js`);
  }
});

test('the resilience and privacy knobs have defaults and reject bad values', () => {
  const { config } = validateConfig({});
  assert.equal(config.solver.breaker_threshold, 3);
  assert.equal(config.solver.breaker_cooldown_sec, 600);
  assert.equal(config.storage.log_images, false, 'image logging is opt-in');

  assert.throws(
    () => validateConfig({ solver: { breaker_threshold: 0 } }),
    (err) => err instanceof ConfigError && /solver\.breaker_threshold/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ solver: { breaker_threshold: 1.5 } }),
    (err) => err instanceof ConfigError && /solver\.breaker_threshold/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ solver: { breaker_cooldown_sec: -1 } }),
    (err) => err instanceof ConfigError && /solver\.breaker_cooldown_sec/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ storage: { log_images: 'yes' } }),
    (err) => err instanceof ConfigError && /storage\.log_images/.test(err.message)
  );
});

test('the HTTP ingress is off, loopback and token-gated by default', () => {
  const { config } = validateConfig({});
  assert.deepEqual(config.http, {
    enabled: false,
    bind: '127.0.0.1',
    port: 8765,
    rate_limit_per_min: 20,
    timeout_ms: 30_000,
    max_body_bytes: 5 * 1024 * 1024,
    max_queue: 8,
    // image_url fetch is an SSRF surface: off by default, default-deny allowlist (#57).
    allow_image_url: false,
    image_url_hosts: [],
  });
});

test('http.image_url_hosts default-denies and rejects anything but a bare host', () => {
  assert.equal(validateConfig({}).config.http.allow_image_url, false);
  assert.deepEqual(validateConfig({}).config.http.image_url_hosts, []);
  assert.deepEqual(
    validateConfig({ http: { allow_image_url: true, image_url_hosts: ['images.example.test', '127.0.0.1'] } }).config
      .http.image_url_hosts,
    ['images.example.test', '127.0.0.1']
  );
  // A URL, a wildcard or `host:port` never matches a hostname, so it is refused at
  // load instead of becoming a locked door the operator thinks is open.
  assert.throws(
    () => validateConfig({ http: { image_url_hosts: ['https://images.example.test'] } }),
    (err) => err instanceof ConfigError && /http\.image_url_hosts/.test(err.message) && /bare host/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { image_url_hosts: ['*.example.test'] } }),
    (err) => err instanceof ConfigError && /wildcard/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { image_url_hosts: ['images.example.test:8443'] } }),
    (err) => err instanceof ConfigError && /host:port/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { allow_image_url: 'yes' } }),
    (err) => err instanceof ConfigError && /http\.allow_image_url/.test(err.message)
  );
});

test('the HTTP ingress rejects a bad port, cap or interval by name', () => {
  assert.throws(
    () => validateConfig({ http: { port: 70_000 } }),
    (err) => err instanceof ConfigError && /http\.port/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { rate_limit_per_min: -1 } }),
    (err) => err instanceof ConfigError && /http\.rate_limit_per_min/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { max_body_bytes: 0 } }),
    (err) => err instanceof ConfigError && /http\.max_body_bytes/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { max_queue: 0 } }),
    (err) => err instanceof ConfigError && /http\.max_queue/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { max_queue: 1.5 } }),
    (err) => err instanceof ConfigError && /http\.max_queue/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { enabled: 'yes' } }),
    (err) => err instanceof ConfigError && /http\.enabled/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ http: { timeout_ms: 1.5 } }),
    (err) => err instanceof ConfigError && /http\.timeout_ms/.test(err.message)
  );
});

test('a config may tune the HTTP bind and limits', () => {
  const { config } = validateConfig({
    http: {
      enabled: true,
      bind: '0.0.0.0',
      port: 0,
      rate_limit_per_min: 0,
      timeout_ms: 60_000,
      max_body_bytes: 100,
      max_queue: 3,
    },
  });
  assert.equal(config.http.enabled, true);
  assert.equal(config.http.bind, '0.0.0.0');
  assert.equal(config.http.port, 0);
  assert.equal(config.http.rate_limit_per_min, 0);
  assert.equal(config.http.timeout_ms, 60_000);
  assert.equal(config.http.max_body_bytes, 100);
  assert.equal(config.http.max_queue, 3);
});

test('a config may tune the breaker and turn image logging on', () => {
  const { config } = validateConfig({
    solver: { breaker_threshold: 5, breaker_cooldown_sec: 30 },
    storage: { log_images: true },
  });
  assert.equal(config.solver.breaker_threshold, 5);
  assert.equal(config.solver.breaker_cooldown_sec, 30);
  assert.equal(config.storage.log_images, true);
});

test('the image gate limits are configurable and validated by name', () => {
  const { config } = validateConfig({});
  assert.deepEqual(config.image, { max_width: 2000, max_pixels: 1_000_000 });

  const tuned = validateConfig({ image: { max_width: 4096, max_pixels: 4_000_000 } }).config;
  assert.equal(tuned.image.max_width, 4096);
  assert.equal(tuned.image.max_pixels, 4_000_000);

  assert.throws(
    () => validateConfig({ image: { max_width: 0 } }),
    (err) => err instanceof ConfigError && /image\.max_width/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ image: { max_pixels: -1 } }),
    (err) => err instanceof ConfigError && /image\.max_pixels/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ image: { max_pixels: 1.5 } }),
    (err) => err instanceof ConfigError && /image\.max_pixels/.test(err.message)
  );
});

test('DEFAULTS is not mutated by a loaded config', () => {
  const loaded = loadConfig({ explicitPath: '/definitely/not/here.toml', env: {}, platform: 'linux', homedir: home });
  loaded.config.reply.title = 'Changed';
  assert.equal(DEFAULTS.reply.title, 'Antwoord');
});

// ---------------------------------------------------------------------------
// Loading a real file
// ---------------------------------------------------------------------------

test('a missing config file is normal and yields the defaults', () => {
  const loaded = loadConfig({ explicitPath: '/nope/absent.toml', env: {}, platform: 'linux', homedir: home });
  assert.equal(loaded.loaded, false);
  assert.equal(loaded.warnings.length, 0);
  assert.equal(loaded.config.reply.title, 'Antwoord');
  assert.equal(loaded.path, '/nope/absent.toml');
});

test('a real TOML file overrides the defaults', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.toml');
  writeFileSync(
    path,
    [
      '[pushbullet]',
      'poll_interval_sec = 15',
      'history_mode = "watermark"',
      '',
      '[reply]',
      'enabled = false',
      'title = "Puzzelantwoord"',
      'unresolved_title = "Niet gelukt"',
      'unresolved_text = "Kon de puzzel niet lezen."',
      '',
      '[ocr]',
      'variants = ["adaptive_15_020_x6"]',
      '',
    ].join('\n')
  );

  const loaded = loadConfig({ explicitPath: path, env: {}, platform: 'linux', homedir: home });
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.config.pushbullet.poll_interval_sec, 15);
  assert.equal(loaded.config.pushbullet.history_mode, 'watermark');
  assert.equal(loaded.config.reply.enabled, false);
  assert.equal(loaded.config.reply.title, 'Puzzelantwoord');
  assert.equal(loaded.config.reply.unresolved_title, 'Niet gelukt');
  assert.equal(loaded.config.reply.unresolved_text, 'Kon de puzzel niet lezen.');
  assert.deepEqual(loaded.config.ocr.variants, ['adaptive_15_020_x6']);
  // Untouched keys keep their defaults.
  assert.equal(loaded.config.reply.max_per_hour, 20);
});

test('malformed TOML fails loudly instead of silently using defaults', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'broken.toml');
  writeFileSync(path, '[pushbullet\npoll_interval_sec = "not toml');
  assert.throws(() => loadConfig({ explicitPath: path, env: {}, platform: 'linux', homedir: home }), ConfigError);
});

// ---------------------------------------------------------------------------
// Unknown keys warn, they do not crash
// ---------------------------------------------------------------------------

test('an unknown key warns but leaves the rest working', () => {
  const { config, warnings } = validateConfig({
    pushbullet: { poll_interval_sec: 30, from_a_newer_version: true },
    unknown_section: { a: 1 },
  });
  assert.equal(config.pushbullet.poll_interval_sec, 30);
  assert.deepEqual(warnings, [
    'unknown config key "pushbullet.from_a_newer_version" ignored',
    'unknown config section "unknown_section" ignored',
  ]);
});

// ---------------------------------------------------------------------------
// Bad values fail loudly and name the key
// ---------------------------------------------------------------------------

test('an unknown history_mode names the key', () => {
  assert.throws(
    () => validateConfig({ pushbullet: { history_mode: 'everything' } }),
    (err) => err instanceof ConfigError && /pushbullet\.history_mode/.test(err.message)
  );
  assert.deepEqual(HISTORY_MODES, ['ignore', 'watermark']);
});

test('an unknown reply strategy names the key', () => {
  assert.throws(
    () => validateConfig({ reply: { strategy: 'carrier-pigeon' } }),
    (err) => err instanceof ConfigError && /reply\.strategy/.test(err.message)
  );
});

test('an empty or non-string unresolved reply value is rejected and names the key', () => {
  assert.throws(
    () => validateConfig({ reply: { unresolved_text: '' } }),
    (err) => err instanceof ConfigError && /reply\.unresolved_text/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ reply: { unresolved_text: 42 } }),
    (err) => err instanceof ConfigError && /reply\.unresolved_text/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ reply: { unresolved_title: '' } }),
    (err) => err instanceof ConfigError && /reply\.unresolved_title/.test(err.message)
  );
});

test('a negative or non-numeric interval names the key', () => {
  assert.throws(
    () => validateConfig({ pushbullet: { poll_interval_sec: -1 } }),
    (err) => err instanceof ConfigError && /pushbullet\.poll_interval_sec/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ reply: { min_interval_sec: 'soon' } }),
    (err) => err instanceof ConfigError && /reply\.min_interval_sec/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ storage: { retain_days: -3 } }),
    (err) => err instanceof ConfigError && /storage\.retain_days/.test(err.message)
  );
});

test('an invalid OCR variant is checked against the real presets and named', () => {
  assert.throws(
    () => validateConfig({ ocr: { variants: ['adaptive_25_020', 'adaptive_made_up'] } }),
    (err) =>
      err instanceof ConfigError &&
      /ocr\.variants/.test(err.message) &&
      /adaptive_made_up/.test(err.message) &&
      /adaptive_25_020/.test(err.message)
  );
});

test('a boolean-shaped key must be a real boolean', () => {
  assert.throws(
    () => validateConfig({ reply: { enabled: 'yes' } }),
    (err) => err instanceof ConfigError && /reply\.enabled/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ solver: { self_consistency_n: 0 } }),
    (err) => err instanceof ConfigError && /solver\.self_consistency_n/.test(err.message)
  );
  assert.throws(
    () => validateConfig({ ocr: { min_confidence: 101 } }),
    (err) => err instanceof ConfigError && /ocr\.min_confidence/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Secrets never belong in the config file
// ---------------------------------------------------------------------------

test('a secret-looking key is rejected, nested or not', () => {
  for (const raw of [
    { pushbullet: { token: 'o.abcdef' } },
    { pushbullet: { api_key: 'sk-abcdef' } },
    { solver: { secret: 'hunter2' } },
    { password: 'hunter2' },
  ]) {
    assert.throws(
      () => validateConfig(raw),
      (err) => err instanceof ConfigError && /secret/i.test(err.message),
      `expected ${JSON.stringify(raw)} to be rejected`
    );
  }
});

test('the secret rejection says where secrets do belong', () => {
  assert.throws(
    () => validateConfig({ pushbullet: { token: 'o.abcdef' } }),
    /PUSHBULLET_TOKEN|credential store|environment/i
  );
});
