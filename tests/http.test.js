/**
 * HTTP ingress tests.
 *
 * These bind a real loopback server and make real HTTP requests (nothing mocked at
 * the socket level), which is the right level of test here: the security properties
 * are in the wiring - auth, caps, status mapping - not in a dispatch function.
 *
 * The one test that runs the real OCR pipeline posts the real corpus image and
 * measures wall-clock latency, which is the end-to-end evidence the Pushbullet path
 * could not provide without an account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  createHttpServer,
  createRateLimiter,
  decodeBase64Image,
  assertHttpUrl,
  imageErrorStatus,
  tokenMatches,
  HttpError,
  SolveTimeoutError,
} from '../src/http/server.js';
import { validateImageBuffer } from '../src/pushbullet/files.js';
import { createSolveCore } from '../src/solver/core.js';
import { createApp, MissingHttpTokenError } from '../src/app.js';
import { validateConfig } from '../src/config.js';
import { createOcrWorker } from '../src/ocr/recognize.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusImage = join(here, '..', 'corpus', '001-count-kleuren.png');
const TOKEN = 'test-token-do-not-log';

function collectingLogger() {
  const logs = [];
  const logger = { logs };
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => logs.push({ level, args });
  }
  return logger;
}

function scriptedCore(result = {}) {
  const value = {
    answer: result.answer ?? null,
    confident: result.confident ?? false,
    method: result.method ?? null,
    puzzleClass: result.puzzleClass ?? null,
    transcript: result.transcript ?? '',
    model: result.model ?? null,
    opinions: result.opinions ?? [],
    disputed: result.disputed ?? false,
  };
  return { solve: async () => value };
}

async function startServer(t, { core, rawHttp = {}, responder = null, logger = collectingLogger(), ...overrides } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-http-'));
  const config = validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0, ...rawHttp } }).config;
  const server = createHttpServer({
    core: core ?? scriptedCore({ answer: '2', confident: true, method: 'tier0:count' }),
    token: TOKEN,
    config,
    inboxDir: join(dir, 'inbox'),
    responder,
    logger,
    ...overrides,
  });
  await server.start();
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, url: `http://127.0.0.1:${server.port()}/v1/solve`, dir, logger, config };
}

async function post(url, { token = TOKEN, body, contentType, method = 'POST' } = {}) {
  const headers = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (contentType) headers['content-type'] = contentType;
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null for non-JSON bodies
  }
  return { status: res.status, headers: res.headers, text, json };
}

const smallPng = () => sharp({ create: { width: 200, height: 44, channels: 3, background: '#ffffff' } }).png().toBuffer();

// ---------------------------------------------------------------------------
// The real end-to-end path + measured latency
// ---------------------------------------------------------------------------

test('a real corpus image is solved over HTTP, and the latency is measured', async (t) => {
  const worker = await createOcrWorker();
  t.after(() => worker.terminate());
  const config = validateConfig({}).config;
  const core = createSolveCore({ worker, config });
  const { url } = await startServer(t, { core });

  const bytes = readFileSync(corpusImage);
  const started = performance.now();
  const res = await post(url, { body: bytes, contentType: 'image/png' });
  const elapsedMs = performance.now() - started;

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '2');
  assert.equal(res.json.method, 'tier0:count');
  assert.equal(res.json.confident, true);
  assert.equal(res.json.puzzleClass, 'count');
  assert.equal(res.json.cost.escalated, false);
  assert.equal(res.json.cost.tier, 'tier0');
  // This number is the deliverable: the Pushbullet path could not produce it without
  // a live account. Print it so a suite run reports it.
  console.log(`MEASURED http end-to-end latency (real OCR): ${elapsedMs.toFixed(0)}ms`);
  assert.ok(elapsedMs > 0 && elapsedMs < 60_000, `latency ${elapsedMs}ms must be plausible`);
});

test('the HTTP response never echoes the image bytes', async (t) => {
  const { url } = await startServer(t);
  const bytes = await smallPng();
  const res = await post(url, { body: bytes, contentType: 'image/png' });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes('data:image'), 'no inline image data may be returned');
  assert.ok(!res.text.includes(bytes.toString('base64')), 'the image must not be echoed base64-encoded');
  assert.deepEqual(Object.keys(res.json.image).sort(), ['bytes', 'height', 'width']);
});

test('cost names the model that was consulted, even when tier0 won', async (t) => {
  const core = scriptedCore({
    answer: '2',
    confident: true,
    method: 'tier0:count',
    // A model was consulted as a secondary opinion; the tier0 answer still won.
    model: { text: { answer: '2' }, vision: null },
  });
  const { url } = await startServer(t, { core });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.cost.escalated, true, 'a consulted model means the caller paid');
  assert.deepEqual(res.json.cost.model, ['gpt-4o-mini']);
});

// ---------------------------------------------------------------------------
// The invariant: unresolved is 422, never a guess
// ---------------------------------------------------------------------------

test('an unresolved puzzle is a 422 with a reason and a null answer', async (t) => {
  const core = scriptedCore({ answer: null, confident: false, disputed: true, method: null });
  const { url } = await startServer(t, { core });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.status, 'unresolved');
  assert.equal(res.json.answer, null, 'an unresolved puzzle must never invent an answer');
  assert.match(res.json.reason, /disagreed/);
  assert.equal(res.json.cost.escalated, false);
});

test('an unresolved 422 carries the human reply as an extra field, never as prose', async (t) => {
  const config = validateConfig({
    http: { enabled: true, bind: '127.0.0.1', port: 0 },
    reply: { unresolved_title: 'Niet gelukt', unresolved_text: 'Kon de puzzel niet lezen.' },
  }).config;
  const core = scriptedCore({ answer: null, confident: false, method: null });
  const { url } = await startServer(t, { core, config });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.answer, null, 'the human text must not replace the structured answer field');
  assert.equal(res.json.status, 'unresolved');
  assert.deepEqual(res.json.unresolvedReply, { title: 'Niet gelukt', text: 'Kon de puzzel niet lezen.' });
});

test('a solved 200 does not carry an unresolvedReply field', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.unresolvedReply, undefined);
});

test('a 422 omits unresolvedReply when replies are disabled', async (t) => {
  const config = validateConfig({
    http: { enabled: true, bind: '127.0.0.1', port: 0 },
    reply: { enabled: false },
  }).config;
  const core = scriptedCore({ answer: null, confident: false, method: null });
  const { url } = await startServer(t, { core, config });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.unresolvedReply, undefined, 'no human reply exists when replies are off');
});

// ---------------------------------------------------------------------------
// Auth is mandatory
// ---------------------------------------------------------------------------

test('an unauthenticated request is refused with 401', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { token: null, body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 401, res.text);
  assert.equal(res.json.error, 'unauthorized');
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
});

test('a wrong bearer token is refused with 401', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { token: 'not-the-token', body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 401);
});

test('the correct bearer token is accepted', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 200, res.text);
});

// ---------------------------------------------------------------------------
// Bad image vs auth: distinct status codes
// ---------------------------------------------------------------------------

test('non-image bytes are a 415, not a 400 or a 500', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: Buffer.from('this is not an image at all'), contentType: 'image/png' });
  assert.equal(res.status, 415, res.text);
  assert.equal(res.json.error, 'invalid_image');
  assert.equal(res.json.reason, 'magic');
});

test('JSON without an image field is a 400', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: JSON.stringify({ puzzle: 'where?' }), contentType: 'application/json' });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error, 'missing_image');
});

test('invalid JSON is a 400', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: '{not json', contentType: 'application/json' });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'bad_json');
});

test('an unsupported content type is a 415', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: 'hello', contentType: 'text/plain' });
  assert.equal(res.status, 415);
  assert.equal(res.json.error, 'unsupported_media_type');
});

// ---------------------------------------------------------------------------
// Body cap
// ---------------------------------------------------------------------------

test('a body over the configured cap is a 413', async (t) => {
  const { url } = await startServer(t, { rawHttp: { max_body_bytes: 128 } });
  const res = await post(url, { body: Buffer.alloc(4096, 0xab), contentType: 'image/png' });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error, 'payload_too_large');
});

// ---------------------------------------------------------------------------
// Rate limit
// ---------------------------------------------------------------------------

test('requests over the rate limit are a 429 with Retry-After', async (t) => {
  const { url } = await startServer(t, { rawHttp: { rate_limit_per_min: 2 } });
  const first = await post(url, { body: await smallPng(), contentType: 'image/png' });
  const second = await post(url, { body: await smallPng(), contentType: 'image/png' });
  const third = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429, third.text);
  assert.equal(third.json.error, 'rate_limited');
  assert.ok(Number(third.headers.get('retry-after')) >= 1);
});

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------

test('image_base64 in JSON is accepted', async (t) => {
  const bytes = await smallPng();
  const { url } = await startServer(t);
  const res = await post(url, {
    body: JSON.stringify({ image_base64: bytes.toString('base64') }),
    contentType: 'application/json',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '2');
});

test('a data: URL in image_base64 is accepted', async (t) => {
  const bytes = await smallPng();
  const { url } = await startServer(t);
  const res = await post(url, {
    body: JSON.stringify({ image_base64: `data:image/png;base64,${bytes.toString('base64')}` }),
    contentType: 'application/json',
  });
  assert.equal(res.status, 200, res.text);
});

test('image_url is fetched and solved', async (t) => {
  const bytes = await smallPng();
  const imageServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => imageServer.close(resolve)));
  const imageUrl = `http://127.0.0.1:${imageServer.address().port}/puzzle.png`;

  const { url } = await startServer(t);
  const res = await post(url, { body: JSON.stringify({ image_url: imageUrl }), contentType: 'application/json' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '2');
});

test('multipart/form-data with a file part is accepted', async (t) => {
  const bytes = await smallPng();
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'puzzle.png');
  const { url } = await startServer(t);
  const res = await post(url, { body: form });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '2');
});

// ---------------------------------------------------------------------------
// The default egress is the HTTP response, never a Pushbullet push
// ---------------------------------------------------------------------------

/**
 * A fetch that refuses any Pushbullet host. The default HTTP path must not call
 * fetch at all; a request that did would trip this rather than pass silently.
 */
