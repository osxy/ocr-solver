#!/usr/bin/env node
/**
 * Live accuracy evaluation against real puzzles.
 *
 * The offline unit and corpus tests prove the pipeline is wired correctly. This
 * answers a different question that only a real provider can answer: can a real
 * model actually read these 44px noisy Dutch puzzles, and how well does it repair
 * a degraded OCR transcript?
 *
 * Deliberately uses the REAL corpus images, not the synthetic needs-model fixture -
 * that one is clean, and passing on it proves very little.
 *
 *   set -a; . ~/.config/puzzlesolver/env; set +a
 *   node scripts/live-eval.js            # ~6-10 model calls, sample counts pinned to 1
 *   node scripts/live-eval.js --verbose  # also print every raw reply
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { solveImage } from '../src/solver/pipeline.js';
import { createReasoner } from '../src/solver/reason.js';
import { createChatClient } from '../src/model/client.js';
import { parsePuzzle } from '../src/solver/puzzle.js';
import { normalizeTranscript } from '../src/solver/transcript.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'corpus');
const expected = JSON.parse(readFileSync(join(corpusDir, 'expected.json'), 'utf8'));
const verbose = process.argv.includes('--verbose');

const apiKey = process.env.LLM_API_KEY ?? '';
if (!apiKey) {
  console.error('LLM_API_KEY is not set. See config/llm.env.example.');
  process.exit(2);
}

const client = createChatClient({
  baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey,
  autoRouter: {
    costTier: process.env.LLM_COST_TIER ?? null,
    allowedModels: (process.env.LLM_ALLOWED_MODELS ?? '').split(',').filter(Boolean),
    excludedModels: (process.env.LLM_EXCLUDED_MODELS ?? '').split(',').filter(Boolean),
  },
});

// One sample per class keeps the run cheap; voting is covered by unit tests.
const reasoner = createReasoner({
  client,
  textModel: process.env.LLM_TEXT_MODEL ?? 'gpt-4o-mini',
  visionModel: process.env.LLM_VISION_MODEL ?? 'gpt-4o',
  sampleCounts: { count: 1, arithmetic: 1, 'ordinal-pick': 1, unknown: 1 },
});

/**
 * Realistic OCR damage, not synthetic sabotage.
 *
 * Each of these is an error Tesseract actually produced on that exact image during
 * tuning. The worst-ranked variant is NOT used for this: on some images it is only a
 * word or two ("en"), and asking a model to answer from that measures nothing about
 * repairing OCR - it just fails, which proves nothing.
 */
const OBSERVED_OCR_DAMAGE = {
  '001-count-kleuren.png': 'Hoeveel kleuren in lijst wit kw: hoofd paars olifant aap?',
  '002-ordinal-lichaamsdeel.png': 'In de lijst lijst hoofd buik citroen borst olifant paard wat 1s de/het eerste lichaamsdeel?',
  '003-arithmetic-acht-min-een.png': 'Wat js acht min een?',
};

/** Raw assistant replies from the most recent batch of client calls. */
function rawReplies(calls, since) {
  return calls.slice(since).filter((c) => c.result).map((c) => c.result.text);
}

/** An OCR worker that reports nothing, forcing the vision tier. */
const blindWorker = {
  async setParameters() {},
  async recognize() {
    return { data: { text: '', confidence: 0, words: [] } };
  },
};

const worker = await createOcrWorker();
const rows = [];

try {
  for (const item of expected) {
    const file = join(corpusDir, item.file);
    const row = { file: item.file, want: item.answer };

    // (a) normal run: should be answered offline, costing nothing.
    const offline = await solveImage(worker, file, {});
    row.offline = offline.answer;
    row.offlineOk = offline.answer === item.answer;
    row.transcript = offline.transcript;
    row.usedModelOffline = offline.model != null;

    // (b) text tier on a realistically damaged transcript.
    const damagedRaw = OBSERVED_OCR_DAMAGE[item.file] ?? item.transcript;
    const degradedNormalized = normalizeTranscript(damagedRaw).text;
    {
      const before = client.calls.length;
      const textResult = await reasoner.solveText({
        transcript: degradedNormalized,
        parsed: parsePuzzle(degradedNormalized),
      });
      row.degraded = degradedNormalized;
      row.textAnswer = textResult?.answer ?? null;
      row.textOk = textResult?.answer === item.answer;
      row.textModel = client.calls.slice(before).map((c) => c.result?.model).filter(Boolean).at(-1) ?? null;
      row.textRaw = rawReplies(client.calls, before);
    }

    // (c) vision tier with OCR suppressed entirely - the real test of whether a
    //     model can read this artwork.
    const before = client.calls.length;
    const vision = await solveImage(blindWorker, file, { reasoner });
    row.visionAnswer = vision.answer;
    row.visionOk = vision.answer === item.answer;
    row.visionMethod = vision.method;
    row.visionTranscript = vision.model?.vision?.transcript ?? null;
    row.visionModel = client.calls.slice(before).map((c) => c.result?.model).filter(Boolean).at(-1) ?? null;
    row.visionRaw = rawReplies(client.calls, before);
    row.visionOpinions = (vision.opinions ?? []).map((o) => `${o.source}=${o.answer}`);

    rows.push(row);
  }
} finally {
  await worker.terminate();
}

const mark = (ok) => (ok === true ? 'ok  ' : ok === false ? 'FAIL' : ' -  ');

console.log('\n=== offline tiers (should never call a model) ===');
for (const r of rows) {
  console.log(`  ${mark(r.offlineOk)} ${r.file.padEnd(34)} want=${String(r.want).padEnd(8)} got=${r.offline ?? '-'}  modelCalled=${r.usedModelOffline}`);
}

console.log('\n=== text tier on a realistically damaged transcript (real observed OCR errors) ===');
for (const r of rows) {
  const detail = r.textModel ? ` [${r.textModel}]` : '';
  console.log(`  ${mark(r.textOk)} ${r.file.padEnd(34)} want=${String(r.want).padEnd(8)} got=${r.textAnswer ?? '-'}${detail}`);
  if (verbose || r.textOk === false) {
    console.log(`         input : ${r.degraded}`);
    for (const raw of r.textRaw ?? []) console.log(`         reply : ${raw.slice(0, 300).replace(/\n/g, ' ')}`);
  }
}

console.log('\n=== vision tier, OCR suppressed (reads the real noisy image) ===');
for (const r of rows) {
  const detail = r.visionModel ? ` [${r.visionModel}]` : '';
  console.log(`  ${mark(r.visionOk)} ${r.file.padEnd(34)} want=${String(r.want).padEnd(8)} got=${r.visionAnswer ?? '-'}${detail}`);
  if (verbose || r.visionOk === false) {
    console.log(`         method=${r.visionMethod} transcript=${JSON.stringify(r.visionTranscript)}`);
    console.log(`         opinions=${r.visionOpinions?.join(', ') || '(none)'}`);
    for (const raw of r.visionRaw ?? []) console.log(`         reply : ${raw.slice(0, 300).replace(/\n/g, ' ')}`);
  }
}

const sum = (key) => rows.filter((r) => r[key]).length;
console.log(
  `\naccuracy: offline ${sum('offlineOk')}/${rows.length}, ` +
  `text-on-degraded ${sum('textOk')}/${rows.length}, ` +
  `vision ${sum('visionOk')}/${rows.length}`
);
console.log(
  'note: text-on-damaged uses OBSERVED OCR errors, and vision suppresses OCR entirely.'
);
console.log(
);
console.log(`total model calls: ${client.calls.filter((c) => c.result).length} ok, ${client.calls.filter((c) => c.error).length} failed\n`);
