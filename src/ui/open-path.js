/**
 * Open a URL, or a file path, with the platform's default handler.
 *
 * The command is separated from the spawn so the *choice* per platform is testable
 * off-platform. On Windows the two kinds of target take **different** handlers:
 *
 *  - a **file path** goes to `explorer.exe`, the shell. *Open log* and *Open config*
 *    pass paths and depend on this. An existing target is revealed with explorer's
 *    documented `/select,` switch - a bare path is not a reveal form (#217). A target
 *    that does not exist (a fresh install has no `config.toml` yet) opens the nearest
 *    existing ancestor **folder** instead; a missing path handed to explorer makes it
 *    open its default folder, Documents, which is the same wrong-window answer as #169.
 *  - a **URL** goes to the shell's protocol handler, `rundll32 url.dll,FileProtocolHandler`.
 *    `explorer.exe` is wrong for a URL: it parses its own switches (`/select,`, `/e,`,
 *    `/root,…`), a URL with a query string matches none of them, and it opens its
 *    default folder instead — seen on a real first run as the Documents folder opening
 *    (issue #169). The setup URL is exactly that shape: `http://127.0.0.1:<port>/?token=…`.
 *
 * `cmd /c start "" <url>` is the other standard route. It was rejected because it puts a
 * `cmd.exe` parser in front of the URL: node's Windows argument quoting does not protect
 * `&`, `|` or `^`, so a future URL with a metacharacter would need hand-built verbatim
 * quoting, while `rundll32` takes the URL as a literal argument with no shell in between.
 *
 * `open` on macOS and `xdg-open` elsewhere already dispatch on both kinds, so no split
 * is needed there.
 *
 * A "launched" result means the handler process started, **not** that a window appeared.
 * No Windows route here can confirm the latter (see `openPath`), so callers must treat it
 * as best-effort and offer the target on another surface.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Is this a URL rather than a file path? True for anything with a scheme of at least
 * two characters (`http:`, `https:`, `file:`, `mailto:`), which a Windows drive letter
 * (`C:\…`) is not — hence the minimum length, not a `://` requirement, so a
 * schemeless-slashes URL is still a URL. A UNC path (`\\server\share`) does not match.
 */
export function isUrl(target) {
  return /^[a-z][a-z0-9+.-]+:/i.test(String(target ?? '').trim());
}

/**
 * The argument to hand `explorer.exe` for a file path.
 *
 * An existing target is revealed with `/select,` and **no space** between the comma and
 * the path - that is the documented reveal form (#217). `explorer.exe <bare path>` is
 * not a reveal form on current Windows and can fall through to the shell's default
 * folder, Documents.
 *
 * A missing target (a fresh install has no `config.toml`) opens the nearest existing
 * ancestor directory instead. The containing folder is useful; a missing path is not,
 * and a wrong window is worse than none. `exists` is injected so the choice is testable
 * off-platform.
 */
export function explorerPathArgs(text, exists = existsSync) {
  if (exists(text)) return [`/select,${text}`];
  // Walk up to the first ancestor that exists. `win32.dirname` is used rather than the
  // platform default so a Windows-shaped path is parsed the same when this branch is
  // exercised from a non-Windows test host. The loop ends at a drive or UNC root, where
  // `dirname` is idempotent; on Windows that root always exists, so the fallback can
  // never silently become "explorer's default folder" again.
  let dir = win32.dirname(text);
  while (!exists(dir) && win32.dirname(dir) !== dir) dir = win32.dirname(dir);
  return [dir];
}

export function openPathCommand(target, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const text = String(target ?? '').trim();
  if (text === '') throw new Error('openPath needs a target path');
  if (platform === 'win32') {
    const root = env.SystemRoot;
    if (isUrl(text)) {
      return { command: root ? `${root}\\System32\\rundll32.exe` : 'rundll32.exe', args: ['url.dll,FileProtocolHandler', text] };
    }
    // `explorer` is the shell's default-handler opener for a path; it returns a non-zero
    // exit code even on success, so callers must not treat that as failure.
    return { command: root ? `${root}\\explorer.exe` : 'explorer.exe', args: explorerPathArgs(text, exists) };
  }
  if (platform === 'darwin') return { command: 'open', args: [text] };
  return { command: 'xdg-open', args: [text] };
}

/**
 * Launch the opener for `target`. Resolves when the opener process has been launched,
 * not when a window appears: `explorer`'s success-is-non-zero quirk makes its exit code
 * useless, and no route here (including the Windows URL handler) reports whether a
 * browser actually appeared. The result is therefore `{ launched }` — a started handler
 * process — plus the `kind` ('url' or 'path') and the command, and callers must not read
 * `launched: true` as "the user can see it".
 */
export function openPath(target, { platform = process.platform, env = process.env, spawn = nodeSpawn, exists = existsSync } = {}) {
  const kind = isUrl(target) ? 'url' : 'path';
  let command;
  let args;
  try {
    ({ command, args } = openPathCommand(target, { platform, env, exists }));
  } catch {
    // An empty target, or a path with no ancestor worth opening: nothing truthful to
    // launch. Resolve `launched: false` instead of rejecting so the caller can offer the
    // target on another surface.
    return Promise.resolve({ launched: false, command: null, kind });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' });
    } catch {
      resolve({ launched: false, command, kind });
      return;
    }
    child.once?.('error', () => resolve({ launched: false, command, kind }));
    child.once?.('spawn', () => {
      child.unref?.();
      resolve({ launched: true, command, kind });
    });
  });
}
