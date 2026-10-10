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
  createAuthThrottle,
  createHttpServer,
  createRateLimiter,
  decodeBase64Image,
  assertHttpUrl,
  assertImageUrlAllowed,
  imageUrlHostAllowed,
  DEFAULT_AUTH_FAILURE_LIMIT,
  httpTokenProblem,
  imageErrorStatus,
  isLoopbackHost,
  tokenMatches,
  HttpError,
  SolveTimeoutError,
} from '../src/http/server.js';
import { downloadImage, ImageFetchError, validateImageBuffer } from '../src/pushbullet/files.js';
import { createResponder } from '../src/pushbullet/respond.js';
import { memoryStore } from '../src/state/db.js';
import { createSolveCore } from '../src/solver/core.js';
import { createApp, MissingHttpTokenError, WeakHttpTokenError } from '../src/app.js';
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

/**
 * A real local image server. `redirectTo` makes it answer a 302 instead of the image,
 * which is how the redirect-refusal tests get a first hop that really resolves.
 */
async function startImageServer(t, { bytes, redirectTo = null, hits = null } = {}) {
  const server = createServer((req, res) => {
    hits?.push(req.url);
    if (redirectTo) {
      res.writeHead(302, { location: redirectTo });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(bytes.length) });
    res.end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/puzzle.png`;
}

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
// #42: require_confidence is an answer policy, not a Pushbullet-only setting
// ---------------------------------------------------------------------------

// The unpicked candidate is a *policy* withholding, not a validation failure. The
// HTTP egress must not return it as a solved 200 when the Pushbullet responder would
// stay silent - two transports disagreeing about the same answer is the defect.
test('an uncorroborated answer is withheld from HTTP exactly as Pushbullet withholds it (#42)', async (t) => {
  const core = scriptedCore({ answer: 'drie', confident: false, method: 'tier0:x' });
  const { url } = await startServer(t, { core });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.status, 'unresolved');
  assert.equal(res.json.answer, null, 'the candidate must not be returned when require_confidence withholds it');
  assert.equal(res.json.confident, false);
  assert.equal(res.json.reason, 'unconfirmed');
  assert.equal(
    res.json.unresolvedReply,
    undefined,
    'a withheld answer gets no acknowledgement, matching the Pushbullet responder'
  );
});

test('require_confidence=false returns the uncorroborated answer over HTTP (#42)', async (t) => {
  const config = validateConfig({
    http: { enabled: true, bind: '127.0.0.1', port: 0 },
    reply: { require_confidence: false },
  }).config;
  const core = scriptedCore({ answer: 'drie', confident: false, method: 'tier0:x' });
  const { url } = await startServer(t, { core, config });
  const res = await post(url, { body: await smallPng(), contentType: 'image/png' });

  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, 'drie', 'the policy is the only thing withholding it');
  assert.equal(res.json.confident, false, 'the caller still sees that it is uncorroborated');
});

test('with deliver=pushbullet an uncorroborated answer is a 422 and the note is suppressed (#42)', async (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const notes = [];
  const responder = createResponder({
    client: {
      createNote: async () => {
        notes.push('note');
        return { iden: 'note-1' };
      },
    },
    store,
    minIntervalMs: 0,
  });
  const core = scriptedCore({ answer: 'drie', confident: false, method: 'tier0:x' });
  const { url } = await startServer(t, { core, responder });
  const res = await post(url, {
    body: JSON.stringify({ image_base64: (await smallPng()).toString('base64'), deliver: 'pushbullet' }),
    contentType: 'application/json',
  });

  assert.equal(res.status, 422, res.text);
  assert.equal(res.json.answer, null);
  assert.equal(res.json.delivery.sent, false);
  assert.equal(res.json.delivery.reason, 'unconfirmed');
  assert.equal(notes.length, 0, 'the responder must not send an uncorroborated answer');
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

test('repeated wrong tokens are throttled instead of answered 401 forever (#47)', async (t) => {
  const { url } = await startServer(t);
  const statuses = [];
  for (let i = 0; i < DEFAULT_AUTH_FAILURE_LIMIT + 2; i++) {
    const res = await post(url, { token: `wrong-${i}`, body: await smallPng(), contentType: 'image/png' });
    statuses.push(res.status);
  }
  assert.equal(statuses[0], 401, 'the first failure is still a plain 401');
  assert.ok(statuses.includes(429), `expected a 429 after ${DEFAULT_AUTH_FAILURE_LIMIT} failures, saw ${statuses.join(',')}`);
  assert.equal(statuses.at(-1), 429, 'once blocked, further attempts stay blocked');
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

// The declared content type is no longer a gate: the magic bytes decide. A body that
// declares `text/plain` is a raw candidate, and a non-image is refused by the image
// gate, not by content-type dispatch (#61).
test('an unsupported content type is decided by the bytes, not the declared type', async (t) => {
  const { url } = await startServer(t);
  const res = await post(url, { body: 'hello', contentType: 'text/plain' });
  assert.equal(res.status, 415);
  assert.equal(res.json.error, 'invalid_image');
  assert.equal(res.json.reason, 'magic');
});

// The forms a caller actually reaches for: no header, the conventional binary type,
// curl's default form encoding, and the explicit image type. All must reach the same gate.
for (const [name, contentType] of [
  ['no Content-Type', undefined],
  ['application/octet-stream', 'application/octet-stream'],
  ["curl's default application/x-www-form-urlencoded", 'application/x-www-form-urlencoded'],
  ['image/png', 'image/png'],
]) {
  test(`a valid PNG posted with ${name} is accepted`, async (t) => {
    const { url } = await startServer(t);
    const res = await post(url, { body: await smallPng(), contentType });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.answer, '2');
  });
}

test('multipart/form-data without a file part is a clear 400', async (t) => {
  const { url } = await startServer(t);
  const form = new FormData();
  form.append('not_a_file', 'just a field');
  const res = await post(url, { body: form });
  assert.equal(res.status, 400, res.text);
  assert.equal(res.json.error, 'missing_image');
  assert.match(res.json.reason, /file part/);
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

test('#35: the HTTP gate re-reads the image caps live, not at server construction', async (t) => {
  const config = validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0 } }).config;
  const { url } = await startServer(t, { config });
  // 1000x500 = 500,000 px, under the default 1,000,000 cap.
  const bytes = await sharp({ create: { width: 1000, height: 500, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  assert.equal((await post(url, { body: bytes, contentType: 'image/png' })).status, 200);

  // Mutate the shared config in place, exactly as `applyLiveSettings` does for a
  // `[live]` setting. A captured copy would still accept the image.
  config.image.max_pixels = 1000;
  const res = await post(url, { body: bytes, contentType: 'image/png' });
  assert.equal(res.status, 413, 'the lowered cap must apply without a restart');
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

test('a permitted host is fetched and solved (image_url still works when enabled)', async (t) => {
  const bytes = await smallPng();
  const imageUrl = await startImageServer(t, { bytes });
  const { url } = await startServer(t, {
    rawHttp: { allow_image_url: true, image_url_hosts: ['127.0.0.1'] },
  });
  const res = await post(url, { body: JSON.stringify({ image_url: imageUrl }), contentType: 'application/json' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.answer, '2');
  assert.equal(res.json.image.bytes, bytes.length, 'the fetched bytes are the ones solved');
});

// ---------------------------------------------------------------------------
// image_url is an SSRF surface: off by default, host-allowlisted when on (#57)
// ---------------------------------------------------------------------------

test('image_url is refused by default and the reason points at uploading', async (t) => {
  const calls = [];
  const { url } = await startServer(t, {
    fetchImpl: (href, init) => {
      calls.push(String(href));
      return globalThis.fetch(href, init);
    },
  });
  const res = await post(url, {
    body: JSON.stringify({ image_url: 'http://127.0.0.1:9/puzzle.png' }),
    contentType: 'application/json',
  });

  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error, 'image_url_disabled');
  assert.match(res.json.reason, /upload the image instead/);
  assert.equal(calls.length, 0, 'a disabled image_url must not be fetched');
});

test('image_url is refused when enabled but the allowlist is empty (default deny)', async (t) => {
  const { url } = await startServer(t, { rawHttp: { allow_image_url: true, image_url_hosts: [] } });
  const res = await post(url, {
    body: JSON.stringify({ image_url: 'http://127.0.0.1:9/puzzle.png' }),
    contentType: 'application/json',
  });

  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error, 'image_url_host_not_allowed');
  assert.match(res.json.reason, /http\.image_url_hosts/);
  assert.match(res.json.reason, /upload the image instead/);
});

test('a loopback, private or link-local image_url is refused by the allowlist', async (t) => {
  const calls = [];
  const { url } = await startServer(t, {
    fetchImpl: (href, init) => {
      calls.push(String(href));
      return globalThis.fetch(href, init);
    },
    // A public-looking allowlist: none of the internal targets below is on it.
    rawHttp: { allow_image_url: true, image_url_hosts: ['images.example.test'] },
  });

  for (const target of [
    'http://127.0.0.1/p.png',
    'http://10.0.0.5/p.png',
    'http://192.168.1.7/p.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/p.png',
  ]) {
    const res = await post(url, { body: JSON.stringify({ image_url: target }), contentType: 'application/json' });
    assert.equal(res.status, 403, `${target}: ${res.text}`);
    assert.equal(res.json.error, 'image_url_host_not_allowed', target);
  }
  assert.equal(calls.length, 0, 'no internal target may be contacted');
});

test('a redirect is refused before it is followed, even to another allowed host', async (t) => {
  const bytes = await smallPng();
  const targetHits = [];
  const targetUrl = await startImageServer(t, { bytes, hits: targetHits });
  const redirectUrl = await startImageServer(t, { bytes, redirectTo: targetUrl });
  // Both URLs are on 127.0.0.1, so only the redirect policy can stop the second hop.
  const { url } = await startServer(t, {
    rawHttp: { allow_image_url: true, image_url_hosts: ['127.0.0.1'] },
  });
  const res = await post(url, { body: JSON.stringify({ image_url: redirectUrl }), contentType: 'application/json' });

  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error, 'image_url_redirect');
  assert.match(res.json.reason, /redirects are not followed/);
  assert.equal(targetHits.length, 0, 'the redirect target must never be contacted');
});

test('a redirect to a link-local metadata address is refused', async (t) => {
  const bytes = await smallPng();
  const redirectUrl = await startImageServer(t, {
    bytes,
    redirectTo: 'http://169.254.169.254/latest/meta-data/',
  });
  const { url } = await startServer(t, {
    rawHttp: { allow_image_url: true, image_url_hosts: ['127.0.0.1'] },
  });
  const res = await post(url, { body: JSON.stringify({ image_url: redirectUrl }), contentType: 'application/json' });

  assert.equal(res.status, 403, res.text);
  assert.equal(res.json.error, 'image_url_redirect');
});

test('downloadImage follows redirects by default but refuses them when asked not to', async (t) => {
  const bytes = await smallPng();
  const targetUrl = await startImageServer(t, { bytes });
  const redirectUrl = await startImageServer(t, { bytes, redirectTo: targetUrl });

  // The Pushbullet path keeps `follow`: a pre-signed S3 URL is not caller-supplied.
  const followed = await downloadImage(redirectUrl);
  assert.equal(followed.ext, '.png');

  // The HTTP ingress passes `manual`, and a 3xx is refused rather than followed.
  await assert.rejects(
    () => downloadImage(redirectUrl, { redirect: 'manual' }),
    (err) => err instanceof ImageFetchError && err.reason === 'redirect' && err.status === 302
  );
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

/**
 * Build a multipart body by hand so the boundary spelling is ours, not undici's.
 *
 * undici's `FormData` generates an all-lowercase boundary, so lowercasing the whole
 * `Content-Type` header is a no-op and cannot be told apart from a correct parser -
 * that is exactly why #187 shipped green. A boundary is case-sensitive (RFC 2046) and
 * Chrome, Edge and curl all send mixed case, so this is the input the tests must supply.
 */
function handBuiltMultipart(bytes, boundary = '----WebKitFormBoundaryAbCdEf12') {
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from('Content-Disposition: form-data; name="image"; filename="puzzle.png"\r\n'),
    Buffer.from('Content-Type: image/png\r\n'),
    Buffer.from('\r\n'),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

test('multipart/form-data with a mixed-case boundary is accepted (#187)', async (t) => {
  const { url } = await startServer(t);
  const { body, contentType } = handBuiltMultipart(await smallPng());
  const res = await post(url, { body, contentType });
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

test('a hostname that only starts with 127. is not loopback and warns (#47)', async () => {
  // The old prefix test classified `127.evil.example` as loopback, suppressing the very
  // warning the function exists to produce. The warning is the control, so assert it fires.
  assert.equal(isLoopbackHost('127.evil.example'), false);
  const logger = collectingLogger();
  const server = createHttpServer({
    core: scriptedCore({ answer: '2' }),
    token: TOKEN,
    config: validateConfig({ http: { enabled: true, bind: '127.evil.example', port: 44444 } }).config,
    inboxDir: join(tmpdir(), 'puzzlesolver-http-bind'),
    logger,
    createServerImpl: fakeServerFactory(),
  });
  await server.start();
  assert.ok(
    logger.logs.some((l) => l.level === 'warn' && /exposes the solver beyond this machine/.test(l.args.join(' '))),
    'a 127.-prefixed hostname must warn'
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
  assert.equal(imageErrorStatus({ reason: 'redirect' }), 403);
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

test('tokenMatches keeps the odd spacing the old pattern accepted (#208)', () => {
  // The parse was rewritten to be linear; these are the shapes the previous regex
  // tolerated and which the rewrite must not have narrowed.
  assert.equal(tokenMatches('abc', 'Bearer  abc'), true, 'several spaces between scheme and token');
  assert.equal(tokenMatches('abc', 'bearer   abc'), true, 'several spaces, lower-case scheme');
  assert.equal(tokenMatches('abc', 'Bearer\t\tabc'), true, 'tabs as the separator');
  assert.equal(tokenMatches('abc', 'BEARER abc'), true, 'the scheme is case-insensitive');
  assert.equal(tokenMatches('ABC', 'Bearer ABC'), true, 'the token itself stays case-sensitive');
  assert.equal(tokenMatches('abc', 'Bearer ABC'), false, 'a case-folded token must not match');
  assert.equal(tokenMatches('abc', 'Bearer abc '), false, 'trailing whitespace is part of the token');
  // The old pattern let `(.+)` fall back to a single separator character, so
  // `tokenMatches(' ', 'Bearer  ')` was true. It could never authenticate a real
  // token (the token floor is far above one space), so the rewrite rejects it.
  assert.equal(tokenMatches(' ', 'Bearer  '), false, 'a whitespace-only header carries no token');
});

test('a hostile authorization header is rejected promptly (#208)', () => {
  // The CodeQL shape: `bearer` plus a long run of separators. The trailing carriage
  // return is what made the old pattern quadratic - `\r` is whitespace that `\s+`
  // matched but `(.+)` cannot, so the engine retried every split of the run. At this
  // size the old pattern took ~25s; the linear parse is O(n).
  const header = `Bearer${' '.repeat(150_000)}\r`;
  const started = performance.now();
  const matched = tokenMatches('test-token-do-not-log', header);
  const elapsedMs = performance.now() - started;
  assert.equal(matched, false, 'a hostile header must still be rejected');
  // Deliberately generous. The linear parse costs ~1-2ms, so a loaded CI runner would
  // have to be thousands of times slower to trip this, while the quadratic pattern is
  // an order of magnitude over it. A tighter bound would flake on a loaded box and
  // teach everyone to distrust the assertion.
  assert.ok(elapsedMs < 5_000, `hostile header took ${elapsedMs.toFixed(0)}ms; the parse must stay linear`);
});

test('the bearer parse carries no backtracking regex (#208)', () => {
  // A stopwatch only samples a machine, so it cannot prove linearity. Pin the
  // mechanism instead: the finding was a quantified whitespace class overlapping the
  // token wildcard, so the function body must carry no quantified whitespace class at
  // all. The per-character test is a bare `/\s/`, which has nothing to backtrack over.
  assert.doesNotMatch(String(tokenMatches), /\\s[+*]/, 'a quantified whitespace class is the backtracking hazard');
});

test('isLoopbackHost validates the whole address, not a prefix (#47)', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', 'localhost', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`);
  }
  for (const host of ['127.evil.example', 'localhost.evil.example', '0.0.0.0', '192.168.1.5', '::2', '127.0.0.1.evil', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} must not be treated as loopback`);
  }
});

test('httpTokenProblem rejects short, weak and monotonous tokens (#47)', () => {
  assert.match(httpTokenProblem('a'), /at least/);
  assert.match(httpTokenProblem('short-token-12'), /at least/);
  assert.match(httpTokenProblem('changeme'), /weak value/);
  assert.match(httpTokenProblem('aaaaaaaaaaaaaaaaaa'), /variation/);
  assert.equal(httpTokenProblem('a-long-random-enough-token'), null);
  assert.equal(httpTokenProblem('test-token-do-not-log'), null);
});

test('a weak token refuses to build the server', () => {
  assert.throws(
    () =>
      createHttpServer({
        core: scriptedCore({ answer: '2' }),
        token: 'a',
        config: validateConfig({ http: { enabled: true, bind: '127.0.0.1', port: 0 } }).config,
        inboxDir: join(tmpdir(), 'puzzlesolver-http-weak'),
      }),
    /not usable/
  );
});

test('createAuthThrottle blocks after the limit and backs off', () => {
  let clock = 0;
  const throttle = createAuthThrottle({ limit: 2, windowMs: 60_000, now: () => clock });
  assert.deepEqual(throttle.fail('c'), { allowed: true, retryAfterSec: 0 });
  assert.deepEqual(throttle.fail('c'), { allowed: false, retryAfterSec: 1 }, 'the trip applies the first backoff');
  assert.equal(throttle.check('c').allowed, false);
  assert.equal(throttle.check('c').retryAfterSec, 1);
  clock += 1000;
  assert.equal(throttle.check('c').allowed, true, 'the first backoff expires');
  assert.deepEqual(throttle.fail('c'), { allowed: true, retryAfterSec: 0 }, 'a fresh failure count starts after the block');
  assert.deepEqual(throttle.fail('c'), { allowed: false, retryAfterSec: 2 }, 'the next trip doubles the backoff');
  // A different client has its own budget, and a success clears the record.
  assert.equal(throttle.check('other').allowed, true);
  throttle.succeed('c');
  assert.equal(throttle.check('c').allowed, true, 'a correct token clears the failure record');
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

test('imageUrlHostAllowed matches the host exactly, not a suffix or a URL prefix', () => {
  const url = (href) => new URL(href);
  assert.equal(imageUrlHostAllowed(url('https://images.example.test/a.png'), ['images.example.test']), true);
  // Case and the FQDN root dot are normalised away by the URL parser and the matcher.
  assert.equal(imageUrlHostAllowed(url('https://IMAGES.Example.test./a.png'), ['images.example.test']), true);
  assert.equal(imageUrlHostAllowed(url('http://[::1]/a.png'), ['::1']), true);
  // A suffix must not admit a subdomain, and a prefix must not admit a longer domain.
  assert.equal(imageUrlHostAllowed(url('https://sub.example.test/a.png'), ['example.test']), false);
  assert.equal(imageUrlHostAllowed(url('https://evil.example.test/a.png'), ['images.example.test']), false);
  assert.equal(imageUrlHostAllowed(url('https://example.test.evil.test/a.png'), ['example.test']), false);
  assert.equal(imageUrlHostAllowed(url('http://127.0.0.1/a.png'), []), false);
  // The host is the trust boundary; the port is not part of the entry.
  assert.equal(imageUrlHostAllowed(url('http://images.example.test:8443/a.png'), ['images.example.test']), true);
});

test('assertImageUrlAllowed refuses by default, on an empty list, and on a foreign host', () => {
  assert.equal(assertImageUrlAllowed('https://images.example.test/a.png', { enabled: true, hosts: ['images.example.test'] }), 'https://images.example.test/a.png');
  for (const [policy, code] of [
    [{ enabled: false, hosts: ['images.example.test'] }, 'image_url_disabled'],
    [{ enabled: true, hosts: [] }, 'image_url_host_not_allowed'],
    [{ enabled: true, hosts: ['other.example.test'] }, 'image_url_host_not_allowed'],
  ]) {
    assert.throws(
      () => assertImageUrlAllowed('https://images.example.test/a.png', policy),
      (err) => err instanceof HttpError && err.status === 403 && err.code === code
    );
  }
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
      assert.match(err.message, /config set http\.token/, 'the message must lead with the command that writes the store');
      assert.match(err.message, /HTTP_AUTH_TOKEN/);
      assert.doesNotMatch(err.message, /credentials\.json/, 'the plaintext migration file must not be presented as a route');
      return true;
    }
  );
});

test('http.enabled with a weak token refuses to start with an actionable error (#47)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-http-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      createApp({
        config: validateConfig({ http: { enabled: true } }).config,
        env: { HTTP_AUTH_TOKEN: 'shorty' },
        providers: [],
        client: { createNote: async () => ({}) },
        reasoner: null,
        solveImage: async () => ({ answer: '1' }),
        createWorker: async () => ({ terminate: async () => {} }),
        inboxDir: join(dir, 'inbox'),
        statePath: join(dir, 'state.db'),
        logger: collectingLogger(),
      }),
    (err) => {
      assert.equal(err.name, 'WeakHttpTokenError');
      assert.match(err.message, /at least 16/);
      assert.match(err.message, /openssl rand/);
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

test('concurrent POST /v1/solve requests are serialised by the shared solve lock', async (t) => {
  const delayMs = 60;
  let active = 0;
  let maxActive = 0;
  const trace = [];
  const core = createSolveCore({
    worker: null,
    config: validateConfig({}).config,
    solveImage: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      trace.push(`start:${active}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active -= 1;
      trace.push('end');
      return solvedResult();
    },
  });
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

