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

/** A concrete free loopback port, so a test can assert a *stable* `web_ui.port` (#85). */
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
  // Backslashes first, then the metacharacters that need escaping: escaping dots first
  // would turn the `\` it inserts into `\\` when the backslash pass ran afterwards, so
  // the pattern would stop meaning a literal `.` (CodeQL js/incomplete-sanitization).
  const escaped = id.replace(/\\/g, '\\\\').replace(/\./g, '\\.');
  // The id is no longer the row heading - the registry label is (#139) - so the row is
  // located by its id element, which is still the row's identity and submitted value.
  const match = new RegExp(`<code class="setting-id">${escaped}</code>[\\s\\S]*?</tr>`).exec(html);
  assert.ok(match, `the page must contain a row for ${id}`);
  return match[0];
}

// ---------------------------------------------------------------------------
// Host validation
// ---------------------------------------------------------------------------

test('the Host header is matched by name; the port plays no part (#85)', () => {
  assert.equal(isAllowedHostHeader('127.0.0.1:43871'), true);
  assert.equal(isAllowedHostHeader('localhost:43871'), true);
  assert.equal(isAllowedHostHeader('[::1]:43871'), true);
  // The port is not the security-relevant part: a proxy forwards `:443` (or no port)
  // while connecting to a different internal port, and the name is what DNS rebinding
  // attacks. The rule stays exact on the name, so this is not "any Host".
  assert.equal(isAllowedHostHeader('127.0.0.1:1'), true);
  assert.equal(isAllowedHostHeader('127.0.0.1'), true, 'a portless Host is a valid name');
  assert.equal(isAllowedHostHeader('evil.example:43871'), false, 'DNS rebinding sends the attacker hostname');
  assert.equal(isAllowedHostHeader('evil.example'), false);
  assert.equal(isAllowedHostHeader('evil.example:443'), false);
  assert.equal(isAllowedHostHeader(''), false);
  assert.equal(isAllowedHostHeader(undefined), false);
});

