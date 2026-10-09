#!/usr/bin/env node
/**
 * Write (and verify) the SHA256 that travels beside the zip.
 *
 *   node packaging/checksum.mjs dist/PuzzleSolver-0.1.0-win-x64.zip
 *   node packaging/checksum.mjs --verify dist/PuzzleSolver-0.1.0-win-x64.zip
 *
 * The write path re-reads the file it just hashed and compares, so a checksum is never
 * emitted for bytes other than the ones on disk. `--verify` re-reads later and fails if
 * the artifact and its sidecar have drifted — which is what makes a checksum worth
 * publishing rather than decoration. The byte size is also appended to the job summary
 * (when `GITHUB_STEP_SUMMARY` is set) so payload growth is visible on every build.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checksumLine, parseChecksum } from './packaging.js';

export function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sidecarPath(file) {
  return `${file}.sha256`;
}

export function emit(file, { summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const digest = sha256(file);
  const size = statSync(file).size;
  const sidecar = sidecarPath(file);
  writeFileSync(sidecar, checksumLine(digest, basename(file)), 'utf8');

  // Read back what was written and re-hash the file: the emitted digest must describe
  // the bytes that exist now, not the bytes that existed a moment ago.
  const written = parseChecksum(readFileSync(sidecar, 'utf8'));
  const again = sha256(file);
  if (written !== again) throw new Error(`${basename(file)} changed while being hashed`);

  console.log(`${digest}  ${basename(file)}  (${size} bytes)`);
  if (summary) {
    appendFileSync(
      summary,
      [
        `### Windows package`,
        '',
        `| | |`,
        `|---|---|`,
        `| artifact | \`${basename(file)}\` |`,
        `| size | ${(size / 1024 / 1024).toFixed(1)} MiB (${size} bytes) |`,
        `| sha256 | \`${digest}\` |`,
      ].join('\n') + '\n',
      'utf8'
    );
  }
  return { digest, size, sidecar };
}

export function verify(file) {
  const expected = parseChecksum(readFileSync(sidecarPath(file), 'utf8'));
  const actual = sha256(file);
  if (expected !== actual) {
    throw new Error(
      `checksum mismatch for ${basename(file)}:\n  sidecar:  ${expected}\n  computed: ${actual}`
    );
  }
  console.log(`verified ${basename(file)} matches its sidecar`);
  return { digest: actual };
}

function main(argv) {
  const doVerify = argv.includes('--verify');
  const files = argv.filter((arg) => arg !== '--verify');
  if (files.length === 0) {
    console.error('usage: node packaging/checksum.mjs [--verify] <file> [...]');
    return 2;
  }
  try {
    for (const file of files) {
      if (doVerify) verify(file);
      else emit(file);
    }
    return 0;
  } catch (err) {
    console.error(`CHECKSUM FAILED: ${err.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));
