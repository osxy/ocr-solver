/**
 * Tier arbitration, end to end through the pipeline.
 *
 * OCR is replaced by a scripted fake so these tests pin down exactly what the
 * pipeline does with a given transcript. Real OCR is covered by corpus.test.js.
 * No network and no provider key are involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveImage } from '../src/solver/pipeline.js';
import { createReasoner } from '../src/solver/reason.js';
import { createFakeClient } from '../src/model/fake.js';
import { memoryStore } from '../src/state/db.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = join(root, 'corpus', '003-arithmetic-acht-min-een.png');

/** An OCR worker that always reports the same transcript. */
function fakeWorker(text, confidence = 90) {
  const calls = [];
  return {
    calls,
    async setParameters(params) {
      calls.push(params);
    },
    async recognize() {
      return { data: { text, confidence, words: [] } };
    },
  };
}

function reasonerWith(responses, extra = {}) {
  const client = createFakeClient({ responses });
  return { client, reasoner: createReasoner({ client, ...extra }) };
}

test('a confident offline answer never calls the model', async () => {
  const { client, reasoner } = reasonerWith([{ answer: 'wrong', puzzle_class: 'count', confidence: 1 }]);
  const result = await solveImage(
    fakeWorker('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?', 95),
    IMAGE,
    { reasoner }
  );

  assert.equal(result.answer, '2');
  assert.equal(result.method, 'tier0:count');
  assert.equal(result.confident, true);
  assert.equal(client.calls.length, 0, 'the common case must stay free and deterministic');
});

test('an unrecognised puzzle is handed to the text model', async () => {
  const { client, reasoner } = reasonerWith([
    { answer: 'Amsterdam', puzzle_class: 'unknown', confidence: 0.95 },
  ]);
  const result = await solveImage(fakeWorker('Wat is de hoofdstad van Nederland?', 88), IMAGE, { reasoner });

  assert.equal(result.needsModel, true);
  assert.equal(result.answer, 'Amsterdam');
  assert.equal(result.method, 'model:text');
  assert.equal(result.confident, true, 'unanimous samples are confident');
  // An `unknown` puzzle gets the full self-consistency treatment (3 samples),
  // because nothing offline could narrow down what shape the answer should take.
  assert.equal(client.calls.length, 3);
});

test('a non-confident offline answer is corroborated by the model', async () => {
  // 'kw' is an unreadable 'kiwi', so the offline count of 2 fruits is not trustworthy.
  const { reasoner } = reasonerWith([{ answer: '2', puzzle_class: 'count', confidence: 0.95 }]);
  const result = await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, { reasoner });

  assert.equal(result.opinions.length, 2, 'tier0 and the model both spoke');
  assert.equal(result.answer, '2');
  assert.equal(result.confident, true, 'agreement upgrades an uncorroborated answer');
  assert.equal(result.agreement.votes, 2);
});

test('a model that contradicts an uncorroborated offline answer triggers the vision tier', async () => {
  const client = createFakeClient({
    responses: (options) => {
      const isVision = Array.isArray(options.messages[1]?.content);
      // text tier says 3, the image says 2 - which agrees with the offline read
      return isVision
        ? { answer: '2', puzzle_class: 'count', confidence: 0.9 }
        : { answer: '3', puzzle_class: 'count', confidence: 0.9 };
    },
  });
  const reasoner = createReasoner({ client });
  const result = await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, { reasoner });

  assert.equal(result.opinions.length, 3);
  assert.equal(result.answer, '2', 'tier0 + vision outvote the text model');
  assert.equal(result.agreement.votes, 2);
  assert.equal(result.confident, false, '2 of 3 is not unanimous');
  assert.ok(client.calls.some((c) => Array.isArray(c.messages[1]?.content)), 'vision tier was used');
});

