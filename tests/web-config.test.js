/**
 * Loopback settings web UI tests (issue #56).
 *
 * These bind a real loopback server and make real HTTP requests, because the claims
 * that matter here are in the wiring, not in a pure function: the one-time token is
 * refused on reuse, the `Host` header is refused off-loopback, every response is
 * no-store, a secret never reaches the page or `config.toml`, and the listener is
 * gone once the editor closes. A unit test of `renderSettingsPage` could not show any
 * of that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfig } from '../src/config.js';
import { createFileCredentialProvider, saveSecrets } from '../src/secrets.js';
import { createSettingsEditor, createSetupSettingsController, SETTINGS } from '../src/ui/settings.js';
import {
  constantTimeEqual,
  createWebSettingsServer,
  defaultWebSettingsDialog,
  defaultWebSetupDialog,
  isAllowedHostHeader,
  renderSettingsPage,
} from '../src/ui/web-config.js';

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-web-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The real editor, with a fake credential sink unless one is supplied. */
function makeEditor(t, { configPath = null, secrets = null, saveSecrets: save = null } = {}) {
  const dir = configPath ? null : tempDir(t);
  const path = configPath ?? join(dir, 'config.toml');
  const writes = [];
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: path,
    secrets,
    saveSecrets:
      save ??
      (async ({ entries }) => {
        writes.push(entries);
        return { saved: Object.keys(entries), providers: ['fake'] };
      }),
  });
  return { editor, path, dir, writes };
}

async function startUi(t, { controller, ...overrides } = {}) {
  const server = createWebSettingsServer({ controller, ...overrides });
  await server.start();
  t.after(() => server.stop());
  return server;
}

/**
 * A minimal HTTP client so the `Host` header can be overridden. `fetch` (undici)
 * refuses to set `Host`, which is exactly the header under test.
 */
function request(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = httpRequest(
      { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

function sessionFrom(html) {
  const match = /name="session" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the page must carry a session token');
  return match[1];
}

async function openSession(t, server) {
  const page = await request(server.url);
  assert.equal(page.status, 200);
  return { page, session: sessionFrom(page.text) };
}

function rowFor(html, id) {
  const match = new RegExp(`<th>${id.replace(/\./g, '\\.')}</th>[\\s\\S]*?</tr>`).exec(html);
  assert.ok(match, `the page must contain a row for ${id}`);
  return match[0];
}

// ---------------------------------------------------------------------------
// Host validation
// ---------------------------------------------------------------------------

test('the Host header must be loopback on the bound port', () => {
  assert.equal(isAllowedHostHeader('127.0.0.1:43871', 43871), true);
  assert.equal(isAllowedHostHeader('localhost:43871', 43871), true);
  assert.equal(isAllowedHostHeader('[::1]:43871', 43871), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:1', 43871), false, 'a different port is not this server');
  assert.equal(isAllowedHostHeader('evil.example:43871', 43871), false, 'DNS rebinding sends the attacker hostname');
  assert.equal(isAllowedHostHeader('127.0.0.1', 43871), false, 'a missing port cannot be matched');
  assert.equal(isAllowedHostHeader('', 43871), false);
  assert.equal(isAllowedHostHeader(undefined, 43871), false);
});

test('a wrong Host is refused before the launch token is even considered', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  // The token is real, so only the Host check can refuse this.
  const res = await request(server.url, { headers: { host: 'attacker.example' } });
  assert.equal(res.status, 403);
  assert.match(res.text, /loopback/i);
  assert.equal(res.headers['cache-control'], 'no-store');
});

// ---------------------------------------------------------------------------
// The one-time launch token
// ---------------------------------------------------------------------------

test('the launch token is single-use: a second GET with it is refused', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const first = await request(server.url);
  assert.equal(first.status, 200);
  assert.ok(server.url.includes('token='), 'the opened URL carries the launch token');

  const second = await request(server.url);
  assert.equal(second.status, 403);
  assert.match(second.text, /already used or has expired/i);
});

test('the launch token expires after its short lifetime', async (t) => {
  const { editor } = makeEditor(t);
  let nowMs = 1_000_000;
  const server = await startUi(t, { controller: editor, now: () => nowMs, launchTokenTtlMs: 1_000 });
  nowMs += 1_001;
  const res = await request(server.url);
  assert.equal(res.status, 403);
});

test('a wrong launch token is refused', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const res = await request(`http://127.0.0.1:${server.port}/?token=${'0'.repeat(64)}`);
  assert.equal(res.status, 403);
});

test('a session token from another session is refused', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  await openSession(t, server);
  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session: 'not-the-session', 'v:storage.retain_days': '3' }),
  });
  assert.equal(res.status, 403);
  assert.match(res.text, /session/i);
});

