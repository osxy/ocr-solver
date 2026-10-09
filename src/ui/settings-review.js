/**
 * The upgrade review: which settings were introduced since the user last looked
 * (issue #67).
 *
 * The registry is the `since` field on the descriptors in `src/ui/settings.js`. This
 * module compares each setting's `since` against a stored version **per setting**,
 * rather than comparing release numbers alone, so a user who skips `0.1.0 -> 0.3.0`
 * is shown the `0.2.0` additions and the `0.3.0` additions rather than only the
 * latest. It owns no setting knowledge of its own.
 *
 * Two pieces of app state live in the store's `kv` table, never in `config.toml`
 * (which is the user's file and must not be rewritten by a notification):
 *
 *   - `settings_prompted_version` - the last version whose additions were offered at
 *     startup. It advances the moment the offer is emitted, so a repeated start does
 *     not nag and an unattended install is left alone after one log line.
 *   - `settings_reviewed_version` - the last version whose settings were actually
 *     presented to the user in the editor or through `config review`. It is the
 *     baseline for the `isNew` badges, and is deliberately *not* advanced by the
 *     startup offer: a dismissal suppresses the prompt, but the settings stay marked
 *     new so the user can still find them.
 *
 * Nothing here may block or fail startup. `planStartupReview` catches its own store
 * errors and returns `null`; the caller continues with defaults either way. A fresh
 * install (no config file) and a downgrade produce no offer. The baseline for an
 * existing install with no recorded version is the oldest `since` in the registry, so
 * every setting introduced after the first release is offered exactly once.
 */
import { APP_VERSION, compareVersions, parseVersion } from '../version.js';
import { SETTINGS } from './settings.js';

/** The last version whose new settings were offered at startup. */
export const PROMPTED_VERSION_KEY = 'settings_prompted_version';
/** The last version whose settings were shown to the user in the editor. */
export const REVIEWED_VERSION_KEY = 'settings_reviewed_version';

/**
 * The conservative baseline when no version has been recorded: the oldest release
 * any descriptor was introduced in. Strictly-newer comparison then leaves the
 * baseline release's settings alone while surfacing every later addition - the
 * skipped-version rule, without inventing a version we cannot know.
 */
export function baselineVersion(settings = SETTINGS) {
  let oldest = null;
  for (const setting of settings) {
    const since = parseVersion(setting.since);
    if (!since) continue;
    if (oldest == null || compareVersions(setting.since, oldest) < 0) oldest = setting.since;
  }
  return oldest;
}

/** Put security-relevant settings first, preserving registry order inside each group. */
function securityFirst(settings) {
  const security = settings.filter((setting) => setting.securityRelevant === true);
  const rest = settings.filter((setting) => setting.securityRelevant !== true);
  return [...security, ...rest];
}

/**
 * The settings introduced strictly after `version`, security-relevant ones first.
 *
 * An unreadable or absent `version` falls back to `baselineVersion()`. That is the
 * first-run-of-the-feature case: an existing config predates the registry, so the
 * honest statement is "everything after the first release", not "nothing is new".
 * The alternative - assuming the current version - would hide the additions that
 * motivated the feature.
 */
export function newSettingsSince(version, { settings = SETTINGS } = {}) {
  let from = version;
  if (parseVersion(from) == null) from = baselineVersion(settings);
  if (from == null) return [];
  const result = settings.filter((setting) => {
    const comparison = compareVersions(setting.since, from);
    return comparison != null && comparison > 0;
  });
  return securityFirst(result);
}

function readVersion(store, key) {
  try {
    return store?.get?.(key) ?? null;
  } catch {
    return null;
  }
}

function writeVersion(store, key, version) {
  try {
    store?.set?.(key, String(version));
    return true;
  } catch {
    // A store that cannot be written must not stop the app; the offer simply repeats.
    return false;
  }
}

/**
 * The read-only view, for callers that must not change state (`config review
 * --json`, the editor's `isNew` badges, the app's diagnostic surface).
 */
export function computeSettingsReview({ store = null, settings = SETTINGS, appVersion = APP_VERSION } = {}) {
  const reviewedVersion = readVersion(store, REVIEWED_VERSION_KEY);
  const promptedVersion = readVersion(store, PROMPTED_VERSION_KEY);
  return {
    appVersion,
    reviewedVersion,
    promptedVersion,
    // Badges: what the user has not been shown in an editor.
    newSettings: newSettingsSince(reviewedVersion, { settings }),
    // Offer: what has not been announced at startup.
    promptedSettings: newSettingsSince(promptedVersion, { settings }),
  };
}

/** Record that the user reviewed (was shown) the settings. Advances both baselines. */
export function recordReview(store, version = APP_VERSION) {
  const reviewed = writeVersion(store, REVIEWED_VERSION_KEY, version);
  const prompted = writeVersion(store, PROMPTED_VERSION_KEY, version);
  return reviewed && prompted;
}

/**
 * Record that the startup offer was dismissed: the prompt stops, the `isNew` badges
 * stay because `settings_reviewed_version` is untouched.
 */
export function recordDismissal(store, version = APP_VERSION) {
  return writeVersion(store, PROMPTED_VERSION_KEY, version);
}

/**
 * Compute and announce what is new on startup, then record that it was offered.
 *
 * @returns {{newSettings: object[], promptedSettings: object[], appVersion: string,
 *            reviewedVersion: string|null, promptedVersion: string|null}|null}
 *   `null` when there is nothing to do: a fresh install, a downgrade, a repeated
 *   start, or a store error. The caller must not treat `null` as a failure.
 */
export function planStartupReview({
  store = null,
  settings = SETTINGS,
  appVersion = APP_VERSION,
  // `false` only for a genuine fresh install (no config file). The first-run flow
  // already walks the user through setup, so offering "here is what is new" on top
  // of it is noise. The app passes the loader's `loaded` flag.
  configLoaded = true,
  logger = null,
} = {}) {
  const review = computeSettingsReview({ store, settings, appVersion });

  if (!configLoaded) {
    // A fresh install: mark both baselines so a config created by first-run setup
    // does not immediately look like an upgrade on the next start.
    recordReview(store, appVersion);
    return null;
  }

  const { promptedSettings } = review;
  if (promptedSettings.length === 0) return null;

  const since = review.promptedVersion ?? baselineVersion(settings) ?? appVersion;
  logger?.info?.(
    `${promptedSettings.length} new setting(s) since ${since} (${promptedSettings
      .map((setting) => setting.id)
      .join(', ')}); run \`node src/cli.js config review\` or open Settings to review them`
  );
  recordDismissal(store, appVersion);
  return review;
}