test('an unresolvable disagreement is reported, not guessed at', async () => {
  const client = createFakeClient({
    responses: (options) => {
      const isVision = Array.isArray(options.messages[1]?.content);
      return isVision
        ? { answer: '5', puzzle_class: 'count', confidence: 0.9 }
        : { answer: '3', puzzle_class: 'count', confidence: 0.9 };
    },
  });
  const reasoner = createReasoner({ client });
  const result = await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, { reasoner });

  // offline says 2, text says 3, vision says 5 - no majority anywhere.
  assert.equal(result.disputed, true);
  assert.equal(result.answer, null, 'three different answers must not be guessed at');
  assert.equal(result.unresolved, true);
});

test('the vision tier runs when OCR produced nothing at all', async () => {
  const { client, reasoner } = reasonerWith([{ answer: '7', puzzle_class: 'arithmetic', confidence: 0.9 }]);
  const result = await solveImage(fakeWorker('', 0), IMAGE, { reasoner });

  assert.equal(result.ranked.length, 0, 'no usable transcript');
  assert.equal(result.answer, '7');
  assert.equal(result.method, 'model:vision');
  // Vision samples are capped at 2 regardless of class, since each one costs an image.
  assert.equal(client.calls.length, 2);
  assert.ok(Array.isArray(client.calls[0].messages[1].content), 'the request carried an image');
});

test('a dead model leaves the offline answer intact', async () => {
  const client = createFakeClient({ failWith: { status: 500, retryable: true } });
  const reasoner = createReasoner({ client });
  const result = await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, { reasoner });

  assert.equal(result.answer, '2', 'the offline answer survives a broken provider');
  assert.equal(result.confident, false, 'but it is not dressed up as certain');
  assert.equal(result.unresolved, false);
});

test('a model rejection does not throw out of the pipeline', async () => {
  const client = createFakeClient({ responses: ['I refuse.'] });
  const reasoner = createReasoner({ client });
  const result = await solveImage(fakeWorker('Wat is de hoofdstad van Nederland?', 88), IMAGE, { reasoner });
  assert.equal(result.unresolved, true);
});

test('an offline-only run is unchanged by the model wiring', async () => {
  const result = await solveImage(fakeWorker('Wat is acht min een?', 95), IMAGE, {});
  assert.equal(result.answer, '7');
  assert.equal(result.method, 'tier0:arithmetic');
  assert.equal(result.model, null);
});

test('records ocr, tier0 and validate stages in the store', async () => {
  const store = memoryStore();
  await solveImage(fakeWorker('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?', 95), IMAGE, {
    store,
    subject: 'p1',
  });

  const stages = store.attemptsFor('p1').map((r) => r.stage);
  assert.ok(stages.includes('ocr'));
  assert.ok(stages.includes('tier0'));
  assert.ok(stages.includes('validate'));
  store.close();
});

test('records the model stages and the final verdict', async () => {
  const store = memoryStore();
  const client = createFakeClient({ responses: [{ answer: '2', puzzle_class: 'count', confidence: 0.95 }] });
  const reasoner = createReasoner({ client, store, subject: 'p2' });
  await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, {
    store,
    subject: 'p2',
    reasoner,
  });

  const stages = store.attemptsFor('p2').map((r) => r.stage);
  assert.ok(stages.includes('model-text'));
  assert.ok(stages.includes('validate'));

  const verdict = store.attemptsFor('p2').at(-1);
  assert.equal(verdict.payload.answer, '2');
  store.close();
});

test('useTier0=false withholds the offline answer and forces the model', async () => {
  // The lexicon would confidently answer 2; `solver.tier0 = false` must ignore that
  // and let the model answer instead, without reimplementing the solve path.
  const client = createFakeClient({ responses: [{ answer: '3', puzzle_class: 'count', confidence: 0.95 }] });
  const reasoner = createReasoner({ client });
  const result = await solveImage(
    fakeWorker('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?', 95),
    IMAGE,
    { reasoner, useTier0: false }
  );

  assert.equal(result.solved, null, 'the offline answer is not surfaced as a tier0 solve');
  assert.equal(result.answer, '3');
  assert.equal(result.method, 'model:text');
  assert.equal(client.calls.length > 0, true, 'the model is consulted even though tier0 could answer');
});