test('constantTimeEqual compares exactly', () => {
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
  assert.equal(constantTimeEqual('abc', null), false);
});

// ---------------------------------------------------------------------------
// One source of truth: the descriptor list
// ---------------------------------------------------------------------------

test('the page renders every descriptor in settings.js, with live/restart labels', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const { page } = await openSession(t, server);
  for (const setting of SETTINGS) {
    assert.ok(page.text.includes(`<th>${setting.id}</th>`), `${setting.id} must appear in the UI`);
  }
  assert.match(rowFor(page.text, 'ui.notify_on_unresolved'), /\[live\]/, 'a per-solve setting is labelled live');
  assert.match(rowFor(page.text, 'solver.llm_text_model'), /\[restart\]/, 'a captured setting is labelled restart');
  assert.match(rowFor(page.text, 'http.token'), /\[restart\]/);
});

test('a descriptor added to the controller list appears in the UI with no second edit', async (t) => {
  // A synthetic controller: if the server had its own hardcoded list, this id would
  // not appear. This is the drift guard between settings.js and the web UI.
  const items = [
    { id: 'future.setting', label: 'A future setting', secret: false, restart: false, type: 'string', value: 'hello', display: 'hello', pending: false },
  ];
  const controller = {
    list: () => items,
    set: () => {},
    reset: () => {},
    save: async () => ({ saved: true, changed: ['future.setting'], restartRequired: [], live: ['future.setting'] }),
  };
  const server = await startUi(t, { controller });
  const { page } = await openSession(t, server);
  assert.match(page.text, /<th>future\.setting<\/th>/);
  assert.match(rowFor(page.text, 'future.setting'), /\[live\]/);
  assert.match(page.text, /name="v:future\.setting"/);
});

// ---------------------------------------------------------------------------
// Secrets never reach the page
// ---------------------------------------------------------------------------

test('a stored secret shows presence and source but never its value', async (t) => {
  const secretValue = 'o.SECRET-VALUE-MUST-NOT-RENDER';
  const { editor } = makeEditor(t, { secrets: { pushbullet: { value: secretValue, source: 'file' }, llm: null, http: null } });
  const server = await startUi(t, { controller: editor });
  const { page } = await openSession(t, server);
  assert.equal(page.text.includes(secretValue), false, 'the secret value must never be rendered');
  assert.match(page.text, /o\.S… \(file\)/, 'presence and source are shown instead');
  assert.match(rowFor(page.text, 'http.token'), /not set/);
});

test('a secret with no probe has no Test connection button', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const { page } = await openSession(t, server);
  const httpRow = rowFor(page.text, 'http.token');
  assert.equal(httpRow.includes('Test connection'), false, 'http.token has no endpoint to probe');
  assert.match(rowFor(page.text, 'pushbullet.token'), /Test connection/);
});

// ---------------------------------------------------------------------------
// Validation before write, mixed save, atomic backup
// ---------------------------------------------------------------------------

