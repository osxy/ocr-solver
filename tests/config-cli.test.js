/**
 * `node src/cli.js config ...` tests. The command is exercised **as a command** - a
 * child process, real files, a real exit code - because the recurring lesson in this
 * repository is that a tested function is not a delivered feature. `--headless` has no
 * tray, so this command is the settings editor for an unattended machine.
 *
 * Every child gets an isolated `XDG_CONFIG_HOME` (the credential store) and an
 * explicit `--config` path, and the ambient token/key variables are blanked, so the
 * suite never reads or writes a real credential.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, defaultStatePath } from '../src/config.js';
import { runConfig as runConfigCommand } from '../src/config-cli.js';
import { openStore } from '../src/state/db.js';
import { PROMPTED_VERSION_KEY, REVIEWED_VERSION_KEY } from '../src/ui/settings-review.js';
import { APP_VERSION } from '../src/version.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

function makeEnv(dir, extra = {}) {
  return {
    ...process.env,
    PUSHBULLET_TOKEN: '',
    LLM_API_KEY: '',
    HTTP_AUTH_TOKEN: '',
    PUZZLESOLVER_CONFIG: '',
    XDG_CONFIG_HOME: join(dir, 'xdg'),
    XDG_DATA_HOME: join(dir, 'data'),
    ...extra,
  };
}

function runConfig(t, args, { extraEnv = {}, input = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.toml');
  const result = spawnSync(process.execPath, [CLI, 'config', ...args, '--config', configPath], {
    encoding: 'utf8',
    input,
    env: makeEnv(dir, extraEnv),
  });
  return { ...result, dir, configPath, credentialsPath: join(dir, 'xdg', 'puzzlesolver', 'credentials.json') };
}

test('config list prints every setting, the path and no secret value', (t) => {
  const setup = runConfig(t, ['list']);
  // Seed a credential file, then re-run in the same directory is impossible with the
  // helper's fresh dir, so seed via `set` and assert on that run instead below. Here
  // the plain list must still succeed and name the settings.
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /solver\.self_consistency_n\s+3\s+\[restart\]/);
  assert.match(setup.stdout, /ui\.notify_on_unresolved\s+true\s+\[live\]/);
  assert.match(setup.stdout, /pushbullet\.token\s+not set/);
});

test('config list reports a stored token by presence and source, never by value', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.toml');
  const credentialsPath = join(dir, 'xdg', 'puzzlesolver', 'credentials.json');
  mkdirSync(dirname(credentialsPath), { recursive: true });
  // Write the credential file the loader reads.
  writeFileSync(credentialsPath, JSON.stringify({ pushbullet_token: 'o.SECRET-MUST-NOT-PRINT' }));

  const result = spawnSync(process.execPath, [CLI, 'config', 'list', '--config', configPath], {
    encoding: 'utf8',
    env: makeEnv(dir),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pushbullet\.token\s+o\.S… \(file\)/);
  assert.equal(result.stdout.includes('SECRET-MUST-NOT-PRINT'), false, 'the value must never be printed');
  assert.equal(result.stdout.includes('o.SECRET'), false);
});

test('config set persists a value and names it as needing a restart', (t) => {
  const result = runConfig(t, ['set', 'solver.self_consistency_n', '5']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved: solver\.self_consistency_n/);
  assert.match(result.stdout, /Restart the service for: solver\.self_consistency_n/);
  assert.equal(loadConfig({ explicitPath: result.configPath, env: {} }).config.solver.self_consistency_n, 5);
});

test('config set says when a value applies live instead of restarting', (t) => {
  const result = runConfig(t, ['set', 'ui.notify_on_unresolved', 'false']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Applied live: ui\.notify_on_unresolved/);
  assert.equal(result.stdout.includes('Restart the service'), false);
});

test('a rejected value exits non-zero, names the setting, and writes nothing', (t) => {
  const result = runConfig(t, ['set', 'solver.self_consistency_n', 'zero']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /solver\.self_consistency_n/);
  assert.equal(existsSync(result.configPath), false, 'a rejected value must not create a config file');
});

test('an unknown setting is refused with a non-zero exit', (t) => {
  const result = runConfig(t, ['set', 'nope.nope', 'true']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown setting/);
});

test('setting the token as a command writes the credential store and never config.toml', (t) => {
  const result = runConfig(t, ['set', 'pushbullet.token', 'o.COMMAND-ROTATED']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Saved: pushbullet\.token/);
  assert.equal(existsSync(result.configPath), false, 'a token must never create config.toml');
  const credentials = JSON.parse(readFileSync(result.credentialsPath, 'utf8'));
  assert.equal(credentials.pushbullet_token, 'o.COMMAND-ROTATED');
});

test('#35: config set solver.tier0 applies live and persists', (t) => {
  const result = runConfig(t, ['set', 'solver.tier0', 'false']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Applied live: solver\.tier0/);
  assert.equal(loadConfig({ explicitPath: result.configPath, env: {} }).config.solver.tier0, false);
});

test('#35: config set http.enabled persists the ingress switch and asks for a restart', (t) => {
  const result = runConfig(t, ['set', 'http.enabled', 'true']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Restart the service for: http\.enabled/);
  assert.equal(loadConfig({ explicitPath: result.configPath, env: {} }).config.http.enabled, true);
});

test('#35: the HTTP token reaches the credential store, never config.toml, through config edit', (t) => {
  const token = 'a-long-random-enough-token';
  const result = runConfig(t, ['edit'], { input: `http.token\n${token}\nhttp.enabled\ntrue\n\ny\n` });
  assert.equal(result.status, 0, result.stderr);
  const credentials = JSON.parse(readFileSync(result.credentialsPath, 'utf8'));
  assert.equal(credentials.http_auth_token, token);
  const text = readFileSync(result.configPath, 'utf8');
  assert.equal(text.includes(token), false, 'the token must not appear in config.toml');
  assert.match(text, /enabled = true/);
  assert.equal(loadConfig({ explicitPath: result.configPath, env: {} }).config.http.enabled, true);
});

test('#35: a weak HTTP token through config set exits non-zero and writes nothing', (t) => {
  const result = runConfig(t, ['set', 'http.token', 'short']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /http\.token is not usable/);
  assert.equal(existsSync(result.configPath), false);
  assert.equal(existsSync(result.credentialsPath), false, 'a rejected token must not create the store');
});

test('config edit runs the guided editor over stdin and saves the change', (t) => {
  // change> id, value, blank change> (finish), confirm.
  const result = runConfig(t, ['edit'], { input: 'solver.self_consistency_n\n7\n\ny\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PuzzleSolver settings/);
  assert.match(result.stdout, /Restart the service for: solver\.self_consistency_n/);
  assert.equal(loadConfig({ explicitPath: result.configPath, env: {} }).config.solver.self_consistency_n, 7);
});

test('config edit reports a rejection and keeps the prior value', (t) => {
  const result = runConfig(t, ['edit'], { input: 'solver.self_consistency_n\nzero\n\ny\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rejected: solver\.self_consistency_n/);
  assert.equal(existsSync(result.configPath), false, 'only the rejected change was queued');
});

/**
 * Drop Node's own runtime warnings before asserting the command printed no error.
 * Node 22 emits `ExperimentalWarning: SQLite ...` on import of `node:sqlite`; it is the
 * runtime talking, not the command, and it is not what this test is about.
 */
