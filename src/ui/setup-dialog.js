/**
 * The default first-run dialog: a terminal prompt.
 *
 * `src/ui/setup.js` holds the logic (validation, the two probes, the credential
 * write); this file is only the part that talks to a human. It is deliberately a
 * plain `readline` prompt rather than a native widget, because the native tray
 * widget cannot be built or exercised on this host, and the wiring - not the widget
 * - was the defect issue #25 exists to close.
 *
 * The whole thing is injectable at the `createApp` boundary, so the startup path is
 * tested with a fake dialog and this prompt itself is exercised only interactively.
 * Anything wired to a real widget is therefore the unverified part, and that is
 * labelled where it belongs rather than pretended here.
 *
 * The dialog never saves on a failed **Test connection** without an explicit "yes":
 * a provider outage must not silently become a half-configured app.
 */
import { createInterface } from 'node:readline/promises';

/**
 * @returns {Promise<{saved: boolean, cancelled?: boolean, failed?: boolean, detail?: string, savedNames?: string[]}>}
 */
export async function defaultSetupDialog({
  setup,
  credentialPath = null,
  credentialStore = null,
  logger = null,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  if (!setup || typeof setup.apply !== 'function') throw new Error('defaultSetupDialog needs a setup instance');
  const rl = createInterface({ input, output });
  const ask = async (prompt) => String(await rl.question(prompt)).trim();
  const say = (message) => output.write(`${message}\n`);

  try {
    say('PuzzleSolver first-run setup');
    if (credentialStore ?? credentialPath) say(`Secrets will be stored in ${credentialStore ?? credentialPath}`);
    const pushbulletToken = await ask('Pushbullet token: ');
    const llmApiKey = await ask('Model API key (optional, Enter to skip): ');

    const validation = setup.validate({ pushbulletToken, llmApiKey });
    if (!validation.ok) {
      for (const [field, message] of Object.entries(validation.errors)) say(`${field}: ${message}`);
      return { saved: false, failed: true, detail: 'the entered values did not validate' };
    }

    // A probe result is advisory: the user decides, but they decide explicitly.
    const { ok, results } = await setup.testConnection({ pushbulletToken, llmApiKey });
    for (const [name, result] of Object.entries(results)) {
      say(`${name}: ${result.ok ? 'ok' : 'failed'} - ${result.detail}`);
    }
    if (!ok) {
      const answer = await ask('The connection test failed. Save anyway? [y/N] ');
      if (!/^y(es)?$/i.test(answer)) return { saved: false, cancelled: true, detail: 'the connection test failed' };
    }

    const applied = await setup.apply({ pushbulletToken, llmApiKey });
    if (!applied.saved) {
      const detail = applied.errors
        ? Object.values(applied.errors).join('; ')
        : 'the credential store did not accept the values';
      say(`Could not save: ${detail}`);
      return { saved: false, failed: true, detail };
    }
    say('Saved. Starting PuzzleSolver.');
    return { saved: true, savedNames: applied.savedNames };
  } catch (err) {
    // EOF on a closed stdin, a broken pipe, anything: report it instead of hanging.
    logger?.warn?.(`setup dialog failed: ${err?.message ?? err}`);
    return { saved: false, failed: true, detail: err?.message ?? String(err) };
  } finally {
    rl.close();
  }
}
