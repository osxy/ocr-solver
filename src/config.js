/**
 * Configuration: TOML on disk, with a working default for every value.
 *
 * A missing config file is normal. The app must run with no config at all, on a
 * machine that has never seen it, so `DEFAULTS` is the real specification and the
 * file only overrides it. Two rules follow from that:
 *
 *  - an unknown key warns and is ignored, so a config written by a newer version
 *    does not brick an older binary;
 *  - a *bad* value throws and names the offending key, because silently ignoring a
 *    typo (`history_mode = "ignore-history"`) is how a typo becomes a behaviour bug.
 *
 * Secrets are rejected outright. The config file is a plain file that ends up in a
 * backup and in a support thread; the token and the key live in the environment or
 * the credential store (DESIGN 4.13).
 *
 * Path resolution: `--config <path>` -> `$PUZZLESOLVER_CONFIG` -> platform default.
 * Windows uses `%APPDATA%\PuzzleSolver\config.toml`; elsewhere
 * `${XDG_CONFIG_HOME:-~/.config}/PuzzleSolver/config.toml`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { VARIANTS } from './imaging/preprocess.js';
import { HISTORY_MODES } from './pushbullet/listener.js';
import { STRATEGIES, DEFAULT_UNRESOLVED_TITLE, DEFAULT_UNRESOLVED_TEXT } from './pushbullet/respond.js';
import {
  DEFAULT_HTTP_BIND,
  DEFAULT_HTTP_PORT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_TIMEOUT_MS,
} from './http/defaults.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const CONFIG_ENV_VAR = 'PUZZLESOLVER_CONFIG';

/**
 * Every value the app can be configured with, and the value used when the file
 * (or the key) is absent. Keep this in step with DESIGN 4.13.
 */
export const DEFAULTS = {
  pushbullet: {
    // 60 s is slow enough to be invisible in the API rate budget and the stream is
    // the primary path; the poll only exists for a socket that died silently.
    poll_interval_sec: 60,
    history_mode: 'ignore',
  },
  solver: {
    tier0: true,
    // Applies to the classes that actually vote (ordinal-pick, unknown). count and
    // arithmetic stay at one deterministic sample (M1-5); this is not a knob for
    // making `9 - 4` sampled.
    self_consistency_n: 3,
    escalate_to_vision: true,
    llm_text_model: 'gpt-4o-mini',
    llm_vision_model: 'gpt-4o',
    llm_base_url: 'https://api.openai.com/v1',
    offline_only: false,
    // Circuit breaker per model tier (DESIGN 7). Three consecutive transient failures
    // trip it; a permanent one (bad key/model/cost tier) trips it immediately. It then
    // stays open for this many seconds and Tier 0 carries the puzzle alone.
    breaker_threshold: 3,
    breaker_cooldown_sec: 600,
  },
  ocr: {
    languages: ['nld'],
    min_confidence: 0,
    variants: ['adaptive_25_020', 'adaptive_25_020_c8', 'adaptive_15_020'],
  },
  reply: {
    enabled: true,
    strategy: 'note-push',
    title: 'Antwoord',
    prefix: '',
    // The acknowledgement sent when no tier produced a valid answer. Its own title
    // and body keep it from reading as a solution (issue #29); an empty value is
    // rejected because `reply.enabled = false` is the way to turn replies off.
    unresolved_title: DEFAULT_UNRESOLVED_TITLE,
    unresolved_text: DEFAULT_UNRESOLVED_TEXT,
    require_confidence: true,
    min_interval_sec: 3,
    max_per_hour: 20,
  },
  storage: {
    retain_days: 7,
    // Image bytes are never written to a log or the attempts table. This only
    // records a durable reference to the retained image, and only for puzzles that
    // ended unresolved, so a failure can be looked at later (DESIGN 8).
    log_images: false,
  },
  ui: {
    tray: true,
    notify_on_unresolved: true,
  },
  // HTTP ingress (#15). Off by default: an endpoint that solves CAPTCHAs is an
  // oracle, so enabling it is a deliberate act with a bearer token attached.
  http: {
    enabled: false,
    bind: DEFAULT_HTTP_BIND,
    port: DEFAULT_HTTP_PORT,
    rate_limit_per_min: DEFAULT_RATE_LIMIT_PER_MIN,
    // Synchronous by design (DESIGN 4.15): offline solves are ~1-5 s and a vision
    // escalation can pass 10 s, so the budget is generous and a solve that blows it
    // is a 504 rather than a 202 the caller has to poll.
    timeout_ms: DEFAULT_TIMEOUT_MS,
    max_body_bytes: DEFAULT_MAX_BODY_BYTES,
  },
};

