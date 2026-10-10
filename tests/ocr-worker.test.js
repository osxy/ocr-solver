/**
 * The OCR worker must not share a writable traineddata cache (issue #110).
 *
 * The CI flake was: `tests/corpus.test.js` cancelled at its 60 s timeout with
 * `Error opening data file ./nld.traineddata` / `Tesseract couldn't load any languages!`,
 * intermittently, on a commit that had already passed the same job. The cause is not a
 * slow suite — a fresh worker initialises in well under a second. It is that every test
 * file runs in its own process, all of them share one cache path, and tesseract.js
 * writes that cache with a truncating `fs.writeFile`. A process that reads while another
 * writes gets a short, corrupt `nld.traineddata`; initialisation then fails, and because
 * tesseract.js leaves the promise it returns unsettled, the caller hangs until its
 * timeout (a leaked worker thread also keeps the process alive — the 15-minute hang).
 *
 * The fix is to load the bundled `@tesseract.js-data/nld` `.gz` straight into Tesseract's
 * in-memory filesystem with `cacheMethod: 'none'`, so there is no shared writable file.
 *
 * This test can fail: it asserts nothing is written where the cache used to go, and it
 * runs the worker from a different working directory so a path that silently became
 * cwd-dependent is caught too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createOcrWorker, recognize } from '../src/ocr/recognize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the OCR worker loads the bundled language data without writing a shared cache', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'puzzlesolver-tessdata-'));
  const workDir = mkdtempSync(join(tmpdir(), 'puzzlesolver-cwd-'));
  const previousCache = process.env.PUZZLESOLVER_CACHE_DIR;
  const previousCwd = process.cwd();
  process.env.PUZZLESOLVER_CACHE_DIR = cacheDir;

  let worker;
  try {
    process.chdir(workDir);
    worker = await createOcrWorker();

    const image = readFileSync(join(root, 'corpus', '003-arithmetic-acht-min-een.png'));
    const result = await recognize(worker, image);
    assert.ok(result.text.length > 0, 'the bundled Dutch language data must load and recognise');

    // On the pre-#110 code this is ['nld.traineddata']; the file is what a second worker
    // can read half-written. It must never appear.
    assert.deepEqual(
      readdirSync(cacheDir),
      [],
      'tesseract.js must not write a shared traineddata cache (a truncated entry hangs a second worker)'
    );
  } finally {
    process.chdir(previousCwd);
    await worker?.terminate();
    if (previousCache === undefined) delete process.env.PUZZLESOLVER_CACHE_DIR;
    else process.env.PUZZLESOLVER_CACHE_DIR = previousCache;
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  }
});
