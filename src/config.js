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
import { DEFAULT_MAX_PIXELS, DEFAULT_MAX_WIDTH } from './imaging/limits.js';
import { COST_TIERS } from './model/client.js';
import { HISTORY_MODES } from './pushbullet/listener.js';
import { STRATEGIES, DEFAULT_UNRESOLVED_TITLE, DEFAULT_UNRESOLVED_TEXT } from './pushbullet/respond.js';
import {
  WEB_UI_CREDENTIAL_SETTING,
  cidrsCoverAddressSpace,
  isCatchAllCidr,
  isLoopbackAddress,
  normalizeHostEntry,
  parseCidr,
  webUiAdmitsNonLoopback,
} from './ui/access.js';
import {
  DEFAULT_ALLOW_IMAGE_URL,
  DEFAULT_HTTP_BIND,
  DEFAULT_HTTP_PORT,
  DEFAULT_IMAGE_URL_HOSTS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_QUEUE,
  DEFAULT_RATE_LIMIT_PER_MIN,
  DEFAULT_TIMEOUT_MS,
  imageUrlHostProblem,
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
    // OpenRouter auto-router controls. They apply only to auto-routed slugs
    // (`openrouter/auto`, `openrouter/auto-beta`); a pinned model ignores them, so
    // they are policy knobs rather than provider settings. `cost_tier` empty means
    // "send no band", which OpenRouter routes at its cheapest.
    cost_tier: '',
    allowed_models: [],
    excluded_models: [],
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
    // Acknowledgements have their own, looser budget so a junk-image flood cannot
    // starve real answers (#48). 60/hour is one a minute on average; the 3 s minimum
    // interval still bounds a burst.
    unresolved_max_per_hour: 60,
  },
  storage: {
    retain_days: 7,
    // Image bytes are never written to a log or the attempts table. This only
    // records a durable reference to the retained image, and only for puzzles that
    // ended unresolved, so a failure can be looked at later (DESIGN 8).
    log_images: false,
    // #100: store a bounded review copy of EVERY solve's image, so the recent-solves
    // page can show what was solved. This is the only setting that persists user
    // content to disk. Off by default for the same reason `log_images` is: retention
    // is an explicit act, and the project fails closed on anything that keeps data.
    keep_images: false,
    // Count cap on stored images. Enforced on every save and at startup prune; a
    // bounded copy plus a count cap is the disk bound. The age policy is the shared
    // `retain_days` window, so images cannot outlive the attempts that reference them.
    max_images: 200,
  },
  ui: {
    tray: true,
    notify_on_unresolved: true,
    // How many recent solves the statistics page lists. Bounded at both ends: an
    // unbounded limit is a way to dump the attempts table or hang a page load. The
    // page renders whatever is stored and never re-polls (issue #64).
    stats_recent_solves: 5,
  },
  // The shared image gate. Both ingresses run it, so its limits are neither
  // Pushbullet-only nor HTTP-only. Byte size and height keep their existing defaults
  // (`files.js`); width and total pixels are the new guard against a tiny file that
  // decodes to an enormous bitmap. Chosen by measurement (DESIGN 8).
  image: {
    max_width: DEFAULT_MAX_WIDTH,
    max_pixels: DEFAULT_MAX_PIXELS,
  },
  // The configuration/solve web UI (#56, #65). Loopback-only and not configurable
  // until #65; now a configured CIDR list can widen it. An empty `allowed_cidrs`
  // means loopback only, so the default does not change. A non-loopback range is an
  // explicit act and additionally requires a credential in the credential store, or
  // the app refuses to start rather than expose an unauthenticated oracle.
  web_ui: {
    bind: '127.0.0.1',
    // The settings UI's port. `0` is the ephemeral loopback case (#56); a value is
    // required before a remote client or a TLS reverse proxy can be pointed at it,
    // because an ephemeral port is unknowable in advance (#85).
    port: 0,
    // Loopback is always admitted; these are added on top of it. The catch-all is
    // refused at load, including a set of ranges that only *together* cover the
    // space (see `requireCidrList`).
    allowed_cidrs: [],
    // Extra Host-header names accepted when the bind is non-loopback or a hostname
    // is used to reach it (a LAN name or a reverse-proxy vhost). Default deny; the
    // bound address and the loopback names are always accepted.
    allowed_hosts: [],
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
    // HTTP requests running or waiting on the shared solver at once; over the bound
    // the request is refused (503 + Retry-After) rather than queued to bill for an
    // answer nobody is waiting for. See DESIGN 4.15 (#43).
    max_queue: DEFAULT_MAX_QUEUE,
    // `image_url` makes the server fetch a caller-supplied URL (SSRF). Uploading is
    // the normal path, so this is off by default; enabling it requires the host to
    // be named below (default deny). See DESIGN §8 (issue #57).
    allow_image_url: DEFAULT_ALLOW_IMAGE_URL,
    image_url_hosts: DEFAULT_IMAGE_URL_HOSTS,
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

function requireEnum(config, section, key, allowed, { allowEmpty = false } = {}) {
  const value = config[section][key];
  // `cost_tier` uses the empty string for "unset": TOML has no null and a missing
  // key already falls back to the default, so an explicit empty is how a user clears
  // a previously configured band.
  if (allowEmpty && value === '') return;
  if (!allowed.includes(value)) {
    throw new ConfigError(
      `${section}.${key} must be one of ${allowed.join(', ')}${allowEmpty ? ', or empty for the provider default' : ''}, got ${JSON.stringify(value)}`
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

/** An allowlist of bare hosts; a typo like `https://example.com` must not silently deny. */
function requireHostList(config, section, key) {
  requireStringArray(config, section, key);
  for (const entry of config[section][key]) {
    const problem = imageUrlHostProblem(entry);
    if (problem) throw new ConfigError(`${section}.${key} entry ${JSON.stringify(entry)} ${problem}`);
  }
}

/**
 * One CIDR range per entry, with the catch-all refused.
 *
 * A UI that writes secrets and spends provider credits, reachable from every
 * address, has no legitimate use, so `0.0.0.0/0` and `::/0` are not accepted. #89:
 * the refusal is about *effective* coverage, not the literal `/0` - two half-space
 * ranges (`0.0.0.0/1` + `128.0.0.0/1`, or `::/1` + `8000::/1`) cover the same space
 * and are refused too. It is a guard against "reachable from everywhere", not a
 * ceiling: a single wide-but-partial range is allowed because the operator asked for
 * it explicitly and the configured credential is the control that actually
 * protects the UI. The error names the reverse-proxy alternative so the operator is
 * not left to discover it. The network address is what is stored (host bits masked).
 */
function requireCidrList(config, section, key) {
  requireStringArray(config, section, key);
  const parsed = [];
  for (const entry of config[section][key]) {
    const cidr = parseCidr(entry);
    if (!cidr) {
      throw new ConfigError(
        `${section}.${key} entry ${JSON.stringify(entry)} is not a CIDR range like "192.168.1.0/24" or "fd00::/8"`
      );
    }
    if (isCatchAllCidr(cidr)) {
      throw new ConfigError(
        `${section}.${key} entry ${JSON.stringify(entry)} is a catch-all and would open the web UI to every address; ` +
          'refuse it and put the UI behind an authenticated TLS reverse proxy if it must be reachable from everywhere'
      );
    }
    parsed.push(cidr);
  }
  if (cidrsCoverAddressSpace(parsed)) {
    throw new ConfigError(
      `${section}.${key} entries together cover every address, which is the same exposure as a catch-all; ` +
        'refuse them and put the UI behind an authenticated TLS reverse proxy if it must be reachable from everywhere'
    );
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
  requireEnum(config, 'solver', 'cost_tier', COST_TIERS, { allowEmpty: true });
  requireStringArray(config, 'solver', 'allowed_models');
  requireStringArray(config, 'solver', 'excluded_models');
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
  requireNumber(config, 'reply', 'unresolved_max_per_hour', { min: 0, integer: true });

  requireNumber(config, 'storage', 'retain_days', { min: 0 });
  requireBoolean(config, 'storage', 'log_images');
  requireBoolean(config, 'storage', 'keep_images');
  requireNumber(config, 'storage', 'max_images', { min: 1, integer: true, max: 100_000 });

  requireBoolean(config, 'ui', 'tray');
  requireBoolean(config, 'ui', 'notify_on_unresolved');
  requireNumber(config, 'ui', 'stats_recent_solves', { min: 1, max: 100, integer: true });

  requireString(config, 'web_ui', 'bind');
  const bindProblem = imageUrlHostProblem(config.web_ui.bind);
  if (bindProblem) throw new ConfigError(`web_ui.bind ${bindProblem}`);
  requireNumber(config, 'web_ui', 'port', { min: 0, max: 65_535, integer: true });
  requireCidrList(config, 'web_ui', 'allowed_cidrs');
  requireHostList(config, 'web_ui', 'allowed_hosts');

  requireNumber(config, 'image', 'max_width', { min: 1, integer: true });
  requireNumber(config, 'image', 'max_pixels', { min: 1, integer: true });

  requireBoolean(config, 'http', 'enabled');
  requireString(config, 'http', 'bind');
  requireNumber(config, 'http', 'port', { min: 0, max: 65_535, integer: true });
  requireNumber(config, 'http', 'rate_limit_per_min', { min: 0, integer: true });
  requireNumber(config, 'http', 'timeout_ms', { min: 0, integer: true });
  requireNumber(config, 'http', 'max_body_bytes', { min: 1, integer: true });
  requireNumber(config, 'http', 'max_queue', { min: 1, integer: true });
  requireBoolean(config, 'http', 'allow_image_url');
  requireHostList(config, 'http', 'image_url_hosts');

  // Loud, at load, whenever the web UI is wider than loopback. The credential check
  // is a runtime one (the credential store is not available here) and lives in
  // `assertWebUiAccessIsConfigured`, but the operator should see the consequence at
  // the same moment the range is loaded.
  const bindName = normalizeHostEntry(config.web_ui.bind);
  const bindIsLoopback = bindName === 'localhost' || isLoopbackAddress(bindName);
  if (webUiAdmitsNonLoopback(config.web_ui)) {
    warnings.push(
      'web_ui.allowed_cidrs admits addresses beyond loopback; the web UI can write the config and solve images, ' +
        `and a non-loopback range requires a configured ${WEB_UI_CREDENTIAL_SETTING} credential or startup is refused. ` +
        'Set web_ui.port to a fixed non-zero port so a remote client or reverse proxy can reach it.'
    );
  }
  if (!bindIsLoopback) {
    warnings.push(
      `web_ui.bind=${config.web_ui.bind} listens beyond this machine. Prefer 127.0.0.1; ` +
        'this UI is plain HTTP, so a password on an untrusted network is cleartext - use a TLS reverse proxy there.'
    );
  }

  return { config, warnings };
}

/**
 * The auto-router options `createChatClient` accepts, read from a validated config.
 * One mapping, so `buildReasonerFromConfig`, the CLI and `live-eval` cannot drift on
 * which config key means which router option. `cost_tier` is normalised to `null`
 * ("send no band") because an empty string is how the config spells unset.
 */
export function autoRouterOptions(config) {
  const solver = config?.solver ?? {};
  return {
    costTier: solver.cost_tier || null,
    allowedModels: [...(solver.allowed_models ?? [])],
    excludedModels: [...(solver.excluded_models ?? [])],
  };
}

/** The environment spelling of the same three options, kept for the CLI/live-eval. */
export function autoRouterFromEnv(env = process.env) {
  const splitList = (value) =>
    String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  return {
    costTier: env?.LLM_COST_TIER || null,
    allowedModels: splitList(env?.LLM_ALLOWED_MODELS),
    excludedModels: splitList(env?.LLM_EXCLUDED_MODELS),
  };
}

/**
 * Resolve the router options the way the CLI and live-eval need them: an explicit
 * flag beats the environment, which beats the config file. An empty list is treated
 * as "not set" rather than "clear the restriction", so an unrelated empty flag
 * cannot silently drop a policy control the user configured.
 */
export function resolveAutoRouter({ config = null, env = null, explicit = null } = {}) {
  const fromConfig = autoRouterOptions(config);
  const fromEnv = env ? autoRouterFromEnv(env) : { costTier: null, allowedModels: [], excludedModels: [] };
  const flags = explicit ?? {};
  const firstNonEmptyList = (...lists) => lists.find((list) => Array.isArray(list) && list.length > 0) ?? [];
  return {
    costTier: flags.costTier || fromEnv.costTier || fromConfig.costTier || null,
    allowedModels: firstNonEmptyList(flags.allowedModels, fromEnv.allowedModels, fromConfig.allowedModels),
    excludedModels: firstNonEmptyList(flags.excludedModels, fromEnv.excludedModels, fromConfig.excludedModels),
  };
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
