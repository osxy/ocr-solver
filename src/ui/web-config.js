/**
 * Loopback web UI for editing settings and first-run setup (issue #56).
 *
 * On Windows the launcher runs the tray with the window hidden (`shell.Run ..., 0`),
 * so the process has no console and the `readline` editor in `settings-dialog.js`
 * has no stdin. This module is the graphical surface for that case: a `node:http`
 * server on an ephemeral loopback port, opened in the default browser. It is
 * deliberately *not* a native widget, because a real HTTP request, a real form post
 * and a real assertion are checkable in CI on this host, and a WinForms window is not.
 *
 * The UI owns no setting knowledge. It renders whatever `controller.list()` returns
 * and persists through `controller.set()`/`controller.save()`. The descriptor list in
 * `src/ui/settings.js` is the single source of truth, and the same controller is the
 * terminal editor, so the two cannot drift.
 *
 * Security is the point, because this endpoint can write the config *and* the
 * credential store - a more sensitive surface than the solve endpoint:
 *
 *  - the listener binds `127.0.0.1` on port 0 and that is **not configurable here**;
 *  - the URL the app opens carries a **one-time launch token** that is single-use,
 *    short-lived (5 minutes) and distinct from the HTTP ingress token. It is redeemed
 *    for a per-session token embedded in the page, so the launch token never has to
 *    survive in a browser history or a `Referer` header;
 *  - the `Host` header is validated against the loopback address and the bound port,
 *    which is what stops a malicious page reaching the UI through DNS rebinding;
 *  - every response carries `Cache-Control: no-store`, so a token or a setting is not
 *    left in the browser cache;
 *  - a secret value is never rendered - presence and source only, exactly as
 *    `config list` does;
 *  - the listener is closed when the editor finishes (save, cancel or timeout), so
 *    the window of exposure is the editing session rather than the process uptime.
 *
 * A failed start returns an actionable outcome instead of throwing, because the tray
 * must keep running when the UI cannot.
 */
import { createServer as createHttpServerImpl } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { openPath } from './open-path.js';
import { createSetupSettingsController, getSetting, parseSettingValue, serializeSettingValue } from './settings.js';

/** The only address this UI ever binds. Not read from config, by design. */
export const WEB_UI_BIND = '127.0.0.1';
/** The body is a settings form, never an image; a small cap is plenty. */
export const WEB_UI_MAX_BODY_BYTES = 256 * 1024;
/** The launch link is worthless after this long even if it was never clicked. */
export const DEFAULT_LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;
/** How long a session may sit idle before the server closes itself. */
export const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * True when `hostHeader` names this loopback UI and the bound port.
 *
 * The whole header is checked, including the port, and only a loopback literal or
 * `localhost` qualifies. A DNS-rebinding page makes the browser send the attacker's
 * hostname (`evil.example`) in `Host` even though the connection lands on 127.0.0.1;
 * rejecting anything else is the control that stops it. A missing or malformed
 * header is refused rather than assumed loopback.
 */
export function isAllowedHostHeader(hostHeader, port) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return false;
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostHeader.trim().toLowerCase());
  if (!match) return false;
  if (Number(match[2]) !== Number(port)) return false;
  const host = match[1].replace(/^\[|\]$/g, '');
  return host === WEB_UI_BIND || host === 'localhost' || host === '::1';
}

/** Constant-time comparison for the two opaque tokens. */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const STYLE = `
  body { font: 14px system-ui, sans-serif; margin: 1.5rem auto; max-width: 60rem; color: #111; }
  h1 { font-size: 1.3rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #ddd; vertical-align: middle; }
  th { white-space: nowrap; font-family: ui-monospace, monospace; font-size: 0.85em; }
  input[type=text], input[type=password], select, textarea { width: 24rem; max-width: 100%; }
  .display { color: #555; font-size: 0.85em; }
  .banner { padding: 0.6rem 0.8rem; margin: 0.8rem 0; border-radius: 4px; }
  .error { background: #fdecea; border: 1px solid #f5c6cb; }
  .test { background: #eef6ff; border: 1px solid #cfe2ff; }
  .ok { background: #eafaef; border: 1px solid #b7e4c7; }
  .secret { color: #555; font-size: 0.85em; }
  .actions { margin-top: 1rem; }
  button { padding: 0.35rem 0.7rem; margin-right: 0.5rem; }
`;

