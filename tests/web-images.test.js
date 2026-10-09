/**
 * The stored-image route (issue #100).
 *
 * A thumbnail is a new response path, and a per-image URL that looks like a static
 * asset is exactly how a gated resource grows an ungated side door. These tests hold
 * the route to the same gate as the statistics page and prove it is addressed by row
 * id, never a client path:
 *
 *   - the address check runs before anything (a foreign client is refused);
 *   - the session is required (a loopback client with no session is refused);
 *   - the content type is fixed server-side and the response is `no-store`;
 *   - a traversal-shaped request and an unknown id are refused, not served;
 *   - a row whose file is gone renders a placeholder on the page and a 404 on the
 *     route, never a 500.
 *
 * No network, no credential, no browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';

import { validateConfig } from '../src/config.js';
import { memoryStore } from '../src/state/db.js';
import { createImageStore } from '../src/state/images.js';
import { createWebSettingsServer } from '../src/ui/web-config.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORPUS = join(root, 'corpus', '003-arithmetic-acht-min-een.png');

function fakeController() {
  return { list: () => [], set() {}, reset() {}, async save() { return { saved: false, changed: [] }; } };
}

const baseUrl = (server) => `http://127.0.0.1:${server.port}`;

async function seed(t, { remote = '127.0.0.1' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'puzzlesolver-webimg-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = join(base, 'images');
  // A file beside the images directory. A route that joined the images dir with a
  // caller-supplied path would reach it; the real route only ever reads a DB row.
  const secretPath = join(base, 'secret.txt');
  writeFileSync(secretPath, 'top secret document');

  const store = memoryStore();
  t.after(() => store.close());
  store.record({ subject: 'with-image', stage: 'validate', ok: true, ms: 10, payload: { answer: '7', method: 'tier0:arithmetic', confident: true } });
  const attemptId = store.lastAttemptId();
  const imageStore = createImageStore({ store, dir, maxCount: 100 });
  const imageId = await imageStore.save({ subject: 'with-image', attemptId, imagePath: CORPUS });
  // A second solve with a stored row whose file will be deleted, for the placeholder.
  store.record({ subject: 'missing-image', stage: 'validate', ok: true, ms: 12, payload: { answer: '1', method: 'tier0:count', confident: true } });
  const missingAttempt = store.lastAttemptId();
  const missingImageId = await imageStore.save({ subject: 'missing-image', attemptId: missingAttempt, imagePath: CORPUS });

  const server = createWebSettingsServer({
    controller: fakeController(),
    store,
    imageStore,
    config: validateConfig({}).config,
    webUi: { bind: '127.0.0.1', port: 0 },
    getRemoteAddress: () => remote,
  });
  await server.start();
  t.after(() => server.stop());
  return { server, store, imageStore, imageId, missingImageId, secretPath };
}

async function openSession(server) {
  const res = await fetch(server.url);
  const html = await res.text();
  const match = /name="session" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the settings page must carry a session token');
  return match[1];
}

/** A raw request whose `path` is sent verbatim, so `.`/`..` are not normalised away. */
function rawGet(server, path) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, method: 'GET', path }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the image is served behind the session with a fixed type and no-store (#100)', async (t) => {
  const { server, imageId } = await seed(t);
  const session = await openSession(server);

  const res = await fetch(`${baseUrl(server)}/images/${imageId}?session=${encodeURIComponent(session)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/webp', 'the type is fixed server-side');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 0);
  // WebP: RIFF....WEBP
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
});

test('the image route is gated exactly like the statistics page (#100)', async (t) => {
  const { server, imageId } = await seed(t);

  // A loopback client with no session is refused, same as /stats.
  const noSession = await fetch(`${baseUrl(server)}/images/${imageId}`);
  assert.equal(noSession.status, 403);

  // A foreign address is refused before the route is even considered.
  const other = await seed(t, { remote: '203.0.113.9' });
  const foreign = await fetch(`${baseUrl(other.server)}/images/${other.imageId}?session=x`);
  assert.equal(foreign.status, 403, 'the address gate runs before the session gate');
});

test('a traversal-shaped request and an unknown id are refused (#100)', async (t) => {
  const { server, imageId } = await seed(t);
  const session = encodeURIComponent(await openSession(server));

  // A literal traversal, sent without client-side normalisation.
  const literal = await rawGet(server, `/images/../../etc/passwd?session=${session}`);
  assert.equal(literal.status, 404, 'a path-shaped request is not served');
  assert.equal(literal.headers['content-type'], 'text/html; charset=utf-8');

  // An encoded traversal that the URL parser keeps as a single segment. This would
  // reach `secret.txt` beside the images directory if the route decoded it and joined
  // it to the directory, so the body is checked, not just the status.
  const encoded = await rawGet(server, `/images/..%2fsecret.txt?session=${session}`);
  assert.equal(encoded.status, 404, 'an encoded traversal is not served');
  assert.equal(encoded.body.includes('top secret'), false, 'the file beside the images directory is never served');

  // A non-numeric id, and a numeric id that is not a known row.
  assert.equal((await rawGet(server, `/images/not-an-id?session=${session}`)).status, 404);
  assert.equal((await rawGet(server, `/images/999999?session=${session}`)).status, 404);
  // The real id still works, so the refusals are not a blanket 404.
  assert.equal((await rawGet(server, `/images/${imageId}?session=${session}`)).status, 200);
});

test('the statistics page links the image and shows a placeholder when the file is gone (#100)', async (t) => {
  const { server, imageStore, imageId, missingImageId } = await seed(t);
  const session = await openSession(server);

  const html = await (await fetch(`${baseUrl(server)}/stats?session=${encodeURIComponent(session)}`)).text();
  assert.match(html, new RegExp(`/images/${imageId}\\?session=`), 'the thumbnail links the gated route');
  assert.match(html, /<img [^>]*width="64"/, 'the thumbnail is a bounded img');
  assert.match(html, /<th>image<\/th>/, 'the recent-solves table has the image column');

  // Delete the file for one row; the page must render a placeholder, not a broken
  // link and not a 500.
  unlinkSync(imageStore.pathFor(missingImageId));
  const after = await fetch(`${baseUrl(server)}/stats?session=${encodeURIComponent(session)}`);
  assert.equal(after.status, 200);
  const afterHtml = await after.text();
  assert.match(afterHtml, /file missing/, 'a missing file is a placeholder');
  assert.doesNotMatch(afterHtml, new RegExp(`/images/${missingImageId}\\?session=`));
  // And the route for that row is a clean 404, not a 500.
  assert.equal((await rawGet(server, `/images/${missingImageId}?session=${encodeURIComponent(session)}`)).status, 404);
});