// The lock lives on the core, so an ingress that never touches the HTTP queue - the
// tray's direct `core.solve`, a Pushbullet push - serialises against HTTP too. Before
// #44 these ran concurrently on one worker.
test('a direct core.solve and an HTTP request never solve concurrently (#44)', async (t) => {
  let active = 0;
  let maxActive = 0;
  const core = createSolveCore({
    worker: null,
    config: validateConfig({}).config,
    solveImage: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 60));
      active -= 1;
      return solvedResult();
    },
  });
  const { url } = await startServer(t, { core });

  const viaHttp = post(url, { body: await smallPng(), contentType: 'image/png' });
  const viaTray = core.solve(join(tmpdir(), 'tray-image.png'), { subject: 'tray' });
  const [httpRes, trayRes] = await Promise.all([viaHttp, viaTray]);

  assert.equal(httpRes.status, 200, httpRes.text);
  assert.equal(trayRes.answer, '2');
  assert.equal(maxActive, 1, `two ingress paths drove the worker ${maxActive} times at once`);
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

// ---------------------------------------------------------------------------
// #43: the queue is bounded, and a task whose deadline passed is not started
// ---------------------------------------------------------------------------

// The rate limit bounds admission per minute; this bounds the backlog behind the one
// worker, so a client with retry-on-504 logic cannot queue work that outlives its own
// wait. `429` is already the rate limit, so a full queue is a distinct `503`.
test('a request over the HTTP queue bound is a 503 with Retry-After (#43)', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const startedP = new Promise((resolve) => {
    started = resolve;
  });
  let solves = 0;
  const core = {
    solve: async () => {
      solves += 1;
      started();
      await gate;
      return solvedResult();
    },
  };
  const { url } = await startServer(t, { core, rawHttp: { max_queue: 1, timeout_ms: 5000 } });
  const bytes = await smallPng();

  const first = post(url, { body: bytes, contentType: 'image/png' });
  await startedP; // the slot is definitely held

  const second = await post(url, { body: bytes, contentType: 'image/png' });
  assert.equal(second.status, 503, second.text);
  assert.equal(second.json.error, 'queue_full');
  assert.ok(Number(second.headers.get('retry-after')) >= 1, 'a refusal must say when to come back');

  release();
  const firstRes = await first;
  assert.equal(firstRes.status, 200, firstRes.text);
  assert.equal(solves, 1, 'the refused request must never reach the core');
});