function page({ body, configPath = null, credentialPath = null }) {
  const where = [
    configPath ? `Config: <code>${escapeHtml(configPath)}</code>` : null,
    credentialPath ? `Secrets: <code>${escapeHtml(credentialPath)}</code>` : null,
  ]
    .filter(Boolean)
    .join(' &middot; ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PuzzleSolver settings</title><style>${STYLE}</style></head>
<body><h1>PuzzleSolver settings</h1>${where ? `<p>${where}</p>` : ''}${body}</body></html>`;
}

function messagePage(title, message, options = {}) {
  return page({ body: `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>`, ...options });
}

function renderField(item) {
  const name = `v:${item.id}`;
  if (item.secret) {
    return `<input type="password" name="${escapeHtml(name)}" value="" autocomplete="off" placeholder="leave blank to keep">`;
  }
  if (item.type === 'boolean') {
    const checked = item.value === true ? ' checked' : '';
    // A hidden "false" is submitted when the box is unchecked; the server treats a
    // "true" anywhere in the pair as checked.
    return `<input type="hidden" name="${escapeHtml(name)}" value="false"><input type="checkbox" name="${escapeHtml(name)}" value="true"${checked}>`;
  }
  if (item.type === 'enum') {
    const options = (item.choices ?? [])
      .map((choice) => `<option value="${escapeHtml(choice)}"${choice === item.value ? ' selected' : ''}>${escapeHtml(choice)}</option>`)
      .join('');
    return `<select name="${escapeHtml(name)}">${options}</select>`;
  }
  if (item.multiline) {
    return `<textarea name="${escapeHtml(name)}" rows="3">${escapeHtml(item.value ?? '')}</textarea>`;
  }
  return `<input type="text" name="${escapeHtml(name)}" value="${escapeHtml(item.value ?? '')}">`;
}

/**
 * Render the whole editor. Exported so a test can assert the descriptor list is the
 * only input: a descriptor that exists in `list()` appears here with no second edit.
 */
export function renderSettingsPage({ items, session, configPath = null, credentialPath = null, error = null, test = null }) {
  const rows = items.map((item) => {
    const tag = item.restart ? 'restart' : 'live';
    const probe =
      item.secret && item.testable !== false
        ? `<button type="submit" formaction="/test" name="test_id" value="${escapeHtml(item.id)}">Test connection</button>`
        : '';
    const pending = item.pending ? ' (pending)' : '';
    return `<tr><th>${escapeHtml(item.id)}</th><td>${renderField(item)}</td>` +
      `<td class="display">${escapeHtml(item.display)}${pending} <span class="secret">[${tag}]</span></td><td>${probe}</td></tr>`;
  });
  const banners = [
    error ? `<div class="banner error"><strong>Rejected:</strong> ${escapeHtml(error)}</div>` : '',
    test
      ? `<div class="banner test">${escapeHtml(test.id)}: ${test.ok ? 'ok' : 'failed'} - ${escapeHtml(test.detail)}</div>`
      : '',
  ].join('');
  const body =
    banners +
    `<form method="post" action="/save"><input type="hidden" name="session" value="${escapeHtml(session)}">` +
    `<table><thead><tr><th>Setting</th><th>Value</th><th>Current</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
    `<div class="actions"><button type="submit">Save</button>` +
    `<button type="submit" formaction="/cancel" formnovalidate>Cancel</button></div></form>`;
  return page({ body, configPath, credentialPath });
}

function renderDonePage(result, options = {}) {
  const changed = (result.changed ?? []).map((id) => `<li><code>${escapeHtml(id)}</code></li>`).join('');
  const restart = (result.restartRequired ?? []).length
    ? `<p>Restart the service for: ${result.restartRequired.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}</p>`
    : '';
  const live = (result.live ?? []).length
    ? `<p>Applied live: ${result.live.map((id) => `<code>${escapeHtml(id)}</code>`).join(', ')}</p>`
    : '';
  const backup = result.backupPath ? `<p>Previous config backed up to <code>${escapeHtml(result.backupPath)}</code></p>` : '';
  const body = `<div class="banner ok"><strong>Saved.</strong></div>${changed ? `<ul>${changed}</ul>` : ''}${restart}${live}${backup}<p>You can close this tab.</p>`;
  return page({ body, ...options });
}

function parseForm(form, item) {
  const name = `v:${item.id}`;
  if (item.type === 'boolean') {
    const values = form.getAll(name);
    // A field the form did not include at all is "leave it alone", not "unchecked".
    // The rendered page always sends the hidden `false`, so an absent boolean only
    // happens for a programmatic post (a test), and treating it as false would
    // silently turn settings off.
    if (values.length === 0) return null;
    return values.includes('true') ? 'true' : 'false';
  }
  return form.get(name);
}

/**
 * Apply the posted form to `controller`, and report every value the controller
 * refused **before** `save()` is reached. The controller's own `parseSettingValue`
 * does the validating, so this is not a second opinion about what is valid.
 */
export function applySettingsForm(controller, form) {
  controller.reset?.();
  const errors = [];
  for (const item of controller.list()) {
    const raw = parseForm(form, item);
    if (raw == null) continue;
    if (item.secret && raw === '') continue; // blank means "keep the stored secret"
    const setting = getSetting(item.id);
    if (!item.secret && setting) {
      let parsed;
      try {
        parsed = parseSettingValue(setting, raw);
      } catch (err) {
        errors.push({ id: item.id, message: err?.message ?? String(err) });
        continue;
      }
      if (serializeSettingValue(setting, parsed) === serializeSettingValue(setting, item.value)) continue;
    }
    try {
      controller.set(item.id, raw);
    } catch (err) {
      errors.push({ id: item.id, message: err?.message ?? String(err) });
    }
  }
  return errors;
}

function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new Error(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('request aborted before the body was read')));
  });
}

