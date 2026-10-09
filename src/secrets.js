/**
 * Secret resolution.
 *
 * One secret, three sources, first hit wins:
 *
 *   1. an explicit option (`--token`, `--api-key`);
 *   2. the environment (`PUSHBULLET_TOKEN`, `LLM_API_KEY`) - what development and
 *      the live test suite use;
 *   3. the platform credential store (Windows Credential Manager, or the
 *      ACL-restricted file fallback);
 *   4. otherwise `null`.
 *
 * Secrets are never written to disk by this module, never logged and never
 * stringified into an error. `describeSecret` is the only diagnostic, and it keeps
 * a three-character prefix - enough to tell two keys apart, useless to a reader.
 *
 * The Windows Credential Manager provider is loaded lazily. The development and CI
 * environment is Linux, so that branch has never been executed here: it is behind a
 * one-method provider interface, its loader is injectable, and no test requires it.
 */
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
};

/** Key names inside the file credential store. */
export const FILE_SECRET_KEYS = {
  pushbullet: 'pushbullet_token',
  llm: 'llm_api_key',
  http: 'http_auth_token',
};

export const SECRET_NAMES = Object.keys(SECRET_ENV);
export const CREDENTIAL_SERVICE = 'PuzzleSolver';

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
 * Windows Credential Manager provider.
 *
 * UNVERIFIED ON WINDOWS. This repository is developed and tested on Linux, so this
 * code path has never run. It is written against the keytar-style interface
 * (`getPassword(service, account)`) and its module loader is injectable, which is
 * what the tests exercise instead. A Windows build is expected to provide the
 * native binding; M2's dependency budget is `smol-toml` alone, so none is bundled.
 * Any failure (missing module, no entry) returns null so the environment variable
 * path still works.
 */
export function createWindowsCredentialProvider({
  loadModule = () => import('keytar'),
  platform = process.platform,
  service = CREDENTIAL_SERVICE,
} = {}) {
  let modulePromise = null;
  async function binding() {
    if (platform !== 'win32') return null;
    if (!modulePromise) modulePromise = Promise.resolve().then(loadModule);
    try {
      const mod = await modulePromise;
      return mod?.default ?? mod ?? null;
    } catch {
      // No binding installed: fall through to the file store / environment.
      return null;
    }
  }
  return {
    name: 'windows-credential-manager',
    async get(name) {
      const account = FILE_SECRET_KEYS[name];
      if (!account) return null;
      const mod = await binding();
      if (typeof mod?.getPassword !== 'function') return null;
      try {
        const value = await mod.getPassword(service, account);
        return value != null && String(value).trim() !== '' ? String(value) : null;
      } catch {
        return null;
      }
    },
    /** UNVERIFIED ON WINDOWS: written against the keytar `setPassword` shape. */
    async set(name, value) {
      const account = FILE_SECRET_KEYS[name];
      if (!account) throw new Error(`unknown secret name ${JSON.stringify(name)}`);
      const text = String(value ?? '');
      if (text.trim() === '') throw new Error(`refusing to store an empty secret for ${name}`);
      const mod = await binding();
      if (typeof mod?.setPassword !== 'function') throw new Error('credential manager backing unavailable');
      await mod.setPassword(service, account, text);
      return { stored: true, store: 'windows-credential-manager' };
    },
  };
}

/** The providers used when none are injected, in priority order. */
export function defaultCredentialProviders(options = {}) {
  const providers = [];
  if ((options.platform ?? process.platform) === 'win32') {
    providers.push(createWindowsCredentialProvider(options));
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
 * @returns {Promise<{pushbullet: {value,source}, llm: {value,source}, providers: string[], warnings: string[]}>}
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

  return { ...out, providers: list.map((p) => p.name), warnings };
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
      }
    }
    if (!stored) {
      throw new Error(`could not store the ${name} secret: ${lastError?.message ?? 'no provider accepted it'}`);
    }
    saved.push(name);
  }
  return { saved, providers: writable.map((p) => p.name) };
}