/** Default config path, platform-aware and overridable through the environment. */
export function defaultConfigPath({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(base, 'PuzzleSolver', 'config.toml');
  }
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(base, 'PuzzleSolver', 'config.toml');
}

/**
 * The config path the app will actually read.
 * `explicit` (from `--config`) wins, then `$PUZZLESOLVER_CONFIG`, then the default.
 * An empty environment variable is treated as unset rather than as a path of "".
 */
export function resolveConfigPath({ explicit = null, env = process.env, platform = process.platform, homedir = osHomedir } = {}) {
  if (explicit != null && String(explicit).trim() !== '') return String(explicit);
  const fromEnv = env?.[CONFIG_ENV_VAR];
  if (fromEnv != null && String(fromEnv).trim() !== '') return String(fromEnv);
  return defaultConfigPath({ platform, env, homedir });
}

/** Default SQLite path. Not part of the config schema; kept beside the inbox data. */
export function defaultStatePath({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'PuzzleSolver', 'state.db');
  }
  const base = env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(base, 'puzzlesolver', 'state.db');
}

const SECRET_KEY_PATTERN = /token|api[_-]?key|key|secret|password/i;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Walk every key in the parsed TOML, nested tables included. */
function walkKeys(node, visit, prefix = '') {
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    visit(key, path, value);
    walkKeys(value, visit, path);
  }
}

function checkSecrets(raw) {
  walkKeys(raw, (key, path) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ConfigError(
        `config key "${path}" looks like a secret. Secrets are never stored in config.toml; ` +
          'set PUSHBULLET_TOKEN / LLM_API_KEY in the environment or put them in the credential store.'
      );
    }
  });
}

/** Unknown sections and keys warn; they must not stop the app from starting. */
function collectUnknownKeys(raw) {
  const warnings = [];
  for (const [section, values] of Object.entries(raw)) {
    if (!(section in DEFAULTS)) {
      warnings.push(`unknown config section "${section}" ignored`);
      continue;
    }
    if (!isPlainObject(values)) {
      warnings.push(`config section "${section}" is not a table and was ignored`);
      continue;
    }
    for (const key of Object.keys(values)) {
      if (!(key in DEFAULTS[section])) warnings.push(`unknown config key "${section}.${key}" ignored`);
    }
  }
  return warnings;
}

function requireBoolean(config, section, key) {
  const value = config[section][key];
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${section}.${key} must be true or false, got ${JSON.stringify(value)}`);
  }
}

function requireString(config, section, key, { allowEmpty = false } = {}) {
  const value = config[section][key];
  if (typeof value !== 'string') {
    throw new ConfigError(`${section}.${key} must be a string, got ${JSON.stringify(value)}`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new ConfigError(`${section}.${key} must not be empty`);
  }
}

function requireNumber(config, section, key, { min = null, max = null, integer = false } = {}) {
  const value = config[section][key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(`${section}.${key} must be a number, got ${JSON.stringify(value)}`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new ConfigError(`${section}.${key} must be an integer, got ${value}`);
  }
  if (min != null && value < min) throw new ConfigError(`${section}.${key} must be >= ${min}, got ${value}`);
  if (max != null && value > max) throw new ConfigError(`${section}.${key} must be <= ${max}, got ${value}`);
}

function requireEnum(config, section, key, allowed) {
  const value = config[section][key];
  if (!allowed.includes(value)) {
    throw new ConfigError(
      `${section}.${key} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`
    );
  }
}

function requireStringArray(config, section, key, { nonEmpty = false } = {}) {
  const value = config[section][key];
  if (!Array.isArray(value)) {
    throw new ConfigError(`${section}.${key} must be an array of strings, got ${JSON.stringify(value)}`);
  }
  if (nonEmpty && value.length === 0) throw new ConfigError(`${section}.${key} must not be empty`);
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${section}.${key} must contain non-empty strings, got ${JSON.stringify(entry)}`);
    }
  }
}

