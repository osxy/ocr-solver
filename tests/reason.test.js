import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretReply, vote, consensus, createReasoner, reparseCorrected } from '../src/solver/reason.js';
import { parsePuzzle, PUZZLE_CLASS } from '../src/solver/puzzle.js';
import { normalizeTranscript } from '../src/solver/transcript.js';
import { createFakeClient, truncated } from '../src/model/fake.js';
import { DEFAULT_MAX_TOKENS } from '../src/solver/reason.js';
import { memoryStore } from '../src/state/db.js';

const parse = (raw) => parsePuzzle(normalizeTranscript(raw).text);

const COUNT = parse('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?');
const ORDINAL = parse('In de lijst lijst hoofd buik citroen borst olifant paard wat is de/het eerste lichaamsdeel?');
const ARITHMETIC = parse('Wat is acht min een?');

// ---------------------------------------------------------------- interpretReply

test('accepts a clean JSON reply for a count puzzle', () => {
  const r = interpretReply('{"answer":"2","puzzle_class":"count","confidence":0.9}', COUNT);
  assert.equal(r.ok, true);
  assert.equal(r.answer, '2');
  assert.equal(r.puzzleClass, PUZZLE_CLASS.COUNT);
  assert.equal(r.confidence, 0.9);
});

test('accepts the Dutch key "antwoord"', () => {
  const r = interpretReply('{"antwoord":"hoofd","puzzle_class":"ordinal-pick"}', ORDINAL);
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'hoofd');
});

test('accepts a fenced reply', () => {
  const r = interpretReply('```json\n{"answer":"7"}\n```', ARITHMETIC);
  assert.equal(r.ok, true);
  assert.equal(r.answer, '7');
});

test('rejects a reply that is not JSON', () => {
  const r = interpretReply('The answer is 7.', ARITHMETIC);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a JSON object/);
});

test('rejects a reply with no answer field', () => {
  const r = interpretReply('{"transcript":"wat is acht min een"}', ARITHMETIC);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no answer field/);
});

test('holds the model to the class the offline parser already determined', () => {
  // The parser knows this is a "hoeveel" question, so a word answer must NOT be
  // allowed to slip through as a loose free-text answer.
  const r = interpretReply('{"answer":"twee","puzzle_class":"count"}', COUNT);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not a bare integer/);
});

test('rejects an ordinal answer that is not one of the puzzle words', () => {
  const r = interpretReply('{"answer":"voet","puzzle_class":"ordinal-pick"}', ORDINAL);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not one of the puzzle's own words/);
});

test('lets the model name the class when the offline parser gave up', () => {
  const unknown = parse('Reken uit: negen min vier');
  assert.equal(unknown.class, PUZZLE_CLASS.UNKNOWN);
  const r = interpretReply('{"answer":"5","puzzle_class":"arithmetic"}', unknown);
  assert.equal(r.ok, true);
  assert.equal(r.puzzleClass, PUZZLE_CLASS.ARITHMETIC);
});

test('lets the arithmetic calculator overrule a wrong model answer', () => {
  // The model reads the transcript correctly but does the sum wrong. The offline
  // calculator cannot be wrong about 9 - 4, so it wins.
  const r = interpretReply(
    '{"answer":"6","transcript":"Wat is negen min vier?","puzzle_class":"arithmetic"}',
    ARITHMETIC
  );
  assert.equal(r.ok, true);
  assert.equal(r.answer, '5');
  assert.equal(r.corrected, true);
  assert.match(r.reason, /arithmetic gives 5/);
});

test('keeps a correct model answer for arithmetic', () => {
  const r = interpretReply('{"answer":"5","transcript":"Wat is negen min vier?","puzzle_class":"arithmetic"}', ARITHMETIC);
  assert.equal(r.ok, true);
  assert.equal(r.answer, '5');
  assert.equal(r.corrected, undefined);
});

test('canonicalises a capitalised word answer', () => {
  const r = interpretReply('{"answer":"Hoofd","puzzle_class":"ordinal-pick"}', ORDINAL);
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'hoofd');
});

// ------------------------------------------------------------------------- vote

const ok = (answer) => ({ ok: true, answer });

test('a single sample is enough', () => {
  const v = vote([ok('2')]);
  assert.equal(v.ok, true);
  assert.equal(v.votes, 1);
  assert.equal(v.of, 1);
});

test('two of three agreeing samples win', () => {
  const v = vote([ok('2'), ok('2'), ok('3')]);
  assert.equal(v.ok, true);
  assert.equal(v.answer, '2');
  assert.equal(v.votes, 2);
  assert.equal(v.of, 3);
});

