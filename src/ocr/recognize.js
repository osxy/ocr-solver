/**
 * Tesseract OCR wrapper.
 *
 * Fully offline: the `@tesseract.js-data/nld` package ships the Dutch traineddata
 * inside node_modules, so no CDN download happens at runtime.
 *
 * Note on confidence: Tesseract reports high confidence for EMPTY output. Measured
 * on the corpus, one variant returned 95% confidence with a blank transcript. Any
 * caller ranking results MUST treat empty text as a hard failure rather than
 * trusting `confidence`. `rankResults` below enforces that.
 */
import { createWorker } from 'tesseract.js';
import nld from '@tesseract.js-data/nld';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Page segmentation modes worth trying on these puzzle images. */
export const PSM = {
  SINGLE_BLOCK: '6', // assume one uniform block of text - correct for 2-line puzzles
  SINGLE_COLUMN: '4',
  SINGLE_LINE: '7',
};

/**
 * Where Tesseract should cache the decompressed traineddata.
 *
 * tesseract.js defaults this to the current working directory, which drops a 23 MB
 * `nld.traineddata` next to whatever directory the app happened to be launched from,
 * and fails outright when that directory is read-only (Program Files). Always point
 * it at a real per-user cache directory instead.
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
  lang = nld.code,
  langPath = nld.langPath,
  cachePath = defaultCachePath(),
} = {}) {
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(lang, 1, { langPath, cachePath, gzip: true });
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
