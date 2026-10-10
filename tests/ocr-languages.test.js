/**
 * `ocr.languages` must actually reach the Tesseract worker, and a language with no
 * bundled traineddata must be refused by name rather than silently reading as Dutch
 * (issue #143, from the v0.45 peer review).
 *
 * Before the fix, `createOcrWorker` took no languages and every caller left them at
 * the bundled `nld`, so `ocr.languages = ["eng"]` validated, saved, demanded a restart
 * and changed nothing. The regression tests here fail on that code: the first because
 * the configured value never reaches tesseract.js, the second because the unavailable
 * language is accepted instead of refused.
 *
 * No real worker is built: `resolveLanguages` and `createWorkerImpl` are the seams
 * `createOcrWorker` exposes for exactly this. The one test that must use the real
 * resolver only resolves the installed `nld` package, which needs no worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOcrWorker } from '../src/ocr/recognize.js';
import {
  DEFAULT_OCR_LANGUAGE,
  OcrLanguageUnavailableError,
  resolveOcrLanguages,
} from '../src/ocr/languages.js';
import { validateConfig } from '../src/config.js';

test('#143: the configured OCR languages reach the Tesseract worker', async () => {
  const calls = [];
  const worker = await createOcrWorker({
    // A value that cannot be the default, so the test can only pass if the configured
    // list is what flows through. This bypasses the real bundle (no `eng` package is
    // installed) while still proving the plumbing.
    languages: ['nld', 'eng'],
    resolveLanguages: (codes) => ({ lang: codes.join('+'), langPath: '/fake/tessdata', gzip: true }),
    createWorkerImpl: async (lang, oem, options) => {
      calls.push({ lang, oem, options });
      return { setParameters: async () => {}, terminate: async () => {} };
    },
  });

  assert.equal(calls.length, 1, 'exactly one Tesseract worker is built');
  assert.equal(calls[0].lang, 'nld+eng', 'the configured languages are what createWorker receives');
  assert.equal(calls[0].options.langPath, '/fake/tessdata');
  assert.equal(calls[0].options.cacheMethod, 'none', 'the #110 no-shared-cache rule still holds');
  await worker.terminate();
});

test('#143: the worker defaults to the bundled language when none is configured', async () => {
  const calls = [];
  await createOcrWorker({
    createWorkerImpl: async (lang, oem, options) => {
      calls.push({ lang, options });
      return { setParameters: async () => {}, terminate: async () => {} };
    },
  });
  assert.equal(calls[0].lang, DEFAULT_OCR_LANGUAGE, 'the default resolves the bundled nld');
  assert.match(calls[0].options.langPath, new RegExp(`@tesseract\\.js-data[\\\\/]${DEFAULT_OCR_LANGUAGE}`));
});

test('#143: an unavailable OCR language is refused by name, never replaced with nld', () => {
  assert.throws(
    () => resolveOcrLanguages(['nld', 'eng']),
    (err) => {
      assert.ok(err instanceof OcrLanguageUnavailableError);
      assert.equal(err.name, 'OcrLanguageUnavailableError');
      assert.equal(err.language, 'eng');
      // The three things the message must say: the language, that only bundled data
      // works offline, and what to install.
      assert.match(err.message, /"eng"/);
      assert.match(err.message, /offline/);
      assert.match(err.message, /npm install @tesseract\.js-data\/eng/);
      return true;
    }
  );
});

test('#143: createOcrWorker refuses an unavailable language without building a worker', async () => {
  let built = false;
  await assert.rejects(
    () =>
      createOcrWorker({
        languages: ['eng'],
        createWorkerImpl: async () => {
          built = true;
          return { setParameters: async () => {}, terminate: async () => {} };
        },
      }),
    (err) => err instanceof OcrLanguageUnavailableError && err.language === 'eng'
  );
  assert.equal(built, false, 'the refusal happens before any worker is created');
});

test('#143: a set spanning two traineddata directories is refused rather than half-loaded', () => {
  // tesseract.js takes one `langPath`; each bundled package brings its own. Installed
  // packages are simulated because only `nld` is a dependency.
  const load = (code) => ({ code, langPath: `/pkg/${code}`, gzip: true });
  assert.throws(
    () => resolveOcrLanguages(['nld', 'eng'], { load }),
    /separate traineddata directories/
  );
});

test('#143: resolveOcrLanguages resolves the installed bundled language and dedupes', () => {
  const resolved = resolveOcrLanguages(['nld', 'nld']);
  assert.equal(resolved.lang, 'nld');
  assert.match(resolved.langPath, /@tesseract\.js-data[\\/]nld/);
  assert.equal(resolved.gzip, true);
});

test('#143: the config loader refuses an OCR language with no bundled traineddata', () => {
  assert.throws(
    () => validateConfig({ ocr: { languages: ['nld', 'eng'] } }),
    (err) => {
      assert.equal(err.name, 'ConfigError');
      assert.match(err.message, /ocr\.languages/);
      assert.match(err.message, /"eng"/);
      assert.match(err.message, /npm install @tesseract\.js-data\/eng/);
      return true;
    }
  );
});
