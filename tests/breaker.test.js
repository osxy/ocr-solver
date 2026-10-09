/**
 * Circuit breaker tests.
 *
 * The clock is injected everywhere, so the 10-minute default cooldown is exercised
 * by advancing a number, never by sleeping. The integration tests run the real
 * reasoner and the real pipeline against a scripted client, so the "a dead provider
 * costs at most N calls" and "a tripped breaker still lets Tier 0 through" claims
 * are asserted against the code that actually runs, not a reimplementation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCircuitBreaker, isPermanentFailure } from '../src/model/breaker.js';
import { ModelError } from '../src/model/client.js';
import { createReasoner } from '../src/solver/reason.js';
import { createFakeClient } from '../src/model/fake.js';
import { parsePuzzle } from '../src/solver/puzzle.js';
import { normalizeTranscript } from '../src/solver/transcript.js';
import { solveImage } from '../src/solver/pipeline.js';
import { memoryStore } from '../src/state/db.js';
import { validateConfig } from '../src/config.js';
import { buildReasonerFromConfig } from '../src/app.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = join(root, 'corpus', '003-arithmetic-acht-min-een.png');
const UNKNOWN = parsePuzzle(normalizeTranscript('Wat is de hoofdstad van Nederland?').text);

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

function transient() {
  return new ModelError('provider is down', { status: 500, retryable: true });
}

/** An OCR worker that always reports one transcript (copy of the pipeline test's). */
function fakeWorker(text, confidence = 90) {
  return {
    async setParameters() {},
    async recognize() {
      return { data: { text, confidence, words: [] } };
    },
  };
}

// ------------------------------------------------------------------ unit: states

test('three consecutive transient failures trip the breaker', () => {
  const breaker = createCircuitBreaker({ name: 'text', threshold: 3 });
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  assert.equal(breaker.state(), 'closed', 'two failures are not yet a trip');
  assert.equal(breaker.allow(), true);

  breaker.failure({ error: transient() });
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.allow(), false, 'an open breaker admits nothing');
});

test('a permanent failure trips immediately, without waiting for the threshold', () => {
  const breaker = createCircuitBreaker({ name: 'text', threshold: 3 });
  breaker.failure({ permanent: true, error: new ModelError('bad key', { status: 401 }) });
  assert.equal(breaker.state(), 'open');
});

test('permanent classification covers 401/403/404 and configuration errors', () => {
  assert.equal(isPermanentFailure(new ModelError('unauthorized', { status: 401 })), true);
  assert.equal(isPermanentFailure(new ModelError('forbidden', { status: 403 })), true);
  assert.equal(isPermanentFailure(new ModelError('unknown model', { status: 404 })), true);
  assert.equal(
    isPermanentFailure(new ModelError('unknown cost tier "cheap"', { retryable: false, permanent: true })),
    true,
    'a bad cost tier is a config error, not a transient one'
  );
  assert.equal(isPermanentFailure(new ModelError('rate limited', { status: 429 })), false);
  assert.equal(isPermanentFailure(new ModelError('gateway', { status: 502 })), false);
  assert.equal(isPermanentFailure(new Error('socket hang up')), false);
});

test('an open breaker becomes half-open after the cooldown and admits one probe', () => {
  const c = clock(0);
  const breaker = createCircuitBreaker({ name: 'text', threshold: 1, cooldownMs: 60_000, now: c.now });
  breaker.failure({ error: transient() });
  assert.equal(breaker.state(), 'open');

  c.advance(59_999);
  assert.equal(breaker.allow(), false, 'still cooling down');

  c.advance(1);
  assert.equal(breaker.allow(), true, 'the first probe after cooldown is admitted');
  assert.equal(breaker.allow(), false, 'only one probe is admitted');

  breaker.success();
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.allow(), true);
});

test('a failed half-open probe reopens the breaker and restarts the cooldown', () => {
  const c = clock(0);
  const breaker = createCircuitBreaker({ name: 'text', threshold: 1, cooldownMs: 10_000, now: c.now });
  breaker.failure({ error: transient() });
  c.advance(10_000);
  assert.equal(breaker.allow(), true);
  breaker.failure({ error: transient() });
  assert.equal(breaker.state(), 'open');

  c.advance(9_999);
  assert.equal(breaker.allow(), false, 'the cooldown restarted from the failed probe');
  c.advance(1);
  assert.equal(breaker.allow(), true);
});

test('a success resets the consecutive failure count', () => {
  const breaker = createCircuitBreaker({ threshold: 3 });
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  breaker.success();
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  assert.equal(breaker.state(), 'closed', 'the earlier failures were reset by the success');
});

test('onTrip fires once per trip, not once per failure while open', () => {
  const trips = [];
  const breaker = createCircuitBreaker({ name: 'text', threshold: 3, onTrip: (t) => trips.push(t) });
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() }); // trips here
  // In production, `allow()` would refuse these; call `failure` directly to prove
  // the guard is in the breaker and not only in the caller.
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  assert.equal(trips.length, 1, 'a second notification while already open is the bug');
});

test('onStateChange reports every transition with reasons', () => {
  const changes = [];
  const c = clock(0);
  const breaker = createCircuitBreaker({
    name: 'text',
    threshold: 2,
    cooldownMs: 1_000,
    now: c.now,
    onStateChange: (t) => changes.push(`${t.from}->${t.to}`),
  });
  breaker.failure({ error: transient() });
  breaker.failure({ error: transient() });
  c.advance(1_000);
  breaker.allow(); // open -> half-open
  breaker.failure({ error: transient() });
  assert.deepEqual(changes, ['closed->open', 'open->half-open', 'half-open->open']);
});

// ------------------------------------------------------- integration: reasoner

