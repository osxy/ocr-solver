/**
 * Stored review copies (issue #100).
 *
 * This is the first feature that persists user content to disk, so the tests are
 * about the failure modes, not the happy path alone:
 *   - the stored copy is bounded and is not the original;
 *   - **a store that throws still solves the puzzle** - the answer path must not
 *     depend on a side feature;
 *   - retention (age + count) prunes rows and files, and the count is asserted
 *     before and after rather than trusted;
 *   - no orphans: a row whose attempt is gone, and a row whose file is gone, are
 *     reconciled; a file with no row is swept;
 *   - addressing is by row id, never a client path.
 *
 * Nothing here needs a network, a token, a key or a browser. `sharp` is a real
 * dependency and is used to make a genuinely oversized fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { solveImage } from '../src/solver/pipeline.js';
import { memoryStore, openStore } from '../src/state/db.js';
import { createImageStore, IMAGE_MAX_DIM } from '../src/state/images.js';
import { createSolveCore } from '../src/solver/core.js';
import { runImages } from '../src/images-cli.js';
import { DEFAULTS, validateConfig } from '../src/config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(root, 'corpus', '003-arithmetic-acht-min-een.png');

/** A scripted OCR worker; the image-storage path does not need real OCR. */
function fakeWorker(text, confidence = 90) {
  return {
    async setParameters() {},
    async recognize() {
      return { data: { text, confidence, words: [] } };
    },
  };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-images-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Record one validate row and return its id, so an image has an owner. */
function validateRow(store, subject = 'p') {
  store.record({ subject, stage: 'validate', ok: true, payload: { answer: '7' } });
  return store.lastAttemptId();
}

test('the stored copy is bounded and is not the original bytes (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });
  const attemptId = validateRow(store, 'big');

  // A genuinely oversized fixture: 1600x1200 is larger than the 512 px bound.
  const source = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  assert.ok(source.length > 1000, 'the fixture is a real image, not a few bytes');

  const id = await imageStore.save({ subject: 'big', attemptId, buffer: source });
  assert.equal(typeof id, 'number');

  const path = imageStore.pathFor(id);
  assert.ok(existsSync(path), 'the stored file exists');
  const meta = await sharp(path).metadata();
  assert.ok(meta.width <= IMAGE_MAX_DIM && meta.height <= IMAGE_MAX_DIM, `bounded: ${meta.width}x${meta.height}`);
  assert.equal(meta.format, 'webp', 'the copy is re-encoded, not the original');
  assert.ok(meta.width < 1600 && meta.height < 1200, 'the copy is actually downscaled');

  // The row records the copy, not the original location.
  const row = store.imageById(id);
  assert.equal(row.mime, 'image/webp');
  assert.equal(row.attempt_id, attemptId);
  store.close();
});

test('a throwing image store still solves the puzzle (keep_images never breaks a solve) (#100)', async (t) => {
  const store = memoryStore();
  const warnings = [];
  const logger = { warn: (m) => warnings.push(String(m)) };
  const bomb = {
    async save() {
      throw new Error('ENOSPC: no space left on device');
    },
  };

  const result = await solveImage(fakeWorker('Wat is acht min een?', 95), CORPUS, {
    store,
    subject: 'throwing-store',
    keepImages: true,
    imageStore: bomb,
    logger,
  });

  // The answer path is independent of the side feature: the solve and its validator
  // ran, and the throw was logged rather than surfaced.
  assert.equal(result.answer, '7', 'the puzzle was still solved');
  assert.equal(result.unresolved, false);
  assert.equal(
    warnings.some((line) => line.includes('keep_images') && line.includes('ENOSPC')),
    true,
    'the failure was logged loudly'
  );
  store.close();
});

test('the image is tied to the validate row even when log_images records too (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });

  // Unresolved, with `log_images` also on: the `image-ref` row is recorded after the
  // validate row, so a naive `lastAttemptId()` read would attach the image to the
  // wrong row and the recent-solves join would silently find nothing.
  const result = await solveImage(fakeWorker('', 0), CORPUS, {
    store,
    subject: 'both-flags',
    keepImages: true,
    logImages: true,
    imageStore,
  });
  assert.equal(result.answer, null);

  const attempts = store.attemptsFor('both-flags');
  const validate = attempts.find((r) => r.stage === 'validate');
  const imageRef = attempts.find((r) => r.stage === 'image-ref');
  assert.ok(validate && imageRef, 'the validate and image-ref rows both exist');
  const rows = store.imageRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempt_id, validate.id, 'the image points at the validate row');
  assert.notEqual(rows[0].attempt_id, imageRef.id);
  store.close();
});