test('a wrong Host is refused before the launch token is even considered', async (t) => {
  const { editor } = makeEditor(t);
  const server = await startUi(t, { controller: editor });
  // The token is real, so only the Host check can refuse this.
  const res = await request(server.url, { headers: { host: 'attacker.example' } });
  assert.equal(res.status, 403);
  assert.match(res.text, /allowed hostname/i);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('#85: a reverse-proxy Host for an enumerated name is admitted, a foreign name is refused', async (t) => {
  const { editor } = makeEditor(t);
  // The proxy connects to this ephemeral upstream but forwards the public name. The
  // public port (`:443`) and the internal one differ; only the name is enumerated.
  const server = await startUi(t, { controller: editor, webUi: { allowed_hosts: ['ui.example.com'] } });
  // `/login` is behind the same access and Host checks but does not consume the
  // one-time launch token, so the same server can answer more than one probe.
  const loginUrl = `http://127.0.0.1:${server.port}/login`;
  for (const host of ['ui.example.com', 'ui.example.com:443', `ui.example.com:${server.port}`]) {
    const admitted = await request(loginUrl, { headers: { host } });
    assert.equal(admitted.status, 200, `${host} must be admitted: ${admitted.text}`);
    assert.match(admitted.text, /Sign in/i);
  }
  const refused = await request(loginUrl, { headers: { host: 'other.example.com' } });
  assert.equal(refused.status, 403, 'an unenumerated name is still refused');
});

test('#85: web_ui.port is the stable port the listener binds, not an ephemeral one', async (t) => {
  const { editor } = makeEditor(t);
  const port = await freePort();
  const server = await startUi(t, { controller: editor, webUi: { port } });
  assert.equal(server.port, port, 'the configured port is the one that listens');
  const page = await request(server.url);
  assert.equal(page.status, 200);
});

test('#85: a non-loopback range with an ephemeral port refuses to start, naming web_ui.port', async (t) => {
  const { editor } = makeEditor(t);
  assert.throws(
    () =>
      createWebSettingsServer({
        controller: editor,
        webUi: { bind: '127.0.0.1', port: 0, allowed_cidrs: ['192.168.1.0/24'] },
        credentialVerifier: 'scrypt$1$1$1$AA$AA',
      }),
    (err) => /web_ui\.port/.test(err.message) && /ephemeral|stable/i.test(err.message),
    'the operator must be told the port is missing, not handed an unreachable UI'
  );
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
    assert.ok(
      page.text.includes(`<code class="setting-id">${setting.id}</code>`),
      `${setting.id} must appear in the UI as the row's identity`
    );
    // #139: the registry's label is rendered, not just carried. A descriptor whose
    // label drifted out of the page fails here rather than silently in the browser.
    assert.ok(page.text.includes(`<span class="setting-label">${setting.label}</span>`), `${setting.id} must render its label`);
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
  assert.match(page.text, /<code class="setting-id">future\.setting<\/code>/);
  assert.match(page.text, /<span class="setting-label">A future setting<\/span>/);
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
    handoffDir: tempDir(t),
    openBrowser: async (url) => {
      openedUrl = url;
      return { launched: true };
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
    handoffDir: tempDir(t),
    openBrowser: async (url) => {
      openedUrl = url;
      return { launched: true };
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
// The hand-off fallback (#169): a launched handler is not a browser that opened
// ---------------------------------------------------------------------------

test('a failed browser hand-off prints the one-time link to the terminal (#169)', async (t) => {
  const { editor } = makeEditor(t);
  let openedUrl = null;
  const written = [];
  const dialog = defaultWebSettingsDialog({
    editor,
    timeoutMs: 20,
    openBrowser: async (url) => {
      openedUrl = url;
      return { launched: false };
    },
    output: { write: (text) => written.push(text) },
  });
  const outcome = await dialog;
  assert.equal(outcome.cancelled, true);
  assert.ok(openedUrl, 'the opener is still tried');
  assert.ok(written.join('').includes(openedUrl), 'the link must reach the terminal');
  assert.match(written.join(''), /Open the settings UI in a browser:/);
});

test('the link is printed even when the opener reports a launch (#169)', async (t) => {
  // The shipped bug: `openPath` resolved on `spawn`, so "success" hid a Documents window
  // and this fallback never ran. A spawn is not an open, so a terminal is not gated on it.
  const { editor } = makeEditor(t);
  let openedUrl = null;
  const written = [];
  const dialog = defaultWebSettingsDialog({
    editor,
    timeoutMs: 20,
    openBrowser: async (url) => {
      openedUrl = url;
      return { launched: true };
    },
    output: { write: (text) => written.push(text) },
  });
  await dialog;
  assert.ok(written.join('').includes(openedUrl), 'a launched handler must not suppress the link');
});

test('a hidden first run records the link and shows it, then removes the record (#169)', async (t) => {
  const { editor } = makeEditor(t);
  const dir = tempDir(t);
  const messages = [];
  let openedUrl = null;
  const dialog = defaultWebSetupDialog({
    setup: {
      validate: () => ({ ok: true, errors: {} }),
      testConnection: async () => ({ ok: true, results: {} }),
      apply: async () => ({ saved: true, savedNames: [] }),
    },
    timeoutMs: 60,
    handoffDir: dir,
    // Even a reported success must not suppress the dialog on first run: there is no
    // terminal and no tray yet, so this is the user's only surface.
    openBrowser: async (url) => {
      openedUrl = url;
      return { launched: true };
    },
    notifyUser: async (message) => messages.push(message),
  });

  const file = join(dir, 'settings-url.txt');
  for (let i = 0; !existsSync(file) && i < 200; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(existsSync(file), 'the link must be recorded while the session is up');
  assert.equal(readFileSync(file, 'utf8').trim(), openedUrl);
  assert.ok(messages[0]?.includes(openedUrl), 'the link must reach a dialog the user can read');

  const outcome = await dialog;
  assert.equal(outcome.cancelled, true);
  assert.equal(existsSync(file), false, 'the record is removed when the session settles');
});

test('a hidden tray Settings open stays quiet when the opener launched (#169)', async (t) => {
  // The tray is the surface here, so only a reported failure raises the dialog; the
  // file is still written, so a browser that silently never appeared is not a dead end.
  const { editor } = makeEditor(t);
  const dir = tempDir(t);
  const messages = [];
  const dialog = defaultWebSettingsDialog({
    editor,
    timeoutMs: 20,
    handoffDir: dir,
    openBrowser: async () => ({ launched: true }),
    notifyUser: async (message) => messages.push(message),
  });
  const outcome = await dialog;
  assert.equal(outcome.cancelled, true);
  assert.deepEqual(messages, []);
  assert.equal(existsSync(join(dir, 'settings-url.txt')), false);
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

// ---------------------------------------------------------------------------
// The restart offer (#128)
// ---------------------------------------------------------------------------

function restartController(result) {
  return { list: () => [], reset: () => {}, save: async () => result };
}

const restartSave = {
  saved: true,
  changed: ['solver.llm_text_model'],
  restartRequired: ['solver.llm_text_model'],
  live: [],
};

const restartablePlan = { restartable: true, display: 'wscript.exe "C:\\x\\PuzzleSolver.vbs"' };

async function waitForClosed(server) {
  for (let i = 0; i < 400 && server.server.listening; i++) await new Promise((r) => setTimeout(r, 5));
}

async function saveForRestart(t, server) {
  const { session } = await openSession(t, server);
  const save = await request(`http://127.0.0.1:${server.port}/save`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session }),
  });
  return { session, save };
}

test('a save that needs a restart keeps the session open and offers a real POST (#128)', async (t) => {
  const server = await startUi(t, { controller: restartController(restartSave), restartPlan: restartablePlan });
  const { session, save } = await saveForRestart(t, server);
  assert.equal(save.status, 200);
  assert.match(save.text, /Restart now/);
  assert.match(save.text, /action="\/restart"/);
  assert.match(save.text, /action="\/dismiss"/);
  // The session is deliberately still up: the restart decision is what the app waits on.
  assert.equal(server.server.listening, true);
  assert.equal(session.length > 0, true);
});

test('/restart answers first, then resolves the outcome as restarted and closes (#128)', async (t) => {
  const server = await startUi(t, { controller: restartController(restartSave), restartPlan: restartablePlan });
  const { session } = await saveForRestart(t, server);
  const restart = await request(`http://127.0.0.1:${server.port}/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session }),
  });
  assert.equal(restart.status, 200);
  assert.match(restart.text, /Restarting/);
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.saved, true, 'the restart is a decision on a successful save');
  assert.equal(outcome.restarted, true);
  await waitForClosed(server);
  assert.equal(server.server.listening, false);
});

test('/dismiss keeps the save and does not ask for a restart (#128)', async (t) => {
  const server = await startUi(t, { controller: restartController(restartSave), restartPlan: restartablePlan });
  const { session } = await saveForRestart(t, server);
  const dismiss = await request(`http://127.0.0.1:${server.port}/dismiss`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session }),
  });
  assert.equal(dismiss.status, 200);
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.saved, true);
  assert.equal(outcome.restarted, false);
  await waitForClosed(server);
});

test('a restart that times out is still a successful save, not a cancel (#128)', async (t) => {
  const server = await startUi(t, {
    controller: restartController(restartSave),
    restartPlan: restartablePlan,
    timeoutMs: 1000,
  });
  await saveForRestart(t, server);
  const outcome = await server.waitForOutcome();
  assert.equal(outcome.saved, true);
  assert.equal(outcome.restarted, false);
  assert.match(outcome.detail, /restart offer timed out/);
});

test('without a restart mechanism the page prints the command and closes on save (#128 hazard 6)', async (t) => {
  const server = await startUi(t, {
    controller: restartController(restartSave),
    restartPlan: { restartable: false, display: 'node "/app/src/cli.js" listen' },
  });
  const { save } = await saveForRestart(t, server);
  assert.equal(save.status, 200);
  assert.match(save.text, /node &quot;\/app\/src\/cli\.js&quot; listen/);
  assert.equal(save.text.includes('/restart'), false, 'no dead button when nothing can restart');
  await waitForClosed(server);
});

test('/restart is refused when no save is waiting on it (#128)', async (t) => {
  const server = await startUi(t, { controller: restartController(restartSave), restartPlan: restartablePlan });
  const { session } = await openSession(t, server);
  const res = await request(`http://127.0.0.1:${server.port}/restart`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: formBody({ session }),
  });
  assert.equal(res.status, 404);
});