/**
 * Build the loopback UI server. It owns a listener of its own: `start()` binds and
 * generates the one-time launch token, `stop()` closes the listener and every open
 * connection. `waitForOutcome()` resolves with the editor outcome (or a cancel /
 * timeout / external close).
 */
export function createWebSettingsServer({
  controller,
  configPath = null,
  credentialPath = null,
  logger = null,
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  launchTokenTtlMs = DEFAULT_LAUNCH_TOKEN_TTL_MS,
  now = () => Date.now(),
  randomToken = () => randomBytes(32).toString('hex'),
  createServerImpl = createHttpServerImpl,
} = {}) {
  if (!controller || typeof controller.list !== 'function' || typeof controller.save !== 'function') {
    throw new Error('createWebSettingsServer needs a settings controller (list/save)');
  }

  let address = null;
  let launchToken = null; // { token, issuedAt, used }
  let sessionToken = null;
  let stopped = false;
  let settled = false;
  let timeoutTimer = null;
  let resolveOutcome;
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve;
  });

  function settle(outcomeValue) {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    resolveOutcome(outcomeValue);
  }

  function finish(outcomeValue) {
    settle(outcomeValue);
  }

  function send(res, status, body, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const buffer = Buffer.from(body);
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(buffer.length),
      // Every response, including the error pages: a token or a setting must not sit
      // in the browser's cache.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      ...headers,
    });
    res.end(buffer);
  }

  const view = () => ({ items: controller.list(), configPath, credentialPath });

  async function handle(req, res) {
    try {
      // The Host check runs before anything else, including token handling: a
      // rebinding request must not even learn whether a token is valid.
      if (!isAllowedHostHeader(req.headers.host, address?.port)) {
        return send(res, 403, messagePage('Refused', 'This settings UI only answers requests addressed to loopback on its own port.'));
      }
      const url = new URL(req.url ?? '/', `http://${WEB_UI_BIND}`);
      const method = String(req.method ?? 'GET').toUpperCase();

      if (method === 'GET' && url.pathname === '/') {
        const provided = url.searchParams.get('token') ?? '';
        const fresh = launchToken && !launchToken.used && now() - launchToken.issuedAt <= launchTokenTtlMs;
        if (!fresh || !constantTimeEqual(provided, launchToken.token)) {
          return send(
            res,
            403,
            messagePage('Link no longer valid', 'The one-time settings link was already used or has expired. Open Settings again to get a new one.')
          );
        }
        launchToken.used = true;
        sessionToken = randomToken();
        return send(res, 200, renderSettingsPage({ ...view(), session: sessionToken }));
      }

      if (method === 'POST' && (url.pathname === '/save' || url.pathname === '/test' || url.pathname === '/cancel')) {
        const body = await readBodyCapped(req, WEB_UI_MAX_BODY_BYTES);
        const form = new URLSearchParams(body.toString('utf8'));
        if (!sessionToken || !constantTimeEqual(form.get('session') ?? '', sessionToken)) {
          return send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.'));
        }

        if (url.pathname === '/cancel') {
          finish({ saved: false, cancelled: true });
          send(res, 200, messagePage('Cancelled', 'No changes were saved. This settings UI is now closed.', view()));
          res.on('finish', () => void stop());
          return undefined;
        }

        if (url.pathname === '/test') {
          const errors = applySettingsForm(controller, form);
          const id = form.get('test_id');
          let result = null;
          if (id) {
            try {
              result = await controller.test(id);
            } catch (err) {
              result = { ok: false, detail: err?.message ?? String(err) };
            }
          }
          return send(res, 200, renderSettingsPage({ ...view(), session: sessionToken, test: result ? { id, ...result } : null, error: errors.map((e) => `${e.id}: ${e.message}`).join('; ') || null }));
        }

        // /save: reject every invalid value first; nothing is written while any error
        // is outstanding, and the wording names the setting.
        const errors = applySettingsForm(controller, form);
        if (errors.length > 0) {
          return send(res, 400, renderSettingsPage({ ...view(), session: sessionToken, error: errors.map((e) => `${e.id}: ${e.message}`).join('; ') }));
        }
        let result;
        try {
          result = await controller.save();
        } catch (err) {
          result = { saved: false, failed: true, detail: err?.message ?? String(err) };
        }
        if (result.failed) {
          return send(res, 400, renderSettingsPage({ ...view(), session: sessionToken, error: result.detail ?? 'nothing was saved' }));
        }
        finish(result);
        send(res, result.saved ? 200 : 200, result.saved ? renderDonePage(result, view()) : messagePage('No changes', 'Nothing was changed, so nothing was saved.', view()));
        res.on('finish', () => void stop());
        return undefined;
      }

      return send(res, 404, messagePage('Not found', 'There is nothing at that address.'));
    } catch (err) {
      logger?.warn?.(`settings UI request failed: ${err?.message ?? err}`);
      return send(res, 500, messagePage('Error', 'The settings UI hit an error. Check the log, then reopen Settings.'));
    }
  }

  const server = createServerImpl((req, res) => {
    handle(req, res).catch((err) => {
      logger?.warn?.(`settings UI request failed: ${err?.message ?? err}`);
      if (!res.writableEnded) {
        try {
          send(res, 500, messagePage('Error', 'The settings UI hit an error.'));
        } catch {
          res.destroy?.();
        }
      }
    });
  });
  server.on('error', (err) => logger?.warn?.(`settings UI server error: ${err?.message ?? err}`));

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        address = server.address();
        launchToken = { token: randomToken(), issuedAt: now(), used: false };
        timeoutTimer = setTimeout(() => {
          logger?.warn?.('the settings web UI timed out; closing it');
          finish({ saved: false, cancelled: true, detail: 'the settings web UI timed out' });
          void stop();
        }, timeoutMs);
        timeoutTimer.unref?.();
        resolve(address);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Port 0: an ephemeral port, and `127.0.0.1` only. Not configurable.
      server.listen({ host: WEB_UI_BIND, port: 0 });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (stopped) return resolve();
      stopped = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      finish({ saved: false, cancelled: true, detail: 'the settings editor was closed' });
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    start,
    stop,
    server,
    get address() {
      return address;
    },
    get port() {
      return address?.port ?? null;
    },
    get url() {
      if (!address || !launchToken) return null;
      return `http://${WEB_UI_BIND}:${address.port}/?token=${launchToken.token}`;
    },
    waitForOutcome: () => outcome,
  };
}

