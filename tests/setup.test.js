/**
 * First-run setup tests. The UI is injected out; what remains - validation, the two
 * connection probes and the credential write - is asserted directly. The write path
 * is the real `saveSecrets` over a real file provider, so this suite proves the
 * credential round-trips rather than trusting a double.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSetup, validateSetupInput } from '../src/ui/setup.js';
import { createFileCredentialProvider, saveSecrets, loadSecrets } from '../src/secrets.js';

test('an empty token or key is rejected with a field-specific error', () => {
  const result = validateSetupInput({ pushbulletToken: '', llmApiKey: '' });
  assert.equal(result.ok, false);
  assert.deepEqual(Object.keys(result.errors).sort(), ['llmApiKey', 'pushbulletToken']);
});

test('internal whitespace is rejected, but a trailing newline is trimmed and accepted', () => {
  const bad = validateSetupInput({ pushbulletToken: 'o.abc def', llmApiKey: 'sk-abc\n' });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.pushbulletToken, /whitespace/);
  assert.equal(bad.errors.llmApiKey, undefined, 'a trailing newline is a paste artefact, not a bad key');

  const good = validateSetupInput({ pushbulletToken: 'o.abc', llmApiKey: 'sk-abc\n' });
  assert.equal(good.ok, true);
});

test('a valid pair passes, and the model key is optional when it is not required', () => {
  assert.equal(validateSetupInput({ pushbulletToken: 'o.abc', llmApiKey: 'sk-xyz' }).ok, true);
  assert.equal(validateSetupInput({ pushbulletToken: 'o.abc', llmApiKey: '', requireModelKey: false }).ok, true);
});

test('test connection probes each non-empty field and reports failures without throwing', async () => {
  const setup = createSetup({
    saveSecrets: async () => ({ saved: [] }),
    testPushbullet: async () => ({ ok: true, detail: 'accepted' }),
    testModel: async () => {
      throw new Error('connection refused');
    },
  });
  const { ok, results } = await setup.testConnection({ pushbulletToken: 'o.abc', llmApiKey: 'sk-xyz' });
  assert.equal(ok, false, 'one failing probe means the test is not ok');
  assert.equal(results.pushbullet.ok, true);
  assert.equal(results.llm.ok, false);
  assert.match(results.llm.detail, /connection refused/);
});

test('apply writes through saveSecrets and never returns the secret values', async () => {
  const writes = [];
  const setup = createSetup({
    saveSecrets: async ({ entries }) => {
      writes.push(entries);
      return { saved: Object.keys(entries), providers: ['fake'] };
    },
  });
  const result = await setup.apply({ pushbulletToken: '  o.abc  ', llmApiKey: 'sk-xyz' });
  assert.equal(result.saved, true);
  assert.deepEqual(result.savedNames, ['pushbullet', 'llm']);
  assert.deepEqual(writes, [{ pushbullet: 'o.abc', llm: 'sk-xyz' }]);
  assert.equal(JSON.stringify(result).includes('sk-xyz'), false, 'the value must not echo back');
});

test('apply refuses to save invalid input', async () => {
  let called = 0;
  const setup = createSetup({ saveSecrets: async () => { called += 1; return { saved: [] }; } });
  const result = await setup.apply({ pushbulletToken: '', llmApiKey: '' });
  assert.equal(result.saved, false);
  assert.equal(called, 0, 'nothing may be written when validation fails');
});

test('when connection is required, a failed probe blocks the write', async () => {
  let called = 0;
  const setup = createSetup({
    saveSecrets: async () => { called += 1; return { saved: [] }; },
    testPushbullet: async () => ({ ok: false, detail: '401' }),
    testModel: async () => ({ ok: true, detail: 'ok' }),
  });
  const result = await setup.apply({ pushbulletToken: 'o.abc', llmApiKey: 'sk-xyz', requireConnection: true });
  assert.equal(result.saved, false);
  assert.equal(called, 0);
  assert.equal(result.results.pushbullet.ok, false);
});

// ---------------------------------------------------------------------------
// The real write path: file provider round-trip
// ---------------------------------------------------------------------------

test('saveSecrets writes through the file provider and loadSecrets reads it back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const provider = createFileCredentialProvider({ path });

  const saved = await saveSecrets({ entries: { pushbullet: 'o.token', llm: 'sk-key' }, providers: [provider] });
  assert.deepEqual(saved.saved, ['pushbullet', 'llm']);
  assert.equal(saved.providers[0], 'file');

  // Read it back through the same public loader, with no env and no explicit option.
  const loaded = await loadSecrets({ env: {}, providers: [provider] });
  assert.equal(loaded.pushbullet.value, 'o.token');
  assert.equal(loaded.llm.value, 'sk-key');
  assert.equal(loaded.pushbullet.source, 'file');
});

test('the credential file is written mode 0600 on POSIX', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX mode bits do not apply');
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  await saveSecrets({ entries: { pushbullet: 'o.token' }, providers: [createFileCredentialProvider({ path })] });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('saveSecrets refuses an empty value instead of blanking a stored secret', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const provider = createFileCredentialProvider({ path });
  await provider.set('pushbullet', 'o.token');
  // `set` is synchronous (a single file write), so this is `throws`, not `rejects`.
  assert.throws(() => provider.set('pushbullet', '   '), /refusing to store an empty secret/);
  assert.equal(provider.get('pushbullet'), 'o.token', 'the existing secret must be untouched');
});

test('setting one secret preserves the other', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-secrets-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'credentials.json');
  const provider = createFileCredentialProvider({ path });
  await provider.set('pushbullet', 'o.token');
  await provider.set('llm', 'sk-key');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(raw.pushbullet_token, 'o.token');
  assert.equal(raw.llm_api_key, 'sk-key');
});

test('saveSecrets with no writable provider names the environment fallback', async () => {
  await assert.rejects(
    () => saveSecrets({ entries: { llm: 'sk-key' }, providers: [{ name: 'read-only', get: async () => null }] }),
    /no writable credential store/
  );
});
