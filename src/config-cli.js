/**
 * `node src/cli.js config ...` - the headless settings route.
 *
 * `--headless` has no tray, so the settings editor needs a command-line equivalent or
 * the feature exists only for people with a desktop session. The command and the tray
 * share `src/ui/settings.js`, so a change made either way validates, routes and writes
 * identically:
 *
 *   node src/cli.js config list                 # current values (secrets shown as presence + source)
 *   node src/cli.js config get <id>             # one value
 *   node src/cli.js config set <id> <value>     # validate and persist one change
 *   node src/cli.js config edit                 # the guided editor over stdin
 *
 * A rejected value exits non-zero and names the setting; nothing is written. The
 * restart semantics are printed on every write rather than left for the user to
 * discover.
 */
import { loadConfig, resolveConfigPath, defaultStatePath } from './config.js';
import { defaultCredentialPath, loadSecrets, saveSecrets } from './secrets.js';
import { openStore } from './state/db.js';
import { createSettingsEditor, getSetting, SETTINGS } from './ui/settings.js';
import { computeSettingsReview, recordDismissal, recordReview } from './ui/settings-review.js';
import { APP_VERSION } from './version.js';
import { defaultSettingsDialog } from './ui/settings-dialog.js';
import { defaultWebSettingsDialog } from './ui/web-config.js';

const USAGE = `Usage: node src/cli.js config <action> [options]

  config list                  print every editable setting and its current value
  config get <id>              print one setting
  config set <id> <value>      validate and persist one setting
  config edit                  guided editor over stdin (the headless tray equivalent)
  config edit --gui            the same editor as a loopback web UI in the browser
  config review                show settings added since the last review, then edit
  config review --json         print the same set and record it, without editing
  config review --dismiss      silence the startup prompt, keep the [new] badges

Options:
  --config <path>              TOML config file (or PUZZLESOLVER_CONFIG)
  --json                       machine-readable output
  --gui                        with "edit"/"review", open the web UI instead of the terminal prompt
  --dismiss                    with "review", suppress the prompt only
`;

function parse(argv) {
  const opts = { json: false, config: null, help: false, gui: false, dismiss: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--config') opts.config = argv[++i] ?? null;
    else if (arg === '--gui') opts.gui = true;
    else if (arg === '--dismiss') opts.dismiss = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    else opts.positional.push(arg);
  }
  return opts;
}

function printUsage(stdout, stream = stdout) {
  stream.write(USAGE);
}

/**
 * @param {string[]} argv arguments after the `config` subcommand
 * @returns {Promise<number>} process exit code
 */
