/**
 * Pushbullet path tests, all against the local double in `fake-pushbullet.js`.
 *
 * Nothing here needs a Pushbullet token, a provider key or a network. The one test
 * that runs the real OCR pipeline uses the same corpus image as `corpus.test.js`,
 * so the vertical slice is covered end to end: tickle -> fetch -> download ->
 * validate -> note push.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

import { startFakePushbullet } from './fake-pushbullet.js';
import { createOcrWorker } from '../src/ocr/recognize.js';
import { solveImage } from '../src/solver/pipeline.js';
import { buildVariants } from '../src/imaging/preprocess.js';
import { memoryStore, openStore } from '../src/state/db.js';
import {
  createPushbulletClient,
  DEFAULT_BASE_URL,
  DEFAULT_STREAM_BASE_URL,
  PushbulletError,
  redactPushbullet,
} from '../src/pushbullet/client.js';
import { createListener, WATERMARK_KEY, HISTORY_MODES } from '../src/pushbullet/listener.js';
import { classifyPush, isCandidatePush } from '../src/pushbullet/filter.js';
import {
  downloadImage,
  fetchImage,
  pruneInbox,
  sniffImage,
  ImageFetchError,
} from '../src/pushbullet/files.js';
import {
  createResponder,
  answerHash,
  DEFAULT_TITLE,
  DEFAULT_UNRESOLVED_TITLE,
  DEFAULT_UNRESOLVED_TEXT,
  UNRESOLVED_MARKER,
} from '../src/pushbullet/respond.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusImage = join(here, '..', 'corpus', '001-count-kleuren.png');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, { timeoutMs = 5_000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await realSleep(intervalMs);
  }
}

function makePng({ width = 200, height = 44 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

/** A stand-in for the solver: the responder only reads `answer` and `confident`. */
function scriptedSolve(result = { answer: '2', confident: true }) {
  return async () => ({ ...result, solved: true, method: 'tier0:count', unresolved: result.answer == null });
}

/**
 * Wire the real listener, filter, fetcher and responder to a fake server. Tests
 * override only the solver and the responder knobs.
 */
async function makeHarness(t, options = {}) {
  const fake = await startFakePushbullet();
  const inboxDir = mkdtempSync(join(tmpdir(), 'puzzlesolver-inbox-'));
  const ownsStore = !options.store;
  const store = options.store ?? memoryStore();
  const client = createPushbulletClient({
    token: fake.token,
    baseUrl: fake.baseUrl,
    sleep: fake.clock.sleep,
    maxRetries: options.maxRetries ?? 2,
    backoffBaseMs: options.backoffBaseMs ?? 10,
  });
  const responder = createResponder({
    client,
    store,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    requireConfidence: options.requireConfidence ?? true,
    strategy: options.strategy,
    strategies: options.strategies,
    title: options.title ?? 'Antwoord',
    prefix: options.prefix ?? '',
    bold: options.bold ?? false,
    unresolvedTitle: options.unresolvedTitle,
    unresolvedText: options.unresolvedText,
    minIntervalMs: options.minIntervalMs ?? 3_000,
  });

  const solve = options.solve ?? scriptedSolve();
  const outcome = { replies: [] };
  const listener = createListener({
    client,
    store,
    historyMode: options.historyMode ?? 'ignore',
    pollIntervalMs: options.pollIntervalMs ?? 0,
    reconnectBaseMs: options.reconnectBaseMs ?? 10,
    reconnectMaxMs: options.reconnectMaxMs ?? 50,
    logger: options.logger ?? null,
    onPush: async (push) => {
      const image = await fetchImage(push, { inboxDir });
      store.setPushStatus(push.iden, 'downloaded');
      const result = await solve(image.path, push);
      const response = await responder.respond(push, result);
      store.setPushStatus(push.iden, response.sent ? 'solved' : 'unresolved');
      outcome.replies.push({ push, image, result, response });
    },
  });

  t.after(async () => {
    listener.stop();
    await fake.close();
    if (ownsStore) store.close();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  return { fake, store, client, responder, listener, outcome, inboxDir };
}

// ---------------------------------------------------------------------------
// The vertical slice
// ---------------------------------------------------------------------------

test('tickle -> fetch -> download -> solve -> note push, with the real solver', async (t) => {
  const worker = await createOcrWorker();
  t.after(() => worker.terminate());

  const harness = await makeHarness(t, {
    solve: (imagePath, push) => solveImage(worker, imagePath, { subject: push.iden }),
  });
  const { fake, listener, store, outcome } = harness;
  const bytes = readFileSync(corpusImage);

  await listener.start();
  await waitFor(() => listener.connected, { label: 'stream connection' });
  const push = fake.pushImage({
    iden: 'slice-1',
    fileName: '001-count-kleuren.png',
    data: bytes,
    sourceDeviceIden: 'dev-phone',
  });
  fake.tickle();

  await waitFor(() => outcome.replies.length === 1, { label: 'one solved push' });
  assert.equal(fake.notePushes.length, 1);

  // The solver really ran over the pushed bytes and produced the corpus answer.
  assert.equal(outcome.replies[0].result.answer, '2');
  assert.equal(outcome.replies[0].result.confident, true);

  const note = fake.notePushes[0];
  assert.equal(note.type, 'note');
  assert.equal(note.title, 'Antwoord');
  assert.equal(note.body, '2');
  assert.equal(note.device_iden, 'dev-phone');
  assert.equal(note.direction, 'outgoing');

  // The download used the pre-signed URL and did not send the Pushbullet token to it.
  const download = fake.requests.find((request) => request.path === `/files/${push.iden}`);
  assert.ok(download, 'the image was fetched from the file_url');
  assert.equal(download.headers['access-token'], undefined, 'no token to a pre-signed URL');

  assert.equal(store.getPush(push.iden).status, 'solved');

  // Our own kind of reply (a note push, as created above) must not be answered.
  const ownNote = fake.pushRaw({ type: 'note', title: 'Antwoord', body: '2', direction: 'outgoing' });
  await listener.poll();
  assert.equal(outcome.replies.length, 1, 'a note push must not be treated as a puzzle');
  assert.equal(store.getPush(ownNote.iden).status, 'ignored');
});

test('a duplicate tickle produces exactly one reply', async (t) => {
  const { fake, listener, outcome } = await makeHarness(t);

  await listener.start();
  await waitFor(() => listener.connected, { label: 'stream connection' });
  fake.pushImage({ data: await makePng() });
  fake.tickle();
  fake.tickle();
  fake.tickle();

  await waitFor(() => fake.notePushes.length === 1, { label: 'one reply' });
  await waitFor(() => outcome.replies.length === 1, { label: 'the handler to finish' });
  await realSleep(150);
  assert.equal(fake.notePushes.length, 1, 'three tickles must still be one reply');
  assert.equal(outcome.replies.length, 1);
});

test('the same push delivered inline twice is processed once', async (t) => {
  const { fake, listener } = await makeHarness(t);

  await listener.start();
  await waitFor(() => listener.connected, { label: 'stream connection' });
  const push = fake.pushImage({ data: await makePng() });
  // No watermark involvement at all: the dedupe table has to catch this one.
  fake.sendRaw({ type: 'push', push });
  fake.sendRaw({ type: 'push', push });

  await waitFor(() => fake.notePushes.length === 1, { label: 'one reply' });
  await realSleep(150);
  assert.equal(fake.notePushes.length, 1);
});

test('the pushes-table dedupe survives a restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-state-'));
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'state.db');
  const push = fake.pushImage({ data: await makePng() });

  const first = openStore({ path: statePath });
  const firstSeen = [];
  const firstListener = createListener({
    client: createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl }),
    store: first,
    pollIntervalMs: 0,
    onPush: async (handled) => {
      firstSeen.push(handled.iden);
    },
  });
  t.after(() => firstListener.stop());
  assert.equal((await firstListener.handlePush(push)).reason, 'processed');
  firstListener.stop();
  first.close();

  // A new process over the same database: only the pushes table remembers.
  const second = openStore({ path: statePath });
  const secondSeen = [];
  const secondListener = createListener({
    client: createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl }),
    store: second,
    pollIntervalMs: 0,
    onPush: async (handled) => {
      secondSeen.push(handled.iden);
    },
  });
  t.after(() => secondListener.stop());
  const replayed = await secondListener.handlePush(push);
  assert.equal(replayed.reason, 'duplicate', 'the claim has to be durable, not in memory');
  assert.deepEqual(secondSeen, []);
  secondListener.stop();
  second.close();

  assert.deepEqual(firstSeen, [push.iden]);
});

