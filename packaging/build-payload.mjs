#!/usr/bin/env node
/**
 * Assemble the Windows payload that `packaging/install.ps1` expects.
 *
 *   dist/payload/
 *     node.exe              the pinned runtime, downloaded from nodejs.org
 *     node_modules/         production dependencies, installed on this Windows runner
 *     app/                  the application source and its own package.json
 *     install.ps1  uninstall.ps1  PuzzleSolver.vbs
 *
 * Run on windows-latest only. The point of the job is that `sharp`'s native binary is
 * the Windows one, which a Linux `node_modules` cannot provide; this script does not
 * try to cross-install.
 *
 * `--ignore-scripts` is deliberate: the repository's `prepare` hook installs a git
 * pre-push hook with POSIX shell redirection, and there is no `.git` in the payload.
 * None of the production dependencies need an install script (`sharp` ships prebuilt
 * optional platform packages), so skipping them changes nothing that travels.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, cpSync, copyFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  bundledNodeUrl,
  BUNDLED_NODE_VERSION,
  REQUIRED_PAYLOAD,
  WINDOWS_SHARP_BINARY,
  FORBIDDEN_PAYLOAD,
} from './packaging.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const payload = join(dist, 'payload');

function log(message) {
  console.log(`[build-payload] ${message}`);
}

function copyInto(source, destination) {
  cpSync(source, destination, { recursive: true });
}

function directorySize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += directorySize(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

function runNpmCi(dir) {
  log('npm ci --omit=dev --ignore-scripts');
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

async function downloadNodeExe(destination) {
  const url = bundledNodeUrl();
  log(`downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not download node.exe: ${response.status} ${response.statusText}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1_000_000) {
    throw new Error(`node.exe looks too small (${bytes.byteLength} bytes); the download was probably an error page`);
  }
  writeFileSync(destination, bytes);
}

function assertPayload(payloadDir) {
  const missing = [];
  for (const entry of [...REQUIRED_PAYLOAD, WINDOWS_SHARP_BINARY]) {
    if (!existsSync(join(payloadDir, entry.split('/').join(sep)))) missing.push(entry);
  }
  if (missing.length) {
    throw new Error(`the payload is incomplete, missing:\n  ${missing.join('\n  ')}`);
  }
  const forbidden = FORBIDDEN_PAYLOAD.filter((entry) => existsSync(join(payloadDir, entry.split('/').join(sep))));
  if (forbidden.length) {
    throw new Error(`the payload contains something that must not ship:\n  ${forbidden.join('\n  ')}`);
  }
}

async function main() {
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });

  // The app: source plus the `"type": "module"` marker that makes ESM load at all.
  mkdirSync(join(payload, 'app'), { recursive: true });
  copyInto(join(root, 'src'), join(payload, 'app', 'src'));
  copyFileSync(join(root, 'package.json'), join(payload, 'app', 'package.json'));

  // npm needs the manifest and lockfile at the root it installs into.
  copyFileSync(join(root, 'package.json'), join(payload, 'package.json'));
  copyFileSync(join(root, 'package-lock.json'), join(payload, 'package-lock.json'));

  // The installer half: path/launch glue the app's own deploy modules invoke.
  for (const name of ['install.ps1', 'uninstall.ps1', 'PuzzleSolver.vbs']) {
    copyFileSync(join(root, 'packaging', name), join(payload, name));
  }

  await downloadNodeExe(join(payload, 'node.exe'));
  runNpmCi(payload);
  assertPayload(payload);

  const bytes = directorySize(payload);
  log(`payload assembled: ${relative(root, payload)} (${(bytes / 1024 / 1024).toFixed(1)} MiB, node ${BUNDLED_NODE_VERSION})`);
  return { payload, bytes };
}

main().catch((err) => {
  console.error(`BUILD FAILED: ${err.message}`);
  process.exit(1);
});
