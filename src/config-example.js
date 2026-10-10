/**
 * The commented example config, generated from `DEFAULTS` and the settings registry.
 *
 * A new user has no way to discover what is settable: a missing `config.toml` is
 * normal, every setting has a working default, and the only route in was to read the
 * source or the docs (#181). The installer writes this file to the config directory,
 * beside where `config.toml` would be, so the file a user copies *from* sits where the
 * file they copy *to* lives - and the install directory (which *is* replaced on update)
 * is not where a user looks for configuration.
 *
 * It is **not** `config.toml`, and every key line is commented out. A live complete
 * file would pin every default at the version that wrote it, so a later release
 * changing a default would silently have no effect on that install. Commented lines
 * mean even a careless `cp config.toml.example config.toml` overrides nothing.
 *
 * It is generated, never hand-written: this repository's most repeated defect is
 * documentation outliving its code (the README, the docs, this file's sibling
 * `config/llm.env.example`). `DEFAULTS` (src/config.js) and `SETTINGS`
 * (src/ui/settings.js) already know every key, its default, its type and its label, so
 * the example cannot drift from either - and `tests/config-example.test.js` proves it,
 * offline and credential-free.
 */
import { dirname, join } from 'node:path';
import { stringify } from 'smol-toml';
import { DEFAULTS, defaultConfigPath } from './config.js';
import { getSetting } from './ui/settings.js';

/** The example's filename. Never `config.toml`; the app does not read this file. */
export const EXAMPLE_CONFIG_FILE = 'config.toml.example';

/** Where the example lives: the config directory, beside `config.toml`. */
export function defaultExampleConfigPath(options = {}) {
  return join(dirname(defaultConfigPath(options)), EXAMPLE_CONFIG_FILE);
}

/** The secret settings, whose ids are named in the header but never emitted as keys. */
const SECRET_IDS = ['pushbullet.token', 'llm.api_key', 'http.token', 'web_ui.password'];

function serializeValue(key, value) {
  // smol-toml renders one key per call, so the value formatting (quoting, arrays,
  // escapes) is exactly the one the config loader accepts. `\n` is escaped into a
  // basic string, which is what a commented one-line-per-key example wants; the
  // multiline textarea default is the one value worth spelling out in a block.
  return stringify({ [key]: value }).trimEnd();
}

/** One `key = value` body line, with the registry label as a trailing comment. */
function keyLine(key, value, descriptor) {
  const body = serializeValue(key, value);
  const label = descriptor?.label;
  const since = descriptor?.since && descriptor.since !== '0.1.0' ? ` (since ${descriptor.since})` : '';
  return label ? `${body}  # ${label}${since}` : body;
}

/** A multiline string default, as a `"""` block - the one value a one-liner mangles. */
function multilineBlock(key, value, descriptor) {
  // The closing `"""` sits on the last text line: on its own line it would add a
  // trailing newline the default does not have, and the round-trip test would fail.
  const lines = String(value).split('\n');
  return [`${key} = """`, ...lines.slice(0, -1), `${lines.at(-1)}"""`].map((line) => `# ${line}`);
}

/**
 * The example, as text. Built section by section in `DEFAULTS` order, so it is stable
 * and a reviewer can diff it; keys inside a section keep their `DEFAULTS` order too.
 */
export function buildExampleConfig() {
  const lines = [
    '# PuzzleSolver example configuration - every line is commented out.',
    '#',
    '# The app does not read this file. It reads config.toml beside it, and a missing',
    '# config.toml is normal: every setting has a working default. Copy the lines you',
    '# want to change into config.toml and remove the leading "# ".',
    '#',
    '# Generated from DEFAULTS (src/config.js) and the settings registry',
    '# (src/ui/settings.js), so it cannot drift from the code. A reinstall replaces it',
    '# only if you have not edited it; your edited copy is kept.',
    '#',
    '# Secrets are NOT config keys and never go in config.toml. Put them in the',
    '# credential store with `node src/cli.js config set <id> <value>`, or with the',
    '# settings editor (the tray\'s Settings item, or `config edit --gui`). The secret',
    `# ids are ${SECRET_IDS.join(', ')}.`,
  ];

  for (const [section, values] of Object.entries(DEFAULTS)) {
    const entries = Object.keys(values).map((key) => ({
      key,
      value: values[key],
      descriptor: getSetting(`${section}.${key}`),
    }));
    lines.push('', `# [${section}]`);
    for (const { key, value, descriptor } of entries) {
      if (descriptor?.multiline) {
        lines.push(...multilineBlock(key, value, descriptor));
      } else {
        lines.push(`# ${keyLine(key, value, descriptor)}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