function pushbulletHostGuard(base = globalThis.fetch) {
  const calls = [];
  const fetchImpl = (url, init) => {
    const href = String(url);
    calls.push(href);
    if (/pushbullet\.com/i.test(href)) {
      throw new Error(`unexpected Pushbullet request on the default HTTP path: ${href}`);
    }
    return base(url, init);
  };
  return { fetchImpl, calls };
}

/** A responder that must never run: invoking it is the regression under test. */
function responderMustNotRun() {
  const calls = [];
  return {
    calls,
    respond: async (push, result) => {
      calls.push({ push, result });
      throw new Error('the responder must not run when deliver is not "pushbullet"');
    },
  };
}

test('the default path never fetches Pushbullet and never invokes the responder', async (t) => {
  const guard = pushbulletHostGuard();
  const responder = responderMustNotRun();
  const { url } = await startServer(t, { responder, fetchImpl: guard.fetchImpl });
  const bytes = await smallPng();

  // Each input shape parses `deliver` on its own, so each is checked, plus an
  // explicit `deliver: null` to pin the "absent means absent" contract.
  const raw = await post(url, { body: bytes, contentType: 'image/png' });
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'puzzle.png');
  const multipart = await post(url, { body: form });
  const jsonDefault = await post(url, {
    body: JSON.stringify({ image_base64: bytes.toString('base64') }),
    contentType: 'application/json',
  });
  const jsonNull = await post(url, {
    body: JSON.stringify({ image_base64: bytes.toString('base64'), deliver: null }),
    contentType: 'application/json',
  });

  for (const res of [raw, multipart, jsonDefault, jsonNull]) {
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.answer, '2');
    assert.equal(res.json.delivery, undefined, 'the default path must not report a delivery');
  }
  assert.equal(responder.calls.length, 0, 'the responder must never be invoked by default');
  assert.equal(guard.calls.length, 0, 'the default path must not fetch anything');
});

