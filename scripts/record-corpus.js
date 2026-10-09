#!/usr/bin/env node
/**
 * Turn a solved or unresolved puzzle into a permanent corpus entry.
 *
 * The whole point of M4 is that a failure is worth more than a success: an
 * unresolved puzzle recorded once becomes a regression that the accuracy report
 * remembers, instead of a one-off that scrolls out of the log. This script copies
 * the image into `corpus/recorded/` and appends one entry to
 * `corpus/recorded/manifest.json`.
 *
 *   node scripts/record-corpus.js --subject <push-iden>              # from the store + inbox
 *   node scripts/record-corpus.js --image inbox/x.png --expected 7   # a local image
 *   node scripts/record-corpus.js --subject <iden> --expected 2      # pin the truth
 *
 * An unresolved puzzle has no answer in the store. It is still recorded, with
 * `expected: null`, so it counts as seen-and-unanswered; when the fix lands, pass
 * `--expected` to promote it into a graded regression. A solved puzzle's own
 * validated answer is used as the expected answer only as a convenience and is
 * labelled `expectedSource: "pipeline"` - recording the pipeline's own output as
 * ground truth is circular, and the label says so.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../src/state/db.js';
import { defaultStatePath } from '../src/config.js';
import { defaultInboxDir } from '../src/pushbullet/files.js';
import { validateManifest } from '../src/accuracy.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpusDir = join(root, 'corpus');
const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff'];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** Locate the image for a subject: explicit path, inbox, or a recorded image-ref. */
export function findImageForSubject({ subject, image = null, inboxDir, store = null }) {
  if (image) return existsSync(image) ? image : null;
  for (const ext of IMAGE_EXT) {
    const candidate = join(inboxDir, `${subject}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  if (store) {
    const ref = store
      .attemptsFor(subject)
      .filter((row) => row.stage === 'image-ref')
      .at(-1);
    if (ref?.payload?.path && existsSync(ref.payload.path)) return ref.payload.path;
  }
  return null;
}

/** What the store already knows about a subject, without inventing anything. */
export function outcomeFromAttempts(attempts) {
  const validate = attempts.filter((row) => row.stage === 'validate').at(-1);
  const payload = validate?.payload ?? {};
  const ocr = attempts.filter((row) => row.stage === 'ocr' && row.payload?.text).at(-1);
  return {
    answer: payload.answer ?? null,
    accepted: Boolean(validate?.ok),
    class: payload.class ?? null,
    confident: Boolean(payload.confident),
    transcript: ocr?.payload?.text ?? null,
  };
}

/**
 * Build the manifest entry. `expectedSource` is deliberately explicit:
 *   user      - someone supplied the ground truth;
 *   pipeline  - the pipeline's own accepted answer (circular, labelled);
 *   pending   - no answer yet; counts as seen-but-unanswered.
 */
export function buildRecordedEntry({
  id,
  subject = null,
  provenance = 'real',
  image = null,
  relFile = null,
  expected = null,
  expectedSource = 'pending',
  class: klass = null,
  category = null,
  transcript = null,
  status = 'unresolved',
  note = null,
  recordedAt = new Date().toISOString(),
}) {
  return {
    id,
    provenance,
    kind: 'image',
    class: klass,
    category,
    list: [],
    transcript,
    expected,
    expectedSource,
    status,
    file: relFile,
    subject,
    image,
    note,
    recordedAt,
  };
}

/** Append or replace one entry in a recorded manifest, returning the new manifest. */
export function upsertRecordedManifest(manifest, entry) {
  const items = Array.isArray(manifest?.items) ? [...manifest.items] : [];
  const at = items.findIndex((item) => item.id === entry.id);
  if (at === -1) items.push(entry);
  else items[at] = entry;
  return { version: 1, items };
}

function safeId(text) {
  return String(text).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'entry';
}

async function main() {
  const subject = arg('subject');
  const imageArg = arg('image');
  const outDir = arg('out', join(corpusDir, 'recorded'));
  const storePath = arg('store', defaultStatePath());
  const inboxDir = arg('inbox', defaultInboxDir());
  const provenance = arg('provenance', 'real');
  const note = arg('note');
  const explicitExpected = arg('expected', null);
  const explicitClass = arg('class', null);

  if (!subject && !imageArg) {
    console.error(
      'usage: node scripts/record-corpus.js (--subject <iden> | --image <path>) [--expected <answer>]\n' +
        '       [--class <class>] [--store <db>] [--inbox <dir>] [--out <dir>] [--provenance real|derived]'
    );
    process.exit(2);
  }

  const store = existsSync(storePath) ? openStore({ path: storePath }) : null;
  const attempts = store && subject ? store.attemptsFor(subject) : [];
  const outcome = outcomeFromAttempts(attempts);

  const image = findImageForSubject({ subject, image: imageArg, inboxDir, store });
  if (!image) {
    console.error(`could not find an image for ${subject ?? imageArg} (looked in ${inboxDir})`);
    process.exit(2);
  }

  const idBase = safeId(subject ?? basename(image, extname(image)));
  const id = `recorded-${provenance}-${idBase}`;
  const fileName = `${id}${extname(image) || '.png'}`;
  mkdirSync(outDir, { recursive: true });
  copyFileSync(image, join(outDir, fileName));
  // Store the path relative to the corpus root so `loadCorpusItems` can resolve it
  // regardless of which directory the manifest itself lives in.
  const relFile = relative(corpusDir, join(outDir, fileName)).split(sep).join('/');

  let expected = explicitExpected;
  let expectedSource = explicitExpected != null ? 'user' : 'pending';
  if (explicitExpected == null && outcome.accepted && outcome.answer != null) {
    expected = outcome.answer;
    expectedSource = 'pipeline';
    console.error(
      `warning: using the pipeline's own answer "${expected}" as expected for ${id}. ` +
        'That is circular as a correctness signal; pass --expected to pin the truth.'
    );
  }

  const entry = buildRecordedEntry({
    id,
    subject,
    provenance,
    image,
    relFile,
    expected,
    expectedSource,
    class: explicitClass ?? outcome.class,
    transcript: outcome.transcript,
    status: expected != null ? 'solved' : 'unresolved',
    note,
  });

  const manifestPath = join(outDir, 'manifest.json');
  const current = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { version: 1, items: [] };
  const next = upsertRecordedManifest(current, entry);
  validateManifest(next);
  writeFileSync(manifestPath, JSON.stringify(next, null, 2) + '\n');

  console.log(
    `recorded ${id}: status=${entry.status} expected=${expected ?? '(none, pending)'} ` +
      `source=${expectedSource} file=${relFile}`
  );
  if (store) store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