function requireVariants(config, section, key) {
  const value = config[section][key];
  requireStringArray(config, section, key, { nonEmpty: true });
  // Checked against the real presets, not a copied list: adding a variant to
  // preprocess.js and forgetting this file would otherwise be a silent rejection.
  const known = Object.keys(VARIANTS);
  for (const name of value) {
    if (!known.includes(name)) {
      throw new ConfigError(`${section}.${key} contains unknown variant "${name}"; known variants: ${known.join(', ')}`);
    }
  }
}

/**
 * Validate a parsed config object and return a complete, deep-cloned config.
 * Extra keys are preserved nowhere: the returned object is exactly the schema.
 *
 * @returns {{config: object, warnings: string[]}}
 */
export function validateConfig(raw = {}) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`config must be a table, got ${JSON.stringify(raw)}`);
  }
  checkSecrets(raw);
  const warnings = collectUnknownKeys(raw);

  const config = structuredClone(DEFAULTS);
  for (const [section, values] of Object.entries(raw)) {
    if (!(section in DEFAULTS) || !isPlainObject(values)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (key in DEFAULTS[section]) config[section][key] = value;
    }
  }

  requireNumber(config, 'pushbullet', 'poll_interval_sec', { min: 0 });
  requireEnum(config, 'pushbullet', 'history_mode', HISTORY_MODES);

  requireBoolean(config, 'solver', 'tier0');
  requireNumber(config, 'solver', 'self_consistency_n', { min: 1, integer: true });
  requireBoolean(config, 'solver', 'escalate_to_vision');
  requireString(config, 'solver', 'llm_text_model');
  requireString(config, 'solver', 'llm_vision_model');
  requireString(config, 'solver', 'llm_base_url');
  requireBoolean(config, 'solver', 'offline_only');
  requireNumber(config, 'solver', 'breaker_threshold', { min: 1, integer: true });
  requireNumber(config, 'solver', 'breaker_cooldown_sec', { min: 0 });

  requireStringArray(config, 'ocr', 'languages', { nonEmpty: true });
  requireNumber(config, 'ocr', 'min_confidence', { min: 0, max: 100 });
  requireVariants(config, 'ocr', 'variants');

  requireBoolean(config, 'reply', 'enabled');
  requireEnum(config, 'reply', 'strategy', Object.keys(STRATEGIES));
  requireString(config, 'reply', 'title');
  requireString(config, 'reply', 'prefix', { allowEmpty: true });
  requireString(config, 'reply', 'unresolved_title');
  requireString(config, 'reply', 'unresolved_text');
  requireBoolean(config, 'reply', 'require_confidence');
  requireNumber(config, 'reply', 'min_interval_sec', { min: 0 });
  requireNumber(config, 'reply', 'max_per_hour', { min: 0, integer: true });

  requireNumber(config, 'storage', 'retain_days', { min: 0 });
  requireBoolean(config, 'storage', 'log_images');

  requireBoolean(config, 'ui', 'tray');
  requireBoolean(config, 'ui', 'notify_on_unresolved');

  requireBoolean(config, 'http', 'enabled');
  requireString(config, 'http', 'bind');
  requireNumber(config, 'http', 'port', { min: 0, max: 65_535, integer: true });
  requireNumber(config, 'http', 'rate_limit_per_min', { min: 0, integer: true });
  requireNumber(config, 'http', 'timeout_ms', { min: 0, integer: true });
  requireNumber(config, 'http', 'max_body_bytes', { min: 1, integer: true });

  return { config, warnings };
}

/**
 * Load the config, or the defaults if there is no file.
 *
 * The absence of a file is not an error. A file that exists but cannot be parsed
 * *is* one: a broken config silently replaced by defaults would make the app run
 * with settings nobody chose.
 *
 * @returns {{path: string, config: object, warnings: string[], loaded: boolean}}
 */
export function loadConfig({
  explicitPath = null,
  env = process.env,
  platform = process.platform,
  homedir = osHomedir,
  readFile = readFileSync,
  fileExists = existsSync,
} = {}) {
  const path = resolveConfigPath({ explicit: explicitPath, env, platform, homedir });
  if (!fileExists(path)) {
    return { path, config: structuredClone(DEFAULTS), warnings: [], loaded: false };
  }

  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (err) {
    throw new ConfigError(`could not read config file ${path}: ${err?.message ?? err}`);
  }

  let raw;
  try {
    raw = parseToml(text);
  } catch (err) {
    throw new ConfigError(`could not parse ${path} as TOML: ${err?.message ?? err}`);
  }

  const { config, warnings } = validateConfig(raw);
  return { path, config, warnings, loaded: true };
}
