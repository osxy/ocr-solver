#!/usr/bin/env node
/**
 * Sweep preprocessing parameters and score them against the corpus.
 *
 * This is how the presets in src/imaging/preprocess.js were chosen: a global
 * luminance threshold cannot work because the noise brightness varies across the
 * image, so a local (Bradley) threshold with a tuned window and offset is needed,
 * and the right constants are found by measurement, not by guessing.
 *
 * Re-run this whenever the puzzle generator's artwork changes.
 *
 *   node scripts/tune-preprocessing.js
 *   node scripts/tune-preprocessing.js --scale 6 --wins 9,15,25 --ts 0.1,0.15,0.2
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrWorker, recognize, PSM } from '../src/ocr/recognize.js';
import { extractMask, renderMask } from '../src/imaging/preprocess.js';
import { normalizeTranscript } from '../src/solver/transcript.js';
import { editDistance } from '../src/solver/lexicon.js';
import { parsePuzzle } from '../src/solver/puzzle.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'corpus');
const expected = JSON.parse(readFileSync(join(corpusDir, 'expected.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const wins = String(arg('wins', '9,15,25')).split(',').map(Number);
const offsets = String(arg('ts', '0.05,0.1,0.15,0.2')).split(',').map(Number);
const components = String(arg('components', '4,8')).split(',').map(Number);
const scale = Number(arg('scale', '4'));

function similarity(a, b) {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - editDistance(a, b) / max;
}

const worker = await createOcrWorker();
const rows = [];

for (const win of wins) {
  for (const t of offsets) {
    for (const minComponent of components) {
      const name = `w${win}_t${t}_c${minComponent}`;
      const scores = [];
      let exact = 0;
      let solved = 0;

      for (const item of expected) {
        const { mask, width, height } = await extractMask(join(corpusDir, item.file), { win, t, minComponent });
        const buffer = await renderMask(mask, width, height, scale);
        const { text } = await recognize(worker, buffer, { psm: PSM.SINGLE_BLOCK });
        const normalized = normalizeTranscript(text).text;
        const sim = similarity(normalized, item.transcript);
        scores.push(sim);
        if (sim === 1) exact++;
        const parsed = parsePuzzle(normalized);
        const wantClass = parsed.class === item.class;
        if (wantClass) solved++;
      }

      rows.push({
        name,
        worst: Math.min(...scores),
        mean: scores.reduce((a, b) => a + b, 0) / scores.length,
        exact,
        solved,
      });
    }
  }
}

await worker.terminate();

rows.sort((a, b) => b.solved - a.solved || b.worst - a.worst || b.mean - a.mean);

console.log('\n  solved  exact  worst  mean   config');
console.log('  ------  -----  -----  -----  --------------------------');
for (const r of rows.slice(0, 15)) {
  console.log(
    `  ${String(r.solved).padStart(4)}/${expected.length}  ${String(r.exact).padStart(4)}/${expected.length}  ` +
    `${r.worst.toFixed(2)}   ${r.mean.toFixed(2)}   ${r.name}`
  );
}
console.log('\n  "solved" = parsed into the right puzzle class; "exact" = transcript matched perfectly.');