// The budget starts at arrival and includes queue wait, so a request that expires
// while the lock is busy must be skipped at dequeue, not run in full (and billed).
test('a request that expires while queued does not start the solve (#43)', async (t) => {
  const timeoutMs = 60;
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let firstStarted;
  const firstStartedP = new Promise((resolve) => {
    firstStarted = resolve;
  });
  let solves = 0;
  const core = createSolveCore({
    worker: null,
    config: validateConfig({}).config,
    solveImage: async () => {
      solves += 1;
      if (solves === 1) {
        firstStarted();
        await gate;
      }
      return solvedResult();
    },
  });
  const { url } = await startServer(t, { core, rawHttp: { timeout_ms: timeoutMs } });
  const bytes = await smallPng();

  const first = post(url, { body: bytes, contentType: 'image/png' });
  await firstStartedP; // the lock is held and the first solve is running

  // Arrives while the lock is held; its 60 ms budget expires in the queue.
  const second = await post(url, { body: bytes, contentType: 'image/png' });
  assert.equal(second.status, 504, second.text);
  assert.equal(second.json.error, 'solve_timeout');

  releaseFirst();
  await first; // the queued task now reaches the lock and is skipped
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(solves, 1, 'the expired request must not start the pipeline');
});

// The unit-level seam behind the HTTP behaviour: `canStart` is evaluated at dequeue.
test('createSolveCore skips a task whose canStart is false at dequeue (#43)', async () => {
  let calls = 0;
  const core = createSolveCore({
    worker: null,
    config: validateConfig({}).config,
    solveImage: async () => {
      calls += 1;
      return solvedResult();
    },
  });
  const result = await core.solve('/inbox/expired.png', { canStart: () => false });
  assert.equal(calls, 0, 'the pipeline must not run for a caller that already left');
  assert.equal(result.skipped, true);
});
