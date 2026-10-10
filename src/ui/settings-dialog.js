/**
 * The default settings editor: a terminal prompt, the same shape as first-run
 * setup (`defaultWebSetupDialog`, which replaced the old terminal setup dialog).
 *
 * It holds no logic about what a setting means or where it is stored; `src/ui/settings.js`
 * does that. This file only lists `editor.list()`, reads a number or id, calls
 * `editor.set`, offers **Test connection** for secrets (through the editor, which uses
 * the same probes as first-run setup), and confirms before `editor.save()`.
 *
 * The editor is injectable at the `createApp` boundary, so the tray wiring is tested
 * with a fake dialog and this prompt itself is exercised interactively and by the
 * `config edit` command. A tray process launched without a console has no stdin to
 * read, so that path degrades to the message rather than hanging.
 */
import { createInterface } from 'node:readline/promises';
import { getSetting } from './settings.js';

// One whitespace code unit, tested per character. This is the `\s` set; it is
// deliberately never quantified - see `parseTestCommand` for why.
const WHITESPACE = /\s/;

/**
 * Parse an interactive `test <id>` command without a backtracking regular expression.
 *
 * The previous parse was `/^test\s+(.+)$/i`, the same shape CodeQL flagged in the
 * request authorization parser (`src/http/server.js`, #208): `\s+` and `(.+)` both
 * match whitespace, so a line terminator after a long separator run - which `(.+)`
 * cannot match - forces the engine to retry every split of the run, making the match
 * O(N^2). Here the scheme is the first four characters, the separator run is skipped by
 * index, and the id is the remainder; every character is visited at most once and no
 * step can backtrack, so the parse is linear in the answer length. There is no remote
 * input (`answer` comes from an interactive prompt), so this was a latent hazard rather
 * than a vulnerability - fixed so the shape does not survive in the codebase (#214).
 *
 * Returns the id, or `null` when the answer is not a `test <id>` command. The caller
 * keeps the previous tolerance: any whitespace separates the keyword from the id.
 */
export function parseTestCommand(answer) {
  const text = String(answer ?? '');
  if (text.slice(0, 4).toLowerCase() !== 'test') return null;
  let end = 4;
  while (end < text.length && WHITESPACE.test(text[end])) end += 1;
  // A bare `test` (or `test` plus only whitespace) names no setting, exactly as the
  // old pattern's `(.+)` required at least one character after the separator run.
  if (end === 4 || end === text.length) return null;
  return text.slice(end);
}

/**
 * @returns {Promise<{saved: boolean, cancelled?: boolean, failed?: boolean, detail?: string, changed?: string[], restartRequired?: string[]}>}
 */
