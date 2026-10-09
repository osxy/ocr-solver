/**
 * Open a file with the platform's default handler.
 *
 * The command is separated from the spawn so the *choice* per platform is testable
 * off-platform: `explorer` on Windows, `open` on macOS, `xdg-open` elsewhere. The
 * spawn itself is injected and unverified here (there is no Explorer on Linux), but
 * the argument list a Windows tray would run is asserted directly.
 */
import { spawn as nodeSpawn } from 'node:child_process';

export function openPathCommand(target, { platform = process.platform, env = process.env } = {}) {
  if (!target || String(target).trim() === '') throw new Error('openPath needs a target path');
  if (platform === 'win32') {
    // `explorer` is the shell's default-handler opener; it returns a non-zero exit
    // code even on success, so callers must not treat that as failure.
    return { command: env.SystemRoot ? `${env.SystemRoot}\\explorer.exe` : 'explorer.exe', args: [String(target)] };
  }
  if (platform === 'darwin') return { command: 'open', args: [String(target)] };
  return { command: 'xdg-open', args: [String(target)] };
}

/**
 * Resolve when the opener has been launched, not when the window closes.
 * `explorer`'s success-is-nonzero quirk is the reason this resolves on `spawn`
 * rather than on exit.
 */
export function openPath(target, { platform = process.platform, env = process.env, spawn = nodeSpawn } = {}) {
  const { command, args } = openPathCommand(target, { platform, env });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' });
    } catch {
      resolve({ opened: false, command });
      return;
    }
    child.once?.('error', () => resolve({ opened: false, command }));
    child.once?.('spawn', () => {
      child.unref?.();
      resolve({ opened: true, command });
    });
  });
}
