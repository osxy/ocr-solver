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
  DPAPI_FORMAT,
  FILE_SECRET_KEYS,
  SECRET_ENV,
  createDpapiCredentialProvider,
  createDpapiRunner,
  createFileCredentialProvider,
  defaultCredentialPath,
  defaultCredentialProviders,
  describeCredentialStore,
  describeSecret,
  loadSecrets,
  protectedCredentialPath,
  resolveSecret,
  saveSecrets,
} from '../src/secrets.js';

const home = () => '/home/andre';

/**
 * A reversible stand-in for DPAPI. It is not cryptographic and must never be read as
 * one: it exists so the provider's file handling, migration and fallback can be
 * exercised without Windows. The real round trip runs on `windows-latest`
 * (`packaging/run-dpapi.ps1`).
 */
function fakeDpapiRunner({ protectFail = null, unprotectFail = null } = {}) {
  const calls = { protect: 0, unprotect: 0 };
  return {
    calls,
    async protect(plaintext) {
      calls.protect += 1;
      if (protectFail) throw protectFail;
      return Buffer.from(`dpapi:${plaintext}`, 'utf8').toString('base64');
    },
    async unprotect(ciphertext) {
      calls.unprotect += 1;
      if (unprotectFail) throw unprotectFail;
      const text = Buffer.from(ciphertext, 'base64').toString('utf8');
      if (!text.startsWith('dpapi:')) throw new Error('not a fake DPAPI blob');
      return text.slice('dpapi:'.length);
    },
  };
}

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
// The Windows provider: DPAPI through an injectable runner
// ---------------------------------------------------------------------------

test('Windows selects DPAPI with the file as fallback; everywhere else only the file', () => {
  const win = defaultCredentialProviders({ platform: 'win32', path: join('C:\\', 'Roaming', 'PuzzleSolver', 'credentials.json') });
  assert.deepEqual(win.map((p) => p.name), ['windows-dpapi', 'file'], 'DPAPI is preferred, the file is the fallback');
  const linux = defaultCredentialProviders({ platform: 'linux', path: '/xdg/puzzlesolver/credentials.json' });
  assert.deepEqual(linux.map((p) => p.name), ['file'], 'no DPAPI provider is even constructed off Windows');
});

test('the DPAPI runner sends a ProtectedData command and base64 on stdin', async () => {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'cHJvdGVjdGVk', stderr: '' };
  };
  const runner = createDpapiRunner({ spawn, powershell: 'powershell.exe' });
  assert.equal(await runner.protect('hello'), 'cHJvdGVjdGVk');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  const index = calls[0].args.indexOf('-EncodedCommand');
  assert.ok(index >= 0, 'the script must travel as -EncodedCommand, not as a quoted argument');
  const script = Buffer.from(calls[0].args[index + 1], 'base64').toString('utf16le');
  assert.match(script, /ProtectedData\]::Protect/);
  assert.match(script, /DataProtectionScope\]::CurrentUser/);
  assert.equal(
    calls[0].options.input,
    `${Buffer.from('hello', 'utf8').toString('base64')}\n`,
    'the value travels as base64 on stdin, so the PowerShell console encoding cannot mangle it'
  );
});

test('the DPAPI runner decodes the protected output for unprotect', async () => {
  const plaintext = 'the-secret';
  const spawn = () => ({ status: 0, stdout: Buffer.from(plaintext, 'utf8').toString('base64'), stderr: '' });
  const runner = createDpapiRunner({ spawn });
  assert.equal(await runner.unprotect(Buffer.from('cipher', 'utf8').toString('base64')), plaintext);
});

test('a failed PowerShell call throws, so the caller can fall back', async () => {
  const runner = createDpapiRunner({ spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }) });
  await assert.rejects(() => runner.protect('x'), /PowerShell exited 1/);
});

test('off Windows the DPAPI provider never even touches the runner', async () => {
  let touches = 0;
  const provider = createDpapiCredentialProvider({
    platform: 'linux',
    path: '/tmp/none.json',
    runner: {
      protect: async () => (touches += 1, 'x'),
      unprotect: async () => (touches += 1, '{}'),
    },
  });
  assert.equal(await provider.get('llm'), null);
  assert.equal(touches, 0);
});

test('a legacy plaintext file is migrated to DPAPI and removed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const secret = 'o.LEGACY-PLAINTEXT';
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.pushbullet]: secret }));
  const runner = fakeDpapiRunner();

  const provider = createDpapiCredentialProvider({ platform: 'win32', path, runner });
  assert.equal(await provider.get('pushbullet'), secret, 'the value survives migration');

  const protectedPath = protectedCredentialPath(path);
  assert.ok(existsSync(protectedPath), 'the protected store is written');
  assert.equal(existsSync(path), false, 'the plaintext file is gone, not merely shadowed');
  const raw = readFileSync(protectedPath, 'utf8');
  assert.equal(raw.includes(secret), false, 'the plaintext secret must not appear in the protected file');
  const envelope = JSON.parse(raw);
  assert.equal(envelope.format, DPAPI_FORMAT);
  assert.equal(envelope.scope, 'CurrentUser');
  assert.equal(envelope.version, 1);
  assert.deepEqual(provider.warnings(), []);
});

test('migration runs once; a later read decrypts rather than re-protecting', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.llm]: 'sk-legacy' }));
  const runner = fakeDpapiRunner();

  const provider = createDpapiCredentialProvider({ platform: 'win32', path, runner });
  assert.equal(await provider.get('llm'), 'sk-legacy');
  assert.equal(runner.calls.protect, 1, 'the legacy file is protected exactly once');
  assert.equal(await provider.get('llm'), 'sk-legacy');
  assert.equal(runner.calls.protect, 1, 'the migrated store is cached, not rewritten');
});