test('a handler failure is recorded and the listener keeps watching', async (t) => {
  let attempts = 0;
  const { fake, listener, store } = await makeHarness(t, {
    solve: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the solver exploded');
      return { answer: '2', confident: true };
    },
  });

  await listener.start();
  const bad = fake.pushImage({ data: await makePng() });
  const good = fake.pushImage({ data: await makePng() });
  await listener.poll();

  assert.equal(store.getPush(bad.iden).status, 'error');
  assert.equal(store.getPush(good.iden).status, 'solved', 'the next push is still handled');
  assert.equal(fake.notePushes.length, 1);
});

// ---------------------------------------------------------------------------
// Idempotency across a restart
// ---------------------------------------------------------------------------

test('a crash between the outbox claim and the send does not send after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-state-'));
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const push = fake.pushImage({ data: await makePng() });
  const crashBeforeSend = {
    name: 'crash-before-send',
    async deliver() {
      throw new Error('crash before the note push');
    },
  };

  const first = openStore({ path: join(dir, 'state.db') });
  const firstClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  const firstResponder = createResponder({
    client: firstClient,
    store: first,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    strategy: 'crash-before-send',
    strategies: { 'crash-before-send': crashBeforeSend },
    minIntervalMs: 0,
  });
  const firstOutcome = await firstResponder.respond(push, { answer: '2', confident: true });
  assert.equal(firstOutcome.sent, false);
  assert.equal(fake.notePushes.length, 0);
  assert.ok(
    first.getOutbox(push.iden, answerHash('2')),
    'the claim has to exist before the send is attempted'
  );
  first.close();

  // "Restart": a fresh store over the same file, a fresh client and responder.
  const second = openStore({ path: join(dir, 'state.db') });
  const secondClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  const secondResponder = createResponder({
    client: secondClient,
    store: second,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    minIntervalMs: 0,
  });
  const secondOutcome = await secondResponder.respond(push, { answer: '2', confident: true });
  assert.equal(secondOutcome.sent, false);
  assert.equal(secondOutcome.reason, 'duplicate');
  assert.equal(fake.notePushes.length, 0, 'a claimed-but-unsent answer is never sent later');
  assert.equal(secondClient.calls.length, 0, 'the duplicate check happens before any network call');
  second.close();
});

