/**
 * Settings editor: the logic behind changing configuration after first-run setup.
 *
 * This is the second half of `src/ui/setup.js`, not a second copy of it. That module
 * owns *what a credential is* (validation, the **Test connection** probes, the
 * `saveSecrets` seam); this one owns *which settings exist* and how a change reaches
 * the right store. The two stores are genuinely different and mixing them up is the
 * risk this file exists to contain:
 *
 *   - secrets (Pushbullet token, model key) go through `saveSecrets` -> the credential
 *     provider. `config.toml` **rejects** secret-shaped keys by design, so a token
 *     written there would be a file the app refuses to read;
 *   - everything else goes to the TOML file, and only after `validateConfig` has
 *     accepted it. The loader is the one validator; the editor does not get a second,
 *     drifting opinion about what is valid.
 *
 * Two properties are deliberate:
 *
 *   - **Validate, then write.** A value that cannot be parsed is rejected when it is
 *     entered, and the assembled config is passed through `validateConfig` again
 *     before the writer runs. Nothing on disk changes on a rejection.
 *   - **Atomic, with a backup.** The new file is written to a temp file in the same
 *     directory and renamed over the old one, and the old one is copied to
 *     `config.toml.bak` first. A bad edit is always recoverable.
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'smol-toml';
import { DEFAULTS, validateConfig } from '../config.js';
import { httpTokenProblem } from '../http/defaults.js';
import { VARIANTS } from '../imaging/preprocess.js';
import { HISTORY_MODES } from '../pushbullet/listener.js';
import { STRATEGIES } from '../pushbullet/respond.js';
import { describeSecret } from '../secrets.js';
import { createSetup, defaultTestModel, defaultTestPushbullet, hasInternalWhitespace } from './setup.js';

/** A value the editor refused before it could reach any store. Names the setting. */
export class SettingValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingValueError';
  }
}

const VARIANT_NAMES = Object.freeze(Object.keys(VARIANTS));

/**
 * Every setting the editor exposes, in menu order. `path` locates the value in the
 * validated config object; `secret` names the credential-store entry instead.
 *
 * `restart: false` is a promise that the running process re-reads the value from this
 * exact config object per solve. `core.solve` re-reads `storage.log_images`,
 * `solver.tier0`, `ocr.variants`, `ocr.min_confidence` and `image.max_pixels`;
 * `handlePush` and the HTTP request path re-read `image.max_width`/`max_pixels` and
 * `ui.notify_on_unresolved`. Everything else is captured when the listener, reasoner,
 * responder or HTTP server is constructed, so the editor says "restart" rather than
 * pretending a live save took effect. Each descriptor's `restart` is checked against
 * the actual re-read site rather than defaulted.
 */
