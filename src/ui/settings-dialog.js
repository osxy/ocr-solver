/**
 * The default settings editor: a terminal prompt, the same shape as the first-run
 * dialog in `setup-dialog.js`.
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

      const testMatch = /^test\s+(.+)$/i.exec(answer);
      if (testMatch) {
        const id = resolveId(testMatch[1]);
        if (!id) {
          say(`unknown setting "${testMatch[1]}"`);
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
