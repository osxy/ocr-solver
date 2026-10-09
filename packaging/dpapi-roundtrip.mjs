/**
 * Prove the DPAPI credential store on a real Windows machine, using the shipped code.
 *
 * This is run by `packaging/run-dpapi.ps1` from the `deploy` job in
 * `.github/workflows/package.yml`, against the *extracted release artifact*: the
 * `app/src/secrets.js` imported below is the file that will run on a user's machine,
 * not the copy in this checkout. It is the difference between "the code calls DPAPI"
 * and "DPAPI moved the secret".
 *
 * The proof matters most for the property that a process restart is supposed to have:
 * a value written to disk by one process can be decrypted by a *different* process.
 * So the script runs the two halves in separate `node` invocations, not in one:
 *
 *   - `write` (process A): a legacy plaintext `credentials.json` is migrated to DPAPI,
 *     the plaintext file is removed, and a fresh secret is written through the same
 *     `saveSecrets` path the setup dialog uses;
 *   - `read` (process B): a fresh process, with a fresh provider and empty module
 *     cache, decrypts the file A left behind. It asserts the values, the
 *     `windows-dpapi` source, and that `Unprotect` was actually called — so a
 *     decryption that silently returns memory or a stale cache cannot pass.
 *
 * `%APPDATA%` is not used: the temp paths are explicit so the assertions cannot be
 * satisfied by a stray store elsewhere in the profile. The child process sets no
 * DPAPI-specific options; it is exactly the code path a restart would take.
 *
 * Usage: node dpapi-roundtrip.mjs <payload-root>
 *        node dpapi-roundtrip.mjs <payload-root> write <root>   (internal)
 *        node dpapi-roundtrip.mjs <payload-root> read  <root>   (internal)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const payload = resolve(process.argv[2] ?? '');
if (!payload) throw new Error('usage: node dpapi-roundtrip.mjs <payload-root>');
const phase = process.argv[3] ?? null;
const rootArg = process.argv[4] ?? null;

const secretsUrl = pathToFileURL(join(payload, 'app', 'src', 'secrets.js')).href;
const {
  createDpapiCredentialProvider,
  createDpapiRunner,
  createFileCredentialProvider,
  loadSecrets,
  protectedCredentialPath,
  saveSecrets,
} = await import(secretsUrl);

const legacySecret = 'o.DPAPI-ROUNDTRIP-LEGACY';
const freshSecret = 'sk-DPAPI-ROUNDTRIP-FRESH';

function credentialPaths(root) {
  const credentialPath = join(root, 'PuzzleSolver', 'credentials.json');
  return { credentialPath, protectedPath: protectedCredentialPath(credentialPath) };
}

function providersFor(credentialPath, runner = null) {
  return [
    createDpapiCredentialProvider({ platform: 'win32', path: credentialPath, ...(runner ? { runner } : {}) }),
    createFileCredentialProvider({ path: credentialPath }),
  ];
}

/** The shipped DPAPI runner, wrapped so the read half can prove Unprotect ran. */
function countingRunner() {
  const real = createDpapiRunner();
  const calls = { protect: 0, unprotect: 0 };
  return {
    calls,
    protect: async (value) => {
      calls.protect += 1;
      return real.protect(value);
    },
    unprotect: async (value) => {
      calls.unprotect += 1;
      return real.unprotect(value);
    },
  };
}