test('three different samples produce no agreement', () => {
  const v = vote([ok('2'), ok('3'), ok('4')]);
  assert.equal(v.ok, false);
  assert.match(v.reason, /no agreement/);
});

test('a lone survivor among failed samples is not promoted', () => {
  // Two of three calls fell over. Accepting the one that came back would silently
  // drop the self-consistency guarantee that those extra samples exist for.
  const v = vote([ok('2'), { ok: false, reason: 'HTTP 500' }, { ok: false, reason: 'timeout' }]);
  assert.equal(v.ok, false);
  assert.match(v.reason, /only 1\/3 samples/);
});

test('two valid samples must agree with each other', () => {
  const v = vote([ok('2'), ok('3')]);
  assert.equal(v.ok, false);
});

test('returns null when nothing validated', () => {
  assert.equal(vote([{ ok: false }, { ok: false }]), null);
});

// -------------------------------------------------------------------- consensus

test('consensus needs a strict majority of opinions', () => {
  const agreed = consensus([
    { answer: '2', source: 'tier0' },
    { answer: '2', source: 'text' },
  ]);
  assert.equal(agreed.answer, '2');
  assert.equal(agreed.votes, 2);
  assert.deepEqual(agreed.sources, ['tier0', 'text']);
});

test('a two-way disagreement yields no winner', () => {
  const tied = consensus([
    { answer: '2', source: 'tier0' },
    { answer: '3', source: 'text' },
  ]);
  assert.equal(tied.answer, null);
});

test('a third opinion breaks a tie', () => {
  const broken = consensus([
    { answer: '2', source: 'tier0' },
    { answer: '3', source: 'text' },
    { answer: '3', source: 'vision' },
  ]);
  assert.equal(broken.answer, '3');
  assert.equal(broken.votes, 2);
});

// --------------------------------------------------------------------- reasoner

test('runs the configured number of samples per puzzle class', async () => {
  const client = createFakeClient({ responses: [{ answer: '2', puzzle_class: 'count', confidence: 0.9 }] });
  const reasoner = createReasoner({ client });
  assert.equal(reasoner.samplesFor(COUNT), 1, 'count is cheap and single-shot');
  assert.equal(reasoner.samplesFor(ARITHMETIC), 1, 'arithmetic is single-shot');
  assert.equal(reasoner.samplesFor(ORDINAL), 3, 'ordinal-pick needs corroboration');

  await reasoner.solveText({ transcript: 'x', parsed: ORDINAL });
  assert.equal(client.calls.length, 3);
});

test('uses temperature 0 for a single sample and spreads multiple samples', async () => {
  const client = createFakeClient({ responses: [{ answer: '2', puzzle_class: 'count', confidence: 0.9 }] });
  const reasoner = createReasoner({ client, temperature: 0.3 });

  await reasoner.solveText({ transcript: 'x', parsed: ARITHMETIC });
  assert.equal(client.calls[0].temperature, 0, 'one sample must be deterministic');

  client.reset();
  await reasoner.solveText({ transcript: 'x', parsed: ORDINAL });
  assert.equal(client.calls[0].temperature, 0.3, 'samples need spread or the vote is meaningless');
});

test('text tier resolves an ordinal puzzle by majority', async () => {
  const client = createFakeClient({
    responses: [
      { answer: 'hoofd', puzzle_class: 'ordinal-pick', confidence: 0.9 },
      { answer: 'buik', puzzle_class: 'ordinal-pick', confidence: 0.7 },
      { answer: 'hoofd', puzzle_class: 'ordinal-pick', confidence: 0.8 },
    ],
  });
  const reasoner = createReasoner({ client });
  const result = await reasoner.solveText({ transcript: 'x', parsed: ORDINAL });
  assert.equal(result.ok, true);
  assert.equal(result.answer, 'hoofd');
  assert.equal(result.votes, 2);
});

test('a malformed model reply is rejected, not thrown', async () => {
  const client = createFakeClient({ responses: ['I cannot help with that.'] });
  const reasoner = createReasoner({ client });
  const result = await reasoner.solveText({ transcript: 'x', parsed: COUNT });
  assert.equal(result, null, 'no valid interpretation means the tier produced nothing');
});

test('a model failure surfaces as null rather than an exception', async () => {
  const client = createFakeClient({ failWith: { status: 500, retryable: true } });
  const reasoner = createReasoner({ client });
  assert.equal(await reasoner.solveText({ transcript: 'x', parsed: COUNT }), null);
});

