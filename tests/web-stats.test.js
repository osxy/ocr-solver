/**
 * Statistics page tests (issue #64).
 *
 * The page is one of the few UI features fully verifiable on this host: a real HTTP
 * GET against a seeded SQLite store, real assertions. These tests cover the bound on
 * the recent list, the honesty of the two accuracy figures, the retention window and
 * the read-only property - including the mutations that would break each.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';

import { validateConfig } from '../src/config.js';
import { openStore } from '../src/state/db.js';
import { createWebSettingsServer } from '../src/ui/web-config.js';

function fakeController() {
  return { list: () => [], set() {}, reset() {}, async save() { return { saved: false, changed: [] }; } };
}

const baseUrl = (server) => `http://127.0.0.1:${server.port}`;

function sessionFrom(html) {
  const match = /name="session" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page must carry a session token');
  return match[1];
}

async function startUi(t, options = {}) {
  const state = { remote: options.remote ?? '127.0.0.1' };
  // #85: a non-loopback range now needs a stable port; allocate a real free one.
  let webUi = options.webUi ?? null;
  if (webUi && Array.isArray(webUi.allowed_cidrs) && webUi.allowed_cidrs.length > 0 && webUi.port == null) {
    webUi = { ...webUi, port: await freePort() };
  }
  const server = createWebSettingsServer({
    controller: fakeController(),
    ...options,
    webUi,
    getRemoteAddress: () => state.remote,
  });
  await server.start();
  t.after(() => server.stop());
  return { server, state };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createHttpServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function openSession(server) {
  const res = await fetch(server.url);
  return sessionFrom(await res.text());
}

/** A seeded store with a clock that advances 1 ms per record, so ordering is exact. */
function seededStore(t, record) {
  let clock = 1000;
  const store = openStore({ path: ':memory:', now: () => { clock += 0.001; return clock; } });
  t.after(() => store.close());
  record(store);
  return store;
}

/** Wrap a store so every write method is counted; read methods pass through. */
function guardWrites(inner) {
  const writes = [];
  const guard = Object.create(inner);
  for (const name of ['record', 'set', 'pruneAttempts', 'claimPush', 'setPushStatus', 'claimOutbox', 'markOutboxSent', 'noteOutboxError']) {
    if (typeof inner[name] !== 'function') continue;
    guard[name] = (...args) => { writes.push(name); return inner[name](...args); };
  }
  guard.writes = writes;
  return guard;
}

function validationRows(store) {
  store.record({ subject: 'solved-tier0', stage: 'ocr', payload: { text: 'hoeveel' }, ms: 40 });
  store.record({ subject: 'solved-tier0', stage: 'tier0', payload: { answer: '1' }, ms: 2 });
  store.record({ subject: 'solved-tier0', stage: 'validate', ok: true, ms: 45, payload: { answer: '1', class: 'count', confident: true, method: 'tier0:count' } });
  store.record({ subject: 'solved-tier0', stage: 'respond', ok: true, payload: { answer: '1', sent: true } });

  store.record({ subject: 'solved-vision', stage: 'validate', ok: true, ms: 900, payload: { answer: '7', class: 'count', confident: true, method: 'model:vision' } });
  store.record({ subject: 'solved-vision', stage: 'model-vision', payload: {}, ms: 900 });
  store.record({ subject: 'solved-vision', stage: 'respond', ok: true, payload: { answer: '7', sent: true } });

  store.record({ subject: 'withheld', stage: 'validate', ok: true, ms: 500, payload: { answer: '3', class: 'count', confident: false, method: 'model:text' } });
  store.record({ subject: 'withheld', stage: 'model-text', payload: {}, ms: 500 });
  store.record({ subject: 'withheld', stage: 'respond', ok: false, payload: { answer: '3', sent: false, reason: 'unconfirmed' } });

  store.record({ subject: 'unresolved', stage: 'validate', ok: false, payload: { answer: null, class: 'unknown', confident: false, method: null, disputed: false } });
  store.record({ subject: 'unresolved', stage: 'respond', ok: false, payload: { answer: null, sent: false, reason: 'unresolved' } });
}

test('the page lists the last solves, newest first, with answer, method and delivery (#64)', async (t) => {
  const store = seededStore(t, validationRows);
  const config = validateConfig({ ui: { stats_recent_solves: 5 } }).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const res = await fetch(`${baseUrl(server)}/stats?session=${encodeURIComponent(session)}`);
  const html = await res.text();
  assert.equal(res.status, 200, html);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  // Newest first: the last recorded subject leads. Match the subject cell, not the
  // word in a header or delivery label.
  const order = ['unresolved', 'withheld', 'solved-vision', 'solved-tier0'].map((s) => html.indexOf(`<code>${s}</code>`));
  assert.ok(order.every((i) => i >= 0), 'every seeded solve is listed');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'newest first');

  assert.match(html, /solved-vision/);
  assert.match(html, /model:vision/, 'the method is shown');
  assert.match(html, /sent/, 'a delivered answer is labelled sent');
  assert.match(html, /withheld - unconfirmed/, 'a withheld answer names the reason');
  assert.match(html, /nothing sent/, 'an unresolved answer is labelled as nothing sent');
  assert.match(html, /\d+ ms/, 'the recorded timing is shown');
});

