/**
 * Secret resolution tests. No real credential store and no Windows: the Windows
 * provider is exercised through its injectable loader only, so this suite never
 * depends on a native binding that may not exist.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREDENTIAL_SERVICE,
  FILE_SECRET_KEYS,
  SECRET_ENV,
  createFileCredentialProvider,
  createWindowsCredentialProvider,
  defaultCredentialPath,
  describeSecret,
  loadSecrets,
  resolveSecret,
} from '../src/secrets.js';

const home = () => '/home/andre';

test('the environment variable names are the ones the CLI and live tests use', () => {
  assert.equal(SECRET_ENV.pushbullet, 'PUSHBULLET_TOKEN');
  assert.equal(SECRET_ENV.llm, 'LLM_API_KEY');
  assert.equal(SECRET_ENV.http, 'HTTP_AUTH_TOKEN');
  assert.equal(FILE_SECRET_KEYS.http, 'http_auth_token');
});

test('the HTTP bearer token resolves through the same provider interface', async () => {
  const store = { name: 'fake-store', get: async (name) => (name === 'http' ? 'http-from-store' : null) };
  assert.deepEqual(await resolveSecret('http', { env: { HTTP_AUTH_TOKEN: 'http-from-env' }, providers: [store] }), {
    value: 'http-from-env',
    source: 'env',
  });
  assert.deepEqual(await resolveSecret('http', { env: {}, providers: [store] }), {
    value: 'http-from-store',
    source: 'fake-store',
  });
});

// ---------------------------------------------------------------------------
// Resolution order: explicit -> env -> store -> null
// ---------------------------------------------------------------------------

test('an explicit option beats the environment; the environment beats the store', async () => {
  const store = { name: 'fake-store', get: async () => 'from-store' };
  const explicit = await resolveSecret('llm', {
    explicit: 'from-flag',
    env: { LLM_API_KEY: 'from-env' },
    providers: [store],
  });
  assert.deepEqual(explicit, { value: 'from-flag', source: 'explicit' });

  const fromEnv = await resolveSecret('llm', { env: { LLM_API_KEY: 'from-env' }, providers: [store] });
  assert.deepEqual(fromEnv, { value: 'from-env', source: 'env' });

  const fromStore = await resolveSecret('llm', { env: {}, providers: [store] });
  assert.deepEqual(fromStore, { value: 'from-store', source: 'fake-store' });
});

test('with nothing configured the secret is null, not a placeholder', async () => {
  assert.deepEqual(await resolveSecret('pushbullet', { env: {}, providers: [] }), { value: null, source: null });
});

test('an empty env var is unset', async () => {
  const resolved = await resolveSecret('llm', { env: { LLM_API_KEY: '   ' }, providers: [] });
  assert.equal(resolved.value, null);
});

test('a broken provider does not stop a later one from answering', async () => {
  const broken = { name: 'broken', get: async () => { throw new Error('nope'); } };
  const good = { name: 'good', get: async () => 'answer' };
  assert.deepEqual(await resolveSecret('pushbullet', { env: {}, providers: [broken, good] }), {
    value: 'answer',
    source: 'good',
  });
});

// ---------------------------------------------------------------------------
// describeSecret never exposes the value
// ---------------------------------------------------------------------------

test('describeSecret keeps only a prefix hint and never the value', () => {
  const secret = 'sk-abcdefghijklmnop';
  const described = describeSecret({ value: secret, source: 'env' });
  assert.deepEqual(described, { present: true, source: 'env', hint: 'sk-…' });
  assert.equal(JSON.stringify(described).includes(secret), false);
  assert.equal(JSON.stringify(described).includes('abcdefghijklmnop'), false);
});

test('describeSecret reports absence without inventing a hint', () => {
  assert.deepEqual(describeSecret({ value: null, source: null }), { present: false, source: null, hint: null });
  assert.deepEqual(describeSecret(''), { present: false, source: null, hint: null });
});

// ---------------------------------------------------------------------------
// The file credential store (the testable platform store)
// ---------------------------------------------------------------------------

test('the file credential store reads the documented JSON keys', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.pushbullet]: 'o.file-token', [FILE_SECRET_KEYS.llm]: 'sk-file' }));
  chmodSync(path, 0o600);

  const provider = createFileCredentialProvider({ path });
  assert.equal(await provider.get('pushbullet'), 'o.file-token');
  assert.equal(await provider.get('llm'), 'sk-file');
  assert.deepEqual(provider.warnings(), []);
});

test('a missing or corrupt credentials file yields null rather than throwing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(await createFileCredentialProvider({ path: join(dir, 'none.json') }).get('llm'), null);

  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{ not json');
  assert.equal(await createFileCredentialProvider({ path: corrupt }).get('llm'), null);
});

// ---------------------------------------------------------------------------
// A corrupt store is loud and is never silently overwritten (#46)
// ---------------------------------------------------------------------------
test('a corrupt file reports why instead of reading as an empty store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'corrupt.json');
  writeFileSync(path, '{"llm_api_key":"sk-keep","http_auth_token":"tok",}');
  chmodSync(path, 0o600); // isolate the parse warning from the permissions warning

  const provider = createFileCredentialProvider({ path });
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const loaded = await loadSecrets({ env: {}, providers: [provider], logger });

  assert.equal(loaded.llm.value, null, 'a corrupt store reads as no secret');
  assert.equal(warnings.length, 1, 'and that must be news, not silence');
  assert.match(warnings[0], /could not be read as JSON/);
  assert.ok(warnings[0].includes(path));
  assert.equal(warnings[0].includes('sk-keep'), false, 'the warning must not quote a value');
});

test('setting a secret on a corrupt file refuses and preserves every other secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'corrupt.json');
  const original = '{"llm_api_key":"sk-keep-me","http_auth_token":"keep-me-too",}';
  writeFileSync(path, original);

  const provider = createFileCredentialProvider({ path });
  assert.throws(() => provider.set('pushbullet', 'o.new-token'), /refusing to overwrite unreadable credentials file/);

  // The file is untouched (so a hand-repair can still recover `sk-keep-me`), and a
  // backup was taken rather than a silent `{}` rewrite losing both existing secrets.
  assert.equal(readFileSync(path, 'utf8'), original, 'the corrupt file must not be rewritten');
  assert.ok(existsSync(`${path}.bak`), 'a backup was quarantined');
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), original);
});

test('writing a secret tightens an existing lax file to mode 0600', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits do not apply');
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'lax.json');
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.llm]: 'sk-old' }));
  chmodSync(path, 0o644);
  assert.equal(statSync(path).mode & 0o777, 0o644);

  const provider = createFileCredentialProvider({ path });
  provider.set('pushbullet', 'o.new-token');

  assert.equal(statSync(path).mode & 0o777, 0o600, 'an existing file must be tightened, not left lax');
});

test('the write is atomic and leaves no temp file behind', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const provider = createFileCredentialProvider({ path });
  await provider.set('pushbullet', 'o.token');
  await provider.set('llm', 'sk-key');
  assert.deepEqual(readdirSync(dir), ['credentials.json'], 'no .tmp file survives a successful write');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.pushbullet_token, 'o.token');
  assert.equal(raw.llm_api_key, 'sk-key');
});

test('a failed rename does not delete the previous store', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const original = JSON.stringify({ [FILE_SECRET_KEYS.llm]: 'sk-old' });
  writeFileSync(path, original);

  const provider = createFileCredentialProvider({
    path,
    rename() {
      throw new Error('rename failed');
    },
  });
  assert.throws(() => provider.set('pushbullet', 'o.token'), /rename failed/);
  assert.equal(readFileSync(path, 'utf8'), original, 'the previous store is untouched');
  assert.deepEqual(readdirSync(dir), ['credentials.json'], 'the temp file is cleaned up');
});

test('a group-readable credentials file warns but still works', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-creds-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'lax.json');
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.llm]: 'sk-lax' }));
  chmodSync(path, 0o644);

  const provider = createFileCredentialProvider({ path });
  assert.equal(await provider.get('llm'), 'sk-lax');
  const warnings = provider.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /readable by other users/);
  assert.ok(warnings[0].includes(path));
});

test('the default credential path follows the platform', () => {
  assert.equal(
    defaultCredentialPath({ platform: 'win32', env: { APPDATA: 'C:\\Roaming' }, homedir: home }),
    join('C:\\Roaming', 'PuzzleSolver', 'credentials.json')
  );
  assert.equal(
    defaultCredentialPath({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: home }),
    join('/xdg', 'puzzlesolver', 'credentials.json')
  );
});

// ---------------------------------------------------------------------------
// The Windows provider: lazily loaded and never required off Windows
// ---------------------------------------------------------------------------

test('the Windows provider loads its binding lazily and reads the credential', async () => {
  let loads = 0;
  const provider = createWindowsCredentialProvider({
    platform: 'win32',
    loadModule: async () => {
      loads += 1;
      return {
        async getPassword(service, account) {
          assert.equal(service, CREDENTIAL_SERVICE);
          return account === FILE_SECRET_KEYS.llm ? 'sk-win' : null;
        },
      };
    },
  });

  assert.equal(loads, 0, 'the binding must not be touched until a secret is asked for');
  assert.equal(await provider.get('llm'), 'sk-win');
  assert.equal(loads, 1);
  assert.equal(await provider.get('llm'), 'sk-win', 'the module is loaded once');
  assert.equal(loads, 1);
  assert.equal(await provider.get('pushbullet'), null, 'no entry means null, not a throw');
});

test('off Windows the Windows provider never even tries to load a binding', async () => {
  let loads = 0;
  const provider = createWindowsCredentialProvider({
    platform: 'linux',
    loadModule: async () => {
      loads += 1;
      return { getPassword: async () => 'should not happen' };
    },
  });
  assert.equal(await provider.get('llm'), null);
  assert.equal(loads, 0);
});

test('a missing Windows binding degrades to null instead of throwing', async () => {
  const provider = createWindowsCredentialProvider({
    platform: 'win32',
    loadModule: async () => {
      throw new Error('module not found');
    },
  });
  assert.equal(await provider.get('llm'), null);
});

// ---------------------------------------------------------------------------
// loadSecrets
// ---------------------------------------------------------------------------

test('loadSecrets resolves both secrets and reports the sources', async () => {
  const resolved = await loadSecrets({
    env: { PUSHBULLET_TOKEN: 'o.env-token' },
    providers: [{ name: 'fake-store', get: async (name) => (name === 'llm' ? 'sk-store' : null) }],
  });
  assert.deepEqual(resolved.pushbullet, { value: 'o.env-token', source: 'env' });
  assert.deepEqual(resolved.llm, { value: 'sk-store', source: 'fake-store' });
  assert.deepEqual(resolved.providers, ['fake-store']);
});