export const SETTINGS = Object.freeze([
  Object.freeze({ id: 'pushbullet.token', label: 'Pushbullet token', secret: 'pushbullet', type: 'secret', restart: true }),
  Object.freeze({ id: 'llm.api_key', label: 'Model API key', secret: 'llm', type: 'secret', restart: true }),

  Object.freeze({ id: 'solver.offline_only', label: 'Offline only (never call a model)', path: ['solver', 'offline_only'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'solver.tier0', label: 'Use the offline tier (Tier 0)', path: ['solver', 'tier0'], type: 'boolean', restart: false }),
  Object.freeze({ id: 'solver.escalate_to_vision', label: 'Escalate to the vision model', path: ['solver', 'escalate_to_vision'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'solver.self_consistency_n', label: 'Self-consistency samples (voting classes)', path: ['solver', 'self_consistency_n'], type: 'integer', min: 1, restart: true }),
  Object.freeze({ id: 'solver.breaker_threshold', label: 'Circuit-breaker failure threshold', path: ['solver', 'breaker_threshold'], type: 'integer', min: 1, restart: true }),
  Object.freeze({ id: 'solver.breaker_cooldown_sec', label: 'Circuit-breaker cooldown (seconds)', path: ['solver', 'breaker_cooldown_sec'], type: 'number', min: 0, restart: true }),
  Object.freeze({ id: 'solver.llm_text_model', label: 'Text model', path: ['solver', 'llm_text_model'], type: 'string', restart: true }),
  Object.freeze({ id: 'solver.llm_vision_model', label: 'Vision model', path: ['solver', 'llm_vision_model'], type: 'string', restart: true }),
  Object.freeze({ id: 'solver.llm_base_url', label: 'Model base URL', path: ['solver', 'llm_base_url'], type: 'string', restart: true }),

  Object.freeze({ id: 'reply.enabled', label: 'Reply at all', path: ['reply', 'enabled'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'reply.strategy', label: 'Reply strategy', path: ['reply', 'strategy'], type: 'enum', choices: Object.keys(STRATEGIES), restart: true }),
  Object.freeze({ id: 'reply.min_interval_sec', label: 'Minimum interval between sends (seconds)', path: ['reply', 'min_interval_sec'], type: 'number', min: 0, restart: true }),
  Object.freeze({ id: 'reply.require_confidence', label: 'Reply only to corroborated answers', path: ['reply', 'require_confidence'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'reply.title', label: 'Reply title', path: ['reply', 'title'], type: 'string', restart: true }),
  Object.freeze({ id: 'reply.prefix', label: 'Reply prefix', path: ['reply', 'prefix'], type: 'string', allowEmpty: true, restart: true }),
  Object.freeze({ id: 'reply.unresolved_title', label: 'Unresolved acknowledgement title', path: ['reply', 'unresolved_title'], type: 'string', restart: true }),
  Object.freeze({ id: 'reply.unresolved_text', label: 'Unresolved acknowledgement text', path: ['reply', 'unresolved_text'], type: 'string', multiline: true, restart: true }),
  Object.freeze({ id: 'reply.unresolved_max_per_hour', label: 'Acknowledgement budget (per hour)', path: ['reply', 'unresolved_max_per_hour'], type: 'integer', min: 0, restart: true }),

  Object.freeze({ id: 'pushbullet.poll_interval_sec', label: 'Fallback poll interval (seconds)', path: ['pushbullet', 'poll_interval_sec'], type: 'number', min: 0, restart: true }),
  Object.freeze({ id: 'pushbullet.history_mode', label: 'History mode', path: ['pushbullet', 'history_mode'], type: 'enum', choices: HISTORY_MODES, restart: true }),

  Object.freeze({ id: 'storage.retain_days', label: 'Retain inbox/attempts (days)', path: ['storage', 'retain_days'], type: 'number', min: 0, restart: true }),
  Object.freeze({ id: 'storage.log_images', label: 'Keep a file reference for unresolved images', path: ['storage', 'log_images'], type: 'boolean', restart: false }),

  Object.freeze({ id: 'ocr.languages', label: 'OCR languages', path: ['ocr', 'languages'], type: 'string-array', restart: true }),
  Object.freeze({ id: 'ocr.min_confidence', label: 'Minimum OCR confidence', path: ['ocr', 'min_confidence'], type: 'number', min: 0, max: 100, restart: false }),
  Object.freeze({ id: 'ocr.variants', label: 'OCR preprocessing variants', path: ['ocr', 'variants'], type: 'string-array', choices: VARIANT_NAMES, restart: false }),

  Object.freeze({ id: 'image.max_width', label: 'Maximum image width (pixels)', path: ['image', 'max_width'], type: 'integer', min: 1, restart: false }),
  Object.freeze({ id: 'image.max_pixels', label: 'Maximum decoded pixels', path: ['image', 'max_pixels'], type: 'integer', min: 1, restart: false }),

  Object.freeze({ id: 'http.enabled', label: 'HTTP ingress', path: ['http', 'enabled'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'http.token', label: 'HTTP bearer token', secret: 'http', type: 'secret', restart: true, testable: false, check: httpTokenProblem }),
  Object.freeze({ id: 'http.bind', label: 'HTTP bind address', path: ['http', 'bind'], type: 'string', restart: true }),
  Object.freeze({ id: 'http.port', label: 'HTTP port', path: ['http', 'port'], type: 'integer', min: 0, max: 65_535, restart: true }),
  Object.freeze({ id: 'http.rate_limit_per_min', label: 'HTTP rate limit (per minute)', path: ['http', 'rate_limit_per_min'], type: 'integer', min: 0, restart: true }),
  Object.freeze({ id: 'http.timeout_ms', label: 'HTTP solve timeout (ms)', path: ['http', 'timeout_ms'], type: 'integer', min: 0, restart: true }),
  Object.freeze({ id: 'http.max_body_bytes', label: 'HTTP max body bytes', path: ['http', 'max_body_bytes'], type: 'integer', min: 1, restart: true }),
  Object.freeze({ id: 'http.max_queue', label: 'HTTP max queue', path: ['http', 'max_queue'], type: 'integer', min: 1, restart: true }),
  Object.freeze({ id: 'http.allow_image_url', label: 'Allow image_url fetching (SSRF risk)', path: ['http', 'allow_image_url'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'http.image_url_hosts', label: 'Allowed image_url hosts (default deny)', path: ['http', 'image_url_hosts'], type: 'string-array', restart: true }),

  Object.freeze({ id: 'ui.tray', label: 'Show the tray', path: ['ui', 'tray'], type: 'boolean', restart: true }),
  Object.freeze({ id: 'ui.notify_on_unresolved', label: 'Notify on an unresolved puzzle', path: ['ui', 'notify_on_unresolved'], type: 'boolean', restart: false }),
]);

const SETTINGS_BY_ID = new Map(SETTINGS.map((setting) => [setting.id, setting]));

export function getSetting(id) {
  return SETTINGS_BY_ID.get(String(id)) ?? null;
}

function readPath(object, path) {
  return path.reduce((node, key) => (node == null ? node : node[key]), object);
}

function writePath(object, path, value) {
  let node = object;
  for (const key of path.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

function checkRange(setting, value) {
  if (setting.min != null && value < setting.min) {
    throw new SettingValueError(`${setting.id} must be >= ${setting.min}, got ${value}`);
  }
  if (setting.max != null && value > setting.max) {
    throw new SettingValueError(`${setting.id} must be <= ${setting.max}, got ${value}`);
  }
}

/**
 * Parse the text a human (or a shell) supplied into the typed value the config
 * expects. Throws `SettingValueError` naming the setting, so a rejected edit can be
 * reported without anything having been written.
 */
export function parseSettingValue(setting, text) {
  if (!setting) throw new SettingValueError('unknown setting');
  const raw = typeof text === 'string' ? text.trim() : text;
  switch (setting.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const normalized = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
      throw new SettingValueError(`${setting.id} must be true or false, got ${JSON.stringify(text)}`);
    }
    case 'integer': {
      const value = Number(raw);
      if (!Number.isInteger(value)) {
        throw new SettingValueError(`${setting.id} must be an integer, got ${JSON.stringify(text)}`);
      }
      checkRange(setting, value);
      return value;
    }
    case 'number': {
      const value = Number(raw);
      if (raw === '' || !Number.isFinite(value)) {
        throw new SettingValueError(`${setting.id} must be a number, got ${JSON.stringify(text)}`);
      }
      checkRange(setting, value);
      return value;
    }
    case 'enum': {
      if (!setting.choices.includes(raw)) {
        throw new SettingValueError(`${setting.id} must be one of ${setting.choices.join(', ')}, got ${JSON.stringify(text)}`);
      }
      return raw;
    }
    case 'string-array': {
      const entries = String(text ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (entries.length === 0) throw new SettingValueError(`${setting.id} must not be empty`);
      for (const entry of entries) {
        if (setting.choices && !setting.choices.includes(entry)) {
          throw new SettingValueError(`${setting.id} contains unknown value "${entry}"; known values: ${setting.choices.join(', ')}`);
        }
      }
      return entries;
    }
    case 'secret': {
      const value = String(text ?? '').trim();
      if (value === '') throw new SettingValueError(`${setting.id} must not be empty`);
      if (hasInternalWhitespace(value)) throw new SettingValueError(`${setting.id} contains whitespace`);
      // A descriptor may carry a setting-specific check (the HTTP bearer token must
      // pass the same strength rule the server enforces at startup, #47). Rejecting
      // it here is what keeps the editor from storing a token the app then refuses to
      // start with.
      if (typeof setting.check === 'function') {
        const problem = setting.check(value);
        if (problem) throw new SettingValueError(`${setting.id} is not usable: ${problem}`);
      }
      return value;
    }
    case 'string': {
      const value = String(text ?? '');
      const trimmed = value.trim();
      if (!setting.allowEmpty && trimmed === '') throw new SettingValueError(`${setting.id} must not be empty`);
      // Internal newlines are meaningful for the acknowledgement text, so only the
      // ends are trimmed; everything in between is kept exactly as entered.
      return setting.multiline ? value.trim() : trimmed;
    }
    default:
      throw new SettingValueError(`setting ${setting.id} has an unsupported type ${JSON.stringify(setting.type)}`);
  }
}

/** Render a typed value for display / `config get`. */
export function serializeSettingValue(setting, value) {
  if (setting?.type === 'string-array' && Array.isArray(value)) return value.join(', ');
  if (setting?.type === 'boolean') return value ? 'true' : 'false';
  return String(value ?? '');
}

/**
 * Reduce a full validated config to the values that differ from `DEFAULTS`.
 *
 * The config file is documented as an override of the built-in defaults, not a copy of
 * them. Writing every key would pin today's defaults in the file, so a later release
 * that changes a default would find the old value explicitly set. Only the differences
 * are written; `config list` is where the effective value of every setting is shown.
 */
export function configToOverrides(config, defaults = DEFAULTS) {
  const equal = (a, b) => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b);
  const out = {};
  for (const [section, values] of Object.entries(config ?? {})) {
    if (!defaults[section] || values == null || typeof values !== 'object') continue;
    const sectionOut = {};
    for (const [key, value] of Object.entries(values)) {
      if (!(key in defaults[section])) continue;
      if (!equal(value, defaults[section][key])) sectionOut[key] = value;
    }
    if (Object.keys(sectionOut).length > 0) out[section] = sectionOut;
  }
  return out;
}

function describeSecretForDisplay(entry) {
  const described = describeSecret(entry ?? null);
  if (!described.present) return 'not set';
  return `${described.hint} (${described.source ?? 'unknown source'})`;
}

/**
 * The atomically-written config file. The old file is copied to `<path>.bak` before
 * the rename so a rejected or bad edit is recoverable; the temp file lives in the
 * same directory so the rename is on one filesystem.
 */
export function writeConfigAtomically({
  path,
  config,
  backupPath = `${path}.bak`,
  writeFile = writeFileSync,
  copyFile = copyFileSync,
  rename = renameSync,
  exists = existsSync,
  mkdir = mkdirSync,
  unlink = unlinkSync,
  now = () => Date.now(),
  pid = process.pid,
} = {}) {
  if (!path || String(path).trim() === '') throw new Error('writeConfigAtomically needs a path');
  const text = stringify(config);
  const dir = dirname(path);
  mkdir(dir, { recursive: true });

  let backedUp = false;
  if (exists(path)) {
    copyFile(path, backupPath);
    backedUp = true;
  }

  const tmp = join(dir, `.${path.split(/[\\/]/).pop()}.tmp-${pid}-${now()}`);
  try {
    writeFile(tmp, text, { encoding: 'utf8' });
    rename(tmp, path);
  } catch (err) {
    try {
      unlink(tmp);
    } catch {
      // the temp file may not exist; the original write error is the one that matters
    }
    throw err;
  }
  return { path, backupPath, backedUp, bytes: Buffer.byteLength(text) };
}

/**
 * Build an editor over one loaded config.
 *
 * @param {object} options
 * @param {object} options.config       the validated config (`loadConfig().config`)
 * @param {string} options.configPath   where the config file lives (or would live)
 * @param {Function} options.saveSecrets the credential-store seam from `secrets.js`
 * @param {object} [options.secrets]    resolved secrets (`loadSecrets()` result); the
 *                                      values are only ever used for **Test connection**
 *                                      and are never returned by `list()`
 */
export function createSettingsEditor({
  config,
  configPath,
  secrets = null,
  saveSecrets,
  testPushbullet = defaultTestPushbullet,
  testModel = defaultTestModel,
  writeConfig = writeConfigAtomically,
  validate = validateConfig,
  logger = null,
} = {}) {
  if (!config || typeof config !== 'object') throw new Error('createSettingsEditor needs the loaded config');
  if (typeof saveSecrets !== 'function') throw new Error('createSettingsEditor needs the saveSecrets provider function');

  const setup = createSetup({ saveSecrets, testPushbullet, testModel, requireModelKey: false, logger });
  const pending = new Map();
  let lastSave = null;

  function currentValue(setting) {
    if (setting.secret) return secrets?.[setting.secret] ?? null;
    return readPath(config, setting.path);
  }

  function list() {
    return SETTINGS.map((setting) => {
      const value = currentValue(setting);
      const entry = {
        id: setting.id,
        label: setting.label,
        secret: Boolean(setting.secret),
        restart: setting.restart !== false,
        type: setting.type,
        pending: pending.has(setting.id),
      };
      // A secret with nothing to probe (the HTTP bearer token has no endpoint to
      // connect to) carries `testable: false`; the editor and the dialog honour it.
      if (setting.secret) entry.testable = setting.testable !== false;
      if (setting.choices) entry.choices = [...setting.choices];
      if (setting.secret) {
        // A secret never leaves this function as a value: only presence and source.
        entry.value = null;
        entry.display = pending.has(setting.id) ? '(pending change)' : describeSecretForDisplay(value);
      } else {
        entry.value = value;
        entry.display = pending.has(setting.id)
          ? `${serializeSettingValue(setting, pending.get(setting.id))} (pending)`
          : serializeSettingValue(setting, value);
      }
      return entry;
    });
  }

  function set(id, text) {
    const setting = getSetting(id);
    if (!setting) throw new SettingValueError(`unknown setting "${id}"`);
    const value = parseSettingValue(setting, text);
    pending.set(setting.id, value);
    return { id: setting.id, value: setting.secret ? null : value, display: setting.secret ? '(pending change)' : serializeSettingValue(setting, value) };
  }

  function reset() {
    pending.clear();
  }

  /**
   * Probe a secret through `setup.testConnection`, so the editor's **Test connection**
   * is the exact code path the first-run dialog uses. A pending edit is tested; with
   * none, the already-stored value is.
   */
  async function test(id) {
    const setting = getSetting(id);
    if (!setting || !setting.secret) throw new SettingValueError(`${id} is not a secret; there is nothing to connect to`);
    if (setting.testable === false) {
      throw new SettingValueError(`${id} has no connection to test; it is only checked when the app starts`);
    }
    const value = pending.get(id) ?? secrets?.[setting.secret]?.value ?? '';
    if (!String(value).trim()) return { ok: false, detail: `${setting.id} is not set` };
    const kwargs = setting.secret === 'pushbullet' ? { pushbulletToken: value } : { llmApiKey: value };
    const { results } = await setup.testConnection(kwargs);
    return Object.values(results)[0] ?? { ok: false, detail: 'no probe ran' };
  }

  /**
   * Validate and persist every pending change.
   *
   * Rejects before writing: `validate` (the loader's `validateConfig`) runs before the
   * writer, and a rejection throws with the offending key named. On success the TOML
   * write happens first (atomically, with a backup) and the credential-store write last.
   * A secret-only save touches the config file not at all.
   */
  async function save() {
    if (pending.size === 0) return { saved: false, reason: 'no-changes', changed: [] };

    const secretEntries = {};
    const configChanges = new Map();
    for (const [id, value] of pending) {
      const setting = getSetting(id);
      if (setting.secret) secretEntries[setting.secret] = value;
      else configChanges.set(id, value);
    }

    let nextConfig = null;
    if (configChanges.size > 0) {
      nextConfig = structuredClone(config);
      for (const [id, value] of configChanges) writePath(nextConfig, getSetting(id).path, value);
      // The single source of truth for validity. A ConfigError here already names the
      // offending key; nothing has been written when it throws.
      ({ config: nextConfig } = validate(nextConfig));
    }

    let written = null;
    if (nextConfig) written = writeConfig({ path: configPath, config: configToOverrides(nextConfig) });

    let secretsSaved = [];
    if (Object.keys(secretEntries).length > 0) {
      const result = await saveSecrets({ entries: secretEntries, logger });
      secretsSaved = result.saved;
    }

    const changed = [...pending.keys()];
    lastSave = {
      saved: true,
      changed,
      restartRequired: changed.filter((id) => getSetting(id).restart !== false),
      live: changed.filter((id) => !getSetting(id).secret && getSetting(id).restart === false),
      configPath: nextConfig ? configPath : null,
      backupPath: written?.backedUp ? written.backupPath : null,
      secretsSaved,
      config: nextConfig,
    };
    pending.clear();
    return lastSave;
  }

  return {
    list,
    set,
    reset,
    test,
    save,
    get pending() {
      return new Map(pending);
    },
    get lastSave() {
      return lastSave;
    },
    /** The setting descriptors, for callers that want them without the editor. */
    settings: SETTINGS,
  };
}

/**
 * A settings-controller shaped view of first-run setup, for the web UI (issue #56).
 *
 * It exposes the exact same `list`/`set`/`reset`/`test`/`save` surface as
 * `createSettingsEditor`, so `src/ui/web-config.js` renders and persists first-run and
 * post-setup editing through one path. The two fields are the *existing* descriptors
 * (`pushbullet.token`, `llm.api_key`), not a second list, so the labels and validation
 * cannot drift from the settings editor. Persistence still goes through `setup.apply`
 * -> `saveSecrets`, the same provider the rest of the app reads through.
 */
export function createSetupSettingsController({ setup, secrets = null } = {}) {
  if (!setup || typeof setup.apply !== 'function' || typeof setup.testConnection !== 'function') {
    throw new Error('createSetupSettingsController needs a setup instance');
  }
  const descriptors = ['pushbullet.token', 'llm.api_key'].map((id) => getSetting(id)).filter(Boolean);
  const pending = new Map();
  let lastSave = null;

  function list() {
    return descriptors.map((setting) => ({
      id: setting.id,
      label: setting.label,
      secret: true,
      restart: setting.restart !== false,
      type: setting.type,
      testable: setting.testable !== false,
      pending: pending.has(setting.id),
      value: null,
      display: pending.has(setting.id) ? '(pending change)' : describeSecretForDisplay(secrets?.[setting.secret] ?? null),
    }));
  }

  function set(id, text) {
    const setting = descriptors.find((entry) => entry.id === id);
    if (!setting) throw new SettingValueError(`unknown setting "${id}"`);
    const value = parseSettingValue(setting, text);
    pending.set(setting.id, value);
    return { id: setting.id, value: null, display: '(pending change)' };
  }

  function reset() {
    pending.clear();
  }

  async function test(id) {
    const setting = descriptors.find((entry) => entry.id === id);
    if (!setting) throw new SettingValueError(`${id} is not a first-run setting`);
    const value = pending.get(id) ?? secrets?.[setting.secret]?.value ?? '';
    if (!String(value).trim()) return { ok: false, detail: `${setting.id} is not set` };
    const kwargs = setting.secret === 'pushbullet' ? { pushbulletToken: value } : { llmApiKey: value };
    const { results } = await setup.testConnection(kwargs);
    return Object.values(results)[0] ?? { ok: false, detail: 'no probe ran' };
  }

  async function save() {
    if (pending.size === 0) return { saved: false, reason: 'no-changes', changed: [] };
    const pushbulletToken = pending.get('pushbullet.token') ?? secrets?.pushbullet?.value ?? '';
    const llmApiKey = pending.get('llm.api_key') ?? secrets?.llm?.value ?? '';
    const validation = setup.validate({ pushbulletToken, llmApiKey });
    if (!validation.ok) {
      return { saved: false, failed: true, detail: Object.values(validation.errors).join('; ') };
    }
    const applied = await setup.apply({ pushbulletToken, llmApiKey });
    if (!applied.saved) {
      const detail = applied.errors ? Object.values(applied.errors).join('; ') : 'the credential store did not accept the values';
      return { saved: false, failed: true, detail };
    }
    const changed = [...pending.keys()];
    lastSave = {
      saved: true,
      changed,
      restartRequired: changed.filter((id) => getSetting(id)?.restart !== false),
      live: [],
      configPath: null,
      backupPath: null,
      secretsSaved: applied.savedNames ?? [],
      config: null,
    };
    pending.clear();
    return lastSave;
  }

  return {
    list,
    set,
    reset,
    test,
    save,
    get pending() {
      return new Map(pending);
    },
    get lastSave() {
      return lastSave;
    },
    settings: descriptors,
  };
}

/** Copy the live values of `live` settings from a freshly validated config. */
export function applyLiveSettings(target, nextConfig, changed) {
  if (!target || !nextConfig) return [];
  const applied = [];
  for (const id of changed) {
    const setting = getSetting(id);
    if (!setting || setting.secret || setting.restart !== false) continue;
    writePath(target, setting.path, readPath(nextConfig, setting.path));
    applied.push(id);
  }
  return applied;
}