test('an unwritable directory is logged and swallowed, never thrown (#100)', async (t) => {
  const base = tempDir(t);
  // A file stands where the images directory should be, so mkdir fails.
  const blocked = join(base, 'images');
  writeFileSync(blocked, 'not a directory');
  const store = memoryStore();
  const warnings = [];
  const imageStore = createImageStore({ store, dir: blocked, logger: { warn: (m) => warnings.push(String(m)) } });
  const attemptId = validateRow(store, 'blocked');

  const id = await imageStore.save({ subject: 'blocked', attemptId, imagePath: CORPUS });
  assert.equal(id, null, 'a failed save reports null, not an exception');
  assert.equal(warnings.length > 0, true, 'the failure is in the log');
  store.close();
});

test('the age policy prunes expired images, rows and files together (#100)', async (t) => {
  const dir = tempDir(t);
  let clock = 1_000_000;
  const store = openStore({ path: ':memory:', now: () => clock });
  t.after(() => store.close());
  const imageStore = createImageStore({ store, dir, now: () => clock, maxCount: 100 });

  // Two old solves, then two recent ones.
  clock = 1;
  const oldA = validateRow(store, 'old-a');
  const oldIdA = await imageStore.save({ subject: 'old-a', attemptId: oldA, imagePath: CORPUS });
  const oldB = validateRow(store, 'old-b');
  const oldIdB = await imageStore.save({ subject: 'old-b', attemptId: oldB, imagePath: CORPUS });
  const oldPaths = [imageStore.pathFor(oldIdA), imageStore.pathFor(oldIdB)];

  clock = 1_000_000;
  const newA = validateRow(store, 'new-a');
  await imageStore.save({ subject: 'new-a', attemptId: newA, imagePath: CORPUS });
  const newB = validateRow(store, 'new-b');
  await imageStore.save({ subject: 'new-b', attemptId: newB, imagePath: CORPUS });

  assert.equal(imageStore.count(), 4, 'four images before the prune');
  const result = imageStore.prune({ retainDays: 1, maxCount: 100 });
  assert.equal(result.removed, 2, 'the two expired images were removed');
  assert.equal(imageStore.count(), 2, 'the two recent images remain');
  for (const path of oldPaths) assert.equal(existsSync(path), false, 'the file is deleted with its row');
});

test('the count cap evicts the oldest and keeps the newest (#100)', async (t) => {
  const dir = tempDir(t);
  let clock = 1_000_000;
  const store = openStore({ path: ':memory:', now: () => clock });
  t.after(() => store.close());
  const imageStore = createImageStore({ store, dir, now: () => clock, maxCount: 3 });

  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    clock += 1;
    const attemptId = validateRow(store, `p${i}`);
    ids.push(await imageStore.save({ subject: `p${i}`, attemptId, imagePath: CORPUS }));
  }

  assert.equal(imageStore.count(), 3, 'the cap holds after five saves');
  assert.equal(imageStore.pathFor(ids[0]), null, 'the oldest row is evicted');
  assert.equal(imageStore.pathFor(ids[1]), null, 'the second oldest is evicted');
  assert.notEqual(imageStore.pathFor(ids[4]), null, 'the newest survives');
  assert.deepEqual(store.imageRows().map((r) => r.subject), ['p2', 'p3', 'p4']);
});

test('no orphans: a row whose attempt is gone, and a row whose file is gone, are reconciled (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir, maxCount: 100 });
  const attemptId = validateRow(store, 'orphan');
  const id = await imageStore.save({ subject: 'orphan', attemptId, imagePath: CORPUS });
  const missingAttempt = validateRow(store, 'missing-file');
  const missingId = await imageStore.save({ subject: 'missing-file', attemptId: missingAttempt, imagePath: CORPUS });

  // Both files exist, then the two failure modes are introduced: the attempt row for
  // one is deleted (retention), and the other's file vanishes. The next prune must
  // reconcile both.
  store.db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
  unlinkSync(imageStore.pathFor(missingId));

  const result = imageStore.prune({ retainDays: 3650, maxCount: 100 });
  assert.equal(result.orphans, 1, 'the ownerless row was removed');
  assert.equal(result.missing, 1, 'the row with no file was removed');
  assert.equal(imageStore.pathFor(id), null);
  assert.equal(imageStore.pathFor(missingId), null);
  assert.equal(imageStore.count(), 0);
  store.close();
});