export async function defaultSettingsDialog({
  editor,
  configPath = null,
  credentialPath = null,
  credentialStore = null,
  logger = null,
  input = process.stdin,
  output = process.stdout,
  // #128: `null` (the default) keeps the old message. A plan carries the exact restart
  // command when one can be named - this dialog runs in whichever process invoked it
  // and cannot restart the service itself.
  restartPlan = null,
} = {}) {
  if (!editor || typeof editor.list !== 'function' || typeof editor.save !== 'function') {
    throw new Error('defaultSettingsDialog needs a settings editor');
  }
  // An async line iterator rather than `rl.question`: with piped (non-TTY) input a
  // sequence of `question()` calls drops lines that arrive between prompts, which is
  // exactly the `config edit` over stdin case. The iterator queues every line.
  const rl = createInterface({ input, output, terminal: Boolean(input.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (prompt) => {
    output.write(prompt);
    const { value, done } = await lines.next();
    if (done) throw new Error('end of input');
    return String(value).trim();
  };
  const say = (message) => output.write(`${message}\n`);

  /** Accept a 1-based list position or a dotted setting id. */
  function resolveId(answer) {
    if (/^\d+$/.test(answer)) {
      const items = editor.list();
      const index = Number(answer) - 1;
      return index >= 0 && index < items.length ? items[index].id : null;
    }
    return getSetting(answer)?.id ?? null;
  }

  function printList() {
    const items = editor.list();
    items.forEach((item, index) => {
      const tag = item.restart ? 'restart' : 'live';
      const mark = item.isNew ? ' [new]' : '';
      say(`${String(index + 1).padStart(2)}. ${item.id} = ${item.display}  [${tag}]${mark}`);
    });
  }

  try {
    say('PuzzleSolver settings');
    if (configPath) say(`Config file: ${configPath}`);
    if (credentialStore ?? credentialPath) say(`Secrets: ${credentialStore ?? credentialPath}`);
    const newCount = editor.list().filter((item) => item.isNew).length;
    if (newCount > 0) say(`${newCount} setting(s) are new since your last review (marked [new]).`);
    printList();
    say('Enter a number or id to change a setting, "test <id>" to probe a secret,');
    say('blank to save, or "q" to cancel. "[restart]" means the service must restart.');

    for (;;) {
      const answer = await ask('change> ');
      if (answer === '') break;
      if (/^q(uit)?$/i.test(answer)) return { saved: false, cancelled: true };

      const testId = parseTestCommand(answer);
      if (testId) {
        const id = resolveId(testId);
        if (!id) {
          say(`unknown setting "${testId}"`);
          continue;
        }
        try {
          const result = await editor.test(id);
          say(`${id}: ${result.ok ? 'ok' : 'failed'} - ${result.detail}`);
        } catch (err) {
          say(`could not test ${id}: ${err?.message ?? err}`);
        }
        continue;
      }

      const id = resolveId(answer);
      if (!id) {
        say(`unknown setting "${answer}"`);
        continue;
      }
      const setting = getSetting(id);
      const value = await ask(`${id} (current: ${editor.list().find((i) => i.id === id)?.display}) new value: `);
      if (value === '') {
        say('unchanged');
        continue;
      }
      try {
        // A multiline field in a one-line prompt accepts \n as an explicit newline.
        editor.set(id, setting.multiline ? value.replace(/\\n/g, '\n') : value);
        say(`set ${id} = ${setting.secret ? '(pending change)' : editor.list().find((i) => i.id === id)?.display}`);
      } catch (err) {
        say(`rejected: ${err?.message ?? err}`);
        continue;
      }
      // Only offer to probe a secret that has something to connect to. The HTTP
      // bearer token has no endpoint; its value is checked at set time and at startup.
      if (setting.secret && setting.testable !== false) {
        const probe = await ask('Test connection now? [y/N] ');
        if (/^y(es)?$/i.test(probe)) {
          const result = await editor.test(id);
          say(`${id}: ${result.ok ? 'ok' : 'failed'} - ${result.detail}`);
        }
      }
    }

    const pending = editor.pending;
    if (pending.size === 0) {
      say('No changes.');
      return { saved: false, changed: [] };
    }
    const confirm = await ask(`Save ${pending.size} change(s)? [y/N] `);
    if (!/^y(es)?$/i.test(confirm)) return { saved: false, cancelled: true };

    const result = await editor.save();
    if (result.backupPath) say(`previous config backed up to ${result.backupPath}`);
    if (result.restartRequired.length > 0) {
      say(`Restart the service for: ${result.restartRequired.join(', ')}`);
      if (restartPlan?.display) say(`Restart it with: ${restartPlan.display}`);
    }
    if (result.live.length > 0) say(`Applied live: ${result.live.join(', ')}`);
    say('Saved.');
    return result;
  } catch (err) {
    // EOF on a windowless process, a broken pipe: report it instead of hanging.
    logger?.warn?.(`settings dialog failed: ${err?.message ?? err}`);
    return { saved: false, failed: true, detail: err?.message ?? String(err) };
  } finally {
    rl.close();
  }
}