test('a crash after the send does not send a second note after restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-state-'));
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const push = fake.pushImage({ data: await makePng() });
  // Delivers successfully, then dies before the responder can record `sent_at`.
  const crashAfterSend = {
    name: 'crash-after-send',
    async deliver({ client, title, body, deviceIden }) {
      await client.createNote({ title, body, deviceIden });
      throw new Error('crash after the note push');
    },
  };

  const first = openStore({ path: join(dir, 'state.db') });
  const firstClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  const firstResponder = createResponder({
    client: firstClient,
    store: first,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    strategy: 'crash-after-send',
    strategies: { 'crash-after-send': crashAfterSend },
    minIntervalMs: 0,
  });
  const firstOutcome = await firstResponder.respond(push, { answer: '2', confident: true });
  assert.equal(firstOutcome.sent, false);
  assert.equal(firstOutcome.reason, 'error');
  assert.equal(fake.notePushes.length, 1, 'the note did reach Pushbullet');
  assert.equal(first.getOutbox(push.iden, answerHash('2')).sent_at, null, 'but was never marked sent');
  first.close();

  const second = openStore({ path: join(dir, 'state.db') });
  const secondClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  const secondResponder = createResponder({
    client: secondClient,
    store: second,
    now: fake.clock.now,
    sleep: fake.clock.sleep,
    minIntervalMs: 0,
  });
  const secondOutcome = await secondResponder.respond(push, { answer: '2', confident: true });
  assert.equal(secondOutcome.sent, false);
  assert.equal(secondOutcome.reason, 'duplicate');
  assert.equal(fake.notePushes.length, 1, 'a restart mid-delivery must not duplicate the reply');
  assert.equal(secondClient.calls.length, 0);
  second.close();
});

// ---------------------------------------------------------------------------
// Watermark and history mode
// ---------------------------------------------------------------------------

test('the watermark advances, survives a restart and blocks a replayed push', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-state-'));
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const statePath = join(dir, 'state.db');
  const first = openStore({ path: statePath });
  const firstClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl, sleep: fake.clock.sleep });
  const seen = [];
  const firstListener = createListener({
    client: firstClient,
    store: first,
    historyMode: 'watermark',
    pollIntervalMs: 0,
    onPush: async (push) => {
      seen.push(push.iden);
    },
  });
  // Registered up front so a failed assertion still stops the reconnect timer.
  t.after(() => firstListener.stop());

  const push = fake.pushImage({ data: await makePng() });
  await firstListener.start();
  await firstListener.poll();
  assert.deepEqual(seen, [push.iden]);

  const watermark = Number(first.get(WATERMARK_KEY));
  assert.ok(Number.isFinite(watermark), 'the watermark is persisted');
  assert.ok(watermark >= push.modified, `watermark ${watermark} must cover ${push.modified}`);

  const replayed = await firstListener.handlePush(push);
  assert.equal(replayed.reason, 'duplicate', 'a re-delivered push is not processed twice');
  assert.deepEqual(seen, [push.iden]);

  firstListener.stop();
  first.close();

  // A fresh process over the same database starts from the stored watermark.
  const second = openStore({ path: statePath });
  assert.equal(Number(second.get(WATERMARK_KEY)), watermark, 'the watermark survives a restart');
  const secondClient = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl, sleep: fake.clock.sleep });
  const secondSeen = [];
  const secondListener = createListener({
    client: secondClient,
    store: second,
    historyMode: 'watermark',
    pollIntervalMs: 0,
    onPush: async (push) => {
      secondSeen.push(push.iden);
    },
  });
  t.after(() => secondListener.stop());
  await secondListener.start();
  await secondListener.poll();
  assert.deepEqual(secondSeen, [], 'nothing before the watermark is replayed');
  assert.equal(secondListener.status().watermark, watermark);

  secondListener.stop();
  second.close();
});

test('lastActivityAt advances on a successful poll - the M3 watchdog signal', async (t) => {
  const fake = await startFakePushbullet();
  t.after(() => fake.close());

  let clock = 1_000;
  const client = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl, sleep: fake.clock.sleep });
  // Deliberately *no* `start()`: connecting would open a socket whose `open` event
  // also stamps lastActivityAt, and the test would then pass even if the poll never
  // did. Only `poll()` may touch it here.
  const listener = createListener({
    client,
    historyMode: 'ignore',
    pollIntervalMs: 0,
    now: () => clock,
  });
  t.after(() => listener.stop());

  assert.equal(listener.status().lastActivityAt, null, 'nothing has happened yet');
  clock = 2_000;
  await listener.poll();
  assert.equal(listener.status().lastActivityAt, 2_000, 'the watchdog must see the successful poll');
});

test('history_mode "ignore" does not answer a pre-existing backlog but catches new pushes', async (t) => {
  const { fake, listener, store, outcome } = await makeHarness(t, { historyMode: 'ignore' });
  const old = fake.pushImage({ data: await makePng() });

  await listener.start();
  await listener.poll();
  assert.equal(fake.notePushes.length, 0, 'a pre-existing push must not be answered on first run');
  assert.equal(store.getPush(old.iden), null, 'the backlog is skipped, not claimed for processing');
  assert.ok(Number(store.get(WATERMARK_KEY)) >= old.modified, 'the backlog is behind the watermark');

  const fresh = fake.pushImage({ data: await makePng() });
  fake.tickle();
  await waitFor(() => outcome.replies.length === 1, { label: 'the new push to be answered' });
  assert.equal(fake.notePushes.length, 1);
  assert.equal(store.getPush(fresh.iden).status, 'solved');
  assert.equal(store.getPush(old.iden), null);
});

