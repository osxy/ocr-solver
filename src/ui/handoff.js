/**
 * The one-time hand-off record for a settings/first-run link nobody can see.
 *
 * The Windows launcher runs the app with the window hidden (`shell.Run …, 0`), so a
 * process started that way has no terminal. When the browser hand-off then fails there
 * is nowhere for the URL to go — and the URL is a bearer of a single-use, short-lived
 * (five-minute) launch token, so it must **not** go into the rotating log, where it would
 * outlive its usefulness and leak a credential. It goes here instead: **one file**,
 * overwritten by each session and deleted when the session settles (save, cancel or
 * timeout), so its life is no longer than the token's. It is deliberately not the log:
 * a separate, non-rotating path, mode 0600, that a person (or the message box beside it)
 * reads once.
 *
 * On Windows `chmod` does nothing and the per-user profile ACL is the protection, exactly
 * as with the stored review copies — the file is not encrypted.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

/** The single file name; a session overwrites it and removes it on the way out. */
export const HANDOFF_FILE = 'settings-url.txt';

/**
 * Where the hand-off file lives: the **data** directory beside the state DB and the
 * inbox, not the install directory — the install directory is replaced wholesale on
 * update, and this record must survive a version bump that happens mid-session.
 */
export function defaultHandoffDir({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'PuzzleSolver', 'handoff');
  }
  const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  return join(base, 'puzzlesolver', 'handoff');
}

/**
 * Record `url` for the current session. Never throws: a hand-off that cannot be written
 * must not break the dialog, and the message box beside it is the user-visible route.
 * The directory is created mode 0700 and the file 0600.
 */
export function writeHandoffLink(
  url,
  { dir = defaultHandoffDir(), file = HANDOFF_FILE, fs = { mkdirSync, writeFileSync } } = {}
) {
  const path = join(dir, file);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path, `${url}\n`, { mode: 0o600 });
    return { path, written: true };
  } catch {
    return { path, written: false };
  }
}

/** Remove the record; best-effort, like every other teardown here. */
export function clearHandoffLink(path, { fs = { rmSync } } = {}) {
  try {
    if (path) fs.rmSync(path, { force: true });
  } catch {
    // A leftover file is harmless: the next session overwrites it and the token inside
    // has expired by then.
  }
}
