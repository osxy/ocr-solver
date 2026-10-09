/**
 * Secret resolution.
 *
 * One secret, three sources, first hit wins:
 *
 *   1. an explicit option (`--token`, `--api-key`);
 *   2. the environment (`PUSHBULLET_TOKEN`, `LLM_API_KEY`) - what development and
 *      the live test suite use;
 *   3. the platform credential store (Windows DPAPI, or the
 *      ACL-restricted file fallback);
 *   4. otherwise `null`.
 *
 * Secrets are never written to disk by this module, never logged and never
 * stringified into an error. `describeSecret` is the only diagnostic, and it keeps
 * a three-character prefix - enough to tell two keys apart, useless to a reader.
 *
 * On Windows the store is DPAPI (`CurrentUser`) reached through the PowerShell that
 * ships with every Windows box, so no npm dependency is needed. That is why it
 * replaced the keytar-based Credential Manager provider: keytar was never a
 * dependency, so that branch could only ever fall through to the plaintext file
 * (issue #60). The PowerShell call sits behind an injectable runner, so everything
 * above it is testable off Windows; the real round trip is demonstrated on
 * `windows-latest` by the deploy job (`packaging/run-dpapi.ps1`).
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Environment variable per secret name. */
export const SECRET_ENV = {
  pushbullet: 'PUSHBULLET_TOKEN',
  llm: 'LLM_API_KEY',
  // Bearer token for the HTTP ingress (#15). A distinct secret from the Pushbullet
  // token: the two credentials guard different listeners and can be rotated apart.
  http: 'HTTP_AUTH_TOKEN',
  // The web UI remote-access credential (#65). Unlike the others this is *not* a
  // usable secret: the stored value is a scrypt verifier (salt + hash), and what a
  // login submits is checked against it. It still lives here because the credential
  // store is the only write path for secrets, and `config.toml` refuses the name.
  web_ui: 'WEB_UI_PASSWORD_HASH',
};

/** Key names inside the file credential store. */
export const FILE_SECRET_KEYS = {
  pushbullet: 'pushbullet_token',
  llm: 'llm_api_key',
  http: 'http_auth_token',
  web_ui: 'web_ui_password_hash',
};

export const SECRET_NAMES = Object.keys(SECRET_ENV);

/**
 * A safe description of a secret for diagnostics.
 * Accepts either a `{ value, source }` entry or a raw string.
 */
export function describeSecret(secret, source = null) {
  const value = secret != null && typeof secret === 'object' && 'value' in secret ? secret.value : secret;
  const origin = secret != null && typeof secret === 'object' && 'source' in secret ? secret.source : source;
  if (value == null || String(value).trim() === '') return { present: false, source: origin ?? null, hint: null };
  const text = String(value);
  return {
    present: true,
    source: origin ?? null,
    // The prefix identifies which key it is; nothing after it is ever exposed.
    hint: text.length > 3 ? `${text.slice(0, 3)}…` : '…',
  };
}

/** Path of the file credential store - the cross-platform fallback. */
export function defaultCredentialPath({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'PuzzleSolver', 'credentials.json');
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'puzzlesolver', 'credentials.json');
}

/**
 * Read secrets from a JSON file. This is the fallback store for platforms with no
 * credential manager, and the one that is actually testable off Windows.
 *
 * The file is expected mode 600; a group/world-readable file still works (locking
 * someone out of their own credential is worse) but `warnings` reports it. A file
 * that cannot be parsed is never silently treated as an empty store: `get` returns
 * null *and* records a warning (so the caller can log it), and `set` refuses to
 * overwrite it, quarantining a `.bak` first. That is the difference between a
 * credential store and a way to silently lose every secret on the next save.
 */