test('a dead provider costs at most N calls per cooldown window', async () => {
  const c = clock(0);
  const client = createFakeClient({ failWith: { status: 500, retryable: true } });
  const breaker = createCircuitBreaker({ name: 'text', threshold: 3, cooldownMs: 60_000, now: c.now });
  const reasoner = createReasoner({
    client,
    breakers: { text: breaker },
    sampleCounts: { unknown: 3 },
  });

  const first = await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(first, null);
  assert.equal(client.calls.length, 3, 'threshold calls, one per sample, and then it trips');

  const second = await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(second, null);
  assert.equal(client.calls.length, 3, 'no call is made while the breaker is open');

  c.advance(60_000);
  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(client.calls.length, 4, 'after the cooldown exactly one probe is admitted');

  // The probe failed, so a second cooldown must pass before another call.
  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(client.calls.length, 4);
  c.advance(60_000);
  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(client.calls.length, 5);
});

test('recovery is automatic once the provider returns', async () => {
  const c = clock(0);
  let dead = true;
  let calls = 0;
  const client = {
    async chat() {
      calls += 1;
      if (dead) throw transient();
      return {
        text: JSON.stringify({ answer: 'Amsterdam', puzzle_class: 'unknown', confidence: 0.9 }),
        model: 'm',
        finishReason: 'stop',
        usage: { completion_tokens: 10 },
        ms: 1,
      };
    },
  };
  const breaker = createCircuitBreaker({ name: 'text', threshold: 3, cooldownMs: 1_000, now: c.now });
  const reasoner = createReasoner({ client, breakers: { text: breaker }, sampleCounts: { unknown: 3 } });

  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(breaker.state(), 'open');
  assert.equal(calls, 3);

  // Still dead: the first probe fails and reopens the breaker.
  c.advance(1_000);
  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.equal(breaker.state(), 'open');
  assert.equal(calls, 4, 'one probe');

  // Provider is back. The next cooldown admits one probe, which succeeds and closes.
  dead = false;
  c.advance(1_000);
  const result = await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });
  assert.ok(result, 'the tier recovered');
  assert.equal(result.answer, 'Amsterdam');
  assert.equal(breaker.state(), 'closed');
  assert.equal(calls, 7, 'one probe plus the two samples the closed breaker then allows');
});

test('a tripped breaker is recorded in the attempts store', async () => {
  const store = memoryStore();
  const breaker = createCircuitBreaker({
    name: 'text',
    threshold: 2,
    onStateChange: (t) =>
      store.record({
        subject: 'circuit-breaker',
        stage: 'breaker',
        variant: t.name,
        payload: { from: t.from, to: t.to, reason: t.reason, failures: t.failures },
      }),
  });
  const client = createFakeClient({ failWith: { status: 500, retryable: true } });
  const reasoner = createReasoner({ client, breakers: { text: breaker }, sampleCounts: { unknown: 2 } });

  await reasoner.solveText({ transcript: 'x', parsed: UNKNOWN });

  const rows = store.attemptsFor('circuit-breaker');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, 'breaker');
  assert.equal(rows[0].variant, 'text');
  assert.equal(rows[0].payload.to, 'open');
  store.close();
});

test('the app wires configured breakers into the reasoner', () => {
  const seen = {};
  const built = buildReasonerFromConfig(
    validateConfig({ solver: { breaker_threshold: 5, breaker_cooldown_sec: 42 } }).config,
    {
      llmApiKey: 'sk-test',
      store: null,
      logger: null,
      createChatClientImpl: () => ({ async chat() {} }),
      createReasonerImpl: (options) => {
        seen.breakers = options.breakers;
        return { solveVision: async () => null };
      },
    }
  );

  assert.ok(built.reasoner);
  assert.equal(seen.breakers.text.threshold, 5);
  assert.equal(seen.breakers.text.cooldownMs, 42_000);
  assert.equal(seen.breakers.vision.cooldownMs, 42_000);
});

// ---------------------------------------------------- integration: Tier 0 survives

test('a tripped breaker still lets a confident offline answer through', async () => {
  const breaker = createCircuitBreaker({ name: 'text', threshold: 1 });
  breaker.failure({ permanent: true, error: new ModelError('bad key', { status: 401 }) });
  assert.equal(breaker.state(), 'open');

  const client = createFakeClient({ responses: [{ answer: '3', puzzle_class: 'count' }] });
  const reasoner = createReasoner({ client, breakers: { text: breaker } });
  const result = await solveImage(
    fakeWorker('Hoeveel kleuren in lijst wit kiwi hoofd paars olifant aap?', 95),
    IMAGE,
    { reasoner }
  );

  assert.equal(result.answer, '2');
  assert.equal(result.method, 'tier0:count');
  assert.equal(result.confident, true);
  assert.equal(client.calls.length, 0, 'Tier 0 is completely unaffected by a dead model tier');
});

test('a tripped breaker leaves an uncorroborated offline answer intact', async () => {
  const breaker = createCircuitBreaker({ name: 'text', threshold: 1 });
  breaker.failure({ permanent: true, error: new ModelError('bad key', { status: 401 }) });

  const client = createFakeClient({ responses: [{ answer: '9', puzzle_class: 'count' }] });
  const reasoner = createReasoner({ client, breakers: { text: breaker } });
  const result = await solveImage(fakeWorker('Hoeveel vruchten in lijst appel kiwi kw', 90), IMAGE, { reasoner });

  assert.equal(result.answer, '2', 'the offline answer is not lost because the model is down');
  assert.equal(result.confident, false, 'but it is not dressed up as certain');
  assert.equal(result.unresolved, false);
  assert.equal(client.calls.length, 0, 'the open breaker made no call at all');
});
