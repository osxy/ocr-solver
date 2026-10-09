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
import { readFileSync, existsSync, statSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

/** Environment variable per secret name. */
export const SECRET_ENV = {
  pushbullet: 'PUSHBULLET_TOKEN',
  llm: 'LLM_API_KEY',
};

/** Key names inside the file credential store. */
export const FILE_SECRET_KEYS = {
  pushbullet: 'pushbullet_token',
  llm: 'llm_api_key',
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
 * someone out of their own credential is worse) but `warnings` reports it.
 */
export function createFileCredentialProvider({
  path = defaultCredentialPath(),
  readFile = readFileSync,
  fileExists = existsSync,
  stat = statSync,
} = {}) {
  let warnedMode = false;
  return {
    name: 'file',
    get(name) {
      if (!path || !fileExists(path)) return null;
      let parsed;
      try {
        parsed = JSON.parse(readFile(path, 'utf8'));
      } catch {
        // A corrupt credentials file is not worth crashing over; env still works.
        return null;
      }
      const key = FILE_SECRET_KEYS[name];
      if (!key) return null;
      const value = parsed?.[key];
      return value != null && String(value).trim() !== '' ? String(value) : null;
    },
    /** Non-fatal problems worth surfacing once, e.g. lax file permissions. */
    warnings() {
      const out = [];
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
