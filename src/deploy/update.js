/**
 * Apply a user-downloaded release over an existing install (issue #168).
 *
 * **The updater has no network access of its own.** It takes the archive the user
 * already downloaded and verified (the README's ritual), or an already-extracted copy
 * of it, and applies it. There is no GitHub API call and no `/releases/latest`: every
 * release here is a pre-release, so a "latest" lookup would report "up to date"
 * forever, and a script that fetches and runs remote code is exactly the thing the
 * checksum ritual exists to guard. Falling back to the local artifact removes the whole
 * branch of failure modes.
 *
 * Two decisions live here, where they are pure and tested offline:
 *
 *  - **Refuse an older build.** A user can extract the wrong zip; installing an older
 *    tree over a newer one is silent and worse than refusing. The comparison reuses
 *    `compareVersions` from `src/version.js`, so update ordering has one owner. `-Force`
 *    exists for a deliberate repair/reinstall of the same version, never for a downgrade.
 *  - **Replace, do not merge.** `Copy-Item -Recurse -Force` overwrites but never
 *    deletes, so a file removed or renamed between versions survives - and a stale
 *    `node_modules` entry can *shadow* the new one. Every top-level entry of the install
 *    directory is removed first, except the updater script that is still running from
 *    it. The install directory holds only the app; the user's config, credentials,
 *    state database, inbox, logs and stored images live in two other directories, which
 *    this never names.
 *
 * The file operations are plain Node, not PowerShell, so the replace rule is exercised
 * on a real temporary tree by `tests/update.test.js` on the Linux host. `update.ps1`
 * drives this and owns only the Windows-only half: the checksum, `Expand-Archive`, and
 * starting the new app.
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../version.js';

/** Read `app/package.json`'s version from a payload or install directory. */
export function readPayloadVersion(dir, { readFile = readFileSync } = {}) {
  try {
    const pkg = JSON.parse(readFile(join(dir, 'app', 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Is `incomingVersion` safe to install over `installedVersion`?
 *
 * `compareVersions` returns `null` for anything that is not `major.minor.patch`; a
 * version that cannot be read is treated as a reason to refuse, not as "equal", so an
 * unreadable payload cannot silently overwrite a good install. `force` is the explicit
 * override for a repair of the same version.
 */
export function decideUpdate({ installedVersion, incomingVersion, force = false } = {}) {
  const comparison = compareVersions(incomingVersion, installedVersion);
  if (comparison === null) return { allowed: force, reason: 'unreadable-version' };
  if (comparison === 0) return { allowed: force, reason: 'same-version' };
  if (comparison < 0) return { allowed: force, reason: 'older' };
  return { allowed: true, reason: 'newer' };
}

/**
 * Replace the installed app with the payload.
 *
 * Every top-level entry of `installDir` is removed except `selfPath`, the updater script
 * that may be executing from there and cannot be deleted out from under itself; then the
 * payload's top-level entries are copied in. Returns the names removed so the caller can
 * report them (and the deploy job can assert a stale file did not survive).
 */
export function applyUpdate({
  installDir,
  sourceDir,
  selfPath = null,
  fs = { readdirSync, rmSync, mkdirSync, cpSync },
} = {}) {
  if (!installDir) throw new Error('applyUpdate needs an installDir');
  if (!sourceDir) throw new Error('applyUpdate needs a sourceDir');
  const self = selfPath ? resolve(selfPath) : null;

  const removed = [];
  for (const name of fs.readdirSync(installDir)) {
    const target = join(installDir, name);
    if (self && resolve(target) === self) continue;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(name);
  }

  fs.mkdirSync(installDir, { recursive: true });
  for (const name of fs.readdirSync(sourceDir)) {
    fs.cpSync(join(sourceDir, name), join(installDir, name), { recursive: true });
  }
  return { removed };
}

// ---------------------------------------------------------------------------
// CLI, invoked by packaging/update.ps1. `check` is the version gate that must pass
// before anything is stopped or deleted; `apply` performs the replace.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { command: argv[0] ?? null, force: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--install') options.installDir = argv[++i];
    else if (arg === '--source') options.sourceDir = argv[++i];
    else if (arg === '--self') options.selfPath = argv[++i];
    else if (arg === '--force') options.force = true;
  }
  return options;
}

export function runCli(argv, { log = console } = {}) {
  const options = parseArgs(argv);
  if (options.command === 'check') {
    const installedVersion = readPayloadVersion(options.installDir);
    const incomingVersion = readPayloadVersion(options.sourceDir);
    const decision = decideUpdate({ installedVersion, incomingVersion, force: options.force });
    if (decision.allowed) {
      log.log?.(`update allowed (${decision.reason}): ${installedVersion} -> ${incomingVersion}`);
      return 0;
    }
    log.warn?.(
      `refusing to update (${decision.reason}): installed ${installedVersion}, incoming ${incomingVersion}. ` +
        'Use -Force only to repair the same version.'
    );
    return 3;
  }
  if (options.command === 'apply') {
    const { removed } = applyUpdate(options);
    log.log?.(`replaced the install (${removed.length} entries removed before copying)`);
    return 0;
  }
  log.warn?.('usage: update.js check|apply --install <dir> --source <dir> [--self <path>] [--force]');
  return 3;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = runCli(process.argv.slice(2));