/** Process A: migrate the legacy file, then save a fresh secret; leave the rest to B. */
async function runWrite(root) {
  const { credentialPath, protectedPath } = credentialPaths(root);
  mkdirSync(dirname(credentialPath), { recursive: true });
  writeFileSync(credentialPath, JSON.stringify({ pushbullet_token: legacySecret }), { encoding: 'utf8', mode: 0o600 });

  const providers = providersFor(credentialPath);
  const migrated = await loadSecrets({ platform: 'win32', env: {}, providers });
  if (migrated.pushbullet.value !== legacySecret) {
    throw new Error(`migration did not return the legacy secret (got ${JSON.stringify(migrated.pushbullet)})`);
  }
  if (migrated.pushbullet.source !== 'windows-dpapi') {
    throw new Error(`the migrated secret was served by ${migrated.pushbullet.source}, not windows-dpapi`);
  }
  if (migrated.warnings.length > 0) throw new Error(`migration reported warnings: ${migrated.warnings.join('; ')}`);
  if (!existsSync(protectedPath)) throw new Error(`no DPAPI store at ${protectedPath}`);
  if (existsSync(credentialPath)) throw new Error(`the plaintext file ${credentialPath} still exists after migration`);

  const saved = await saveSecrets({ entries: { llm: freshSecret }, platform: 'win32', env: {}, providers });
  if (!saved.saved.includes('llm')) throw new Error(`saveSecrets did not store the model key: ${JSON.stringify(saved)}`);
  console.log(`write-ok: migrated ${protectedPath} and saved the fresh secret`);
}

/** Process B: a fresh process must decrypt A's file; the cache cannot answer it. */
async function runRead(root) {
  const { credentialPath, protectedPath } = credentialPaths(root);
  if (!existsSync(protectedPath)) throw new Error(`no DPAPI store at ${protectedPath}; the writer produced nothing`);

  // The decrypt assertions come first: this is the property the proof exists for, so
  // a broken Unprotect must fail here, on the source and the value, and not be masked
  // by an unrelated scratch precondition.
  const runner = countingRunner();
  const providers = providersFor(credentialPath, runner);
  const reread = await loadSecrets({ platform: 'win32', env: {}, providers });
  if (reread.llm.value !== freshSecret || reread.llm.source !== 'windows-dpapi') {
    throw new Error(`the fresh secret did not decrypt back through DPAPI (got ${JSON.stringify(reread.llm)})`);
  }
  if (reread.pushbullet.value !== legacySecret || reread.pushbullet.source !== 'windows-dpapi') {
    throw new Error(`the migrated Pushbullet token did not decrypt back (got ${JSON.stringify(reread.pushbullet)})`);
  }
  if (reread.warnings.length > 0) throw new Error(`the fresh read reported warnings: ${reread.warnings.join('; ')}`);
  if (runner.calls.unprotect < 1) {
    throw new Error('the fresh process never called Unprotect; the value was served without decrypting');
  }

  // Then the on-disk hygiene the migration promises: no plaintext anywhere.
  if (existsSync(credentialPath)) throw new Error(`the plaintext file ${credentialPath} still exists`);
  const envelope = readFileSync(protectedPath, 'utf8');
  if (envelope.includes(legacySecret)) throw new Error('the legacy secret appears in plaintext in the DPAPI store');
  if (envelope.includes(freshSecret)) throw new Error('the fresh secret appears in plaintext in the DPAPI store');
  if (!envelope.includes('puzzlesolver-dpapi')) throw new Error('the store is not a DPAPI envelope');
  console.log(`read-ok: a fresh process decrypted the store (unprotect calls: ${runner.calls.unprotect})`);
}

/** Two separate node processes, so the read cannot be served from the writer's memory. */
function runOrchestrator() {
  const root = mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-roundtrip-'));
  const script = fileURLToPath(import.meta.url);
  const { protectedPath } = credentialPaths(root);
  try {
    const runPhase = (name) => {
      const result = spawnSync(process.execPath, [script, payload, name, root], { encoding: 'utf8' });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`${name} process exited ${result.status}: ${(result.stderr || result.stdout || '').trim()}`);
      }
      return String(result.stdout ?? '').trim();
    };
    const writeOut = runPhase('write');
    const readOut = runPhase('read');
    console.log(
      'DPAPI round trip: process A migrated + wrote; process B decrypted from disk, all matched ' +
        `(store ${protectedPath}) [${writeOut}; ${readOut}]`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (phase === 'write') {
  await runWrite(rootArg ?? mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-write-')));
} else if (phase === 'read') {
  await runRead(rootArg ?? mkdtempSync(join(tmpdir(), 'puzzlesolver-dpapi-read-')));
} else {
  runOrchestrator();
}