export async function runConfig(
  argv = [],
  {
    stdout = process.stdout,
    stderr = process.stderr,
    stdin = process.stdin,
    env = process.env,
    platform = process.platform,
    homedir = undefined,
    logger = null,
    dialog = defaultSettingsDialog,
    guiDialog = defaultWebSettingsDialog,
    openBrowser = undefined,
  } = {}
) {
  const opts = parse(argv);
  if (opts.help || opts.positional[0] === 'help') {
    printUsage(stdout);
    return 0;
  }

  const action = opts.positional[0] ?? 'list';
  const explicitPath = opts.config;
  const configPath = resolveConfigPath({ explicit: explicitPath, env, platform, ...(homedir ? { homedir } : {}) });
  const credentialPath = defaultCredentialPath({ platform, env, ...(homedir ? { homedir } : {}) });

  let loaded;
  try {
    loaded = loadConfig({ explicitPath, env, platform, ...(homedir ? { homedir } : {}) });
  } catch (err) {
    stderr.write(`${err?.message ?? err}\n`);
    return 1;
  }
  for (const warning of loaded.warnings) stderr.write(`warning: ${warning}\n`);

  // Secrets are resolved with real values only for the credential store round-trip and
  // the Test connection probe; `list()` and every printer below expose presence/source.
  const secrets = await loadSecrets({ env, platform, ...(homedir ? { homedir } : {}), logger });
  // The store chain and any fallback are user-facing: `config list` is where a
  // Windows user learns whether DPAPI or the plaintext file is in use (#60).
  for (const warning of secrets.warnings) stderr.write(`warning: ${warning}\n`);

  // The upgrade review (#67) lives in the app state store, never in `config.toml`.
  // Only `review`/`edit` need it; `list`/`get`/`set` stay store-free. A store that
  // cannot be opened degrades to "no new settings" rather than an error: the editor
  // still works, which is the whole point of the command.
  let reviewStore = null;
  function ensureReviewStore() {
    if (reviewStore) return reviewStore;
    try {
      reviewStore = openStore({ path: defaultStatePath({ platform, env, ...(homedir ? { homedir } : {}) }) });
    } catch (err) {
      stderr.write(`warning: settings review state is unavailable: ${err?.message ?? err}\n`);
    }
    return reviewStore;
  }
  const reviewRequested = action === 'review' || action === 'edit';
  const review = reviewRequested ? computeSettingsReview({ store: ensureReviewStore() }) : null;

  const editor = createSettingsEditor({
    config: loaded.config,
    configPath: loaded.path,
    secrets,
    saveSecrets: (args) =>
      saveSecrets({ ...args, env, platform, ...(homedir ? { homedir } : {}), credentialPath, logger }),
    logger,
    newSettingIds: review ? review.newSettings.map((setting) => setting.id) : null,
  });

  function writeItems(items) {
    if (opts.json) {
      stdout.write(
        `${JSON.stringify(
          items.map((item) => ({
            id: item.id,
            secret: item.secret,
            restart: item.restart,
            value: item.secret ? null : item.value,
            display: item.display,
            since: item.since ?? null,
            isNew: item.isNew === true,
            securityRelevant: item.securityRelevant === true,
            ...(item.choices ? { choices: item.choices } : {}),
          })),
          null,
          2
        )}\n`
      );
      return;
    }
    const width = Math.max(...items.map((item) => item.id.length));
    for (const item of items) {
      const marks = `${item.restart ? '[restart]' : '[live]'}${item.isNew ? ' [new]' : ''}`;
      stdout.write(`${item.id.padEnd(width)}  ${item.display}  ${marks}\n`);
    }
  }

  /** Only the fields a caller can act on: never the whole config, never a secret. */
  function safeResult(result) {
    return {
      saved: result.saved,
      reason: result.reason ?? null,
      changed: result.changed ?? [],
      restartRequired: result.restartRequired ?? [],
      live: result.live ?? [],
      configPath: result.configPath ?? null,
      backupPath: result.backupPath ?? null,
      secretsSaved: result.secretsSaved ?? [],
    };
  }

  function writeResult(result) {
    if (opts.json) {
      stdout.write(`${JSON.stringify(safeResult(result), null, 2)}\n`);
      return;
    }
    stdout.write(`Saved: ${result.changed.join(', ')}\n`);
    if (result.backupPath) stdout.write(`Previous config backed up to ${result.backupPath}\n`);
    if (result.restartRequired.length > 0) {
      stdout.write(`Restart the service for: ${result.restartRequired.join(', ')}\n`);
    }
    if (result.live.length > 0) stdout.write(`Applied live: ${result.live.join(', ')}\n`);
  }

  try {
    switch (action) {
    case 'list': {
      stdout.write(`config: ${loaded.path}${loaded.loaded ? '' : ' (not present; defaults)'}\n`);
      stdout.write(`credentials: ${secrets.store ?? credentialPath}\n`);
      writeItems(editor.list());
      return 0;
    }
    case 'get': {
      const id = opts.positional[1];
      if (!id) {
        stderr.write('config get needs a setting id; run `config list` to see them\n');
        return 2;
      }
      const item = editor.list().find((entry) => entry.id === id);
      if (!item) {
        stderr.write(`unknown setting "${id}"; run \`config list\` to see them\n`);
        return 2;
      }
      stdout.write(`${item.display.replace(/ \(pending\)$/, '')}\n`);
      return 0;
    }
    case 'set': {
      const id = opts.positional[1];
      const value = opts.positional.slice(2).join(' ');
      if (!id || opts.positional.length < 3) {
        stderr.write('config set needs a setting id and a value; run `config list` to see them\n');
        return 2;
      }
      try {
        editor.set(id, value);
      } catch (err) {
        stderr.write(`${err?.message ?? err}\n`);
        return 2;
      }
      const result = await editor.save();
      writeResult(result);
      return 0;
    }
    case 'review':
    case 'edit': {
      if (action === 'review' && opts.dismiss) {
        // Suppress the prompt without pretending the settings were reviewed: the
        // `[new]` badges stay because the reviewed baseline is untouched.
        recordDismissal(ensureReviewStore(), APP_VERSION);
        stdout.write('Dismissed the new-settings prompt; the settings remain marked new.\n');
        return 0;
      }
      const newItems = editor.list().filter((item) => item.isNew);
      if (action === 'review') {
        if (newItems.length === 0) {
          stdout.write('No new settings to review.\n');
          recordReview(ensureReviewStore(), APP_VERSION);
          return 0;
        }
        if (!opts.json) {
          stdout.write(
            `New settings since ${review?.reviewedVersion ?? 'the first release'} ` +
              '(security-relevant first):\n'
          );
        }
        writeItems(newItems);
        if (opts.json) {
          recordReview(ensureReviewStore(), APP_VERSION);
          return 0;
        }
        stdout.write('\n');
      }
      const activeDialog = opts.gui ? guiDialog : dialog;
      const outcome = await activeDialog({
        editor,
        configPath: loaded.path,
        credentialPath,
        credentialStore: secrets.store,
        secrets,
        logger,
        // #67: the editor is the review; the web shell can name the new settings.
        settingsReview: review,
        // #65: the GUI is gated by the same access rule and refuses to start on a
        // non-loopback range without a configured credential, exactly like the tray.
        ...(opts.gui
          ? {
              openBrowser,
              output: stdout,
              config: loaded.config,
              webUi: loaded.config.web_ui,
              credentialVerifier: secrets.web_ui?.value ?? null,
            }
          : { input: stdin, output: stdout }),
      });
      // The settings were presented, so they are no longer new. A failed start did
      // not present them, so the badges stay and the review can be offered again.
      if (!outcome?.failed) recordReview(ensureReviewStore(), APP_VERSION);
      if (outcome?.failed) {
        stderr.write(`${outcome.detail ?? 'the settings editor failed'}\n`);
        return 1;
      }
      if (!outcome?.saved) {
        if (opts.json) stdout.write(`${JSON.stringify({ saved: false, cancelled: Boolean(outcome?.cancelled) })}\n`);
        return 0;
      }
      if (opts.json) stdout.write(`${JSON.stringify(safeResult(outcome), null, 2)}\n`);
      else writeResult(outcome);
      return 0;
    }
    default: {
      stderr.write(`unknown config action "${action}"\n`);
      printUsage(stderr);
      return 2;
    }
    }
  } finally {
    try {
      reviewStore?.close?.();
    } catch {
      // a state store that cannot be closed must not change the command's verdict
    }
  }
}

/** Exported for the tests and for `config list` callers that want the schema. */
export { SETTINGS, getSetting };