/**
 * Start the UI, open it, and wait for the user to save or cancel. The listener is
 * always stopped on the way out - save, cancel, timeout, or a start failure.
 *
 * A failed start is returned as `{ saved: false, failed: true, detail }` rather than
 * thrown, so the tray can report it and keep running. The URL contains the one-time
 * token, so it is only ever written to `output` (a caller-supplied stream, normally a
 * terminal) and never to the log.
 */
export async function openWebSettingsDialog({
  controller,
  configPath = null,
  credentialPath = null,
  logger = null,
  openBrowser = openPath,
  output = null,
  timeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
  launchTokenTtlMs = DEFAULT_LAUNCH_TOKEN_TTL_MS,
  createServerImpl,
} = {}) {
  let server;
  try {
    server = createWebSettingsServer({ controller, configPath, credentialPath, logger, timeoutMs, launchTokenTtlMs, createServerImpl });
    await server.start();
  } catch (err) {
    const detail = `could not start the settings web UI on 127.0.0.1: ${err?.message ?? err}`;
    logger?.warn?.(detail);
    return { saved: false, failed: true, detail };
  }

  try {
    let opened = { opened: false };
    try {
      opened = (await openBrowser(server.url)) ?? { opened: false };
    } catch (err) {
      logger?.warn?.(`could not open a browser: ${err?.message ?? err}`);
    }
    if (!opened?.opened) {
      // Actionable, but the URL is a bearer of a short-lived one-time token, so it
      // goes to the terminal (a person) and never to the rotating log.
      output?.write?.(`Open the settings UI in a browser: ${server.url}\n`);
      logger?.warn?.('could not open a browser for the settings web UI; open the link printed on the terminal');
    }
    return await server.waitForOutcome();
  } finally {
    await server.stop();
  }
}

/** The tray/default settings editor as a browser UI, over a real settings editor. */
export async function defaultWebSettingsDialog({ editor, ...rest } = {}) {
  return openWebSettingsDialog({ controller: editor, ...rest });
}

/** First-run setup as a browser UI, over the `createSetup` logic. */
export async function defaultWebSetupDialog({ setup, secrets = null, ...rest } = {}) {
  return openWebSettingsDialog({ controller: createSetupSettingsController({ setup, secrets }), ...rest });
}