test('an invalid value is rejected before anything is written and names the setting', async (t) => {
  const { editor, path } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);

  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:storage.retain_days': 'not-a-number' }),
  });
  assert.equal(res.status, 400);
  assert.match(res.text, /storage\.retain_days must be a number/);
  assert.equal(existsSync(path), false, 'a rejected value must not create the config file');
  assert.equal(editor.pending.size, 0, 'a rejection must not leave a pending write');
});

test('an invalid value leaves an existing config byte-identical', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'config.toml');
  writeFileSync(path, '[storage]\nretain_days = 7\n');
  const before = readFileSync(path, 'utf8');
  const { editor } = makeEditor(t, { configPath: path });
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);

  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:storage.retain_days': 'zero' }),
  });
  assert.equal(res.status, 400);
  assert.equal(readFileSync(path, 'utf8'), before, 'nothing may be written on a rejection');
});

test('a mixed save routes the HTTP token to the credential store and the rest to config.toml, keeping a backup', async (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'config.toml');
  const credentialPath = join(dir, 'credentials.json');
  writeFileSync(configPath, '[storage]\nretain_days = 7\n');
  const provider = createFileCredentialProvider({ path: credentialPath });
  const { editor } = makeEditor(t, {
    configPath,
    saveSecrets: (args) => saveSecrets({ ...args, providers: [provider] }),
  });
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);

  const token = 'a-long-random-enough-http-token';
  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:http.token': token, 'v:storage.retain_days': '3' }),
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /Saved\./);

  const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
  assert.equal(credentials.http_auth_token, token, 'the HTTP token goes to the credential store');
  const configText = readFileSync(configPath, 'utf8');
  assert.equal(configText.includes(token), false, 'the HTTP token must never reach config.toml');
  assert.match(configText, /retain_days = 3/, 'the non-secret setting is written');
  assert.equal(existsSync(`${configPath}.bak`), true, 'the previous config is kept as a backup');
});

test('an empty secret field keeps the stored secret instead of clearing it', async (t) => {
  const { editor, writes } = makeEditor(t, { secrets: { pushbullet: { value: 'o.STORED', source: 'file' }, llm: null, http: null } });
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);
  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:storage.retain_days': '3' }),
  });
  assert.equal(res.status, 200);
  assert.equal(writes.length, 0, 'a blank secret input must not be written');
});

// ---------------------------------------------------------------------------
// Response hygiene and lifecycle
// ---------------------------------------------------------------------------

test('every response is Cache-Control: no-store', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const page = await request(server.url);
  assert.equal(page.headers['cache-control'], 'no-store');
  const missing = await request(`http://127.0.0.1:${server.port}/nope`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['cache-control'], 'no-store');
  const refused = await request(server.url, { headers: { host: 'evil.example' } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers['cache-control'], 'no-store');
});

test('the listener is closed and the port released after a save', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);
  const res = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:storage.retain_days': '3' }),
  });
  assert.equal(res.status, 200);
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.saved, true);
  assert.equal(server.server.listening, false, 'the listener must be gone once the editor saves');
  assert.equal(server.port, server.address.port);
});

test('the listener is closed after a cancel', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  const { session } = await openSession(t, server);
  await request(`http://127.0.0.1:${server.port}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session }),
  });
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.cancelled, true);
  assert.equal(outcome.saved, false);
  assert.equal(server.server.listening, false);
});

test('a session that is never used times out and closes', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor, timeoutMs: 20 });
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.cancelled, true);
  assert.match(outcome.detail, /timed out/);
  assert.equal(server.server.listening, false);
});

test('the server only ever binds 127.0.0.1', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  assert.equal(server.address.address, '127.0.0.1');
  assert.equal(server.address.family, 'IPv4');
  assert.notEqual(server.port, 0, 'an ephemeral port is chosen');
});

// ---------------------------------------------------------------------------
// The dialog wrapper: the default wired into the tray / `config edit --gui`
// ---------------------------------------------------------------------------

test('defaultWebSettingsDialog opens the browser, saves through HTTP, and stops', async (t) => {
  const { editor, path } = makeEditor(t);
  let openedUrl = null;
  const dialog = defaultWebSettingsDialog({
    editor,
    openBrowser: async (url) => {
      openedUrl = url;
      return { opened: true };
    },
  });

  // Wait for the browser opener to receive the URL, then drive the session.
  for (let i = 0; openedUrl == null && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(openedUrl, 'the dialog must hand a URL to the browser opener');
  assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);

  const page = await request(openedUrl);
  const session = sessionFrom(page.text);
  const port = new URL(openedUrl).port;
  const save = await request(`http://127.0.0.1:${port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:storage.retain_days': '5' }),
  });
  assert.equal(save.status, 200);

  const outcome = await dialog;
  assert.equal(outcome.saved, true);
  assert.equal(readFileSync(path, 'utf8').includes('retain_days = 5'), true);
});