test('when the plaintext file cannot be deleted it is scrubbed, and the warning says so', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const secret = 'o.SCRUB-ME';
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.pushbullet]: secret }));

  const provider = createDpapiCredentialProvider({
    platform: 'win32',
    path,
    runner: fakeDpapiRunner(),
    unlink() {
      throw new Error('EPERM');
    },
  });
  assert.equal(await provider.get('pushbullet'), secret);
  assert.equal(readFileSync(path, 'utf8').includes(secret), false, 'the plaintext must not survive');
  assert.equal(readFileSync(path, 'utf8').trim(), '{}', 'and the file is scrubbed rather than left with the secret');
  const warnings = provider.warnings();
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not be deleted/);
});

test('a failed DPAPI read leaves the plaintext alone, falls back to the file and reports it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const secret = 'o.FALLBACK';
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.pushbullet]: secret }));

  const dpapi = createDpapiCredentialProvider({ platform: 'win32', path, runner: fakeDpapiRunner({ protectFail: new Error('no powershell') }) });
  const file = createFileCredentialProvider({ path });
  const loaded = await loadSecrets({ platform: 'win32', env: {}, providers: [dpapi, file] });

  assert.equal(loaded.pushbullet.value, secret);
  assert.equal(loaded.pushbullet.source, 'file', 'the source must be truthful: the value came from the file');
  assert.ok(existsSync(path), 'the plaintext file is left in place when DPAPI is unavailable');
  assert.ok(loaded.warnings.some((w) => /DPAPI is unavailable/.test(w)), 'and the fallback is announced');
});

test('a failed DPAPI write falls through to the file store and says so', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const dpapi = createDpapiCredentialProvider({ platform: 'win32', path, runner: fakeDpapiRunner({ protectFail: new Error('no powershell') }) });
  const file = createFileCredentialProvider({ path });
  const warnings = [];
  const result = await saveSecrets({
    entries: { pushbullet: 'o.NEW' },
    platform: 'win32',
    providers: [dpapi, file],
    logger: { warn: (message) => warnings.push(message), info() {} },
  });

  assert.deepEqual(result.saved, ['pushbullet']);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pushbullet_token, 'o.NEW', 'the fallback file holds the value');
  assert.ok(warnings.some((w) => /windows-dpapi did not accept/.test(w)), 'the fallback is not silent');
});

test('a protected store that cannot be decrypted falls back to the file and says so', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const secret = 'o.OLD-FILE';
  const protectedPath = protectedCredentialPath(path);
  writeFileSync(protectedPath, JSON.stringify({ format: DPAPI_FORMAT, version: 1, scope: 'CurrentUser', data: 'zzz' }));
  writeFileSync(path, JSON.stringify({ [FILE_SECRET_KEYS.pushbullet]: secret }));

  const runner = { protect: async () => 'x', unprotect: async () => { throw new Error('bad blob'); } };
  const dpapi = createDpapiCredentialProvider({ platform: 'win32', path, protectedPath, runner });
  const file = createFileCredentialProvider({ path });
  const loaded = await loadSecrets({ platform: 'win32', env: {}, providers: [dpapi, file] });

  assert.equal(loaded.pushbullet.value, secret);
  assert.equal(loaded.pushbullet.source, 'file');
  assert.ok(loaded.warnings.some((w) => /could not be decrypted/.test(w)));
});

test('a fresh Windows write goes to the protected path and never creates the plaintext file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const dpapi = createDpapiCredentialProvider({ platform: 'win32', path, runner: fakeDpapiRunner() });
  const file = createFileCredentialProvider({ path });

  const result = await saveSecrets({ entries: { pushbullet: 'o.FRESH' }, platform: 'win32', providers: [dpapi, file] });
  assert.deepEqual(result.saved, ['pushbullet']);
  assert.equal(existsSync(path), false, 'the plaintext file is never written');
  const protectedPath = protectedCredentialPath(path);
  assert.ok(existsSync(protectedPath));
  assert.equal(readFileSync(protectedPath, 'utf8').includes('o.FRESH'), false);
  const reloaded = await loadSecrets({ platform: 'win32', env: {}, providers: [dpapi, file] });
  assert.equal(reloaded.pushbullet.value, 'o.FRESH');
  assert.equal(reloaded.pushbullet.source, 'windows-dpapi');
});

test('loadSecrets names the store chain and the effective destination', async () => {
  const path = join('/tmp', 'creds', 'credentials.json');
  const dpapi = createDpapiCredentialProvider({ platform: 'win32', path, runner: fakeDpapiRunner() });
  const file = createFileCredentialProvider({ path });
  const loaded = await loadSecrets({ platform: 'win32', env: {}, providers: [dpapi, file] });
  assert.deepEqual(loaded.providers, ['windows-dpapi', 'file']);
  assert.match(loaded.store, /Windows DPAPI \(CurrentUser\)/);
  assert.ok(loaded.store.includes(protectedCredentialPath(path)));
});

test('the store description names the file path off Windows', () => {
  const file = createFileCredentialProvider({ path: '/home/andre/.config/puzzlesolver/credentials.json' });
  assert.equal(
    describeCredentialStore([file], { platform: 'linux' }),
    'credential file at /home/andre/.config/puzzlesolver/credentials.json'
  );
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
