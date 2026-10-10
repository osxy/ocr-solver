/**
 * A native Windows message box, for the case with no terminal and no browser.
 *
 * The launcher runs the app hidden, so `output` is null and there is no console to print
 * the settings link to. A file alone is not a fallback unless the user is told about it,
 * so a hidden session raises a real dialog — the one surface a windowless process can
 * still show. It is Windows-only, and it is deliberately the *same* mechanism the secret
 * store uses for DPAPI (`powershell.exe` ships with every Windows box, so no npm
 * dependency is added); off Windows, `buildMessageBoxCommand` returns `null` and the
 * caller falls back to the hand-off file alone.
 *
 * The script is passed with `-EncodedCommand` (UTF-16LE, base64) rather than as a
 * `-Command` argument, so no quoting or escaping of the URL can go wrong: the URL is
 * data inside the script, never part of a command line the shell re-parses.
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** PowerShell single-quote escaping: double every `'`, wrap in `'…'`. */
function powerShellString(text) {
  return `'${String(text ?? '').replace(/'/g, "''")}'`;
}

/**
 * The command that shows `message`, or `null` on a platform with no route. Pure, so the
 * off-Windows tests can assert the shape without spawning anything.
 */
export function buildMessageBoxCommand(message, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return null;
  const script =
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    `[System.Windows.Forms.MessageBox]::Show(${powerShellString(message)}, 'PuzzleSolver') | Out-Null`;
  const root = env.SystemRoot;
  return {
    command: root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
  };
}

/**
 * Show `message` in a detached message box. Resolves once the PowerShell process has
 * started; `shown: true` therefore means "a dialog was launched", not "the user has read
 * it". Never throws and never rejects — a message box is a courtesy beside the hand-off
 * file, and must not be able to take the settings dialog down.
 */
export function showMessageBox(message, { platform = process.platform, env = process.env, spawn = nodeSpawn } = {}) {
  const spec = buildMessageBoxCommand(message, { platform, env });
  if (!spec) return Promise.resolve({ shown: false, reason: 'unsupported' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, { detached: true, stdio: 'ignore' });
    } catch {
      resolve({ shown: false, reason: 'spawn-failed' });
      return;
    }
    child.once?.('error', () => resolve({ shown: false, reason: 'spawn-failed' }));
    child.once?.('spawn', () => {
      child.unref?.();
      resolve({ shown: true });
    });
  });
}