test('history_mode "watermark" answers the backlog after the stored watermark', async (t) => {
  const { fake, listener, store } = await makeHarness(t, { historyMode: 'watermark' });
  const old = fake.pushImage({ data: await makePng() });

  await listener.start();
  await listener.poll();
  assert.equal(fake.notePushes.length, 1, 'watermark mode is what answers history');
  assert.equal(store.getPush(old.iden).status, 'solved');
});

test('a failed bootstrap retries instead of turning the backlog into fresh pushes', async (t) => {
  const fake = await startFakePushbullet();
  const store = memoryStore();
  t.after(async () => {
    await fake.close();
    store.close();
  });

  const old = fake.pushImage({ data: await makePng() });
  // Fail the bootstrap GET exactly once. If the first poll fell back to watermark
  // 0 after that, the pre-existing push would be answered - which is the bug this
  // guards: coming online after a blip must not fire off a backlog.
  fake.failNext({ status: 500, times: 1, method: 'GET', path: '/v2/pushes' });
  const client = createPushbulletClient({
    token: fake.token,
    baseUrl: fake.baseUrl,
    maxRetries: 0,
    sleep: fake.clock.sleep,
  });
  const seen = [];
  const listener = createListener({
    client,
    store,
    historyMode: 'ignore',
    pollIntervalMs: 0,
    onPush: async (push) => {
      seen.push(push.iden);
    },
  });
  // Registered before start() so a failed assertion cannot leave a reconnect
  // timer holding the test process open.
  t.after(() => listener.stop());

  await listener.start();
  await listener.poll();

  assert.deepEqual(seen, [], 'the backlog must not be answered after a failed bootstrap');
  assert.equal(store.getPush(old.iden), null);
  assert.ok(Number(store.get(WATERMARK_KEY)) >= old.modified, 'the retried bootstrap still advances');
});

test('an unknown history_mode is rejected instead of guessed at', () => {
  assert.deepEqual(HISTORY_MODES, ['ignore', 'watermark']);
  assert.throws(
    () => createListener({ client: { getPushes: async () => [] }, historyMode: 'replay' }),
    /history_mode/
  );
});

// ---------------------------------------------------------------------------
// Reconnect and rate limiting
// ---------------------------------------------------------------------------

test('a dropped stream reconnects and resumes without losing or repeating a push', async (t) => {
  const { fake, listener, store, outcome } = await makeHarness(t, {
    // Long poll so only the reconnected stream can deliver the second push.
    pollIntervalMs: 60_000,
  });

  await listener.start();
  await waitFor(() => listener.connected, { label: 'stream connection' });

  const push = fake.pushImage({ data: await makePng() });
  fake.tickle();
  await waitFor(() => fake.notePushes.length === 1, { label: 'first reply' });

  assert.equal(fake.dropStream(), 1, 'the fake had one live stream to drop');
  await waitFor(() => listener.connected && listener.status().reconnects >= 1, { label: 'reconnect' });

  const second = fake.pushImage({ data: await makePng() });
  fake.tickle();
  await waitFor(() => fake.notePushes.length === 2, { label: 'second reply' });
  await waitFor(() => outcome.replies.length === 2, { label: 'the handler to finish' });
  await realSleep(150);

  assert.equal(fake.notePushes.length, 2, 'the drop lost nothing and repeated nothing');
  assert.equal(outcome.replies.length, 2);
  assert.equal(store.getPush(push.iden).status, 'solved');
  assert.equal(store.getPush(second.iden).status, 'solved');
});

test('a 429 is backed off, retried, and produces exactly one note push', async (t) => {
  const { fake, listener, store } = await makeHarness(t, { backoffBaseMs: 500 });

  await listener.start();
  const push = fake.pushImage({ data: await makePng() });
  fake.failNext({ status: 429, times: 1 });

  const before = fake.clock.now();
  await listener.poll();

  assert.equal(fake.notePushes.length, 1, 'the retry succeeded');
  assert.ok(
    fake.clock.now() - before >= 0.25,
    'the client waited out a backoff instead of hammering the endpoint'
  );
  const posts = fake.requests.filter(
    (request) => request.method === 'POST' && request.path === '/v2/pushes'
  );
  assert.equal(posts.length, 2, 'one rejected attempt plus one successful retry');
  assert.equal(store.outboxFor(push.iden).length, 1, 'one claim, one send');
});

test('a 429 that outlasts the retries never double-sends later', async (t) => {
  const { fake, listener, responder } = await makeHarness(t, { maxRetries: 1, backoffBaseMs: 10 });

  await listener.start();
  const push = fake.pushImage({ data: await makePng() });
  fake.failNext({ status: 429, times: 3 });

  await listener.poll();

  const first = fake.notePushes.length;
  assert.equal(first, 0, 'all attempts were rate-limited');

  // Same answer for the same push: the claim taken before the failed send stands.
  const second = await responder.respond(push, { answer: '2', confident: true });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(fake.notePushes.length, 0, 'a failed delivery must not be retried behind the claim');
});

test('outgoing pushes respect the minimum interval between sends', async (t) => {
  const { fake, listener, store } = await makeHarness(t, { minIntervalMs: 3_000 });

  await listener.start();
  fake.pushImage({ data: await makePng() });
  fake.pushImage({ data: await makePng() });
  await listener.poll();

  assert.equal(fake.notePushes.length, 2);
  const [first, second] = fake.notePushes.map((note) => note.created);
  assert.ok(second - first >= 3, `expected a >= 3s gap between sends, got ${second - first}s`);
  assert.equal(store.countSentSince(0), 2);
});

