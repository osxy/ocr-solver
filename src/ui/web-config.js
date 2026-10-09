/**
 * Web UI for editing settings, first-run setup, and solving an uploaded image (issue
 * #56, extended by #65).
 *
 * On Windows the launcher runs the tray with the window hidden (`shell.Run ..., 0`),
 * so the process has no console and the `readline` editor in `settings-dialog.js`
 * has no stdin. This module is the graphical surface for that case: a `node:http`
 * server on an ephemeral port, opened in the default browser. It is deliberately
 * *not* a native widget, because a real HTTP request, a real form post and a real
 * assertion are checkable in CI on this host, and a WinForms window is not.
 *
 * The UI owns no setting knowledge. It renders whatever `controller.list()` returns
 * and persists through `controller.set()`/`controller.save()`. The descriptor list in
 * `src/ui/settings.js` is the single source of truth, and the same controller is the
 * terminal editor, so the two cannot drift.
 *
 * The solve page is not a second solve path: it feeds the *same* `classifyRequest` /
 * `resolveImage` from the HTTP ingress (#61) into the *same* shared core, so the one
 * solve lock, the admission bound (#43) and the body/pixel/width caps (#41) all apply.
 * The rendered result is `formatSolveResponse`, the ingress's own serialiser, so the
 * answer, method, confidence and timing agree by construction.
 *
 * Security is the point, because this endpoint can write the config, spend provider
 * credits and solve images:
 *
 *  - **one access rule for every page** (config, solve and any future route): the
 *    socket's remote address must be loopback or fall in `web_ui.allowed_cidrs`. The
 *    check runs before `Host`, before any token and before any handler. The remote
 *    address is the socket's, never `X-Forwarded-For`;
 *  - **the `Host` header is explicitly enumerated**: loopback names, the concrete bind
 *    address and `web_ui.allowed_hosts` (default deny). The name is what is compared;
 *    the port is not, so a reverse proxy's `Host: ui.example.com` or `:443` is admitted
 *    while a foreign name is still refused. Widening the bind does not loosen this,
 *    because a session is scoped to a hostname and DNS rebinding is exactly the attack
 *    it defends (#56, #85);
 *  - the listener binds `web_ui.bind` (loopback by default), and a non-loopback range
 *    is refused unless a credential verifier is configured;
 *  - the URL the app opens carries a **one-time launch token** that is single-use,
 *    short-lived (5 minutes) and distinct from the HTTP ingress token; on loopback it
 *    is redeemed for a session token embedded in the page. A non-loopback client must
 *    instead log in with the configured credential, and its session is bound to the
 *    address that authenticated;
 *  - every response carries `Cache-Control: no-store`; a secret value is never rendered
 *    (presence and source only); and the listener is closed when the editor finishes.
 */
import { createServer as createHttpServerImpl } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import { DEFAULT_MAX_BODY_BYTES } from '../http/defaults.js';
import { DEFAULT_MAX_HEIGHT, DEFAULT_MIN_HEIGHT } from '../imaging/limits.js';
import { percent, storeRecentSolves, storeStats } from '../accuracy.js';
import { createAuthThrottle } from '../http/throttle.js';
import { openPath } from './open-path.js';
import { createSetupSettingsController, getSetting, parseSettingValue, serializeSettingValue } from './settings.js';
import {
  addressAllowed,
  isAllowedHostHeader,
  isLoopbackAddress,
  parseAllowedCidrs,
  verifyWebUiPassword,
  webUiAdmitsNonLoopback,
  WEB_UI_CREDENTIAL_SETTING,
} from './access.js';

/** The default bind. `web_ui.bind` may widen it; see the module comment. */
export const WEB_UI_BIND = '127.0.0.1';
/** The settings body is a form, never an image; a small cap is plenty. */
export const WEB_UI_MAX_BODY_BYTES = 256 * 1024;
/** The launch link is worthless after this long even if it was never clicked. */
export const DEFAULT_LAUNCH_TOKEN_TTL_MS = 5 * 60 * 1000;
/** How long a session may sit idle before the server closes itself. */
export const DEFAULT_SESSION_TIMEOUT_MS = 15 * 60 * 1000;
/** The generic refusal a failed login gets. It never says which part was wrong. */
export const LOGIN_FAILED_MESSAGE = 'Incorrect credentials.';