test('purge removes every row and file and is idempotent (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir, maxCount: 100 });
  const a = await imageStore.save({ subject: 'a', attemptId: validateRow(store, 'a'), imagePath: CORPUS });
  const b = await imageStore.save({ subject: 'b', attemptId: validateRow(store, 'b'), imagePath: CORPUS });
  const paths = [imageStore.pathFor(a), imageStore.pathFor(b)];
  assert.equal(imageStore.count(), 2);

  const removed = imageStore.purge();
  assert.equal(removed, 2);
  assert.equal(imageStore.count(), 0, 'no rows after the purge');
  for (const path of paths) assert.equal(existsSync(path), false, 'no files after the purge');
  assert.equal(imageStore.purge(), 0, 'a second purge is a no-op');
  store.close();
});

test('addressing is by row id, never a client path (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });
  const id = await imageStore.save({ subject: 'p', attemptId: validateRow(store, 'p'), imagePath: CORPUS });

  assert.equal(imageStore.pathFor(id), imageStore.pathFor(String(id)), 'a numeric id resolves');
  assert.equal(imageStore.pathFor('../../etc/passwd'), null, 'a traversal-shaped value does not resolve');
  assert.equal(imageStore.pathFor('../secret.webp'), null);
  assert.equal(imageStore.pathFor(999_999), null, 'an unknown id does not resolve');
  store.close();
});

test('an image with no owning attempt is never written', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });
  const id = await imageStore.save({ subject: 'p', attemptId: null, imagePath: CORPUS });
  assert.equal(id, null, 'no owner means no orphan');
  assert.equal(imageStore.count(), 0);
  store.close();
});

test('the images purge command removes every row and file (#100)', async (t) => {
  const base = tempDir(t);
  const statePath = join(base, 'state.db');
  const dir = join(base, 'images');

  const store = openStore({ path: statePath });
  const imageStore = createImageStore({ store, dir });
  await imageStore.save({ subject: 'p', attemptId: validateRow(store, 'p'), imagePath: CORPUS });
  const storedPath = imageStore.pathFor(store.imageRows()[0].id);
  assert.equal(imageStore.count(), 1);
  store.close();

  let out = '';
  const code = await runImages(['purge'], {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: () => {} },
    imagesDir: dir,
    statePath,
  });
  assert.equal(code, 0);
  assert.match(out, /purged 1 stored image/);

  const reopened = openStore({ path: statePath });
  assert.equal(reopened.countImages(), 0, 'the rows are gone');
  reopened.close();
  assert.equal(existsSync(storedPath), false, 'the file is gone');
});

test('a row whose path escapes the images directory is refused (#100)', async (t) => {
  const base = tempDir(t);
  const dir = join(base, 'images');
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });
  const attemptId = validateRow(store, 'outside');
  const secret = join(base, 'secret.txt');
  writeFileSync(secret, 'top secret document');

  // A row whose recorded path is outside the configured root must never resolve, even
  // though the id is a real row id. This is the `insideRoot` guard, independent of the
  // route's numeric-id regex.
  const id = store.insertImageRecord({ subject: 'outside', attemptId, path: secret });
  assert.equal(imageStore.pathFor(id), null, 'a path outside the root is not served');
  assert.equal(imageStore.exists(id), false);
  store.close();
});

test('the review-copy settings default to off and are validated (#100)', () => {
  assert.equal(DEFAULTS.storage.keep_images, false, 'retaining user content is opt-in');
  assert.equal(DEFAULTS.storage.max_images, 200);

  const on = validateConfig({ storage: { keep_images: true, max_images: 5 } }).config;
  assert.equal(on.storage.keep_images, true);
  assert.equal(on.storage.max_images, 5);

  assert.throws(() => validateConfig({ storage: { keep_images: 'yes' } }), /storage\.keep_images must be true or false/);
  assert.throws(() => validateConfig({ storage: { max_images: 0 } }), /storage\.max_images must be >= 1/);
  assert.throws(() => validateConfig({ storage: { max_images: 1.5 } }), /storage\.max_images must be an integer/);
});

test('the solve core hands the image store and the live opt-in to the pipeline (#100)', async (t) => {
  const dir = tempDir(t);
  const store = memoryStore();
  const imageStore = createImageStore({ store, dir });
  const config = validateConfig({ storage: { keep_images: true, max_images: 10 } }).config;
  let seen = null;
  const core = createSolveCore({
    worker: null,
    store,
    config,
    imageStore,
    solveImage: async (worker, path, options) => {
      seen = options;
      return { answer: '7', unresolved: false };
    },
  });

  await core.solve(CORPUS, { subject: 'wired' });
  assert.equal(seen.keepImages, true, 'the config opt-in reaches the pipeline');
  assert.equal(seen.imageStore, imageStore, 'the app-built image store reaches the pipeline');
  assert.equal(seen.logImages, false, 'the two image settings stay distinct');
  store.close();
});