// ---------------------------------------------------------------------------
// The confidence gate
// ---------------------------------------------------------------------------

test('require_confidence suppresses an unconfirmed answer and allows it when false', async (t) => {
  const strict = await makeHarness(t, { solve: scriptedSolve({ answer: '2', confident: false }) });
  await strict.listener.start();
  const unconfirmed = strict.fake.pushImage({ data: await makePng() });
  await strict.listener.poll();

  assert.equal(strict.fake.notePushes.length, 0, 'an uncorroborated answer must not be sent');
  assert.equal(strict.outcome.replies[0].response.reason, 'unconfirmed');
  assert.equal(
    strict.store.getOutbox(unconfirmed.iden, answerHash('2')),
    null,
    'nothing is even claimed for a suppressed answer'
  );

  const loose = await makeHarness(t, {
    solve: scriptedSolve({ answer: '2', confident: false }),
    requireConfidence: false,
  });
  await loose.listener.start();
  loose.fake.pushImage({ data: await makePng() });
  await loose.listener.poll();

  assert.equal(loose.fake.notePushes.length, 1, 'require_confidence: false trades accuracy for coverage');
  assert.equal(loose.fake.notePushes[0].body, '2');
});

test('an unresolved puzzle gets the acknowledgement, even with require_confidence false', async (t) => {
  const { fake, listener, outcome } = await makeHarness(t, {
    solve: scriptedSolve({ answer: null, confident: true }),
    requireConfidence: false,
  });

  await listener.start();
  fake.pushImage({ data: await makePng() });
  await listener.poll();

  assert.equal(fake.notePushes.length, 1, 'an unresolved puzzle is acknowledged, not ignored');
  assert.equal(fake.notePushes[0].title, DEFAULT_UNRESOLVED_TITLE);
  assert.equal(fake.notePushes[0].body, DEFAULT_UNRESOLVED_TEXT);
  assert.equal(outcome.replies[0].response.sent, true);
  assert.equal(outcome.replies[0].response.unresolved, true);
});

// ---------------------------------------------------------------------------
// The unresolved acknowledgement (issue #29)
// ---------------------------------------------------------------------------

test('the unresolved acknowledgement uses the default title and text when unset', async (t) => {
  const { fake, responder } = await makeHarness(t);
  const push = fake.pushImage({ data: await makePng() });

  const outcome = await responder.respond(push, { answer: null, confident: true });

  assert.equal(outcome.sent, true);
  assert.equal(outcome.unresolved, true);
  assert.equal(fake.notePushes[0].title, DEFAULT_UNRESOLVED_TITLE);
  assert.equal(fake.notePushes[0].body, DEFAULT_UNRESOLVED_TEXT);
  // It cannot be mistaken for a solution: a distinct title and a sentence body, not a
  // bare number or word.
  assert.notEqual(DEFAULT_UNRESOLVED_TITLE, DEFAULT_TITLE);
  assert.ok(DEFAULT_UNRESOLVED_TEXT.trim().length > 10);
  assert.doesNotMatch(DEFAULT_UNRESOLVED_TEXT.trim(), /^\d+$/);
});

test('a custom unresolved title and text replace the default', async (t) => {
  const { fake, responder } = await makeHarness(t, {
    unresolvedTitle: 'Geen antwoord',
    unresolvedText: 'Deze puzzel kon ik niet lezen.',
  });
  const push = fake.pushImage({ data: await makePng() });

  await responder.respond(push, { answer: null, confident: true });

  assert.equal(fake.notePushes[0].title, 'Geen antwoord');
  assert.equal(fake.notePushes[0].body, 'Deze puzzel kon ik niet lezen.');
});

test('a solved puzzle sends the answer and never the acknowledgement', async (t) => {
  const { fake, responder, store } = await makeHarness(t);
  const push = fake.pushImage({ data: await makePng() });

  const outcome = await responder.respond(push, { answer: '2', confident: true });

  assert.equal(outcome.sent, true);
  assert.equal(outcome.unresolved, false);
  assert.equal(fake.notePushes.length, 1);
  assert.equal(fake.notePushes[0].body, '2');
  assert.equal(fake.notePushes[0].title, DEFAULT_TITLE);
  assert.equal(store.getOutbox(push.iden, UNRESOLVED_MARKER), null, 'a solved puzzle never claims the marker');
});

test('a duplicate tickle does not send a second acknowledgement', async (t) => {
  const { fake, responder } = await makeHarness(t);
  const push = fake.pushImage({ data: await makePng() });

  const first = await responder.respond(push, { answer: null, confident: true });
  assert.equal(first.sent, true);

  const second = await responder.respond(push, { answer: null, confident: true });
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'duplicate');
  assert.equal(fake.notePushes.length, 1, 'one acknowledgement per push, not one per tickle');
});