test('vision tier sends the image and can rescue a failed text tier', async () => {
  const client = createFakeClient({
    responses: (options) => {
      const isVision = Array.isArray(options.messages[1]?.content);
      if (!isVision) return 'not json at all';
      return { answer: '2', puzzle_class: 'count', confidence: 0.95 };
    },
  });
  const reasoner = createReasoner({ client });
  const result = await reasoner.resolve({
    transcript: 'Hoeveel kleuren in lijst wit kw paars?',
    parsed: COUNT,
    images: [{ name: 'v', buffer: Buffer.from('fake') }],
  });

  assert.ok(result, 'vision should have rescued this');
  assert.equal(result.answer, '2');
  assert.equal(result.method, 'model:vision');

  const visionCall = client.calls.find((c) => Array.isArray(c.messages[1]?.content));
  assert.ok(visionCall, 'a vision request must have been made');
  assert.ok(visionCall.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
});

test('records every sample and verdict in the store', async () => {
  const store = memoryStore();
  const client = createFakeClient({
    responses: [{ answer: 'hoofd', puzzle_class: 'ordinal-pick', confidence: 0.9 }],
  });
  const reasoner = createReasoner({ client, store, subject: 'p1.png' });
  await reasoner.solveText({ transcript: 'x', parsed: ORDINAL });

  const rows = store.attemptsFor('p1.png');
  const stages = rows.map((r) => r.stage);
  assert.ok(stages.filter((s) => s === 'model-text').length >= 3, 'one row per sample');
  store.close();
});

// ------------------------------------------------------- truncation / token budget

test('defaults to a budget sized for narration, not just the answer', () => {
  // Sized for ~20-token answers, a small budget gets eaten by models that narrate
  // their reasoning as content, and the JSON never arrives. That is a budget bug, and
  // it looks exactly like a model that cannot do the task.
  assert.ok(DEFAULT_MAX_TOKENS >= 1000, `expected a generous default, got ${DEFAULT_MAX_TOKENS}`);
});

test('retries with a bigger budget when a reply is truncated', async () => {
  // Arithmetic is single-sample, so the call count is unambiguous here.
  const client = createFakeClient({
    responses: [
      truncated('We need answer JSON only. Need solve. Dutch: "wat is acht min een" ...'),
      { answer: '7', puzzle_class: 'arithmetic', confidence: 0.9 },
    ],
  });
  const reasoner = createReasoner({ client });
  const result = await reasoner.solveText({ transcript: 'wat is acht min een', parsed: ARITHMETIC });

  assert.ok(result, 'the retry should have produced a usable answer');
  assert.equal(result.answer, '7');
  assert.equal(client.calls.length, 2, 'one sample, one retry');
  assert.ok(
    client.calls[1].maxTokens > client.calls[0].maxTokens,
    `retry must get more room: ${client.calls[0].maxTokens} -> ${client.calls[1].maxTokens}`
  );
});

test('does not retry a reply that was not truncated', async () => {
  const client = createFakeClient({ responses: [{ answer: '7', puzzle_class: 'arithmetic', confidence: 0.9 }] });
  const reasoner = createReasoner({ client });
  await reasoner.solveText({ transcript: 'x', parsed: ARITHMETIC });
  assert.equal(client.calls.length, 1, 'a good reply must cost exactly one call');
});

test('reports a persistently truncated reply as truncated, not merely unparseable', async () => {
  const store = memoryStore();
  const client = createFakeClient({ responses: [truncated('partial {'), truncated('partial {')] });
  const reasoner = createReasoner({ client, store, subject: 'p' });
  const result = await reasoner.solveText({ transcript: 'x', parsed: ARITHMETIC });

  assert.equal(result, null, 'nothing usable came back');
  const rows = store.attemptsFor('p');
  const truncatedRow = rows.find((r) => r.payload?.truncated === true);
  assert.ok(truncatedRow, 'the attempt log must record that the reply was truncated');
  assert.equal(truncatedRow.payload.finishReason, 'length');
  assert.ok(
    rows.some((r) => /truncated before valid JSON/.test(r.payload?.reason ?? '')),
    'the rejection reason should name truncation specifically'
  );
  store.close();
});

test('re-parse uses the model-corrected wording when it parses', () => {
  const corrected = reparseCorrected('In de lijst peer arm fiets banaan teen wat is de/het eerste lichaamsdeel?', ORDINAL);
  assert.equal(corrected.class, PUZZLE_CLASS.ORDINAL_PICK);
  assert.equal(corrected.category, 'lichaamsdeel');
  assert.ok(corrected.list.includes('arm'));

  const unchanged = reparseCorrected('blah blah', ORDINAL);
  assert.equal(unchanged, ORDINAL, 'a useless correction keeps the original parse');
});