/**
 * Integration tests for the web UI access rule and the solve page (issue #65).
 *
 * The access rule is exercised over a real HTTP server with an *injected* remote
 * address, because a non-loopback client is awkward to simulate on one host. The
 * injection is the same seam a proxy deployment would need, and the socket address
 * (never `X-Forwarded-For`) is what the server reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { validateConfig } from '../src/config.js';
import { memoryStore } from '../src/state/db.js';
import { createApp, MissingWebUiCredentialError } from '../src/app.js';
import { hashWebUiPassword } from '../src/ui/access.js';
import { createWebSettingsServer, remoteAddressOf } from '../src/ui/web-config.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-web-solve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeController() {
  let saves = 0;
  const calls = { list: 0 };
  return {
    list() {
      calls.list += 1;
      return [];
    },
    set() {},
    reset() {},
    async save() {
      saves += 1;
      return { saved: false, reason: 'no-changes', changed: [] };
    },
    get saves() {
      return saves;
    },
    calls,
  };
}

function scriptedCore(result) {
  return { solve: async () => result };
}

const SOLVED = {
  answer: '7',
  confident: true,
  method: 'model:vision',
  puzzleClass: 'count',
  transcript: '7',
  model: { text: false, vision: true },
  opinions: [],
  disputed: false,
};

const UNRESOLVED = {
  answer: null,
  confident: false,
  method: null,
  puzzleClass: null,
  transcript: '',
  model: null,
  opinions: [],
  disputed: false,
};

async function startUi(t, { controller = fakeController(), config = null, remote = '127.0.0.1', ...options } = {}) {
  const state = { remote };
  const server = createWebSettingsServer({
    controller,
    config,
    ...options,
    getRemoteAddress: () => state.remote,
  });
  await server.start();
  t.after(() => server.stop());
  return { server, state, controller };
}

const baseUrl = (server) => `http://127.0.0.1:${server.port}`;

function sessionFrom(html) {
  const match = /name="session" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page must carry a session token');
  return match[1];
}

async function openLoopbackSession(server) {
  const res = await fetch(server.url);
  const html = await res.text();
  assert.equal(res.status, 200, html);
  return sessionFrom(html);
}

/** A low-level request so the `Host` header can be overridden (fetch refuses to). */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'GET', headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function login(server, password) {
  return fetch(`${baseUrl(server)}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
  });
}

const smallPng = () => sharp({ create: { width: 200, height: 44, channels: 3, background: '#ffffff' } }).png().toBuffer();

async function upload(server, session, bytes) {
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: 'image/png' }), 'puzzle.png');
  return fetch(`${baseUrl(server)}/solve?session=${encodeURIComponent(session)}`, { method: 'POST', body: form });
}

// ---------------------------------------------------------------------------
// The one access rule
// ---------------------------------------------------------------------------

test('a disallowed source is refused before any handler runs (#65)', async (t) => {
  const controller = fakeController();
  const { server, state } = await startUi(t, {
    controller,
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('letmein'),
  });
  state.remote = '10.9.9.9';

  const root = await fetch(`${baseUrl(server)}/`);
  assert.equal(root.status, 403);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  const save = await fetch(`${baseUrl(server)}/save`, { method: 'POST', body: 'session=x' });
  assert.equal(save.status, 403);
  const solve = await fetch(`${baseUrl(server)}/solve?session=x`, { method: 'POST', body: 'x' });
  assert.equal(solve.status, 403);
  // A route the server has never heard of is gated too: the check is before dispatch.
  const unknown = await fetch(`${baseUrl(server)}/does-not-exist`);
  assert.equal(unknown.status, 403);
  // The settings controller was never touched.
  assert.equal(controller.calls.list, 0, 'a disallowed source must not reach a handler');
  assert.equal(controller.saves, 0);
});

test('the trusted client address comes from the socket, never X-Forwarded-For', () => {
  assert.equal(
    remoteAddressOf({ headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: '10.9.9.9' } }),
    '10.9.9.9',
    'a spoofed forwarding header must not become the client address'
  );
  assert.equal(remoteAddressOf({ headers: { 'x-forwarded-for': '127.0.0.1' }, socket: null }), null);
});

test('X-Forwarded-For does not affect the decision', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('letmein'),
  });
  state.remote = '10.9.9.9';
  const res = await fetch(`${baseUrl(server)}/`, { headers: { 'x-forwarded-for': '127.0.0.1' } });
  assert.equal(res.status, 403, 'a spoofed forwarding header must not admit the caller');
});

test('the loopback default still works unchanged (#56 regression)', async (t) => {
  const { server } = await startUi(t, {});
  const res = await fetch(server.url);
  assert.equal(res.status, 200);
  const session = sessionFrom(await res.text());
  assert.ok(session);
  const solve = await fetch(`${baseUrl(server)}/solve?session=not-the-session`);
  assert.equal(solve.status, 403, 'a loopback client with the wrong session cannot reach the solve form');
});

test('an address inside the range is admitted and a near miss is refused', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('letmein'),
  });
  state.remote = '192.168.1.5';
  const admitted = await fetch(`${baseUrl(server)}/`);
  assert.equal(admitted.status, 200, 'a matching address must get the login page, not a refusal');
  assert.match(await admitted.text(), /Sign in/i);

  state.remote = '192.168.2.5';
  const refused = await fetch(`${baseUrl(server)}/`);
  assert.equal(refused.status, 403, 'a near miss must be refused');
});

test('a non-loopback range with no configured credential refuses to start (#65)', () => {
  assert.throws(
    () =>
      createWebSettingsServer({
        controller: fakeController(),
        webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
      }),
    (err) => /web_ui\.password/.test(err.message) && /credential/i.test(err.message)
  );
  // Loopback with no credential is fine - the default is not changed.
  assert.doesNotThrow(() =>
    createWebSettingsServer({ controller: fakeController(), webUi: { bind: '127.0.0.1', allowed_cidrs: [] } })
  );
});

test('a widened web_ui range still refuses to build without a credential at app start (#65)', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({ web_ui: { allowed_cidrs: ['192.168.1.0/24'] } }).config;
  await assert.rejects(
    () =>
      createApp({
        config,
        configPath: join(dir, 'config.toml'),
        env: {},
        platform: 'linux',
        homedir: () => dir,
        explicitSecrets: { pushbullet: 'o.test-token' },
        providers: [],
        worker: {},
        store: memoryStore(),
        reasoner: null,
        inboxDir: join(dir, 'inbox'),
        logPath: join(dir, 'app.log'),
      }),
    (err) => err instanceof MissingWebUiCredentialError && /web_ui\.password/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// The credential
// ---------------------------------------------------------------------------

test('a wrong credential is generic and a correct one admits the client', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('correct-password'),
  });
  state.remote = '192.168.1.5';

  const wrong = await login(server, 'wrong-password');
  const wrongHtml = await wrong.text();
  assert.equal(wrong.status, 401);
  assert.match(wrongHtml, /Incorrect credentials/i);
  assert.equal(wrongHtml.includes('correct-password'), false);

  const right = await login(server, 'correct-password');
  const rightHtml = await right.text();
  assert.equal(right.status, 200, rightHtml);
  const session = sessionFrom(rightHtml);
  const solve = await fetch(`${baseUrl(server)}/solve?session=${session}`);
  assert.equal(solve.status, 200, 'the authenticated session reaches the solve page');
});

test('failed logins are throttled, reusing the #47 backoff', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('correct-password'),
  });
  state.remote = '192.168.1.5';

  let statuses = [];
  for (let i = 0; i < 5; i++) {
    const res = await login(server, `guess-${i}`);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(statuses[4], 429, 'the fifth failure trips the backoff');
  const blocked = await login(server, 'correct-password');
  assert.equal(blocked.status, 429, 'a blocked client is refused before the password is checked');
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
});

test('an authenticated session is bound to the address that authenticated', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'] },
    credentialVerifier: hashWebUiPassword('correct-password'),
  });
  state.remote = '192.168.1.5';
  const session = sessionFrom(await (await login(server, 'correct-password')).text());

  // Same session, a different (still allowed) address: refused.
  state.remote = '192.168.1.6';
  const reused = await fetch(`${baseUrl(server)}/solve?session=${session}`);
  assert.equal(reused.status, 200);
  assert.match(await reused.text(), /Sign in/i, 'the session does not carry to another address');

  state.remote = '192.168.1.5';
  const home = await fetch(`${baseUrl(server)}/solve?session=${session}`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Solve an image/i);
});

// ---------------------------------------------------------------------------
// The solve page
// ---------------------------------------------------------------------------

test('an uploaded image is solved and the answer, method, confidence and timing are shown', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({ reply: { unresolved_text: 'ACK-UNRESOLVED' } }).config;
  const { server } = await startUi(t, {
    solveCore: scriptedCore(SOLVED),
    config,
    inboxDir: join(dir, 'inbox'),
  });
  const session = await openLoopbackSession(server);
  const res = await upload(server, session, await smallPng());
  const html = await res.text();
  assert.equal(res.status, 200, html);
  assert.match(html, /Solved\./);
  assert.match(html, /7/, 'the answer is shown');
  assert.match(html, /model:vision/, 'the method is shown');
  assert.match(html, /\btrue\b/, 'confidence is shown');
  assert.match(html, /\d+ ms/, 'the timing is shown');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('an unresolved puzzle shows the acknowledgement wording, never a guess', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({ reply: { unresolved_text: 'ACK-NO-ANSWER-WAS-SENT' } }).config;
  const { server } = await startUi(t, {
    solveCore: scriptedCore(UNRESOLVED),
    config,
    inboxDir: join(dir, 'inbox'),
  });
  const session = await openLoopbackSession(server);
  const res = await upload(server, session, await smallPng());
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Not solved\./);
  assert.match(html, /ACK-NO-ANSWER-WAS-SENT/);
  assert.equal(html.includes('Solved.'), false, 'an unresolved puzzle must not read as solved');
});

test('the solve page still applies the shared body cap', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({ http: { enabled: true, max_body_bytes: 100 } }).config;
  const { server } = await startUi(t, {
    solveCore: scriptedCore(SOLVED),
    config,
    inboxDir: join(dir, 'inbox'),
  });
  const session = await openLoopbackSession(server);
  const res = await upload(server, session, Buffer.alloc(2048, 1));
  assert.equal(res.status, 413, await res.text());
});

test('the solve page shares the queue bound and refuses when it is full', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({}).config;
  const fullCore = { ...scriptedCore(SOLVED), acquireSlot: () => false, releaseSlot: () => {} };
  const { server } = await startUi(t, { solveCore: fullCore, config, inboxDir: join(dir, 'inbox') });
  const session = await openLoopbackSession(server);
  const res = await upload(server, session, await smallPng());
  assert.equal(res.status, 503, await res.text());
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
});

test('a non-image upload is refused by the shared gate', async (t) => {
  const dir = tempDir(t);
  const config = validateConfig({}).config;
  const { server } = await startUi(t, { solveCore: scriptedCore(SOLVED), config, inboxDir: join(dir, 'inbox') });
  const session = await openLoopbackSession(server);
  const res = await fetch(`${baseUrl(server)}/solve?session=${session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('this is not an image'),
  });
  assert.equal(res.status, 415, await res.text());
});

test('the Host allowlist is still explicit when a hostname is configured', async (t) => {
  const { server, state } = await startUi(t, {
    webUi: { bind: '127.0.0.1', allowed_cidrs: ['192.168.1.0/24'], allowed_hosts: ['ui.lan'] },
    credentialVerifier: hashWebUiPassword('correct-password'),
  });
  state.remote = '192.168.1.5';
  const allowed = await rawGet(`${baseUrl(server)}/`, { host: `ui.lan:${server.port}` });
  assert.equal(allowed.status, 200);
  const refused = await rawGet(`${baseUrl(server)}/`, { host: `evil.example:${server.port}` });
  assert.equal(refused.status, 403);
});