test('a restart does not send the acknowledgement twice', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-state-'));
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const push = fake.pushImage({ data: await makePng() });
  const statePath = join(dir, 'state.db');

  const firstStore = openStore({ path: statePath });
  const first = createResponder({
    client: createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl }),
    store: firstStore,
    now: fake.clock.now,
    minIntervalMs: 0,
  });
  const firstOutcome = await first.respond(push, { answer: null, confident: true });
  assert.equal(firstOutcome.sent, true);
  firstStore.close();

  const secondStore = openStore({ path: statePath });
  const second = createResponder({
    client: createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl }),
    store: secondStore,
    now: fake.clock.now,
    minIntervalMs: 0,
  });
  const secondOutcome = await second.respond(push, { answer: null, confident: true });
  assert.equal(secondOutcome.sent, false);
  assert.equal(secondOutcome.reason, 'duplicate');
  assert.equal(fake.notePushes.length, 1, 'the marker survives a restart and still dedupes');
  secondStore.close();
});

test('the unresolved marker never collides with a real answer row', async (t) => {
  const { fake, responder, store } = await makeHarness(t);
  const push = fake.pushImage({ data: await makePng() });

  const ack = await responder.respond(push, { answer: null, confident: true });
  assert.equal(ack.sent, true);
  assert.ok(store.getOutbox(push.iden, UNRESOLVED_MARKER), 'the acknowledgement is claimed under the marker');
  assert.notEqual(UNRESOLVED_MARKER, answerHash('2'));

  // The same push later yields a real answer: a distinct key, so it still sends.
  const answer = await responder.respond(push, { answer: '2', confident: true });
  assert.equal(answer.sent, true);
  assert.ok(store.getOutbox(push.iden, answerHash('2')), 'the answer has its own outbox row');
  assert.equal(fake.notePushes.length, 2, 'the answer is delivered after the acknowledgement');
});

test('an uncorroborated answer stays silent and is not acknowledged as unresolved', async (t) => {
  const { fake, responder, store } = await makeHarness(t, { requireConfidence: true });
  const push = fake.pushImage({ data: await makePng() });

  const outcome = await responder.respond(push, { answer: '2', confident: false });

  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'unconfirmed');
  assert.equal(fake.notePushes.length, 0, 'an unconfirmed answer is withheld, and so is the acknowledgement');
  assert.equal(store.getOutbox(push.iden, UNRESOLVED_MARKER), null, 'nothing is claimed for a withheld answer');
});

test('an empty unresolved text falls back to silence rather than an empty note', async (t) => {
  const { fake, responder } = await makeHarness(t, { unresolvedText: '' });
  const push = fake.pushImage({ data: await makePng() });

  const outcome = await responder.respond(push, { answer: null, confident: true });

  assert.equal(outcome.sent, false);
  assert.equal(outcome.reason, 'unresolved');
  assert.equal(fake.notePushes.length, 0);
});

// ---------------------------------------------------------------------------
// Filter, fetcher, client and responder units
// ---------------------------------------------------------------------------

test('the filter accepts image file pushes and rejects everything else', () => {
  const base = {
    iden: 'p1',
    type: 'file',
    file_type: 'image/png',
    file_name: 'puzzle.png',
    sender_iden: 'sender-user',
    direction: 'incoming',
  };
  assert.equal(isCandidatePush(base), true);
  assert.equal(classifyPush({ ...base, file_type: null, file_name: 'PUZZLE.JPG' }).kind, 'extension');
  assert.equal(classifyPush({ ...base, type: 'note' }).reason, 'type=note');
  assert.equal(
    classifyPush({ ...base, file_type: 'application/pdf', file_name: 'puzzle.pdf' }).accepted,
    false
  );
  assert.equal(classifyPush({ ...base, direction: 'outgoing' }).reason, 'own-push');
  assert.equal(classifyPush({ ...base, active: false }).reason, 'inactive');
  assert.equal(classifyPush({ ...base, iden: undefined }).reason, 'no-iden');
  assert.equal(classifyPush(null).reason, 'not-a-push');
  assert.equal(isCandidatePush(base, { allowedSenders: ['someone-else'] }), false);
  assert.equal(isCandidatePush(base, { allowedSenders: ['sender-user'] }), true);
  assert.equal(isCandidatePush({ ...base, channel_iden: 'chan-1' }, { allowedChannels: ['chan-2'] }), false);
  assert.equal(isCandidatePush({ ...base, channel_iden: 'chan-1' }, { allowedChannels: ['chan-1'] }), true);
});

test('magic bytes decide the image type, not the file_type field', () => {
  assert.equal(sniffImage(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(4)])).ext, '.png');
  assert.equal(sniffImage(Buffer.from('GIF89a......')).ext, '.gif');
  assert.equal(sniffImage(Buffer.from('RIFF____WEBPVP8 ')).ext, '.webp');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])).ext, '.jpg');
  assert.equal(sniffImage(Buffer.from('BM______')).ext, '.bmp');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('II'), Buffer.from([0x2a, 0x00])])).ext, '.tif');
  assert.equal(sniffImage(Buffer.from('this is not an image')), null);
  assert.equal(sniffImage(null), null);
});

test('the fetcher rejects bad magic, undecodable bytes, oversize and implausible heights', async (t) => {
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });

  const badMagic = fake.pushImage({ data: Buffer.from('this is not an image'), fileType: 'image/png' });
  await assert.rejects(
    () => downloadImage(badMagic.file_url),
    (err) => err instanceof ImageFetchError && err.reason === 'magic'
  );

  const badDecode = fake.pushImage({
    data: Buffer.concat([PNG_SIGNATURE, Buffer.from('garbage')]),
    fileType: 'image/png',
  });
  await assert.rejects(
    () => downloadImage(badDecode.file_url),
    (err) => err instanceof ImageFetchError && err.reason === 'decode'
  );

  const valid = fake.pushImage({ data: await makePng(), fileType: 'image/png' });
  await assert.rejects(
    () => downloadImage(valid.file_url, { maxBytes: 8 }),
    (err) => err instanceof ImageFetchError && err.reason === 'size'
  );

  const tooShort = fake.pushImage({
    data: await makePng({ width: 200, height: 4 }),
    fileType: 'image/png',
  });
  await assert.rejects(
    () => downloadImage(tooShort.file_url),
    (err) => err instanceof ImageFetchError && err.reason === 'height'
  );

  const image = await downloadImage(valid.file_url);
  assert.equal(image.ext, '.png');
  assert.equal(image.width, 200);
  assert.equal(image.height, 44);
  assert.equal(image.bytes, (await makePng()).length);
});

