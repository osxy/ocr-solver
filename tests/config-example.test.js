/**
 * Guards for the commented example config (#181).
 *
 * The example exists so a new user can discover what is settable without reading the
 * source, and it must never become the next stale document. It is generated from
 * `DEFAULTS` and the settings registry, and these tests hold it to that: the text is
 * decommented and parsed with the same parser the loader uses, so the *values* are
 * compared, not just the key names.
 *
 * The two assertions the issue names are here and are mutation-provable:
 *
 *   1. every `section.key` the example shows exists in `DEFAULTS` - add an invented
 *      key to `buildExampleConfig()` and watch this test go red;
 *   2. no secret appears - a secret descriptor's id is not a key line, because the app
 *      refuses a config.toml that carries one, and shipping a file that contradicts the
 *      app's own refusal would be worse than shipping nothing.
 *
 * The whole suite is offline and credential-free: it reads two source modules and the
 * generated string, and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseToml } from 'smol-toml';
import { DEFAULTS } from '../src/config.js';
import { SETTINGS } from '../src/ui/settings.js';
import { buildExampleConfig, defaultExampleConfigPath, EXAMPLE_CONFIG_FILE } from '../src/config-example.js';

const example = buildExampleConfig();

/**
 * The example with the comment markers removed, keeping only the lines that would be
 * TOML: section headers, key lines and the body of a `"""` block. Prose header lines
 * and blank lines are dropped, so the result parses.
 */
function decommentToToml(text) {
  const out = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    const body = line.replace(/^# ?/, '');
    if (inBlock) {
      out.push(body);
      if (body.endsWith('"""')) inBlock = false;
      continue;
    }
    if (/^\[[A-Za-z0-9_]+\]$/.test(body) || /^[a-z0-9_]+ = /.test(body)) {
      out.push(body);
      if (/= """$/.test(body)) inBlock = true;
    }
  }
  return out.join('\n');
}

/** Every nested `section.key` in an object, as `DEFAULTS` uses. */
function keyPaths(node, prefix = '') {
  const paths = [];
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value != null && typeof value === 'object' && !Array.isArray(value)) paths.push(...keyPaths(value, path));
    else paths.push(path);
  }
  return paths;
}

test('every key the example shows exists in DEFAULTS', () => {
  const parsed = parseToml(decommentToToml(example));
  const known = new Set(keyPaths(DEFAULTS));
  const shown = keyPaths(parsed);

  assert.ok(shown.length > 0, 'the example parsed to no keys; the decommenter is broken');
  const invented = shown.filter((path) => !known.has(path));
  assert.deepEqual(
    invented,
    [],
    `the example shows keys that are not in DEFAULTS (src/config.js), so copying them into config.toml would warn and be ignored: ${invented.join(', ')}`
  );
});

test('the example shows every DEFAULTS key with its exact default', () => {
  const parsed = parseToml(decommentToToml(example));
  const shown = parsed;

  // Completeness: a key added to DEFAULTS must reach the example, or a reader cannot
  // discover it. This is the direction the docs already guard for (#138), applied here.
  const missing = keyPaths(DEFAULTS).filter((path) => {
    const [section, key] = [path.slice(0, path.indexOf('.')), path.slice(path.indexOf('.') + 1)];
    return shown[section]?.[key] === undefined;
  });
  assert.deepEqual(
    missing,
    [],
    `the example omits keys that are in DEFAULTS: ${missing.join(', ')}`
  );

  // Values: generated from DEFAULTS means the default shown is the default in use. A
  // key with the right name and a stale value is exactly the drift this prevents.
  const wrong = [];
  for (const path of keyPaths(DEFAULTS)) {
    const [section, key] = [path.slice(0, path.indexOf('.')), path.slice(path.indexOf('.') + 1)];
    if (JSON.stringify(shown[section]?.[key]) !== JSON.stringify(DEFAULTS[section][key])) {
      wrong.push(`${path}: example ${JSON.stringify(shown[section]?.[key])} vs DEFAULTS ${JSON.stringify(DEFAULTS[section][key])}`);
    }
  }
  assert.deepEqual(wrong, [], `the example's values drifted from DEFAULTS:\n${wrong.join('\n')}`);
});

test('no secret key appears in the example, and the header says where secrets go', () => {
  const parsed = parseToml(decommentToToml(example));
  const shown = new Set(keyPaths(parsed));

  const secretIds = SETTINGS.filter((setting) => setting.secret).map((setting) => setting.id);
  assert.ok(secretIds.length >= 4, `only ${secretIds.length} secret settings; the guard lost its subject`);
  const leaked = secretIds.filter((id) => shown.has(id));
  assert.deepEqual(
    leaked,
    [],
    `secret keys appear in the example, but config.toml rejects secret-shaped keys: ${leaked.join(', ')}`
  );

  // A file that shows where the config keys are but never says where the secrets go
  // leaves the reader where #172 found them. Each secret id must be named, and the
  // credential-store route (`config set`) must be the one offered.
  for (const id of secretIds) {
    assert.ok(example.includes(id), `the example must name the secret ${id} and tell the reader where it goes`);
  }
  assert.match(example, /config set/, 'the example must offer `config set` for secrets, the route the messages use');
  assert.match(example, /settings editor/i, 'the example must also name the settings editor');
  assert.doesNotMatch(example, /credentials\.json/, 'the example must not route secrets through the migration file');
});

test('the example is named config.toml.example and defaults to the config directory', () => {
  assert.equal(EXAMPLE_CONFIG_FILE, 'config.toml.example');
  // The absolute path is platform-joined, so assert the parts, not the separators:
  // the Windows deploy job asserts the real path on Windows (packaging/run-deploy.ps1).
  const win = defaultExampleConfigPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\Andre\\AppData\\Roaming' }, homedir: null });
  assert.ok(win.endsWith(EXAMPLE_CONFIG_FILE), win);
  assert.ok(win.includes('PuzzleSolver'), win);
  assert.ok(win.includes('Roaming'), 'the example belongs in the roaming config dir, not the install dir');
  const posix = defaultExampleConfigPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/andre/.config' }, homedir: null });
  assert.ok(posix.endsWith(EXAMPLE_CONFIG_FILE), posix);
  assert.ok(posix.includes('PuzzleSolver'), posix);
});

test('every line in the example is commented, so it can never pin a default', () => {
  const offenders = example
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.trim() !== '' && !line.startsWith('#'))
    .map(({ line, number }) => `${number}: ${line}`);
  assert.deepEqual(
    offenders,
    [],
    `these example lines are live TOML, so copying the file over config.toml would pin defaults at this version: ${offenders.join('; ')}`
  );
});