export { isAllowedHostHeader };

/**
 * The only trusted client address: the socket's. `X-Forwarded-For` is caller-supplied
 * and trivially spoofed, so honouring it would turn the allowlist into a formality.
 * A proxy deployment must be configured explicitly; the header is never consulted.
 */
export function remoteAddressOf(req) {
  return req?.socket?.remoteAddress ?? null;
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
  .newbanner { background: #fff8e1; border: 1px solid #ffe08a; }
  .new { color: #8a6d00; font-weight: 600; }
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
<body><h1>PuzzleSolver</h1>${where ? `<p>${where}</p>` : ''}${body}</body></html>`;
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
      .map((choice) => {
        // An empty enum choice is a real "unset" (the cost band's provider default),
        // so it needs a visible label rather than a blank row in the select.
        const label = choice === '' ? '(blank)' : choice;
        return `<option value="${escapeHtml(choice)}"${choice === item.value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      })
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
  const newItems = items.filter((item) => item.isNew === true);
  // The rows stay in registry order; the offer summary puts security-relevant
  // additions first, the same order the startup log and `config review` use (#67).
  const offeredItems = [
    ...newItems.filter((item) => item.securityRelevant === true),
    ...newItems.filter((item) => item.securityRelevant !== true),
  ];
  const rows = items.map((item) => {
    const tag = item.restart ? 'restart' : 'live';
    const probe =
      item.secret && item.testable !== false
        ? `<button type="submit" formaction="/test" name="test_id" value="${escapeHtml(item.id)}">Test connection</button>`
        : '';
    const pending = item.pending ? ' (pending)' : '';
    const isNew = item.isNew ? ' <span class="new">[new]</span>' : '';
    const security = item.securityRelevant ? ' <span class="new">[security]</span>' : '';
    return `<tr><th>${escapeHtml(item.id)}</th><td>${renderField(item)}</td>` +
      `<td class="display">${escapeHtml(item.display)}${pending} <span class="secret">[${tag}]</span>${isNew}${security}</td><td>${probe}</td></tr>`;
  });
  const banners = [
    error ? `<div class="banner error"><strong>Rejected:</strong> ${escapeHtml(error)}</div>` : '',
    test
      ? `<div class="banner test">${escapeHtml(test.id)}: ${test.ok ? 'ok' : 'failed'} - ${escapeHtml(test.detail)}</div>`
      : '',
    newItems.length > 0
      ? `<div class="banner newbanner"><strong>${newItems.length} setting(s) added since your last review</strong> ` +
        '(marked <span class="new">[new]</span>, security-relevant first): ' +
        offeredItems.map((item) => `<code>${escapeHtml(item.id)}</code>`).join(', ') +
        '</div>'
      : '',
  ].join('');
  const body =
    banners +
    `<p><a href="/solve?session=${escapeHtml(session)}">Solve an uploaded image &rarr;</a> ` +
    `<a href="/stats?session=${escapeHtml(session)}">Statistics &rarr;</a></p>` +
    `<form method="post" action="/save"><input type="hidden" name="session" value="${escapeHtml(session)}">` +
    `<table><thead><tr><th>Setting</th><th>Value</th><th>Current</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>` +
    `<div class="actions"><button type="submit">Save</button>` +
    `<button type="submit" formaction="/cancel" formnovalidate>Cancel</button></div></form>`;
  return page({ body, configPath, credentialPath });
}

/** The solve form and, after a post, the result. Exported for a direct render test. */
export function renderSolvePage({ session, result = null, timingMs = null, error = null, configPath = null, credentialPath = null }) {
  const banners = error ? `<div class="banner error"><strong>Rejected:</strong> ${escapeHtml(error)}</div>` : '';
  let outcome = '';
  if (result) {
    if (result.answer != null) {
      outcome =
        '<div class="banner ok"><strong>Solved.</strong></div>' +
        '<table><tbody>' +
        `<tr><th>answer</th><td>${escapeHtml(result.answer)}</td></tr>` +
        `<tr><th>method</th><td>${escapeHtml(result.method ?? 'unknown')}</td></tr>` +
        `<tr><th>confident</th><td>${result.confident === true ? 'true' : 'false'}</td></tr>` +
        `<tr><th>took</th><td>${timingMs == null ? 'unknown' : `${Math.round(timingMs)} ms`}</td></tr>` +
        '</tbody></table>';
    } else {
      // Never a guess: an unresolved puzzle (or one withheld for lack of corroboration)
      // shows the acknowledgement wording, the same text a Pushbullet reply would use.
      const acknowledgement =
        result.unresolvedReply?.text ??
        'No answer passed validation, so nothing was sent. The image was left unresolved.';
      outcome = `<div class="banner test"><strong>Not solved.</strong> ${escapeHtml(acknowledgement)}</div>`;
    }
  }
  const form =
    '<h2>Solve an image</h2>' +
    '<p>Uploaded through the same paths the HTTP ingress accepts and solved by the same core: ' +
    'one solve lock, the same queue bound and the same image caps.</p>' +
    `<form method="post" action="/solve?session=${escapeHtml(session)}" enctype="multipart/form-data">` +
    '<input type="file" name="image" accept="image/*" required> ' +
    '<button type="submit">Solve</button></form>';
  return page({ body: banners + form + outcome, configPath, credentialPath });
}

function formatWhen(at) {
  if (at == null || !Number.isFinite(Number(at))) return 'unknown';
  return new Date(Number(at) * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, ' UTC');
}

/**
 * One recorded solve's delivery verdict. The reason comes from the responder row
 * when there is one, otherwise from `formatSolveResponse`'s own reason, so the page
 * and the solve page name the same cause. `sent === null` means no responder row was
 * recorded (an HTTP or CLI solve), not that nothing was sent (#64).
 */
export function deliveryLabel(row) {
  if (row.sent === true) return 'sent';
  const reason = row.respondReason ?? row.reason ?? 'no valid answer';
  // A responder records `sent: false` both for a withheld candidate and for an
  // unresolved puzzle. The answer field is what tells them apart.
  if (row.answer == null) return `nothing sent - ${reason}`;
  if (row.sent === false || row.reason === 'unconfirmed') return `withheld - ${reason}`;
  return 'answer recorded (no reply path recorded)';
}

function summaryRows(group) {
  return Object.entries(group ?? {})
    .sort()
    .map(([name, summary]) =>
      `<tr><th>${escapeHtml(name)}</th><td>${summary.seen}</td><td>${summary.valid}</td>` +
      `<td>${summary.withheld}</td><td>${summary.sentable}/${summary.seen} (${escapeHtml(percent(summary.sentableRate))})</td></tr>`
    )
    .join('');
}

function summaryTable(title, group) {
  const rows = summaryRows(group);
  if (!rows) return '';
  return (
    `<h3>${escapeHtml(title)}</h3>` +
    '<table><thead><tr><th></th><th>distinct puzzles</th><th>solved</th><th>withheld</th><th>sent-able</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

/**
 * The statistics page. Read-only by construction: it takes already-read data and a
 * session token, and has no store, controller or POST target. Exported so a test can
 * assert the numbers and labels without an HTTP server.
 */
export function renderStatsPage({
  session,
  recent = [],
  stats = null,
  corpusReport = null,
  retainDays = null,
  error = null,
  configPath = null,
  credentialPath = null,
}) {
  const banners = error ? `<div class="banner error"><strong>Rejected:</strong> ${escapeHtml(error)}</div>` : '';

  const recentRows = recent
    .map(
      (row) =>
        '<tr>' +
        `<td>${escapeHtml(formatWhen(row.at))}</td>` +
        `<td><code>${escapeHtml(row.subject)}</code></td>` +
        `<td>${row.answer == null ? '<em>none</em>' : escapeHtml(row.answer)}</td>` +
        `<td>${escapeHtml(row.method ?? 'none')}</td>` +
        `<td>${escapeHtml(deliveryLabel(row))}</td>` +
        `<td>${row.ms == null ? 'unknown' : `${Math.round(Number(row.ms))} ms`}</td>` +
        `<td>${row.confident === true ? 'true' : 'false'}</td>` +
        '</tr>'
    )
    .join('');
  const recentTable = recentRows
    ? '<table><thead><tr><th>when</th><th>puzzle</th><th>answer</th><th>method</th><th>sent / withheld</th><th>took</th><th>confident</th></tr></thead>' +
      `<tbody>${recentRows}</tbody></table>`
    : '<p class="display">No recorded solves yet.</p>';

  // Recorded traffic and the offline corpus are two different populations. They are
  // rendered in two separate sections and are never added, averaged or compared to
  // produce one headline (#49, #64).
  const traffic = stats?.traffic ?? null;
  const overall = traffic?.overall ?? null;
  const unresolved = overall ? overall.seen - overall.valid : 0;
  const trafficSection = overall
    ? `<h2>Recorded traffic (real)</h2>` +
      '<p>Every <strong>distinct puzzle</strong> the app actually saw (one row per subject), from ' +
      'the <code>attempts</code> store. Real traffic carries no ground truth, so there is no ' +
      'accuracy figure here: the real number is the <strong>sent-able rate</strong> - answers ' +
      'that passed validation and were corroborated, and so would have been sent. Re-solving ' +
      'the same image counts once here, while the recent-solves list above shows each solve.</p>' +
      '<table><thead><tr><th>distinct puzzles</th><th>solved (valid)</th><th>unresolved</th><th>withheld</th><th>sent-able</th></tr></thead>' +
      `<tbody><tr><td>${overall.seen}</td><td>${overall.valid}</td><td>${unresolved}</td>` +
      `<td>${overall.withheld}</td><td>${overall.sentable}/${overall.seen} (${escapeHtml(percent(overall.sentableRate))})</td></tr></tbody></table>` +
      summaryTable('By tier (how the answer was produced)', traffic.byTier) +
      summaryTable('By puzzle class', traffic.byClass) +
      `<p>Model calls made (recorded <code>model-text</code> + <code>model-vision</code> stages): <strong>${stats.modelCalls}</strong></p>`
    : '<h2>Recorded traffic (real)</h2><p class="display">No recorded traffic yet.</p>';

  const corpus = corpusReport?.overall ?? null;
  const corpusSection =
    '<h2>Offline corpus (synthetic fixtures)</h2>' +
    '<p><strong>This is a regression guard, not real-world accuracy.</strong> The corpus is ' +
    'our own generated fixtures, chosen for solvability, run through the same pipeline. ' +
    'It is shown separately from recorded traffic and is never blended with it.</p>' +
    (corpus
      ? `<table><thead><tr><th>correct</th><th>graded</th><th>accuracy</th></tr></thead>` +
        `<tbody><tr><td>${corpus.correct}</td><td>${corpus.gradeable}</td><td>${escapeHtml(percent(corpus.accuracy))}</td></tr></tbody></table>`
      : '<p class="display">No offline corpus report has been cached. Run <code>npm run accuracy</code> to produce one.</p>');

  const windowText =
    retainDays == null
      ? 'The store deletes attempts older than the configured retention window, so this page shows a moving window rather than everything ever seen.'
      : `Attempts older than <strong>${escapeHtml(String(retainDays))} day(s)</strong> are deleted by the retention window ` +
        '(<code>storage.retain_days</code>), so this page shows a moving window rather than everything ever seen.';

  const body =
    banners +
    `<p><a href="/solve?session=${escapeHtml(session)}">Solve an uploaded image &rarr;</a> ` +
    `<a href="/stats?session=${escapeHtml(session)}">Refresh &rarr;</a></p>` +
    `<h2>Recent solves</h2>` +
    `<p>Newest first, at most ${escapeHtml(String(recent.length))} shown. Read on request only; ` +
    'there is no auto-refresh. The answer and method come from the same recorded verdict the ' +
    'solve page formats, so the two cannot disagree. <strong>took</strong> is that solve\'s own ' +
    'recorded duration; <em>unknown</em> means no timing was recorded for it.</p>' +
    recentTable +
    trafficSection +
    corpusSection +
    `<p class="display">${windowText}</p>`;
  return page({ body, configPath, credentialPath });
}

/** The login form for a non-loopback client. No username: only a password exists. */
export function renderLoginPage({ error = null, configPath = null, credentialPath = null } = {}) {
  const banner = error ? `<div class="banner error">${escapeHtml(error)}</div>` : '';
  const body =
    banner +
    '<h2>Sign in</h2>' +
    '<p>This web UI is reachable from a non-loopback address, so it requires the configured credential.</p>' +
    '<form method="post" action="/login">' +
    '<input type="password" name="password" autocomplete="current-password" required> ' +
    '<button type="submit">Sign in</button></form>';
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
        const err = new Error(`request body exceeds ${maxBytes} bytes`);
        err.status = 413;
        fail(err);
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

/** Host to put in the URL the browser is handed. A wildcard bind is probed on loopback. */
function hostForUrl(bindHost) {
  const value = String(bindHost ?? WEB_UI_BIND);
  if (value === '0.0.0.0') return '127.0.0.1';
  if (value === '::') return '[::1]';
  return value.includes(':') ? `[${value}]` : value;
}

/**
 * Build the web UI server. It owns a listener of its own: `start()` binds and
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
  // Access control (#65).
  webUi = null,
  credentialVerifier = null,
  getRemoteAddress = remoteAddressOf,
  // Solve page (#65). Without a core the route is a 404; the config editor does not
  // need one, but the tray/app passes the shared core.
  solveCore = null,
  config = null,
  inboxDir = null,
  // Statistics page (#64). Without a store the route is a 404, exactly like the
  // solve page without a core. `corpusReport` is the cached offline-corpus report
  // (`loadReportCache(...).corpus`); it is rendered as its own labelled figure and
  // is never blended with the recorded-traffic report computed from `store`.
  store = null,
  corpusReport = null,
} = {}) {
  if (!controller || typeof controller.list !== 'function' || typeof controller.save !== 'function') {
    throw new Error('createWebSettingsServer needs a settings controller (list/save)');
  }

  const bindHost = String(webUi?.bind ?? WEB_UI_BIND);
  const bindPort = Number.isInteger(webUi?.port) ? webUi.port : 0;
  const allowedCidrs = parseAllowedCidrs(webUi?.allowed_cidrs);
  const allowedHosts = Array.isArray(webUi?.allowed_hosts) ? webUi.allowed_hosts : [];
  // `isAllowedHostHeader` ignores a wildcard bind (it is not a Host anyone can type)
  // and adds the other entries explicitly. The bound address is the one name the
  // operator typed to reach this exact socket, so it is legitimate by construction.
  const boundAddress = bindHost;
  const exposesRemote = webUiAdmitsNonLoopback({ allowed_cidrs: webUi?.allowed_cidrs });

  // Refuse to listen wider than loopback without a credential. This is the "both are
  // set up or nothing is exposed" rule: no silent fall back to token-only.
  if (exposesRemote && !credentialVerifier) {
    throw new Error(
      `web_ui.allowed_cidrs admits addresses beyond loopback but no web UI credential is configured. ` +
        `Set ${WEB_UI_CREDENTIAL_SETTING} (stored as a scrypt verifier in the credential store) or the web UI will not start.`
    );
  }
  // #85: an ephemeral port is fine on loopback (the URL is opened locally), but a
  // remote client or a TLS reverse proxy has no stable port to reach. Refuse to start
  // with a message naming the setting rather than silently exposing an unreachable UI.
  if (exposesRemote && bindPort === 0) {
    throw new Error(
      'web_ui.allowed_cidrs admits addresses beyond loopback but web_ui.port is 0 (an ephemeral port), ' +
        'so a remote client or a TLS reverse proxy has no stable port to reach. Set web_ui.port to the fixed port you will expose.'
    );
  }

  const solveMaxBytes = config?.http?.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES;
  const requireConfidence = config?.reply?.require_confidence === true;
  const unresolvedReply =
    config?.reply?.enabled === true && String(config.reply.unresolved_text ?? '').trim() !== ''
      ? { title: config.reply.unresolved_title ?? null, text: config.reply.unresolved_text }
      : null;
  const modelNames = { text: config?.solver?.llm_text_model ?? null, vision: config?.solver?.llm_vision_model ?? null };

  let address = null;
  let launchToken = null; // { token, issuedAt, used }
  let sessionToken = null;
  let sessionRemote = null;
  let stopped = false;
  let settled = false;
  let timeoutTimer = null;
  let resolveOutcome;
  let httpModulePromise = null;
  const loginThrottle = createAuthThrottle({ now });
  const outcome = new Promise((resolve) => {
    resolveOutcome = resolve;
  });

  function settle(outcomeValue) {
    if (settled) return;
    settled = true;
    if (timeoutTimer) clearTimeout(timeoutTimer);
    // #87: whether the settings were ever fetched. A timeout or a link opened in
    // neither a browser nor a terminal returns `false`; the app uses this to advance
    // only the prompt baseline, never the `[new]` badge baseline.
    resolveOutcome({ ...outcomeValue, sessionOpened: sessionToken != null });
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

  function openSession(remote) {
    sessionToken = randomToken();
    sessionRemote = remote;
    return sessionToken;
  }

  function sessionValid(provided, remote) {
    return (
      sessionToken != null &&
      constantTimeEqual(String(provided ?? ''), sessionToken) &&
      sessionRemote === remote
    );
  }

  function httpModule() {
    // Imported lazily so a settings-only run never loads the image gate (`sharp`), and
    // cached so the solve path does not re-resolve it per request.
    httpModulePromise ??= import('../http/server.js');
    return httpModulePromise;
  }

  async function handleLogin(req, res, remote) {
    if (!credentialVerifier) {
      return send(res, 403, messagePage('Refused', 'Login is not configured on this web UI.'));
    }
    const gate = loginThrottle.check(remote);
    if (!gate.allowed) {
      return send(
        res,
        429,
        renderLoginPage({ error: `Too many failed attempts. Try again in ${gate.retryAfterSec}s.`, configPath, credentialPath }),
        { 'retry-after': String(gate.retryAfterSec) }
      );
    }
    const body = await readBodyCapped(req, WEB_UI_MAX_BODY_BYTES);
    const form = new URLSearchParams(body.toString('utf8'));
    const offered = form.get('password') ?? '';
    // The same generic message whether the verifier is malformed or the password is
    // simply wrong: a login must not become an oracle for which part failed.
    if (!verifyWebUiPassword(offered, credentialVerifier)) {
      const outcome = loginThrottle.fail(remote);
      if (!outcome.allowed) {
        return send(
          res,
          429,
          renderLoginPage({ error: `Too many failed attempts. Try again in ${outcome.retryAfterSec}s.`, configPath, credentialPath }),
          { 'retry-after': String(outcome.retryAfterSec) }
        );
      }
      return send(res, 401, renderLoginPage({ error: LOGIN_FAILED_MESSAGE, configPath, credentialPath }));
    }
    loginThrottle.succeed(remote);
    openSession(remote);
    return send(res, 200, renderSettingsPage({ ...view(), session: sessionToken }));
  }

  async function handleSolve(req, res, url, remote) {
    if (!solveCore || typeof solveCore.solve !== 'function') {
      return send(res, 404, messagePage('Not found', 'Solving is not available from this web UI.'));
    }
    let slot = false;
    const acquire = typeof solveCore.acquireSlot === 'function' ? solveCore.acquireSlot : () => true;
    const release = typeof solveCore.releaseSlot === 'function' ? solveCore.releaseSlot : () => {};
    try {
      const body = await readBodyCapped(req, solveMaxBytes);
      const { classifyRequest, resolveImage, formatSolveResponse, imageErrorStatus } = await httpModule();
      let image;
      try {
        const parsed = await classifyRequest(req, body);
        image = await resolveImage(parsed, {
          inboxDir,
          maxBodyBytes: solveMaxBytes,
          // Same shared gate as the ingress (#41): the body cap is the HTTP cap, and
          // the width/pixel caps are the live config values.
          imageLimits: {
            minHeight: DEFAULT_MIN_HEIGHT,
            maxHeight: DEFAULT_MAX_HEIGHT,
            maxWidth: config?.image?.max_width,
            maxPixels: config?.image?.max_pixels,
          },
          // image_url is an SSRF surface and is never fetched from the UI; uploading
          // is the only input the form offers.
          imageUrlPolicy: { enabled: false, hosts: [] },
        });
      } catch (err) {
        const status = Number.isInteger(err?.status) ? err.status : imageErrorStatus(err);
        const reason = err?.reason ?? err?.message ?? 'the image was rejected';
        logger?.warn?.(`web ui solve rejected: ${reason}`);
        return send(res, status, renderSolvePage({ session: sessionToken, error: reason, configPath, credentialPath }));
      }

      if (!acquire()) {
        return send(
          res,
          503,
          renderSolvePage({ session: sessionToken, error: 'The solver queue is full; try again shortly.', configPath, credentialPath }),
          { 'retry-after': '1' }
        );
      }
      slot = true;
      const startedAt = now();
      let result;
      try {
        result = await solveCore.solve(image.path, { subject: image.iden });
      } finally {
        if (slot) {
          slot = false;
          release();
        }
      }
      const timingMs = now() - startedAt;
      const formatted = formatSolveResponse(result, { image, unresolvedReply, requireConfidence, modelNames });
      logger?.info?.(
        `web ui: ${formatted.answer != null ? formatted.answer : 'unresolved'} in ${Math.round(timingMs)}ms (${formatted.method ?? 'no method'})`
      );
      return send(res, 200, renderSolvePage({ session: sessionToken, result: formatted, timingMs, configPath, credentialPath }));
    } catch (err) {
      logger?.warn?.(`web ui solve failed: ${err?.message ?? err}`);
      return send(res, Number.isInteger(err?.status) ? err.status : 500, renderSolvePage({ session: sessionToken, error: 'The solve failed; check the log.', configPath, credentialPath }));
    }
  }

  /**
   * The statistics page's handler. It only reads: a bounded recent-list query and a
   * SQL-aggregated totals query. There is no POST behind it and no store write on the
   * path. The recorded verdict is passed through `formatSolveResponse` - the same
   * serialiser the solve page uses - so the two pages cannot disagree on
   * answer/method/confidence/reason.
   */
  async function handleStats(res) {
    if (!store) {
      return send(res, 404, messagePage('Not found', 'Statistics are not available from this web UI.'));
    }
    const { formatSolveResponse } = await httpModule();
    const limit = Number.isInteger(config?.ui?.stats_recent_solves) ? config.ui.stats_recent_solves : 5;
    const recent = storeRecentSolves(store, { limit }).map((row) => {
      const formatted = formatSolveResponse(
        {
          answer: row.answer,
          method: row.method,
          confident: row.confident,
          disputed: row.disputed,
          puzzleClass: row.puzzleClass,
          opinions: [],
        },
        { requireConfidence, modelNames }
      );
      return { ...row, status: formatted.status, reason: formatted.reason ?? null };
    });
    return send(
      res,
      200,
      renderStatsPage({
        session: sessionToken,
        recent,
        stats: storeStats(store),
        corpusReport,
        retainDays: config?.storage?.retain_days ?? null,
        configPath,
        credentialPath,
      })
    );
  }

  async function handle(req, res) {
    try {
      const remote = getRemoteAddress(req);
      // 1. The one access rule, before Host, before token, before any handler. Every
      //    page and every POST goes through it by construction, including an unknown
      //    path (the 404 default is below).
      if (!remote || !addressAllowed(remote, allowedCidrs)) {
        return send(res, 403, messagePage('Refused', 'This web UI only answers requests from an allowed address.'));
      }
      // 2. DNS-rebinding defence. Widening the bind enumerates more names, never "any".
      if (!isAllowedHostHeader(req.headers.host, { boundAddress, allowedHosts })) {
        return send(
          res,
          403,
          messagePage('Refused', 'This web UI only answers requests addressed to an allowed hostname (loopback by default).')
        );
      }
      const url = new URL(req.url ?? '/', `http://${WEB_UI_BIND}`);
      const method = String(req.method ?? 'GET').toUpperCase();
      const loopbackClient = isLoopbackAddress(remote);

      if (method === 'GET' && url.pathname === '/login') {
        return send(res, 200, renderLoginPage({ configPath, credentialPath }));
      }
      if (method === 'POST' && url.pathname === '/login') {
        return handleLogin(req, res, remote);
      }

      if (method === 'GET' && url.pathname === '/') {
        if (loopbackClient) {
          // Loopback keeps #56's behaviour: the one-time launch token is enough.
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
          openSession(remote);
          return send(res, 200, renderSettingsPage({ ...view(), session: sessionToken }));
        }
        // Non-loopback already authenticated (session in the query) gets the page;
        // otherwise it must log in. The launch token is not enough there.
        if (sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return send(res, 200, renderSettingsPage({ ...view(), session: sessionToken }));
        }
        return send(res, 200, renderLoginPage({ configPath, credentialPath }));
      }

      if (method === 'GET' && url.pathname === '/solve') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return loopbackClient
            ? send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.'))
            : send(res, 200, renderLoginPage({ configPath, credentialPath }));
        }
        return send(res, 200, renderSolvePage({ session: sessionToken, configPath, credentialPath }));
      }

      if (method === 'POST' && url.pathname === '/solve') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.'));
        }
        return handleSolve(req, res, url, remote);
      }

      // Read-only: GET only. There is deliberately no POST /stats branch, so a write
      // cannot be reached from the statistics page (#64). An unknown method falls
      // through to the 404 below.
      if (method === 'GET' && url.pathname === '/stats') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return loopbackClient
            ? send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.'))
            : send(res, 200, renderLoginPage({ configPath, credentialPath }));
        }
        return handleStats(res);
      }

      if (method === 'POST' && (url.pathname === '/save' || url.pathname === '/test' || url.pathname === '/cancel')) {
        const body = await readBodyCapped(req, WEB_UI_MAX_BODY_BYTES);
        const form = new URLSearchParams(body.toString('utf8'));
        if (!sessionValid(form.get('session') ?? '', remote)) {
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
      return send(res, Number.isInteger(err?.status) ? err.status : 500, messagePage('Error', 'The settings UI hit an error. Check the log, then reopen Settings.'));
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
      // `web_ui.port` (default 0 = ephemeral), on the configured bind (loopback
      // unless widened). A non-loopback range is refused above unless it is set.
      server.listen({ host: bindHost, port: bindPort });
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
      return `http://${hostForUrl(bindHost)}:${address.port}/?token=${launchToken.token}`;
    },
    /** The one access rule and its inputs, for diagnostics and tests. */
    accessRule() {
      return { bind: bindHost, port: bindPort, allowedCidrs: allowedCidrs.map((c) => c.text), allowedHosts: [...allowedHosts], requiresCredential: exposesRemote };
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
  webUi = null,
  credentialVerifier = null,
  getRemoteAddress,
  solveCore = null,
  config = null,
  inboxDir = null,
  store = null,
  corpusReport = null,
} = {}) {
  let server;
  try {
    server = createWebSettingsServer({
      controller,
      configPath,
      credentialPath,
      logger,
      timeoutMs,
      launchTokenTtlMs,
      createServerImpl,
      webUi,
      credentialVerifier,
      ...(getRemoteAddress ? { getRemoteAddress } : {}),
      solveCore,
      config,
      inboxDir,
      store,
      corpusReport,
    });
    await server.start();
  } catch (err) {
    const detail = `could not start the settings web UI on ${webUi?.bind ?? WEB_UI_BIND}: ${err?.message ?? err}`;
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