// ---------------------------------------------------------------------------
// Optional Pushbullet egress, for exercising the note-push path
// ---------------------------------------------------------------------------

test('deliver=pushbullet drives the responder with a synthetic push', async (t) => {
  const calls = [];
  const responder = {
    respond: async (push, result) => {
      calls.push({ push, result });
      return { sent: true, reason: 'sent', strategy: 'note-push' };
    },
  };
  const { url } = await startServer(t, { responder });
  const res = await post(url, {
    body: JSON.stringify({ image_base64: (await smallPng()).toString('base64'), deliver: 'pushbullet' }),
    contentType: 'application/json',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.delivery.requested, 'pushbullet');
  assert.equal(res.json.delivery.sent, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].push.iden, /^http-[0-9a-f]{32}$/);
  assert.equal(calls[0].push.type, 'file');
});

test('deliver=pushbullet without a responder reports why nothing was sent', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, {
    body: JSON.stringify({ image_base64: (await smallPng()).toString('base64'), deliver: 'pushbullet' }),
    contentType: 'application/json',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.delivery.sent, false);
  assert.equal(res.json.delivery.reason, 'reply-disabled');
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

test('a GET on the solve path is 405 with Allow: POST', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { method: 'GET' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST');
});

test('an unknown path is a 404', async (t) => {
  const { server } = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${server.port()}/nope`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// The bind warning
// ---------------------------------------------------------------------------

function fakeServerFactory() {
  return function fakeServer() {
    const events = {};
    return {
      listening: false,
      once(event, fn) {
        (events[event] ??= []).push(fn);
        return this;
      },
      off(event, fn) {
        events[event] = (events[event] ?? []).filter((x) => x !== fn);
        return this;
      },
      on() {
        return this;
      },
      listen({ port }) {
        this.listening = true;
        const address = { port: port || 44444 };
        this.address = () => address;
        for (const fn of events.listening ?? []) fn();
        return this;
      },
      close(cb) {
        this.listening = false;
        cb?.();
      },
      closeAllConnections() {},
      address: () => null,
    };
  };
}

test('a non-loopback bind logs a loud warning', async () => {
  const logger = collectingLogger();
  const server = createHttpServer({
    core: scriptedCore({ answer: '2' }),
    token: TOKEN,
    config: validateConfig({ http: { enabled: true, bind: '0.0.0.0', port: 44444 } }).config,
    inboxDir: join(tmpdir(), 'puzzlesolver-http-bind'),
    logger,
    createServerImpl: fakeServerFactory(),
  });
  await server.start();
  assert.ok(
    logger.logs.some((l) => l.level === 'warn' && /exposes the solver beyond this machine/.test(l.args.join(' '))),
    'binding 0.0.0.0 must warn'
  );
  await server.stop();
});

// ---------------------------------------------------------------------------
// Unit-level pieces
// ---------------------------------------------------------------------------

test('imageErrorStatus maps every fetcher reason', () => {
  assert.equal(imageErrorStatus({ reason: 'size' }), 413);
  assert.equal(imageErrorStatus({ reason: 'http' }), 502);
  assert.equal(imageErrorStatus({ reason: 'no-url' }), 400);
  assert.equal(imageErrorStatus({ reason: 'magic' }), 415);
  assert.equal(imageErrorStatus({ reason: 'decode' }), 415);
  assert.equal(imageErrorStatus({ reason: 'height' }), 415);
});

test('tokenMatches is strict about the scheme and the value', () => {
  assert.equal(tokenMatches('abc', 'Bearer abc'), true);
  assert.equal(tokenMatches('abc', 'bearer abc'), true);
  assert.equal(tokenMatches('abc', 'abc'), false);
  assert.equal(tokenMatches('abc', 'Bearer abd'), false);
  assert.equal(tokenMatches('abc', 'Bearer abcd'), false);
  assert.equal(tokenMatches('', 'Bearer '), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('decodeBase64Image strips a data URL and rejects garbage', () => {
  const bytes = Buffer.from('hello');
  assert.deepEqual(decodeBase64Image(bytes.toString('base64')), bytes);
  assert.deepEqual(decodeBase64Image(`data:image/png;base64,${bytes.toString('base64')}`), bytes);
  assert.throws(() => decodeBase64Image('not base64 !!!'), HttpError);
  assert.throws(() => decodeBase64Image(''), HttpError);
});

test('assertHttpUrl allows http(s) and rejects everything else', () => {
  assert.equal(assertHttpUrl('https://example.test/a.png'), 'https://example.test/a.png');
  assert.equal(assertHttpUrl('http://127.0.0.1/a.png'), 'http://127.0.0.1/a.png');
  assert.throws(() => assertHttpUrl('file:///etc/passwd'), HttpError);
  assert.throws(() => assertHttpUrl('not a url'), HttpError);
});

test('createRateLimiter is a fixed window', () => {
  let clock = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => clock });
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, true);
  assert.equal(limiter.take('a').allowed, false);
  assert.equal(limiter.take('b').allowed, true, 'a different client has its own budget');
  clock = 60_001;
  assert.equal(limiter.take('a').allowed, true, 'the window resets');
});

test('validateImageBuffer shares the decode gate', async () => {
  const png = await smallPng();
  const ok = await validateImageBuffer(png);
  assert.equal(ok.ext, '.png');
  assert.ok(ok.width > 0 && ok.height > 0);
  await assert.rejects(() => validateImageBuffer(Buffer.from('nope')), /not a recognised image/);
  await assert.rejects(() => validateImageBuffer(png, { maxBytes: 10 }), /larger than/);
});

// ---------------------------------------------------------------------------
// App assembly: HTTP-only with no Pushbullet account
// ---------------------------------------------------------------------------

test('the app runs HTTP-only with no Pushbullet token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-http-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logger = collectingLogger();

  const app = await createApp({
    config: validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0 } }).config,
    env: { HTTP_AUTH_TOKEN: 'http-only-secret' },
    providers: [],
    // No client and no Pushbullet token: this must not throw.
    reasoner: null,
    solveImage: async () => ({ answer: '7', confident: true, method: 'tier0:arithmetic', puzzleClass: 'arithmetic', transcript: 'x', opinions: [], model: null, disputed: false }),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger,
  });
  t.after(() => app.stop());

  assert.equal(app.listener, null, 'no Pushbullet token means no Pushbullet ingress');
  assert.ok(app.httpServer, 'the HTTP ingress is present');
  await app.start();
  assert.equal(app.status().http.listening, true);

  const res = await post(`http://127.0.0.1:${app.httpServer.port()}/v1/solve`, {
    token: 'http-only-secret',
    body: await smallPng(),
    contentType: 'image/png',
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '7');
});