export function createFileCredentialProvider({
  path = defaultCredentialPath(),
  readFile = readFileSync,
  writeFile = writeFileSync,
  fileExists = existsSync,
  mkdir = mkdirSync,
  stat = statSync,
  chmod = chmodSync,
  rename = renameSync,
  unlink = unlinkSync,
  copyFile = copyFileSync,
  mode = 0o600,
  backupSuffix = '.bak',
  now = () => Date.now(),
  pid = process.pid,
} = {}) {
  let warnedMode = false;
  // Set when a read could not parse; reported (and cleared) by `warnings()`, which
  // `loadSecrets` logs, so a corrupt file is loud instead of invisible.
  let readError = null;

  /**
   * Read and parse the store. Returns `{ ok, value, reason }`; `reason` is
   * `'unreadable'` or `'invalid'` and is deliberately value-free.
   */
  function readStore() {
    let text;
    try {
      text = readFile(path, 'utf8');
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid' };
      }
      return { ok: true, value: parsed };
    } catch {
      return { ok: false, reason: 'invalid' };
    }
  }

  /** Write through a same-directory temp file, then rename; chmod covers a pre-existing file. */
  function writeStore(contents) {
    mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${pid}-${now()}`;
    try {
      writeFile(tmp, contents, { encoding: 'utf8', mode });
      try {
        chmod(tmp, mode);
      } catch {
        // POSIX mode bits do not exist on Windows; a platform that cannot chmod still writes.
      }
      rename(tmp, path);
      try {
        // The rename replaces an existing file whose old mode would otherwise persist.
        chmod(path, mode);
      } catch {
        // best effort on platforms without POSIX modes
      }
    } catch (err) {
      try {
        unlink(tmp);
      } catch {
        // the temp file may not exist; the original write error is the one that matters
      }
      throw err;
    }
  }

  return {
    name: 'file',
    path,
    get(name) {
      if (!path || !fileExists(path)) return null;
      const outcome = readStore();
      if (!outcome.ok) {
        readError = outcome.reason;
        return null;
      }
      const key = FILE_SECRET_KEYS[name];
      if (!key) return null;
      const value = outcome.value?.[key];
      return value != null && String(value).trim() !== '' ? String(value) : null;
    },
    /**
     * Persist one secret, merging with whatever is already there. The file is the
     * cross-platform store, so this is the write path the setup dialog uses.
     * Never logs the value; the mode is enforced on every write, not only at creation.
     *
     * A file that cannot be parsed is *not* rewritten: the other secrets may still
     * be recoverable by hand, and silently replacing them with `{}` plus the new key
     * is how one typo destroys the whole store. A `.bak` is copied and `set` throws.
     */
    set(name, value) {
      const key = FILE_SECRET_KEYS[name];
      if (!key) throw new Error(`unknown secret name ${JSON.stringify(name)}`);
      if (!path) throw new Error('the file credential provider has no path to write to');
      const text = String(value ?? '');
      if (text.trim() === '') throw new Error(`refusing to store an empty secret for ${name}`);

      let parsed = {};
      if (fileExists(path)) {
        const outcome = readStore();
        if (!outcome.ok) {
          readError = outcome.reason;
          const backupPath = `${path}${backupSuffix}`;
          let backedUp = false;
          try {
            copyFile(path, backupPath);
            backedUp = true;
          } catch {
            // If even the backup fails, still refuse rather than clobber.
          }
          throw new Error(
            `refusing to overwrite unreadable credentials file ${path}` +
              (backedUp ? `; a backup was written to ${backupPath}` : '; the file was left untouched')
          );
        }
        parsed = outcome.value;
      }
      parsed[key] = text;
      writeStore(`${JSON.stringify(parsed, null, 2)}\n`);
      return { stored: true, path, mode };
    },
    /** Non-fatal problems worth surfacing once, e.g. a corrupt file or lax permissions. */
    warnings() {
      const out = [];
      if (readError) {
        out.push(
          `credentials file ${path} could not be read as JSON (${readError}); ` +
            'its secrets were ignored and it will not be overwritten until it is fixed'
        );
        readError = null;
      }
      if (!path || !fileExists(path)) return out;
      try {
        const mode = stat(path).mode & 0o777;
        if (!warnedMode && (mode & 0o077) !== 0) {
          warnedMode = true;
          out.push(`credential file ${path} is readable by other users (mode ${mode.toString(8).padStart(3, '0')}); chmod 600 it`);
        }
      } catch {
        // stat can race with the file being replaced; ignore
      }
      return out;
    },
  };
}

/**
 * Windows credential store: DPAPI at `CurrentUser` scope, reached through the
 * PowerShell that ships with every Windows box.
 *
 * `Add-Type -AssemblyName System.Security` exposes
 * `[System.Security.Cryptography.ProtectedData]`, so this needs no npm dependency and
 * no key to manage. `keytar` was never a dependency, so the old Credential Manager
 * branch could only fall through to the plaintext file (issue #60); DPAPI is the
 * shipped store now.
 *
 * The blob is written to a *sibling* file rather than over the legacy JSON path, so a
 * fallback write by the file provider can never scribble plaintext into the middle of
 * an encrypted envelope. The legacy file is read once, migrated, then removed.
 *
 * Everything below the PowerShell call is injectable, so the provider is exercised off
 * Windows. The real round trip is demonstrated on `windows-latest` by the deploy job
 * (`packaging/run-dpapi.ps1`), not asserted from this file's existence.
 */
export const DPAPI_FORMAT = 'puzzlesolver-dpapi';
export const DPAPI_SCOPE = 'CurrentUser';

/** Where the DPAPI blob lives: beside the legacy file it replaces, never on top of it. */
export function protectedCredentialPath(filePath) {
  return join(dirname(filePath), 'credentials.dpapi');
}

// The value travels on stdin as base64 and both scripts emit base64, so the pipe is
// pure ASCII and Windows PowerShell's console encoding cannot mangle a secret.
const DPAPI_PROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in = [Console]::In.ReadToEnd()',
  '$plain = [Convert]::FromBase64String($in.Trim())',
  '$protected = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join('; ');

const DPAPI_UNPROTECT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$in = [Console]::In.ReadToEnd()',
  '$protected = [Convert]::FromBase64String($in.Trim())',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');

/**
 * The default DPAPI runner. The script is passed as an `-EncodedCommand`
 * (UTF-16LE base64), which removes every quoting hazard, and the value on stdin as
 * base64. `protect` maps plaintext to a DPAPI blob; `unprotect` maps it back.
 *
 * A non-zero exit, a spawn error or empty output throws, so the caller can fall back
 * to the file provider and say so instead of pretending the secret was protected.
 */
export function createDpapiRunner({ spawn = spawnSync, powershell = 'powershell.exe', timeoutMs = 20000 } = {}) {
  function run(script, input) {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const result = spawn(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { input: `${input}\n`, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    if (result?.error) throw result.error;
    if (result?.status !== 0) {
      const detail = String(result?.stderr ?? '').trim();
      throw new Error(`PowerShell exited ${result?.status}${detail ? `: ${detail}` : ''}`);
    }
    const output = String(result?.stdout ?? '').trim();
    if (output === '') throw new Error('PowerShell returned no output');
    return output;
  }
  return {
    async protect(plaintext) {
      return run(DPAPI_PROTECT_SCRIPT, Buffer.from(String(plaintext), 'utf8').toString('base64'));
    },
    async unprotect(ciphertextBase64) {
      return Buffer.from(run(DPAPI_UNPROTECT_SCRIPT, String(ciphertextBase64)), 'base64').toString('utf8');
    },
  };
}

/**
 * The DPAPI credential provider.
 *
 * A protected call is the *only* way this provider ever serves or writes a value: on
 * any failure it returns `null` (read) or throws (write), so the file provider behind
 * it is the only path that can use plaintext and the reported `source` is truthful.
 * The failure is recorded as a warning so the fallback is announced, never silent.
 */
export function createDpapiCredentialProvider({
  platform = process.platform,
  path = defaultCredentialPath(),
  protectedPath = protectedCredentialPath(path),
  runner = null,
  readFile = readFileSync,
  writeFile = writeFileSync,
  fileExists = existsSync,
  mkdir = mkdirSync,
  rename = renameSync,
  unlink = unlinkSync,
  mode = 0o600,
  now = () => Date.now(),
  pid = process.pid,
  format = DPAPI_FORMAT,
  scope = DPAPI_SCOPE,
} = {}) {
  const dpapi = runner ?? createDpapiRunner();
  let pendingWarnings = [];
  // Migration and the first decrypt happen once per process. `null` is a cached
  // failure: the provider then declines every read, so the file provider serves the
  // legacy value with source `file` and the warning explains why.
  let storePromise = null;

  function readObject(file) {
    try {
      const parsed = JSON.parse(readFile(file, 'utf8'));
      return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function isEnvelope(value) {
    return value != null && typeof value === 'object' && value.format === format && typeof value.data === 'string';
  }

  /** Encrypt the whole store and replace the protected file atomically. */
  async function writeProtected(store) {
    const plain = `${JSON.stringify(store, null, 2)}\n`;
    const data = await dpapi.protect(plain);
    const envelope = `${JSON.stringify({ format, version: 1, scope, data }, null, 2)}\n`;
    mkdir(dirname(protectedPath), { recursive: true });
    const tmp = `${protectedPath}.tmp-${pid}-${now()}`;
    try {
      writeFile(tmp, envelope, { encoding: 'utf8', mode });
      rename(tmp, protectedPath);
    } catch (err) {
      try {
        unlink(tmp);
      } catch {
        // the temp file may not exist; the original write error is the one that matters
      }
      throw err;
    }
  }

  /** Delete the plaintext file; if it cannot be deleted, scrub its contents instead. */
  function scrubLegacy() {
    try {
      unlink(path);
      return 'removed';
    } catch {
      try {
        writeFile(path, '{}\n', { encoding: 'utf8', mode });
        return 'scrubbed';
      } catch {
        return 'left';
      }
    }
  }

  async function loadStore() {
    if (fileExists(protectedPath)) {
      const envelope = readObject(protectedPath);
      if (!isEnvelope(envelope)) {
        pendingWarnings.push(`the protected credential store ${protectedPath} is not a recognised DPAPI envelope; it was ignored`);
        return null;
      }
      try {
        const parsed = JSON.parse(await dpapi.unprotect(envelope.data));
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          pendingWarnings.push(`the protected credential store ${protectedPath} did not hold a JSON object; it was ignored`);
          return null;
        }
        return parsed;
      } catch (err) {
        pendingWarnings.push(
          `the protected credential store ${protectedPath} could not be decrypted (${err?.message ?? err}); ` +
            'nothing was changed and the plaintext fallback is being used'
        );
        return null;
      }
    }

    // No protected store: migrate a legacy plaintext file on this first read.
    const legacy = readObject(path);
    if (legacy) {
      try {
        await writeProtected(legacy);
      } catch (err) {
        pendingWarnings.push(
          `DPAPI is unavailable (${err?.message ?? err}); the plaintext credential file ${path} was left in place and is being used`
        );
        return null;
      }
      const outcome = scrubLegacy();
      if (outcome === 'left') {
        pendingWarnings.push(
          `credentials were migrated to ${protectedPath} but the plaintext file ${path} could not be removed; delete it manually`
        );
      } else if (outcome === 'scrubbed') {
        pendingWarnings.push(
          `credentials were migrated to ${protectedPath} but the plaintext file ${path} could not be deleted; it was overwritten with an empty store`
        );
      }
      return legacy;
    }
    // Nothing to migrate. The file provider still reports an unparseable legacy file
    // with its own warning, and this provider makes no claim that DPAPI worked.
    return {};
  }

  function ensureStore() {
    if (!storePromise) storePromise = loadStore();
    return storePromise;
  }

  return {
    name: 'windows-dpapi',
    protectedPath,
    async get(name) {
      if (platform !== 'win32') return null;
      const key = FILE_SECRET_KEYS[name];
      if (!key) return null;
      const store = await ensureStore();
      if (store == null) return null;
      const value = store[key];
      return value != null && String(value).trim() !== '' ? String(value) : null;
    },
    async set(name, value) {
      if (platform !== 'win32') throw new Error('DPAPI is only available on Windows');
      const key = FILE_SECRET_KEYS[name];
      if (!key) throw new Error(`unknown secret name ${JSON.stringify(name)}`);
      const text = String(value ?? '');
      if (text.trim() === '') throw new Error(`refusing to store an empty secret for ${name}`);
      const store = await ensureStore();
      if (store == null) throw new Error('the DPAPI credential store is unavailable');
      store[key] = text;
      await writeProtected(store);
      return { stored: true, store: 'windows-dpapi', path: protectedPath };
    },
    warnings() {
      const out = pendingWarnings;
      pendingWarnings = [];
      return out;
    },
  };
}

/**
 * A human label for the store secrets are written to. It names the actual destination
 * so a Windows install does not advertise a plaintext path it will not use.
 */
export function describeCredentialStore(providers = [], { platform = process.platform } = {}) {
  const dpapi = providers.find((provider) => provider?.name === 'windows-dpapi');
  if (platform === 'win32' && dpapi) {
    return dpapi.protectedPath ? `Windows DPAPI (CurrentUser) at ${dpapi.protectedPath}` : 'Windows DPAPI (CurrentUser)';
  }
  const file = providers.find((provider) => provider?.name === 'file');
  return file?.path ? `credential file at ${file.path}` : 'the file credential store';
}

/** The providers used when none are injected, in priority order. */
export function defaultCredentialProviders(options = {}) {
  const providers = [];
  if ((options.platform ?? process.platform) === 'win32') {
    providers.push(createDpapiCredentialProvider(options));
  }
  providers.push(createFileCredentialProvider(options));
  return providers;
}

/**
 * Resolve one secret through the documented order.
 * @returns {Promise<{value: string|null, source: string|null}>}
 */
export async function resolveSecret(name, { explicit = null, env = process.env, providers = [] } = {}) {
  if (explicit != null && String(explicit).trim() !== '') {
    return { value: String(explicit), source: 'explicit' };
  }

  const envVar = SECRET_ENV[name];
  if (envVar && env?.[envVar] != null && String(env[envVar]).trim() !== '') {
    return { value: String(env[envVar]), source: 'env' };
  }

  for (const provider of providers) {
    try {
      const value = await provider.get(name);
      if (value != null && String(value).trim() !== '') {
        return { value: String(value), source: provider.name };
      }
    } catch {
      // A broken provider must not prevent a later one from answering.
    }
  }

  return { value: null, source: null };
}

/**
 * Resolve every known secret.
 * @returns {Promise<{pushbullet: {value,source}, llm: {value,source}, providers: string[], store: string, warnings: string[]}>}
 */
export async function loadSecrets({
  explicit = {},
  env = process.env,
  providers = null,
  platform = process.platform,
  homedir = osHomedir,
  credentialPath = null,
  logger = null,
} = {}) {
  const list =
    providers ??
    defaultCredentialProviders({
      path: credentialPath ?? defaultCredentialPath({ platform, env, homedir }),
      platform,
    });

  const out = {};
  for (const name of SECRET_NAMES) {
    out[name] = await resolveSecret(name, { explicit: explicit?.[name] ?? null, env, providers: list });
  }

  const warnings = [];
  for (const provider of list) {
    try {
      for (const warning of provider.warnings?.() ?? []) warnings.push(warning);
    } catch {
      // provider diagnostics are best-effort
    }
  }
  for (const warning of warnings) logger?.warn?.(warning);
  // Name the store chain explicitly, so a Windows install that fell back to the file
  // shows both the preference and the fallback instead of hiding it (#60).
  const store = describeCredentialStore(list, { platform });
  logger?.info?.(`credential store: ${list.map((p) => p.name).join(' -> ')} (${store})`);

  return { ...out, providers: list.map((p) => p.name), store, warnings };
}

/**
 * Persist secrets through the provider interface - the first provider that can
 * `set` wins. This is the *only* write path: environment variables cannot be
 * written, so the credential store is the destination, and the setup dialog calls
 * this rather than reaching into a file itself.
 *
 * Values are never returned or logged. `saveSecrets` deliberately refuses to run
 * with no writable provider instead of silently discarding a key the user typed.
 *
 * @returns {Promise<{saved: string[], providers: string[]}>}
 */
export async function saveSecrets({
  entries = {},
  providers = null,
  platform = process.platform,
  env = process.env,
  homedir = osHomedir,
  credentialPath = null,
  logger = null,
} = {}) {
  const list =
    providers ??
    defaultCredentialProviders({
      path: credentialPath ?? defaultCredentialPath({ platform, env, homedir }),
      platform,
    });
  const writable = list.filter((p) => typeof p.set === 'function');
  if (writable.length === 0) {
    throw new Error(
      'no writable credential store is available; set PUSHBULLET_TOKEN / LLM_API_KEY in the environment instead'
    );
  }

  const saved = [];
  for (const [name, value] of Object.entries(entries)) {
    if (value == null || String(value).trim() === '') continue;
    let stored = false;
    let lastError = null;
    for (const provider of writable) {
      try {
        await provider.set(name, value);
        stored = true;
        logger?.info?.(`stored ${name} secret in ${provider.name}`);
        break;
      } catch (err) {
        lastError = err;
        // The fallback is announced: silently storing plaintext because DPAPI is
        // unavailable would be exactly the posture #60 exists to end.
        logger?.warn?.(`credential store ${provider.name} did not accept the ${name} secret: ${err?.message ?? err}`);
      }
    }
    if (!stored) {
      throw new Error(`could not store the ${name} secret: ${lastError?.message ?? 'no provider accepted it'}`);
    }
    saved.push(name);
  }
  return { saved, providers: writable.map((p) => p.name) };
}
