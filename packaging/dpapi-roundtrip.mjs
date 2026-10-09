/**
 * Prove the DPAPI credential store on a real Windows machine, using the shipped code.
 *
 * This is run by `packaging/run-dpapi.ps1` from the `deploy` job in
 * `.github/workflows/package.yml`, against the *extracted release artifact*: the
 * `app/src/secrets.js` imported below is the file that will run on a user's machine,
 * not the copy in this checkout. It is the difference between "the code calls DPAPI"
 * and "DPAPI moved the secret".
 *
 * It asserts, in order:
 *   1. a legacy plaintext `credentials.json` is migrated and then removed;
 *   2. the DPAPI file exists and does not contain the plaintext secret;
 *   3. the migrated value decrypts back through the shipped resolver;
 *   4. a fresh write through `saveSecrets` round-trips, still through DPAPI.
 *
 * `%APPDATA%` is not used: the temp paths are explicit so the assertions cannot be
 * satisfied by a stray store elsewhere in the profile.
 *
 * Usage: node dpapi-roundtrip.mjs <payload-root>
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const payload = resolve(process.argv[2] ?? '');
if (!payload) throw new Error('usage: node dpapi-roundtrip.mjs <payload-root>');

const secretsUrl = pathToFileURL(join(payload, 'app', 'src', 'secrets.js')).href;
const {
  createDpapiCredentialProvider,
  createFileCredentialProvider,
  loadSecrets,
  protectedCredentialPath,
  saveSecrets,
} = await import(secretsUrl);

const root = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-roundtrip-'));
const credentialPath = join(root, 'PuzzleSolver', 'credentials.json');
const protectedPath = protectedCredentialPath(credentialPath);
const legacySecret = 'o.DPAPI-ROUNDTRIP-LEGACY';
const freshSecret = 'sk-DPAPI-ROUNDTRIP-FRESH';

try {
  // A pre-existing plaintext file is the exact state #60 starts from.
  mkdirSync(dirname(credentialPath), { recursive: true });
  writeFileSync(credentialPath, JSON.stringify({ pushbullet_token: legacySecret }), { encoding: 'utf8', mode: 0o600 });

  const providers = [
    createDpapiCredentialProvider({ platform: 'win32', path: credentialPath }),
    createFileCredentialProvider({ path: credentialPath }),
  ];

  const migrated = await loadSecrets({ platform: 'win32', env: {}, providers });
  if (migrated.pushbullet.value !== legacySecret) {
    throw new Error(`migration did not return the legacy secret (got ${JSON.stringify(migrated.pushbullet)})`);
  }
  if (migrated.pushbullet.source !== 'windows-dpapi') {
    throw new Error(`the migrated secret was served by ${migrated.pushbullet.source}, not windows-dpapi`);
  }
  if (migrated.warnings.length > 0) {
    throw new Error(`migration reported warnings: ${migrated.warnings.join('; ')}`);
  }
  if (!existsSync(protectedPath)) throw new Error(`no DPAPI store at ${protectedPath}`);
  if (existsSync(credentialPath)) throw new Error(`the plaintext file ${credentialPath} still exists after migration`);
  const envelope = readFileSync(protectedPath, 'utf8');
  if (envelope.includes(legacySecret)) throw new Error('the plaintext secret appears in the DPAPI store');
  if (!envelope.includes('puzzlesolver-dpapi')) throw new Error('the store is not a DPAPI envelope');

  // A write through the same path the setup dialog and `config set` use.
  const saved = await saveSecrets({ entries: { llm: freshSecret }, platform: 'win32', env: {}, providers });
  if (!saved.saved.includes('llm')) throw new Error(`saveSecrets did not store the model key: ${JSON.stringify(saved)}`);
  const reread = await loadSecrets({ platform: 'win32', env: {}, providers });
  if (reread.llm.value !== freshSecret || reread.llm.source !== 'windows-dpapi') {
    throw new Error(`the fresh secret did not round-trip through DPAPI (got ${JSON.stringify(reread.llm)})`);
  }
  if (reread.pushbullet.value !== legacySecret) throw new Error('the migrated Pushbullet token was lost by the second write');
  if (readFileSync(protectedPath, 'utf8').includes(freshSecret)) throw new Error('the fresh secret appears in plaintext');
  if (existsSync(credentialPath)) throw new Error('a plaintext credentials file reappeared after the fresh write');

  console.log(
    'DPAPI round trip: migrate -> plaintext removed -> decrypt -> fresh write -> decrypt, all matched ' +
      `(store ${protectedPath})`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
