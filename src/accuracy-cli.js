/**
 * Offline accuracy report, computed from two independent sources:
 *
 *   1. the committed corpus (deterministic, repeatable, no network, no key);
 *   2. the recorded `attempts` store (real traffic, whatever exists).
 *
 *   node src/cli.js accuracy                 # full offline corpus + store
 *   node src/cli.js accuracy --no-images     # text fixtures only (fast)
 *   node src/cli.js accuracy --json          # machine-readable
 *   node src/cli.js accuracy --no-store      # corpus only
 *
 * The report is grouped by corpus provenance and never blended: synthetic images
 * measure the pipeline against our noise model, real images against the real
 * generator, and the two must stay visually distinct. The CLI does not claim a
 * real-world accuracy number; it reports what each corpus actually measured.
 *
 * Lives under `src/` rather than `scripts/` because the packaged app ships `src/`
 * but not `scripts/` or the development corpus. With no corpus manifest it degrades
 * to the recorded-traffic report instead of failing.
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOcrWorker } from './ocr/recognize.js';
import { solveImage } from './solver/pipeline.js';
import { openStore } from './state/db.js';
import { defaultStatePath } from './config.js';
import {
  loadCorpusItems,
  runCorpus,
  buildReport,
  storeReport,
  reportBundle,
  saveReportCache,
  defaultAccuracyCachePath,
  formatReport,
  formatSummary,
} from './accuracy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCorpusDir = join(root, 'corpus');

function firstValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? null : argv[i + 1];
}
const has = (argv, name) => argv.includes(`--${name}`);

/**
 * @param {string[]} argv   arguments after the subcommand
 * @param {object} [options]
 * @param {string} [options.corpusDir]
 * @param {string} [options.storePath]  override; default is the platform state path
 */
export async function runAccuracy(argv = process.argv.slice(2), { corpusDir = defaultCorpusDir, storePath = null } = {}) {
  const wantImages = !has(argv, 'no-images');
  const wantStore = !has(argv, 'no-store');
  const json = has(argv, 'json');
  const resolvedCorpusDir = firstValue(argv, 'corpus') ?? corpusDir;
  const manifestPath = join(resolvedCorpusDir, 'manifest.json');
  const items = existsSync(manifestPath) ? loadCorpusItems(resolvedCorpusDir) : [];

  let outcomes = null;
  let worker = null;
  try {
    if (wantImages && items.length > 0) {
      worker = await createOcrWorker();
      const started = Date.now();
      outcomes = await runCorpus({
        items,
        worker,
        corpusDir: resolvedCorpusDir,
        solveImageImpl: solveImage,
        onProgress: (_done, _total, item, row) => {
          if (!json && row.expected != null && !row.correct) {
            process.stderr.write(`  fail ${item.id}: want=${row.expected} got=${row.answer ?? '-'} (${item.provenance})\n`);
          }
        },
      });
      process.stderr.write(`ran ${items.length} corpus items in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    } else {
      // Text-only: skip image items entirely. They are deterministic too, but they
      // need OCR, which is the whole reason to offer a fast mode.
      const textItems = items.filter((i) => i.kind === 'text');
      outcomes = await runCorpus({ items: textItems, worker: null, corpusDir: resolvedCorpusDir, solveImageImpl: solveImage });
    }
  } finally {
    await worker?.terminate();
  }

  const corpusReport = outcomes.length
    ? buildReport(outcomes, {
        source: 'corpus',
        label: `offline corpus (${wantImages ? 'images+text' : 'text only'})`,
      })
    : null;

  let store = null;
  const resolvedStorePath = storePath ?? firstValue(argv, 'store') ?? defaultStatePath();
  let storeValue = null;
  if (wantStore && existsSync(resolvedStorePath)) {
    store = openStore({ path: resolvedStorePath });
    storeValue = storeReport(store);
  }

  const bundle = reportBundle({
    corpusReport,
    storeReport: storeValue,
    generatedAt: new Date().toISOString(),
  });
  bundle.storePath = resolvedStorePath;
  bundle.storeExists = Boolean(store);

  const cachePath = firstValue(argv, 'cache') ?? defaultAccuracyCachePath(resolvedStorePath);
  if (outcomes && wantImages) saveReportCache(cachePath, bundle);

  if (json) {
    console.log(JSON.stringify(bundle, null, 2));
  } else {
    if (corpusReport) {
      console.log(`\n${formatReport(corpusReport)}`);
    } else {
      console.log('\nno offline corpus found; reporting recorded traffic only');
    }
    if (storeValue) {
      console.log(`\nrecorded traffic (${resolvedStorePath}): ${formatSummary(storeValue.overall)}  [seen ${storeValue.overall.seen}]`);
    } else if (wantStore) {
      console.log(`\nrecorded traffic: no store at ${resolvedStorePath} (nothing recorded yet)`);
    }
    if (corpusReport) {
      console.log(`\nnote: only the 'real' provenance is the real generator; 'synthetic' is our noise model.`);
    }
  }

  // A non-zero exit only when a *real* item fails; synthetic failures are reported
  // but must not make a tuning script look like a broken build.
  const real = corpusReport?.byProvenance?.real;
  if (real && real.accuracy != null && real.accuracy < 1) process.exitCode = 1;
  store?.close();
  return bundle;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runAccuracy();
}
