/**
 * Live model smoke test. OPT-IN: every test here skips unless LLM_API_KEY is set.
 *
 * This is the only part of the suite that touches a real provider, and it exists to
 * close the one gap the scripted client cannot: whether a real model actually reads
 * these Dutch puzzles well enough for the tiers to be worth having.
 *
 * Run it without putting a key in the project:
 *
 *   set -a; . ~/.config/puzzlesolver/env; set +a
 *   npm run test:live
 *
 * Cost note: sample counts are pinned to 1 here so the whole file is a handful of
 * calls. Self-consistency itself is covered exhaustively by the offline unit tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solveImage } from '../src/solver/pipeline.js';
import { createReasoner } from '../src/solver/reason.js';
import { createChatClient, extractJson } from '../src/model/client.js';

const apiKey = process.env.LLM_API_KEY ?? '';
const baseUrl = process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1';
const textModel = process.env.LLM_TEXT_MODEL ?? 'gpt-4o-mini';
// May be a comma-separated fallback chain; the reasoner normalises it.
const visionModel = process.env.LLM_VISION_MODEL ?? 'gpt-4o';
const costTier = process.env.LLM_COST_TIER ?? null;
const allowedModels = (process.env.LLM_ALLOWED_MODELS ?? '').split(',').filter(Boolean);
const excludedModels = (process.env.LLM_EXCLUDED_MODELS ?? '').split(',').filter(Boolean);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEEDS_MODEL = join(root, 'corpus', 'needs-model', '004-unknown-hoofdstad.png');
const COUNT_PUZZLE = join(root, 'corpus', '001-count-kleuren.png');

/** Skip instead of fail when no key is configured. */
const live = apiKey
  ? test
  : (name, fn) => test(name, { skip: 'LLM_API_KEY not set - see config/llm.env.example' }, fn);

function liveReasoner(extra = {}) {
  // Mirror the real configuration, so the smoke test exercises auto routing when
  // the environment asks for it rather than a bare pinned model.
  const client = createChatClient({
    baseUrl,
    apiKey,
    autoRouter: { costTier, allowedModels, excludedModels },
  });
  const reasoner = createReasoner({
    client,
    textModel,
    visionModel,
    // One sample per class keeps the smoke test cheap; the voting logic is unit tested.
    sampleCounts: { count: 1, arithmetic: 1, 'ordinal-pick': 1, unknown: 1 },
    ...extra,
  });
  return { client, reasoner };
}

/** An OCR worker that reports a fixed transcript, to force a chosen tier. */
function fakeWorker(text, confidence = 90) {
  return {
    async setParameters() {},
    async recognize() {
      return { data: { text, confidence, words: [] } };
    },
  };
}

live('a real model answers a puzzle the offline lexicon cannot', async () => {
  const { client, reasoner } = liveReasoner();

  const result = await solveImage(fakeWorker('Wat Is de hoofdstad van Nederland?', 95), NEEDS_MODEL, { reasoner });

  assert.equal(result.needsModel, true, 'the offline tiers must have given up first');
  assert.ok(result.answer, `expected an answer, got nothing. Ranked OCR: ${result.ranked[0]?.text}`);
  assert.match(result.answer, /amsterdam/i, `expected Amsterdam, got ${JSON.stringify(result.answer)}`);

  // The provider must have honoured the JSON contract well enough to be parsed.
  const reply = client.calls[0]?.result?.text ?? '';
  const json = extractJson(reply);
  assert.ok(json, `reply was not parseable JSON: ${reply.slice(0, 300)}`);
  assert.ok(json.answer != null, 'parsed JSON had no answer field');
});

live('a real model reports the transcript it worked from', async () => {
  const { client, reasoner } = liveReasoner();
  const result = await solveImage(fakeWorker('Wat Is de hoofdstad van Nederland?', 95), NEEDS_MODEL, { reasoner });

  const json = extractJson(client.calls[0].result.text);
  assert.ok(typeof json.transcript === 'string' && json.transcript.length > 0, 'a transcript should come back');
  assert.ok(result.answer);
});

live('the vision tier reads the preprocessed image when OCR yields nothing', async () => {
  const { client, reasoner } = liveReasoner();

  // An empty transcript forces the vision path with no text to lean on.
  const result = await solveImage(fakeWorker('', 0), NEEDS_MODEL, { reasoner });

  assert.equal(result.ranked.length, 0, 'there must be no usable transcript');
  assert.equal(result.method, 'model:vision', `expected the vision tier, got ${result.method}`);
  assert.ok(result.answer, 'the vision model should have produced an answer');
  assert.match(result.answer, /amsterdam/i, `expected Amsterdam, got ${JSON.stringify(result.answer)}`);

  const visionCall = client.calls.find((c) => Array.isArray(c.messages[1]?.content));
  assert.ok(visionCall, 'a vision request must have been sent');
  assert.ok(visionCall.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));
});

live('a confident offline answer never reaches the provider', async () => {
  const { client, reasoner } = liveReasoner();

  const result = await solveImage(
    fakeWorker('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?', 95),
    COUNT_PUZZLE,
    { reasoner }
  );

  assert.equal(result.answer, '2');
  assert.equal(result.method, 'tier0:count');
  assert.equal(client.calls.length, 0, 'a real client must not be called when the lexicon already knows');
});

live('reports which model actually answered each tier', async () => {
  const { client, reasoner } = liveReasoner();
  await solveImage(fakeWorker('Wat Is de hoofdstad van Nederland?', 95), NEEDS_MODEL, { reasoner });

  const answered = client.calls.filter((c) => c.result).map((c) => c.result.model);
  assert.ok(answered.length > 0, 'at least one call should have succeeded');
  for (const model of answered) {
    assert.notEqual(model, 'openrouter/auto', 'the API reports the resolved model, not the slug');
  }
});

live('the client never leaks the key into a recorded call', async () => {
  const { client, reasoner } = liveReasoner();
  await solveImage(fakeWorker('Wat Is de hoofdstad van Nederland?', 95), NEEDS_MODEL, { reasoner });

  const serialised = JSON.stringify(client.calls);
  assert.ok(!serialised.includes(apiKey), 'the API key must never appear in recorded call data');
});