test('the fetcher rejects a small file with an absurd pixel count or width', async (t) => {
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });

  // 2000x2000 = 4,000,000 pixels in ~16 KB: inside the byte cap, over the default
  // 1,000,000 pixel cap. Before issue #41 it was accepted and handed to
  // `buildVariants`, where it cost tens of seconds and hundreds of MB.
  const bomb = fake.pushImage({ data: await makePng({ width: 2000, height: 2000 }), fileType: 'image/png' });
  const started = performance.now();
  await assert.rejects(
    () => downloadImage(bomb.file_url),
    (err) => err instanceof ImageFetchError && err.reason === 'pixels'
  );
  assert.ok(performance.now() - started < 2000, 'rejection must not decode the pixels');

  // 3000px wide and 100px tall: 300,000 pixels is under the pixel cap, so only the
  // width cap can stop it.
  const wide = fake.pushImage({ data: await makePng({ width: 3000, height: 100 }), fileType: 'image/png' });
  await assert.rejects(
    () => downloadImage(wide.file_url),
    (err) => err instanceof ImageFetchError && err.reason === 'width'
  );
});

test('the preprocessing layer refuses a pixel bomb that skipped the gate', async () => {
  // Second layer: `limitInputPixels` is threaded from `image.max_pixels`. This is the
  // same 4 Mpx file the gate rejects, handed straight to `buildVariants` as if an
  // ingress had forgotten to validate it.
  const bomb = await makePng({ width: 2000, height: 2000 });
  await assert.rejects(
    () => buildVariants(bomb, ['adaptive_25_020'], { limitInputPixels: 1_000_000 }),
    /pixel limit/i
  );
});

test('fetchImage stores the file under the inbox with a magic-derived extension', async (t) => {
  const fake = await startFakePushbullet();
  const inboxDir = mkdtempSync(join(tmpdir(), 'puzzlesolver-inbox-'));
  t.after(async () => {
    await fake.close();
    rmSync(inboxDir, { recursive: true, force: true });
  });

  // file_type lies: the bytes are a JPEG. The saved extension must follow the bytes.
  const jpeg = await sharp({ create: { width: 200, height: 44, channels: 3, background: '#fff' } })
    .jpeg()
    .toBuffer();
  const push = fake.pushImage({ iden: 'img-1', fileName: 'puzzle.png', fileType: 'image/png', data: jpeg });

  const saved = await fetchImage(push, { inboxDir });
  assert.equal(saved.path, join(inboxDir, 'img-1.jpg'));
  assert.ok(existsSync(saved.path));
  assert.deepEqual(readFileSync(saved.path), jpeg);
  assert.equal(saved.ext, '.jpg');
});

test('pruneInbox removes only files older than retain_days', (t) => {
  const inboxDir = mkdtempSync(join(tmpdir(), 'puzzlesolver-inbox-'));
  t.after(() => rmSync(inboxDir, { recursive: true, force: true }));

  writeFileSync(join(inboxDir, 'old.png'), 'old');
  writeFileSync(join(inboxDir, 'new.png'), 'new');
  const oldMs = Date.now() - 30 * 86_400_000;
  utimesSync(join(inboxDir, 'old.png'), new Date(oldMs), new Date(oldMs));

  const removed = pruneInbox({ inboxDir, retainDays: 7 });
  assert.deepEqual(removed, ['old.png']);
  assert.equal(existsSync(join(inboxDir, 'old.png')), false);
  assert.equal(existsSync(join(inboxDir, 'new.png')), true);
});

test('the client retries 429 with backoff and fails fast on 401', async (t) => {
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });

  const good = createPushbulletClient({
    token: fake.token,
    baseUrl: fake.baseUrl,
    sleep: fake.clock.sleep,
    backoffBaseMs: 100,
  });
  fake.failNext({ status: 429, times: 1, method: 'GET', path: '/v2/pushes' });
  const pushes = await good.getPushes();
  assert.deepEqual(pushes, []);
  assert.equal(good.calls.length, 1);
  assert.equal(good.calls[0].status, 200);
  assert.equal(good.calls[0].attempt, 1, 'the first attempt was retried');

  const bad = createPushbulletClient({
    token: 'wrong-token',
    baseUrl: fake.baseUrl,
    maxRetries: 3,
    sleep: fake.clock.sleep,
  });
  await assert.rejects(
    () => bad.getPushes(),
    (err) => err instanceof PushbulletError && err.status === 401 && err.retryable === false
  );
  assert.equal(bad.calls.length, 1, 'a 401 burns exactly one attempt');
});

