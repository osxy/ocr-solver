#!/usr/bin/env node
/**
 * Regenerate the M4 corpus and its manifest.
 *
 *   node scripts/generate-corpus.js                 # render, verify, write
 *   node scripts/generate-corpus.js --no-verify      # render only (fast, for a font change)
 *   node scripts/generate-corpus.js --verify-only    # solve the committed images, write nothing
 *
 * The synthetic images are committed rather than rendered at test time. Font
 * rendering is the one non-hermetic input here (librsvg + fontconfig), so the
 * committed PNGs - not the renderer - are what the tests consume; regenerating on
 * a machine with different fonts is an explicit, reviewable diff.
 *
 * Every rendered image is solved through the *real* pipeline before it is written.
 * A synthetic fixture the pipeline cannot read would silently depress the accuracy
 * number and look like a pipeline bug, which is the trap this milestone is exposed
 * to; refusing to write it turns that into a loud failure at generation time.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { solveImage } from '../src/solver/pipeline.js';
import { renderPuzzleImage } from '../src/corpus/render.js';
import { OBSERVED_OCR_DAMAGE } from '../src/corpus/observed.js';
import {
  buildTextFixtures,
  buildDamagedTextFixtures,
  buildEdgeTextFixtures,
  buildImageSpecs,
  wrapTranscript,
  assertSolvable,
} from '../src/corpus/build.js';
import { validateManifest } from '../src/accuracy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'corpus');
const syntheticDir = join(corpusDir, 'synthetic');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value == null || value.startsWith('--') ? true : Number.isNaN(Number(value)) ? value : Number(value);
}

const imageCount = Number(arg('images', 36));
const textCount = Number(arg('text', 180));
const damagedCount = Number(arg('damaged', 60));
const verify = !process.argv.includes('--no-verify');
const verifyOnly = process.argv.includes('--verify-only');
const baseSeed = Number(arg('seed', 20240501));

/** Real items: the hand-maintained expected.json is the source of truth for them. */
function realItems() {
  const expected = JSON.parse(readFileSync(join(corpusDir, 'expected.json'), 'utf8'));
  return expected.map((item) => ({
    id: item.file.replace(/\.[a-z]+$/i, ''),
    provenance: 'real',
    kind: 'image',
    class: item.class,
    category: item.category ?? null,
    list: item.list ?? [],
    transcript: item.transcript,
    expected: item.answer,
    file: item.file,
    note: item.note ?? null,
  }));
}

/** Derived items: real images carrying the OCR errors Tesseract really made. */
function derivedItems(reals) {
  const byFile = new Map(reals.map((item) => [item.file, item]));
  return Object.entries(OBSERVED_OCR_DAMAGE).map(([file, transcript]) => {
    const real = byFile.get(file);
    if (!real) throw new Error(`OBSERVED_OCR_DAMAGE names ${file}, which is not in corpus/expected.json`);
    return {
      id: `derived-${real.id}`,
      provenance: 'derived',
      kind: 'text',
      class: real.class,
      category: real.category ?? null,
      list: real.list ?? [],
      transcript,
      expected: real.expected,
      derivedFrom: file,
    };
  });
}

function syntheticTextItems() {
  const clean = [...buildTextFixtures({ count: textCount, seed: baseSeed + 1 }), ...buildEdgeTextFixtures()];
  const damaged = buildDamagedTextFixtures({ count: damagedCount, seed: baseSeed + 2 });
  return [
    ...clean.map((item) => ({ ...item, provenance: 'synthetic', kind: 'text' })),
    ...damaged.map((item) => ({ ...item, provenance: 'synthetic', kind: 'text' })),
  ];
}

async function renderSyntheticImages(specs, worker) {
  mkdirSync(syntheticDir, { recursive: true });
  const items = [];
  for (const spec of specs) {
    const lines = wrapTranscript(spec.transcript);
    const buffer = await renderPuzzleImage({ lines, seed: spec.seed });
    const id = spec.id;
    const file = `synthetic/${id}.png`;
    writeFileSync(join(corpusDir, file), buffer);
    const item = {
      id,
      provenance: 'synthetic',
      kind: 'image',
      class: spec.class,
      category: spec.category ?? null,
      list: spec.list ?? [],
      transcript: spec.transcript,
      expected: spec.expected,
      file,
      seed: spec.seed,
    };
    if (verify) {
      const result = await solveImage(worker, join(corpusDir, file), {});
      if (result.answer !== spec.expected) {
        throw new Error(
          `synthetic image ${id} (${JSON.stringify(spec.transcript)}) solved as ${result.answer}, ` +
            `expected ${spec.expected}. Refusing to write a fixture the pipeline cannot read.`
        );
      }
      item.verified = true;
    }
    items.push(item);
  }
  return items;
}

async function verifyCommitted() {
  const manifest = validateManifest(JSON.parse(readFileSync(join(corpusDir, 'manifest.json'), 'utf8')));
  const worker = await createOcrWorker();
  let failures = 0;
  try {
    for (const item of manifest.items) {
      if (item.kind !== 'image') continue;
      const result = await solveImage(worker, join(corpusDir, item.file), {});
      const ok = result.answer === item.expected;
      if (!ok) {
        failures++;
        console.error(`FAIL ${item.id}: want=${item.expected} got=${result.answer} (${item.provenance})`);
      }
    }
  } finally {
    await worker.terminate();
  }
  const images = manifest.items.filter((i) => i.kind === 'image').length;
  console.log(`verified ${images - failures}/${images} committed images`);
  if (failures) process.exitCode = 1;
}

async function main() {
  if (verifyOnly) {
    await verifyCommitted();
    return;
  }

  const reals = realItems();
  const texts = syntheticTextItems();
  const derived = derivedItems(reals);
  const imageSpecs = buildImageSpecs({ count: imageCount, seed: baseSeed });

  // Clear stale synthetic PNGs so a removed fixture cannot linger as an orphan.
  if (existsSync(syntheticDir)) {
    for (const name of readdirSync(syntheticDir)) {
      if (name.endsWith('.png')) rmSync(join(syntheticDir, name));
    }
  }

  const worker = verify ? await createOcrWorker() : null;
  let images = [];
  try {
    images = await renderSyntheticImages(imageSpecs, worker);
  } finally {
    await worker?.terminate();
  }

  for (const item of texts) assertSolvable(item, item.id);

  const items = [...reals, ...images, ...texts, ...derived];
  const manifest = {
    version: 1,
    generated: {
      seed: baseSeed,
      images: images.length,
      text: texts.length,
      derived: derived.length,
      real: reals.length,
      verified: verify,
    },
    items,
  };
  validateManifest(manifest);
  writeFileSync(join(corpusDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const by = (key) => {
    const out = {};
    for (const item of items) out[item[key]] = (out[item[key]] ?? 0) + 1;
    return out;
  };
  console.log(
    `wrote corpus/manifest.json: ${items.length} items ` +
      `(provenance ${JSON.stringify(by('provenance'))}, kind ${JSON.stringify(by('kind'))}, class ${JSON.stringify(by('class'))})`
  );
}

await main();
