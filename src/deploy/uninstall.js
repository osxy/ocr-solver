/**
 * Remove the per-user Startup-folder shim. Directory removal is left to
 * `packaging/uninstall.ps1`, because a running Node process cannot delete its own
 * install directory on Windows.
 *
 * Executed on `windows-latest` since #59. The filename and the Startup-folder path live
 * here so there is one owner for both, and `tests/deploy.test.js` asserts them without a
 * Windows host.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStartupDir, STARTUP_FILE } from './autostart.js';

export function runUninstall({
  startupDir = defaultStartupDir(),
  fileExists = existsSync,
  unlink = unlinkSync,
  log = console,
} = {}) {
  const path = `${startupDir}\\${STARTUP_FILE}`;
  if (!fileExists(path)) {
    // A startup entry that was never written is already the desired end state.
    return { removed: false, path };
  }
  try {
    unlink(path);
  } catch (err) {
    // Windows can briefly lock a file an antivirus scanner is reading. Report it rather
    // than swallow it; the caller decides whether that is fatal.
    log.warn?.(`could not remove ${path}: ${err?.message ?? err}`);
    return { removed: false, path };
  }
  return { removed: true, path };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) runUninstall();