test('the traffic totals are labelled distinct puzzles and took is per solve (#86)', async (t) => {
  // The same image re-solved: two validate rows for one subject. The totals count it
  // once ("distinct puzzles"); the recent list shows both with their own times.
  let clock = 1_000_000;
  const store = openStore({ path: ':memory:', now: () => { clock += 0.001; return clock; } });
  t.after(() => store.close());
  store.record({ subject: 'http-abc', stage: 'validate', ok: true, ms: 300, payload: { answer: '7', class: 'count', confident: true, method: 'tier0:count' } });
  store.record({ subject: 'http-abc', stage: 'validate', ok: true, ms: 250, payload: { answer: '7', class: 'count', confident: true, method: 'tier0:count' } });

  const config = validateConfig({}).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const html = await (await fetch(`${baseUrl(server)}/stats?session=${session}`)).text();

  const trafficSection = html.slice(html.indexOf('Recorded traffic'), html.indexOf('Offline corpus'));
  assert.match(trafficSection, /distinct puzzles/, 'the total is labelled as distinct puzzles');
  assert.match(trafficSection, /one row per subject/, 'the label states the counting unit');
  assert.equal(/\bseen\b/.test(trafficSection), false, 'the ambiguous "seen" label is gone from the traffic section');
  // Each solve reports its own recorded duration, not the subject span.
  assert.match(html, /300 ms/);
  assert.match(html, /250 ms/);
});

test('ui.stats_recent_solves defaults to 5 and bounds the list (#64)', async (t) => {
  // 8 solves, default config.
  const store = seededStore(t, (s) => {
    for (let i = 0; i < 8; i += 1) {
      s.record({ subject: `p${i}`, stage: 'validate', ok: true, payload: { answer: String(i), confident: true, method: 'tier0:count' } });
    }
  });
  const config = validateConfig({}).config;
  assert.equal(config.ui.stats_recent_solves, 5, 'the default is 5');
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const html = await (await fetch(`${baseUrl(server)}/stats?session=${session}`)).text();
  // Count the subject cells, not the word anywhere else.
  const rows = [...html.matchAll(/<td><code>p\d+<\/code><\/td>/g)];
  assert.equal(rows.length, 5, 'the default shows exactly 5');

  const twoConfig = validateConfig({ ui: { stats_recent_solves: 2 } }).config;
  const { server: server2 } = await startUi(t, { store, config: twoConfig });
  const session2 = await openSession(server2);
  const html2 = await (await fetch(`${baseUrl(server2)}/stats?session=${session2}`)).text();
  assert.equal([...html2.matchAll(/<td><code>p\d+<\/code><\/td>/g)].length, 2, 'the setting changes the count');
});

test('traffic and corpus accuracy are separate, labelled, and never blended (#64)', async (t) => {
  const store = seededStore(t, validationRows);
  const config = validateConfig({}).config;
  const corpusReport = { overall: { seen: 10, valid: 9, correct: 9, gradeable: 10, accuracy: 0.9, sentableRate: 0.9 } };
  const { server } = await startUi(t, { store, config, corpusReport });
  const session = await openSession(server);
  const html = await (await fetch(`${baseUrl(server)}/stats?session=${session}`)).text();

  assert.match(html, /Recorded traffic \(real\)/);
  assert.match(html, /Offline corpus \(synthetic fixtures\)/);
  assert.match(html, /regression guard, not real-world accuracy/, 'the synthetic figure carries its warning');
  // The corpus figure is a percentage; the traffic figure is a sent-able rate.
  assert.match(html, /90\.0%/, 'the corpus accuracy is shown');
  assert.match(html, /sent-able/);
  // The labels must keep the two apart: real traffic must not be called accuracy and
  // the synthetic number must not headline the real section.
  const trafficSection = html.slice(html.indexOf('Recorded traffic'), html.indexOf('Offline corpus'));
  assert.equal(trafficSection.includes('90.0%'), false, 'the synthetic figure must not leak into the traffic section');
  assert.match(trafficSection, /sent-able rate/, 'the real traffic headline names what it measures');
  assert.equal(/90\.0%/.test(trafficSection), false);
});