function withoutNodeWarnings(stderr) {
  return stderr
    .split('\n')
    .filter((line) => !/^\(node:\d+\) ExperimentalWarning:/.test(line) && !/^\(Use `node --trace-warnings/.test(line))
    .join('\n')
    .trim();
}

test('config --help is a usage page, not an error', (t) => {
  const result = runConfig(t, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /config list/);
  assert.match(result.stdout, /config edit/);
  assert.equal(withoutNodeWarnings(result.stderr), '', '--help itself must not write to stderr');
});

// ---------------------------------------------------------------------------
// `config edit --gui`: the web editor wiring, off-browser
// ---------------------------------------------------------------------------

/** A minimal capture stream that keeps everything written to it. */
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

test('config edit --gui drives the injected web dialog, not the terminal prompt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stdout = captureStream();
  const stderr = captureStream();
  let guiCalls = 0;
  let terminalCalls = 0;

  const code = await runConfigCommand(['edit', '--gui', '--config', join(dir, 'config.toml')], {
    stdout,
    stderr,
    env: {},
    platform: 'linux',
    homedir: () => join(dir, 'home'),
    dialog: async () => {
      terminalCalls += 1;
      return { saved: false, cancelled: true };
    },
    guiDialog: async ({ editor, configPath, openBrowser }) => {
      guiCalls += 1;
      assert.equal(typeof editor.list, 'function', 'the web dialog receives the real editor');
      assert.match(configPath, /config\.toml$/);
      assert.equal(openBrowser, undefined, 'no browser override is supplied by default');
      return { saved: false, cancelled: true };
    },
  });

  assert.equal(code, 0, stderr.text);
  assert.equal(guiCalls, 1, '--gui must select the web dialog');
  assert.equal(terminalCalls, 0, '--gui must not fall back to the terminal prompt');
});

test('#87: config edit --gui that is never fetched keeps the badges but silences the prompt', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-config-cli-87-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '[solver]\nself_consistency_n = 5\n');
  const env = { XDG_DATA_HOME: join(dir, 'data') };
  const homedir = () => join(dir, 'home');
  const statePath = defaultStatePath({ platform: 'linux', env, homedir });
  const seed = openStore({ path: statePath });
  seed.set(REVIEWED_VERSION_KEY, '0.2.0');
  seed.set(PROMPTED_VERSION_KEY, '0.2.0');
  seed.close();

  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runConfigCommand(['edit', '--gui', '--config', configPath], {
    stdout,
    stderr,
    env,
    platform: 'linux',
    homedir,
    guiDialog: async () => ({ saved: false, cancelled: true, sessionOpened: false }),
  });
  assert.equal(code, 0, stderr.text);

  const after = openStore({ path: statePath });
  t.after(() => after.close());
  assert.equal(after.get(REVIEWED_VERSION_KEY), '0.2.0', 'a UI that never rendered must not clear the badges');
  assert.equal(after.get(PROMPTED_VERSION_KEY), APP_VERSION, 'but the prompt baseline advances');
});
