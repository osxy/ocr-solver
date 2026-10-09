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
import { createResponder } from '../src/pushbullet/respond.js';
import { memoryStore } from '../src/state/db.js';
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
// Pixel bomb: tiny on the wire, enormous once decoded (issue #41)
// ---------------------------------------------------------------------------

test('a small file that decodes to a pixel bomb is a 413 before the solve runs', async (t) => {
  let solveCalls = 0;
  const core = { solve: async () => { solveCalls += 1; return { answer: '2', confident: true, method: 'tier0:count' }; } };
  const { url } = await startServer(t, { core });
  // 2000x2000 white PNG: ~16 KB on the wire, 4,000,000 pixels decoded. It is well
  // inside the 5 MiB byte cap and would have gone straight to `buildVariants` before
  // the pixel cap existed.
  const bomb = await sharp({ create: { width: 2000, height: 2000, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  assert.ok(bomb.length < 5 * 1024 * 1024, 'the bomb must be within the byte cap');

  const started = performance.now();
  const res = await post(url, { body: bomb, contentType: 'image/png' });
  const elapsedMs = performance.now() - started;

  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.error, 'invalid_image');
  assert.equal(res.json.reason, 'pixels');
  assert.equal(solveCalls, 0, 'the gate must reject before the solve (and buildVariants) runs');
  assert.ok(elapsedMs < 2000, `rejection took ${elapsedMs.toFixed(0)}ms; it must not decode the pixels`);
});

test('a very wide image is a 413 with reason width', async (t) => {
  const { url } = await startServer(t);
  const wide = await sharp({ create: { width: 3000, height: 100, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const res = await post(url, { body: wide, contentType: 'image/png' });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.reason, 'width');
});

test('an image just under the pixel cap still solves', async (t) => {
  const { url } = await startServer(t);
  // 1000x500 = 500,000 px, half the default cap - the cap must not reject it.
  const bytes = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const res = await post(url, { body: bytes, contentType: 'image/png' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.image.width, 1000);
  assert.equal(res.json.image.height, 500);
});

test('the HTTP gate honours a configured pixel cap', async (t) => {
  const config = validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0 }, image: { max_pixels: 1000 } }).config;
  const { url } = await startServer(t, { config });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 413, res.text);
  assert.equal(res.json.reason, 'pixels');
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
  assert.equal(imageErrorStatus({ reason: 'width' }), 413);
  assert.equal(imageErrorStatus({ reason: 'pixels' }), 413);
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
  await assert.rejects(
    () => validateImageBuffer(png, { maxWidth: 100 }),
    (err) => err.reason === 'width'
  );
  await assert.rejects(
    () => validateImageBuffer(png, { maxPixels: 100 }),
    (err) => err.reason === 'pixels'
  );
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

// The old fixture was `() => new Promise(() => {})` - a solve that never resolves.
// That is fine while the deadline works, but break `withTimeout` and the request
// never completes, so the whole run hangs instead of failing (#37). Resolving after
// twice the budget keeps the 504 assertion *and* terminates under that mutation. The
// explicit per-test timeout is the backstop: a regression fails by name in seconds.
// (`solvedResult` is a hoisted declaration later in this file.)
test('the solve timeout is a 504, not a hang', { timeout: 5000 }, async (t) => {
  const timeoutMs = 30;
  const core = {
    solve: () => new Promise((resolve) => setTimeout(() => resolve(solvedResult()), timeoutMs * 2)),
  };
  const { url } = await startServer(t, { core, rawHttp: { timeout_ms: timeoutMs } });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });
  assert.equal(res.status, 504, res.text);
  assert.equal(res.json.error, 'solve_timeout');
});

test('SolveTimeoutError carries a 504 status', () => {
  assert.equal(new SolveTimeoutError(1000).status, 504);
  assert.equal(new SolveTimeoutError(1000).code, 'solve_timeout');
});

// ---------------------------------------------------------------------------
// Three claims in src/http/server.js that had no test behind them (#31)
// ---------------------------------------------------------------------------

/** A solve result the HTTP layer reports as a solved 200. Local so each test states it. */
function solvedResult() {
  return {
    answer: '2',
    confident: true,
    method: 'tier0:count',
    puzzleClass: 'count',
    transcript: '2',
    model: null,
    opinions: [],
    disputed: false,
  };
}

// Claim 1: one solve at a time, because the shared Tesseract worker is not safe
// to drive concurrently.

test('concurrent POST /v1/solve requests are serialised behind the queue', async (t) => {
  const delayMs = 60;
  let active = 0;
  let maxActive = 0;
  const trace = [];
  const core = {
    solve: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      trace.push(`start:${active}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      trace.push('end');
      return solvedResult();
    },
  };
  const { url } = await startServer(t, { core });
  const bytes = await smallPng();

  const responses = await Promise.all([
    post(url, { body: bytes, contentType: 'image/png' }),
    post(url, { body: bytes, contentType: 'image/png' }),
    post(url, { body: bytes, contentType: 'image/png' }),
  ]);

  for (const res of responses) assert.equal(res.status, 200, res.text);
  assert.equal(maxActive, 1, `the shared worker was driven ${maxActive} times at once`);
  // Pins the shape too: every solve ends before the next begins, all three ran.
  assert.deepEqual(trace, ['start:1', 'end', 'start:1', 'end', 'start:1', 'end']);
});

// Claim 2: the response never contains a secret or an upstream error body. The
// image half is tested above; these cover the 500 body, the most externally
// visible surface and the one not yet covered by the log/store redaction tests.

test('a model failure whose upstream body carries a key never reaches the HTTP response', async (t) => {
  const secret = 'sk-or-v1-' + 'deadbeef'.repeat(8);
  const upstream = `upstream 500 body: {"error":{"api_key":"${secret}"}}`;
  const core = {
    solve: async () => {
      throw new Error(upstream);
    },
  };
  const logger = collectingLogger();
  const { url } = await startServer(t, { core, logger });

  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 500, res.text);
  assert.equal(res.json.error, 'internal');
  assert.deepEqual(Object.keys(res.json).sort(), ['error', 'id'], 'the 500 body must be a bare error id');
  assert.equal(res.text.includes(secret), false, 'the key must not reach the response body');
  assert.equal(res.text.includes('deadbeef'), false, 'no part of the key body may survive');
  assert.equal(res.text.includes('upstream'), false, 'the upstream error body must not reach the response');

  // The operator still gets a redacted line, and the response id identifies it.
  const line = logger.logs.map((l) => l.args.join(' ')).find((text) => /request .* failed/.test(text));
  assert.ok(line, 'the failure was still logged for the operator');
  assert.equal(line.includes(secret), false, 'the log line is the redacted one');
  assert.ok(line.includes(res.json.id), 'the response id quotes the log line');
});

test('an unexpected internal error returns a bare 500, not a stack or an upstream body', async (t) => {
  const token = 'o.' + 'A1b2C3d4E5f6'.repeat(4);
  const responder = {
    respond: async () => {
      // A string throw, so this exercises the non-Error branch of sendError too.
      throw `pushbullet upstream body: {"access_token":"${token}"}`;
    },
  };
  const { url } = await startServer(t, { responder });
  const res = await post(url, {
    body: JSON.stringify({ image_base64: (await smallPng()).toString('base64'), deliver: 'pushbullet' }),
    contentType: 'application/json',
  });

  assert.equal(res.status, 500, res.text);
  assert.equal(res.json.error, 'internal');
  assert.deepEqual(Object.keys(res.json).sort(), ['error', 'id']);
  assert.equal(res.text.includes(token), false, 'the Pushbullet token must not reach the response');
  assert.equal(res.text.includes('access_token'), false, 'the upstream body must not reach the response');
  assert.match(res.json.id, /^[0-9a-f-]{36}$/, 'the id is a generated UUID, never attacker-influenced text');
});

// Claim 3: after a 504, the abandoned solve keeps running on the worker but its
// result is discarded - nothing is delivered later.

test('a solve that finishes after the 504 is discarded, never delivered or claimed', { timeout: 5000 }, async (t) => {
  const timeoutMs = 40;
  let finished = false;
  const core = {
    solve: async () => {
      // Bounded, unlike the old manual gate: it resolves after twice the budget, so
      // the test still observes a solve that outlives its deadline but cannot hang
      // when the deadline itself is broken (#37).
      await new Promise((resolve) => setTimeout(resolve, timeoutMs * 2));
      finished = true;
      return solvedResult();
    },
  };

  // A real responder over a real (in-memory) outbox, with the claim spied on, so
  // "nothing was delivered" means no outbox row and no note - not merely a stub
  // nobody happened to call. `minIntervalMs: 0` skips the send-spacing sleep.
  const store = memoryStore();
  t.after(() => store.close());
  const claims = [];
  let notes = 0;
  const spyStore = {
    getOutbox: (...args) => store.getOutbox(...args),
    claimOutbox: (iden, hash) => {
      claims.push({ iden, hash });
      return store.claimOutbox(iden, hash);
    },
    countSentSince: (...args) => store.countSentSince(...args),
    lastSentAt: () => store.lastSentAt(),
    noteOutboxError: (...args) => store.noteOutboxError(...args),
    markOutboxSent: (...args) => store.markOutboxSent(...args),
    record: (...args) => store.record(...args),
  };
  const responder = createResponder({
    client: {
      createNote: async () => {
        notes += 1;
        return { iden: 'note-1' };
      },
    },
    store: spyStore,
    minIntervalMs: 0,
  });

  const { url } = await startServer(t, { core, responder, rawHttp: { timeout_ms: timeoutMs } });
  const res = await post(url, {
    body: JSON.stringify({ image_base64: (await smallPng()).toString('base64'), deliver: 'pushbullet' }),
    contentType: 'application/json',
  });

  assert.equal(res.status, 504, res.text);
  assert.equal(res.json.error, 'solve_timeout');

  // Wait past the abandoned solve's own deadline, then give a late-delivery bug time
  // to run. `finished` proves the solve ran on; the zero counts prove it was ignored.
  await new Promise((resolve) => setTimeout(resolve, timeoutMs * 3));

  assert.equal(finished, true, 'the abandoned solve did keep running on the worker');
  assert.equal(claims.length, 0, 'a solve that outlived the timeout must not claim an outbox row');
  assert.equal(notes, 0, 'a solve that outlived the timeout must not send a note');
});