test('an HTTP-only app makes zero Pushbullet requests while solving', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-http-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logger = collectingLogger();

  // Installed before createApp so the running server's default fetch is this guard:
  // any Pushbullet request throws rather than succeeding invisibly.
  const originalFetch = globalThis.fetch;
  const outbound = [];
  globalThis.fetch = (url, init) => {
    const href = String(url);
    outbound.push(href);
    if (/pushbullet\.com/i.test(href)) {
      throw new Error(`an HTTP-only app reached a Pushbullet host: ${href}`);
    }
    return originalFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const app = await createApp({
    config: validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0 } }).config,
    env: { HTTP_AUTH_TOKEN: 'http-only-secret' }, // no PUSHBULLET_TOKEN anywhere
    providers: [],
    reasoner: null,
    solveImage: async () => ({ answer: '7', confident: true, method: 'tier0:arithmetic', puzzleClass: 'arithmetic', transcript: 'x', opinions: [], model: null, disputed: false }),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger,
  });
  t.after(() => app.stop());
  await app.start();

  const res = await post(`http://127.0.0.1:${app.httpServer.port()}/v1/solve`, {
    token: 'http-only-secret',
    body: await smallPng(),
    contentType: 'image/png',
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '7');
  assert.equal(res.json.delivery, undefined, 'the HTTP response is the only delivery');
  assert.equal(outbound.filter((url) => /pushbullet\.com/i.test(url)).length, 0, 'no request may reach a Pushbullet host');
});

test('http.enabled without a token refuses to start', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-http-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      createApp({
        config: validateConfig({ http: { enabled: true } }).config,
        env: {},
        providers: [],
        client: { createNote: async () => ({}) }, // a Pushbullet client so the pushbullet path is satisfied
        reasoner: null,
        solveImage: async () => ({ answer: '1' }),
        createWorker: async () => ({ terminate: async () => {} }),
        inboxDir: join(dir, 'inbox'),
        statePath: join(dir, 'state.db'),
        logger: collectingLogger(),
      }),
    (err) => {
      assert.equal(err.name, 'MissingHttpTokenError');
      assert.match(err.message, /HTTP_AUTH_TOKEN/);
      return true;
    }
  );
});

test('the solve timeout is a 504, not a hang', async (t) => {
  const core = { solve: () => new Promise(() => {}) }; // never resolves
  const { url } = await startServer(t, { core, rawHttp: { timeout_ms: 30 } });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 504, res.text);
  assert.equal(res.json.error, 'solve_timeout');
});

test('SolveTimeoutError carries a 504 status', () => {
  assert.equal(new SolveTimeoutError(1000).status, 504);
  assert.equal(new SolveTimeoutError(1000).code, 'solve_timeout');
});