test('a web first-run dialog collects the two secrets through createSetup', async (t) => {
  const applied = [];
  const setup = {
    validate: () => ({ ok: true, errors: {} }),
    testConnection: async () => ({ ok: true, results: { pushbullet: { ok: true, detail: 'Pushbullet accepted the token' } } }),
    apply: async (input) => {
      applied.push(input);
      return { saved: true, savedNames: ['pushbullet', 'llm'] };
    },
  };
  let openedUrl = null;
  const dialog = defaultWebSetupDialog({
    setup,
    openBrowser: async (url) => {
      openedUrl = url;
      return { opened: true };
    },
  });
  for (let i = 0; openedUrl == null && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  const page = await request(openedUrl);
  assert.match(page.text, /pushbullet\.token/);
  assert.match(page.text, /llm\.api_key/);
  const session = sessionFrom(page.text);
  const port = new URL(openedUrl).port;
  const res = await request(`http://127.0.0.1:${port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session, 'v:pushbullet.token': 'o.first-run', 'v:llm.api_key': 'sk-first-run' }),
  });
  assert.equal(res.status, 200, res.text);
  const outcome = await dialog;
  assert.equal(outcome.saved, true);
  assert.deepEqual(applied, [{ pushbulletToken: 'o.first-run', llmApiKey: 'sk-first-run' }]);
});

test('a start failure is returned as an actionable outcome, not thrown', async (t) => {
  const { editor } = makeEditor(t);
  // Force listen() to fail the way a taken privileged port would.
  const createServerImpl = () => {
    const server = createHttpServer();
    server.listen = (_options, cb) => {
      const err = new Error('EADDRINUSE: address already in use');
      server.emit('error', err);
      return server;
    };
    return server;
  };
  const outcome = await defaultWebSettingsDialog({ editor, createServerImpl });
  assert.equal(outcome.saved, false);
  assert.equal(outcome.failed, true);
  assert.match(outcome.detail, /could not start the settings web UI/);
  assert.match(outcome.detail, /EADDRINUSE/);
});

// ---------------------------------------------------------------------------
// The setup controller keeps the descriptor labels
// ---------------------------------------------------------------------------

test('the setup controller is built from the settings descriptors', () => {
  const setup = { validate: () => ({ ok: true, errors: {} }), testConnection: async () => ({ ok: true, results: {} }), apply: async () => ({ saved: true }) };
  const controller = createSetupSettingsController({ setup });
  assert.deepEqual(
    controller.list().map((item) => item.id).sort(),
    ['llm.api_key', 'pushbullet.token']
  );
  // The labels come from settings.js, not a second list.
  assert.equal(controller.list().find((i) => i.id === 'pushbullet.token').label, 'Pushbullet token');
});

test('renderSettingsPage is the whole renderer and escapes untrusted text', () => {
  const html = renderSettingsPage({
    items: [
      { id: 'x.<script>', label: '', secret: false, restart: false, type: 'string', value: '" onfocus="alert(1)', display: '<b>', pending: false },
    ],
    session: '" onload="evil',
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('onfocus="alert(1)"'), false);
  assert.equal(html.includes('onload="evil"'), false);
});