test('the page explains the retention window (#64)', async (t) => {
  const store = seededStore(t, validationRows);
  const config = validateConfig({ storage: { retain_days: 7 } }).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const html = await (await fetch(`${baseUrl(server)}/stats?session=${session}`)).text();
  assert.match(html, /moving window/);
  assert.match(html, /storage\.retain_days/);
  assert.match(html, /7 day\(s\)/);
});

test('the statistics page is read-only: no write is reachable from it (#64)', async (t) => {
  const inner = seededStore(t, validationRows);
  const store = guardWrites(inner);
  const config = validateConfig({}).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const res = await fetch(`${baseUrl(server)}/stats?session=${session}`);
  assert.equal(res.status, 200);
  assert.deepEqual(store.writes, [], 'a GET /stats must not call a single store write');

  // There is no POST behind the page: an attempted write cannot reach the store.
  const post = await fetch(`${baseUrl(server)}/stats?session=${session}`, { method: 'POST', body: 'x=1' });
  assert.equal(post.status, 404, 'POST /stats is not a route');
  assert.deepEqual(store.writes, [], 'a POST to the page cannot write either');
});

test('a load does not run an unbounded query against a large database (#64)', async (t) => {
  // Many rows: 400 subjects each with several attempts. If the page still did the old
  // per-subject `attemptsFor` loop this would be 400x the work.
  const inner = seededStore(t, (s) => {
    for (let i = 0; i < 400; i += 1) {
      s.record({ subject: `p${i}`, stage: 'ocr', payload: { text: 'x' }, ms: 1 });
      s.record({ subject: `p${i}`, stage: 'model-text', payload: {}, ms: 1 });
      s.record({ subject: `p${i}`, stage: 'validate', ok: true, payload: { answer: String(i), confident: true, method: 'model:text' } });
    }
  });
  let perSubjectCalls = 0;
  const store = Object.create(inner);
  store.attemptsFor = (...args) => { perSubjectCalls += 1; return inner.attemptsFor(...args); };

  const config = validateConfig({ ui: { stats_recent_solves: 5 } }).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const res = await fetch(`${baseUrl(server)}/stats?session=${session}`);
  assert.equal(res.status, 200);
  assert.equal(perSubjectCalls, 0, 'the totals must use the SQL aggregate, not the N+1 loop');
  const recent = inner.recentSolves(5);
  assert.equal(recent.length, 5, 'the recent list is bounded by the configured limit');

  // The plan, not just the row count: the recent query is an indexed scan that stops
  // at the LIMIT rather than reading and sorting the whole table.
  const plan = inner.db
    .prepare("EXPLAIN QUERY PLAN SELECT subject FROM attempts WHERE stage = ? ORDER BY created_at DESC, id DESC LIMIT ?")
    .all('validate', 5)
    .map((row) => row.detail)
    .join('\n');
  assert.match(plan, /idx_attempts_created_at/);
});

test('the access gate covers the statistics route too (#64)', async (t) => {
  const store = seededStore(t, validationRows);
  const config = validateConfig({}).config;
  const { server, state } = await startUi(t, {
    store,
    config,
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: 'scrypt$1$1$1$AA$AA',
  });
  state.remote = '10.9.9.9';
  const refused = await fetch(`${baseUrl(server)}/stats?session=anything`);
  assert.equal(refused.status, 403, 'a disallowed source is refused before the handler');
});

test('the transcript and image bytes are never rendered by default (#64)', async (t) => {
  const store = seededStore(t, (s) => {
    s.record({
      subject: 'p',
      stage: 'validate',
      ok: true,
      payload: { answer: '1', confident: true, method: 'tier0:count', transcript: 'SECRET-TRANSCRIPT-TEXT' },
    });
    s.record({ subject: 'p', stage: 'image-ref', variant: 'source', payload: { path: '/tmp/secret.png' } });
  });
  const config = validateConfig({}).config;
  const { server } = await startUi(t, { store, config });
  const session = await openSession(server);
  const html = await (await fetch(`${baseUrl(server)}/stats?session=${session}`)).text();
  assert.equal(html.includes('SECRET-TRANSCRIPT-TEXT'), false, 'the OCR transcript must not render');
  assert.equal(html.includes('/tmp/secret.png'), false, 'the image reference must not render');
});

test('without a store the statistics route is a 404, like the solve page without a core (#64)', async (t) => {
  const { server } = await startUi(t, {});
  const session = await openSession(server);
  const res = await fetch(`${baseUrl(server)}/stats?session=${session}`);
  assert.equal(res.status, 404);
});

test('the settings page links to the statistics page with the session (#64)', async (t) => {
  const store = seededStore(t, validationRows);
  const config = validateConfig({}).config;
  const { server } = await startUi(t, { store, config });
  const res = await fetch(server.url);
  const html = await res.text();
  const session = sessionFrom(html);
  assert.match(html, new RegExp(`/stats\\?session=${session}`));
});
