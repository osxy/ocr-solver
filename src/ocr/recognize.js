/**
 * Tesseract OCR wrapper.
 *
 * Fully offline: the traineddata is read from the installed
 * `@tesseract.js-data/<code>` package inside node_modules, so no CDN download happens
 * at runtime. Which languages are usable, and what happens when one is not, lives in
 * `./languages.js` (issue #143).
 *
 * Note on confidence: Tesseract reports high confidence for EMPTY output. Measured
 * on the corpus, one variant returned 95% confidence with a blank transcript. Any
 * caller ranking results MUST treat empty text as a hard failure rather than
 * trusting `confidence`. `rankResults` below enforces that.
 */
import { createWorker } from 'tesseract.js';
import { DEFAULT_OCR_LANGUAGE, resolveOcrLanguages } from './languages.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Page segmentation modes worth trying on these puzzle images. */
export const PSM = {
  SINGLE_BLOCK: '6', // assume one uniform block of text - correct for 2-line puzzles
  SINGLE_COLUMN: '4',
  SINGLE_LINE: '7',
};

/**
 * Where Tesseract *would* cache the decompressed traineddata.
 *
 * The bundled data makes a disk cache unnecessary and unsafe. `@tesseract.js-data/nld`
 * ships `nld.traineddata.gz` inside `node_modules`, and reading + gunzipping it costs
 * the same as reading the 23 MB decompressed file (~0.4 s, measured). tesseract.js
 * writes that cache with a truncating `fs.writeFile`, so two workers sharing the path
 * can read a half-written file, fail to initialise, and hang the caller (tesseract.js
 * leaves the promise it returns unsettled after an initialisation failure).
 * `createOcrWorker` therefore passes `cacheMethod: 'none'` and never reads or writes
 * this path — issue #110. It is kept so the regression test can name a location and
 * assert nothing is ever written there.
 *
 * tesseract.js's own default is the current working directory, which is worse still:
 * it drops a 23 MB file next to wherever the app was launched from.
 */
export function defaultCachePath() {
  if (process.env.PUZZLESOLVER_CACHE_DIR) return process.env.PUZZLESOLVER_CACHE_DIR;
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || tmpdir()
      : process.env.XDG_CACHE_HOME || join(process.env.HOME || tmpdir(), '.cache');
  return join(base, 'PuzzleSolver', 'tessdata');
}

export async function createOcrWorker({
  // The configured `ocr.languages` (issue #143). It defaults to the bundled `nld`, but
  // a configured language is resolved against installed packages and a missing one is
  // refused by name rather than quietly replaced with `nld`.
  languages = [DEFAULT_OCR_LANGUAGE],
  cachePath = defaultCachePath(),
  cacheMethod = 'none',
  // Injection seams for the tests: resolution and tesseract.js's own factory, so the
  // language that reaches `createWorker` can be asserted without a real worker.
  resolveLanguages = resolveOcrLanguages,
  createWorkerImpl = createWorker,
} = {}) {
  const { lang, langPath, gzip } = resolveLanguages(languages);
  // `cacheMethod: 'none'` loads the bundled `.gz` straight into Tesseract's in-memory
  // filesystem and skips the shared on-disk cache entirely. The disk cache is not just
  // redundant here: its non-atomic write is what made two parallel workers read a
  // truncated `.traineddata` and hang (issue #110). Do not set this back to
  // 'write'/'refresh' without first making the cache write atomic.
  const worker = await createWorkerImpl(lang, 1, { langPath, cachePath, gzip, cacheMethod });
  // Silence "Invalid resolution 25 dpi" warnings and pin the engine.
  await worker.setParameters({ user_defined_dpi: '300', preserve_interword_spaces: '1' });
  return worker;
}

/** Recognise one image buffer with one PSM. */
export async function recognize(worker, buffer, { psm = PSM.SINGLE_BLOCK } = {}) {
  await worker.setParameters({ tessedit_pageseg_mode: psm });
  const started = Date.now();
  const { data } = await worker.recognize(buffer);
  return {
    text: data.text.replace(/\s+/g, ' ').trim(),
    confidence: Math.round(data.confidence ?? 0),
    words: (data.words ?? []).map((w) => ({ text: w.text, confidence: Math.round(w.confidence ?? 0) })),
    ms: Date.now() - started,
  };
}

/** Recognise every preprocessing variant at every PSM. */
export async function recognizeVariants(worker, variants, psms = [PSM.SINGLE_BLOCK]) {
  const results = [];
  for (const variant of variants) {
    for (const psm of psms) {
      const r = await recognize(worker, variant.buffer, { psm });
      results.push({ variant: variant.name, psm, ...r, empty: r.text.length === 0 });
    }
  }
  return results;
}

/**
 * Rank OCR results. Empty transcripts are demoted below every non-empty one
 * regardless of reported confidence.
 */
export function rankResults(results) {
  return [...results].sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    return b.confidence - a.confidence;
  });
}

/** Rank results, preferring transcripts that look like a real sentence. */
export function bestResult(results) {
  const scored = results.map((r) => {
    const words = r.text.split(' ').filter(Boolean);
    const lengthBonus = Math.min(words.length, 12) * 0.5; // real puzzles are 6-12 words
    const dictionaryBonus = /\b(in|de|het|wat|is|lijst|hoeveel|eerste)\b/i.test(r.text) ? 3 : 0;
    return { ...r, score: (r.empty ? -1000 : 0) + r.confidence + lengthBonus + dictionaryBonus };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}