test('the client sends the token as Access-Token and builds the note push body', async (t) => {
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });

  const client = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  assert.equal(client.streamUrl, `ws://127.0.0.1:${new URL(fake.baseUrl).port}/websocket/${fake.token}`);

  const note = await client.createNote({ title: 'Antwoord', body: '2', deviceIden: 'dev-1' });
  const request = fake.requests.at(-1);
  assert.equal(request.headers['access-token'], fake.token);
  assert.deepEqual(request.body, {
    type: 'note',
    title: 'Antwoord',
    body: '2',
    device_iden: 'dev-1',
  });
  assert.equal(note.type, 'note');
  assert.equal(note.body, '2');
  assert.equal(note.device_iden, 'dev-1');
});

test('a production stream base URL can be given explicitly', () => {
  const client = createPushbulletClient({
    token: 'o.secret',
    baseUrl: 'https://api.pushbullet.com',
    streamBaseUrl: 'wss://stream.pushbullet.com',
  });
  assert.equal(client.streamUrl, 'wss://stream.pushbullet.com/websocket/o.secret');
  assert.throws(() => createPushbulletClient({ token: '' }), /token/);
});

describe('production defaults', () => {
  test('the constants name the real REST and stream hosts', () => {
    assert.equal(DEFAULT_BASE_URL, 'https://api.pushbullet.com');
    assert.equal(DEFAULT_STREAM_BASE_URL, 'wss://stream.pushbullet.com');
  });

  test('a client with no streamBaseUrl derives the real stream host', () => {
    // Regression: swapping only the scheme from the default baseUrl used to build
    // wss://api.pushbullet.com/websocket/<token>, a host that serves no stream.
    const client = createPushbulletClient({ token: 'o.secret' });
    assert.equal(client.baseUrl, 'https://api.pushbullet.com');
    assert.equal(client.streamUrl, 'wss://stream.pushbullet.com/websocket/o.secret');
  });
});

test('a non-Pushbullet host derives its own stream URL, so the loopback double keeps working', () => {
  const loopback = createPushbulletClient({ token: 'o.secret', baseUrl: 'http://127.0.0.1:41234' });
  assert.equal(loopback.streamUrl, 'ws://127.0.0.1:41234/websocket/o.secret');

  const staging = createPushbulletClient({ token: 'o.secret', baseUrl: 'https://api.staging.example' });
  assert.equal(staging.streamUrl, 'wss://api.staging.example/websocket/o.secret');
});

test('an explicit streamBaseUrl wins over the derived default', () => {
  const production = createPushbulletClient({ token: 'o.secret', streamBaseUrl: 'wss://stream.example.test' });
  assert.equal(production.streamUrl, 'wss://stream.example.test/websocket/o.secret');

  const loopback = createPushbulletClient({
    token: 'o.secret',
    baseUrl: 'http://127.0.0.1:41234',
    streamBaseUrl: 'ws://127.0.0.1:9',
  });
  assert.equal(loopback.streamUrl, 'ws://127.0.0.1:9/websocket/o.secret');
});

test('redactPushbullet never leaves a usable token in a message', () => {
  const token = 'o.abcdef12345678901234';
  const message = `request failed for access-token: ${token}`;
  const cleaned = redactPushbullet(message);
  assert.equal(cleaned.includes(token), false);
  assert.match(cleaned, /o\.abc…/);
  const header = redactPushbullet('Access-Token: o.xyz987654321');
  assert.equal(header.includes('o.xyz987654321'), false);
});

test('the responder refuses stubs rather than pretending to deliver', async (t) => {
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });
  const store = memoryStore();
  t.after(() => store.close());

  const client = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });

  for (const strategy of ['sms-thread', 'clipboard+notify']) {
    const push = fake.pushImage({ data: await makePng() });
    const responder = createResponder({ client, store, strategy, now: fake.clock.now, minIntervalMs: 0 });
    const outcome = await responder.respond(push, { answer: '2', confident: true });
    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, 'not-implemented');
    assert.equal(fake.notePushes.length, 0);
  }

  assert.throws(() => createResponder({ client, store, strategy: 'carrier-pigeon' }), /unknown reply strategy/);
});

test('the hourly cap stops sending at max_per_hour', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const calls = [];
  const client = { createNote: async (note) => (calls.push(note), { iden: `n-${calls.length}` }) };

  const responder = createResponder({
    client,
    store,
    now: () => Date.parse('2026-01-01T00:00:00Z') / 1000,
    minIntervalMs: 0,
    maxPerHour: 20,
  });

  for (let i = 0; i < 20; i++) {
    const outcome = await responder.respond({ iden: `p-${i}` }, { answer: '2', confident: true });
    assert.equal(outcome.sent, true, `send ${i + 1} should be allowed`);
  }
  const refused = await responder.respond({ iden: 'p-20' }, { answer: '2', confident: true });
  assert.equal(refused.sent, false);
  assert.equal(refused.reason, 'rate-limited');
  assert.equal(calls.length, 20);
});

test('the responder formats the note with the configured prefix and boldness', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const fake = await startFakePushbullet();
  t.after(async () => {
    await fake.close();
  });

  const client = createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl });
  const responder = createResponder({
    client,
    store,
    now: fake.clock.now,
    minIntervalMs: 0,
    prefix: 'Antwoord: ',
    bold: true,
    title: 'Puzzel',
  });
  const push = fake.pushImage({ data: await makePng() });
  const outcome = await responder.respond(push, { answer: 'hoofd', confident: true });
  assert.equal(outcome.sent, true);
  assert.equal(fake.notePushes[0].body, 'Antwoord: **hoofd**');
  assert.equal(fake.notePushes[0].title, 'Puzzel');
});
