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
import { readFileSync } from 'node:fs';

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

/**
 * Theme (issue #99). A cookie plus a server-side render, deliberately not
 * `localStorage`: the served CSP forbids scripts, so a JS switch would mean relaxing
 * it, and a cookie cannot flash the wrong theme because the server writes the choice
 * into the HTML before the browser paints. `prefers-color-scheme` stays the default
 * through CSS, so an OS-dark visitor is dark on the first load with no toggle.
 */
export const THEME_COOKIE = 'theme';
/** The known theme values. `auto` means "follow the OS" and clears the cookie. */
export const THEME_CHOICES = Object.freeze(['light', 'dark', 'auto']);
const THEME_MAX_AGE_SEC = 365 * 24 * 60 * 60;
/** The visible label for each toggle choice. */
export const THEME_CHOICE_LABELS = Object.freeze({ light: 'Light', dark: 'Dark', auto: 'Auto' });

/** Only the two concrete themes are renderable; anything else is ignored. */
export function normalizeTheme(value) {
  const text = String(value ?? '');
  return text === 'light' || text === 'dark' ? text : null;
}

/** A `?theme=` query value, allowlisted like the cookie. `null` when unknown. */
export function themeFromParam(value) {
  const text = String(value ?? '');
  return THEME_CHOICES.includes(text) ? text : null;
}

function readCookie(cookieHeader, name) {
  for (const part of String(cookieHeader ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The cookie's theme, or `null` (unknown / absent -> the OS preference). */
export function themeFromCookie(cookieHeader) {
  return normalizeTheme(readCookie(cookieHeader, THEME_COOKIE));
}

/**
 * The `Set-Cookie` value for an explicit choice. The value comes from the allowlist,
 * never from caller text, so a theme cookie cannot carry markup. `auto` expires it so
 * the OS preference takes over again.
 */
export function themeCookieHeader(choice) {
  const value = themeFromParam(choice);
  if (value == null) return null;
  if (value === 'auto') return `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
  return `${THEME_COOKIE}=${value}; Path=/; Max-Age=${THEME_MAX_AGE_SEC}; SameSite=Lax; HttpOnly`;
}

/**
 * The token layer (issue #104): one place that decides colour roles, spacing, radii,
 * borders and the type ramp, with both themes derived from the same roles. Every page
 * consumes these through `var(--token)`, and no page function may hard-code a colour,
 * radius or spacing. The tokens are JavaScript objects, not loose CSS text, so
 * `tests/web-tokens.test.js` can assert the two themes define the same roles, that
 * every `var(--x)` reference resolves, and that each recorded pair meets WCAG AA.
 *
 * The dark palette is declared once and interpolated into both the OS media query and
 * the explicit `[data-theme="dark"]` rule, because CSS cannot apply a media query to
 * an attribute selector.
 */
export const COLOR_TOKENS = Object.freeze({
  light: Object.freeze({
    bg: '#ffffff',
    fg: '#1a1a1a',
    'fg-muted': '#565b64',
    link: '#0b57d0',
    accent: '#0b57d0',
    'accent-fg': '#ffffff',
    'accent-hover': '#0842a0',
    border: '#d4d7dd',
    'border-strong': '#6b7280',
    panel: '#f6f7f9',
    'panel-hover': '#eef0f3',
    'panel-border': '#e2e5ea',
    'ok-bg': '#eafaef',
    'ok-border': '#9ad4ae',
    'ok-fg': '#14532d',
    'info-bg': '#eef6ff',
    'info-border': '#a9c9f5',
    'info-fg': '#0b3d75',
    'warn-bg': '#fff8e1',
    'warn-border': '#ecd27a',
    'warn-fg': '#6b5200',
    'err-bg': '#fdecea',
    'err-border': '#f0b4ba',
    'err-fg': '#7a1f1f',
  }),
  dark: Object.freeze({
    bg: '#14161a',
    fg: '#e7e9ee',
    'fg-muted': '#a8b0bd',
    link: '#8ab4ff',
    accent: '#8ab4ff',
    'accent-fg': '#0b1020',
    'accent-hover': '#a9c8ff',
    border: '#333a45',
    'border-strong': '#7a8494',
    panel: '#1c2027',
    'panel-hover': '#232833',
    'panel-border': '#2a313b',
    'ok-bg': '#16301f',
    'ok-border': '#2f6b45',
    'ok-fg': '#b7e4c7',
    'info-bg': '#15263c',
    'info-border': '#2c4f7c',
    'info-fg': '#cfe2ff',
    'warn-bg': '#332b12',
    'warn-border': '#7a6524',
    'warn-fg': '#ffe08a',
    'err-bg': '#3a1d20',
    'err-border': '#7a3a40',
    'err-fg': '#ffb4ab',
  }),
});

/** The non-colour scales. A key is a token name; the value is the CSS value. */
export const SPACE_TOKENS = Object.freeze({ 1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 4: '1rem', 5: '1.5rem', 6: '2rem', 7: '3rem' });
export const RADIUS_TOKENS = Object.freeze({ sm: '4px', md: '6px', lg: '10px', pill: '999px' });
export const TYPE_TOKENS = Object.freeze({ xs: '0.75rem', sm: '0.82rem', md: '0.9375rem', lg: '1.05rem', xl: '1.3rem', display: '2rem' });

function cssVars(entries, prefix = '') {
  return entries.map(([name, value]) => `    --${prefix}${name}: ${value};`).join('\n');
}

const LIGHT_VARS = cssVars(Object.entries(COLOR_TOKENS.light));
const DARK_VARS = cssVars(Object.entries(COLOR_TOKENS.dark));
const SCALE_VARS = [
  cssVars(Object.entries(SPACE_TOKENS), 'space-'),
  cssVars(Object.entries(RADIUS_TOKENS), 'radius-'),
  cssVars(Object.entries(TYPE_TOKENS), 'text-'),
  '    --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;',
  '    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;',
  '    --line: 1.5;',
  '    --border-width: 1px;',
  '    --focus-width: 2px;',
  '    --content-width: 66rem;',
].join('\n');

export const STYLE = `
  :root {
    color-scheme: light;
${LIGHT_VARS}
${SCALE_VARS}
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
${DARK_VARS}
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
${DARK_VARS}
  }

  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    font: var(--text-md)/var(--line) var(--font-sans);
    margin: 0 auto; max-width: var(--content-width);
    padding: 0 var(--space-5) var(--space-7);
    background: var(--bg); color: var(--fg);
  }
  a { color: var(--link); }
  a:hover { text-decoration-thickness: 2px; }
  p { margin: var(--space-3) 0; max-width: 80ch; }
  .muted, .display { color: var(--fg-muted); }
  .display { font-size: var(--text-sm); }

  .skip { position: absolute; left: -9999px; top: 0; }
  .skip:focus { position: static; display: inline-block; margin: var(--space-2) 0; }

  header.top {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);
    flex-wrap: wrap; padding: var(--space-4) 0 var(--space-3); margin-bottom: var(--space-1);
    border-bottom: var(--border-width) solid var(--border); background: var(--bg);
  }
  .brand { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
  h1 { font-size: var(--text-xl); margin: 0; letter-spacing: -0.01em; }
  h2 { font-size: var(--text-lg); margin: var(--space-6) 0 var(--space-2); }
  h3 {
    font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.05em;
    margin: var(--space-5) 0 var(--space-2); color: var(--fg-muted);
  }
  .where { color: var(--fg-muted); font-size: var(--text-xs); margin: var(--space-1) 0 var(--space-3); }
  .group { scroll-margin-top: var(--space-7); }
  .group-title { display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap; }
  .group-title .count { color: var(--fg-muted); font-size: var(--text-xs); font-weight: 400; }

  nav.links { margin: var(--space-4) 0; display: flex; gap: var(--space-5); flex-wrap: wrap; }
  nav.jump {
    margin: var(--space-4) 0; padding: var(--space-3) var(--space-4);
    border: var(--border-width) solid var(--panel-border);
    border-radius: var(--radius-md); background: var(--panel);
    display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
  }
  nav.jump a { text-decoration: none; }
  nav.jump a:hover { text-decoration: underline; }
  .toc-label { color: var(--fg-muted); font-weight: 600; }

  code {
    font-family: var(--font-mono); font-size: 0.88em;
    background: var(--panel); border: var(--border-width) solid var(--panel-border);
    border-radius: var(--radius-sm); padding: 0.05em 0.35em;
  }

  .theme { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); color: var(--fg-muted); }
  .theme .options { display: inline-flex; border: var(--border-width) solid var(--border-strong); border-radius: var(--radius-pill); overflow: hidden; }
  .theme a { padding: 0.28rem var(--space-3); text-decoration: none; color: var(--fg-muted); background: var(--panel); }
  .theme a + a { border-left: var(--border-width) solid var(--border); }
  .theme a:hover { color: var(--link); }
  .theme a.active { background: var(--accent); color: var(--accent-fg); font-weight: 600; }

  table { border-collapse: collapse; width: 100%; margin: var(--space-2) 0 var(--space-4); font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: var(--border-width) solid var(--border); vertical-align: middle; }
  thead th {
    background: var(--panel); color: var(--fg-muted); font-size: var(--text-xs); font-weight: 600;
    border-bottom: 2px solid var(--border-strong);
  }
  tbody tr:hover { background: var(--panel-hover); }
  th { white-space: nowrap; font-family: var(--font-mono); font-size: 0.85em; }
  td.num, th.num { text-align: right; }

  input[type=text], input[type=password], select, textarea {
    width: 24rem; max-width: 100%; padding: var(--space-2) var(--space-3);
    border: var(--border-width) solid var(--border-strong); border-radius: var(--radius-md);
    background: var(--bg); color: var(--fg); font: inherit;
  }
  input[type=file] { color: var(--fg); font: inherit; }
  input[type=checkbox] { width: auto; accent-color: var(--accent); }
  :focus-visible { outline: var(--focus-width) solid var(--link); outline-offset: 2px; }

  .banner {
    display: flex; align-items: flex-start; gap: var(--space-3);
    padding: var(--space-3) var(--space-4); margin: var(--space-4) 0;
    border: var(--border-width) solid; border-left-width: 4px;
    border-radius: var(--radius-md); font-size: var(--text-sm);
  }
  .banner-icon { flex: 0 0 auto; display: inline-flex; }
  .banner-body { min-width: 0; }
  .banner-icon svg, .empty-icon svg { width: 1.1rem; height: 1.1rem; display: block; }
  .error { background: var(--err-bg); border-color: var(--err-border); color: var(--err-fg); }
  .test { background: var(--info-bg); border-color: var(--info-border); color: var(--info-fg); }
  .ok { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok-fg); }
  .newbanner { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-fg); }
  .new { color: var(--warn-fg); font-weight: 600; }

  .tag {
    font-family: var(--font-mono); font-size: var(--text-xs); white-space: nowrap;
    padding: 0.08em var(--space-2); border-radius: var(--radius-pill);
    border: var(--border-width) solid var(--border); background: var(--panel); color: var(--fg-muted);
  }
  .tag-restart { color: var(--warn-fg); border-color: var(--warn-border); background: var(--warn-bg); }
  .tag-live { color: var(--ok-fg); border-color: var(--ok-border); background: var(--ok-bg); }
  .tag-security { color: var(--err-fg); border-color: var(--err-border); background: var(--err-bg); }

  .actions { margin-top: var(--space-5); display: flex; gap: var(--space-2); }
  button, input[type=submit] {
    padding: var(--space-2) var(--space-4); cursor: pointer; font: inherit;
    border: var(--border-width) solid var(--border-strong); border-radius: var(--radius-md);
    background: var(--panel); color: var(--fg);
  }
  button:hover, input[type=submit]:hover { border-color: var(--link); color: var(--link); }
  button.primary, input[type=submit].primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
  button.primary:hover, input[type=submit].primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); color: var(--accent-fg); }

  .empty {
    display: flex; align-items: flex-start; gap: var(--space-4);
    padding: var(--space-5); margin: var(--space-4) 0;
    border: var(--border-width) dashed var(--border-strong);
    border-radius: var(--radius-lg); background: var(--panel);
  }
  .empty-icon { flex: 0 0 auto; color: var(--fg-muted); }
  .empty-icon svg { width: 1.6rem; height: 1.6rem; }
  .empty-title { font-weight: 600; margin: 0 0 var(--space-1); }
  .empty-body { margin: 0; color: var(--fg-muted); font-size: var(--text-sm); max-width: 72ch; }

  .state {
    display: flex; align-items: flex-start; gap: var(--space-4);
    margin: var(--space-4) 0; padding: var(--space-4);
    border: var(--border-width) solid var(--border); border-left-width: 6px;
    border-radius: var(--radius-md);
  }
  .state-icon { flex: 0 0 auto; }
  .state-icon svg { width: 1.6rem; height: 1.6rem; display: block; }
  .state-body { min-width: 0; }
  .state-title { display: block; font-size: var(--text-lg); }
  .state-detail { margin: var(--space-1) 0 0; }
  .state-error { background: var(--err-bg); border-color: var(--err-border); color: var(--err-fg); }
  .state-notice { background: var(--info-bg); border-color: var(--info-border); color: var(--info-fg); }
  .state-ok { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok-fg); }

  .outcome {
    display: flex; align-items: flex-start; gap: var(--space-4);
    margin: var(--space-4) 0; padding: var(--space-4);
    border: var(--border-width) solid var(--border); border-left-width: 6px;
    border-radius: var(--radius-md);
  }
  .outcome-icon { flex: 0 0 auto; }
  .outcome-icon svg { width: 2rem; height: 2rem; display: block; }
  .outcome-body { min-width: 0; }
  .outcome-title { font-size: var(--text-lg); font-weight: 700; display: block; }
  .outcome-detail { margin: var(--space-1) 0 0; }
  .outcome-solved { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok-fg); }
  .outcome-withheld { background: var(--warn-bg); border-color: var(--warn-border); border-left-style: dashed; color: var(--warn-fg); }
  .outcome-unresolved { background: var(--err-bg); border-color: var(--err-border); color: var(--err-fg); }
  .answer { font-family: var(--font-mono); font-size: var(--text-display); font-weight: 700; line-height: 1.1; margin: var(--space-2) 0; }

  .verdict { display: inline-flex; align-items: center; gap: var(--space-1); white-space: nowrap; }
  .verdict svg { width: 1em; height: 1em; }

  .thumb { display: inline-block; line-height: 0; }
  .thumb img {
    display: block; width: 64px; height: 64px; object-fit: cover;
    border: var(--border-width) solid var(--border-strong); border-radius: var(--radius-md);
    background: var(--panel);
  }
  .thumb-missing, .thumb-none { color: var(--fg-muted); font-size: var(--text-xs); white-space: nowrap; }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior: auto; }
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
    }
  }
`;

/** A link to the same page with a theme choice, so the toggle is a GET, not a script. */
function themeHref(base, value) {
  const separator = String(base).includes('?') ? '&' : '?';
  return `${escapeHtml(base)}${separator}theme=${value}`;
}

function themeToggle(theme, base) {
  const links = THEME_CHOICES.map((value) => {
    const active = value === 'auto' ? theme == null : theme === value;
    const current = active ? ' class="active" aria-current="true"' : '';
    return `<a href="${themeHref(base, value)}"${current}>${THEME_CHOICE_LABELS[value]}</a>`;
  }).join('');
  return `<nav class="theme" aria-label="Colour theme"><span>Theme</span><span class="options">${links}</span></nav>`;
}

/**
 * The inline icon set. There is no icon font and no SVG sprite: the CSP is
 * `default-src 'none'`, so an inline `<svg>` in the document is the only icon
 * available. `currentColor` lets the surrounding state role colour it, and the
 * shape is what makes an outcome readable without relying on colour (#104).
 */
function svgIcon(inner) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`
  );
}
const ICONS = Object.freeze({
  check: svgIcon('<path d="M20 6 9 17l-5-5"/>'),
  pause: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>'),
  question: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4"/><path d="M12 17h.01"/>'),
  alert: svgIcon('<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
  info: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
  box: svgIcon('<path d="M3 7h18v13H3z"/><path d="M3 7l2-3h14l2 3"/><path d="M3 11h18"/>'),
});

/** A banner with a shape, so a state is never colour alone. `body` is trusted HTML. */
function banner(kind, iconName, body) {
  return `<div class="banner ${kind}"><span class="banner-icon">${ICONS[iconName]}</span><span class="banner-body">${body}</span></div>`;
}

/**
 * A designed empty state. A fresh install must not show a bare, unlabelled table:
 * every list and aggregate with nothing to show gets a title, an explanation and a
 * way forward.
 */
function emptyState({ title, body, action = null, icon = 'box' }) {
  return (
    '<div class="empty">' +
    `<span class="empty-icon">${ICONS[icon]}</span>` +
    `<div><p class="empty-title">${escapeHtml(title)}</p>` +
    `<p class="empty-body">${body}</p>${action ?? ''}</div></div>`
  );
}

/** A full-width state card for a whole page (a refusal, a not-found, a cancel). */
function statePage(tone, title, message) {
  const icon = tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : 'info';
  return (
    `<div class="state state-${tone}">` +
    `<span class="state-icon">${ICONS[icon]}</span>` +
    `<div class="state-body"><strong class="state-title">${escapeHtml(title)}</strong>` +
    `<p class="state-detail">${escapeHtml(message)}</p></div></div>`
  );
}

/**
 * The one reading of a solve result (issue #104). Solved, withheld and unresolved
 * are three different facts, and the page must say which one it is in words and in
 * shape, not only in colour. `formatSolveResponse` already distinguishes them: a
 * withheld candidate has no `answer` but carries `reason === 'unconfirmed'`.
 */
export function solveOutcome(result) {
  if (result?.answer != null) {
    return { kind: 'solved', label: 'Solved.', detail: 'A validated answer was produced. This page displays it; it does not send it.' };
  }
  if (result?.reason === 'unconfirmed') {
    return {
      kind: 'withheld',
      label: 'Withheld.',
      detail: 'An answer was found, but it was not corroborated, so the reply policy withheld it and nothing was sent.',
    };
  }
  return { kind: 'unresolved', label: 'Not solved.', detail: null };
}

const OUTCOME_ICON = Object.freeze({ solved: 'check', withheld: 'pause', unresolved: 'question' });

function outcomeCard(outcome, detailHtml = '') {
  return (
    `<section class="outcome outcome-${outcome.kind}" aria-label="Solve result">` +
    `<span class="outcome-icon">${ICONS[OUTCOME_ICON[outcome.kind]]}</span>` +
    `<div class="outcome-body"><strong class="outcome-title">${outcome.label}</strong>` +
    (outcome.detail ? `<p class="outcome-detail">${escapeHtml(outcome.detail)}</p>` : '') +
    detailHtml +
    '</div></section>'
  );
}

const VERDICT_ICON = Object.freeze({ solved: 'check', withheld: 'pause', unresolved: 'question', sent: 'check', pending: 'info' });

/** A small shape + word verdict for the tables, so the status is not colour alone. */
function verdictBadge(kind, label) {
  return `<span class="verdict verdict-${kind}">${ICONS[VERDICT_ICON[kind] ?? 'info']}${escapeHtml(label)}</span>`;
}

/** The labels for the settings groups, by the `id` prefix. */
const GROUP_LABELS = Object.freeze({
  pushbullet: 'Pushbullet',
  llm: 'Model provider',
  solver: 'Solver and models',
  reply: 'Replies',
  storage: 'Storage and retention',
  ocr: 'OCR',
  image: 'Image limits',
  http: 'HTTP ingress',
  web_ui: 'Web UI access',
  ui: 'Interface',
});
/** The order the groups appear in; any future prefix follows these, in list order. */
const GROUP_ORDER = Object.freeze(['pushbullet', 'llm', 'solver', 'reply', 'storage', 'ocr', 'image', 'http', 'web_ui', 'ui']);

/**
 * Group the descriptor rows by their `id` prefix (the setting's topic). Topic, not
 * lifecycle, is the axis someone actually searches by ("where do I change the reply
 * text?"); the `[live]`/`[restart]`/`[security]` facts stay on every row and in each
 * group's summary. Exported so the grouping rule is testable without a server.
 */
export function groupSettings(items) {
  const groups = new Map();
  for (const item of items ?? []) {
    const key = String(item.id ?? '').split('.')[0] || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [];
  const take = (key) => {
    if (!groups.has(key)) return;
    ordered.push({ key, label: GROUP_LABELS[key] ?? key, items: groups.get(key) });
    groups.delete(key);
  };
  for (const key of GROUP_ORDER) take(key);
  for (const key of [...groups.keys()]) take(key);
  return ordered;
}

function page({ body, theme = null, themeBase = null, configPath = null, credentialPath = null }) {
  const where = [
    configPath ? `Config: <code>${escapeHtml(configPath)}</code>` : null,
    credentialPath ? `Secrets: <code>${escapeHtml(credentialPath)}</code>` : null,
  ]
    .filter(Boolean)
    .join(' &middot; ');
  // Only a validated theme reaches the attribute; a cookie cannot inject markup.
  const themeAttr = theme ? ` data-theme="${theme}"` : '';
  const toggle = themeBase ? themeToggle(theme, themeBase) : '';
  return `<!doctype html>
<html lang="en"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PuzzleSolver settings</title><style>${STYLE}</style></head>
<body><a class="skip" href="#main">Skip to content</a>` +
    `<header class="top"><span class="brand"><h1>PuzzleSolver</h1></span>${toggle}</header>` +
    `<main id="main">${where ? `<p class="where">${where}</p>` : ''}${body}</main></body></html>`;
}

function messagePage(title, message, options = {}) {
  return page({ body: statePage(options.tone ?? 'error', title, message), ...options });
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
 *
 * The ~50 rows are grouped by topic (the `id` prefix), with a jump list of anchors,
 * because that is how someone actually finds a setting. The lifecycle tags
 * (`[live]`/`[restart]`/`[security]`) stay on every row and are summarised per group,
 * so grouping never hides what a setting does (#104).
 */
export function renderSettingsPage({ items, session, theme = null, configPath = null, credentialPath = null, error = null, test = null }) {
  const newItems = items.filter((item) => item.isNew === true);
  // The offer summary puts security-relevant additions first, the same order the
  // startup log and `config review` use (#67).
  const offeredItems = [
    ...newItems.filter((item) => item.securityRelevant === true),
    ...newItems.filter((item) => item.securityRelevant !== true),
  ];

  const rowHtml = (item) => {
    const tag = item.restart ? 'restart' : 'live';
    const probe =
      item.secret && item.testable !== false
        ? `<button type="submit" formaction="/test" name="test_id" value="${escapeHtml(item.id)}">Test connection</button>`
        : '';
    const pending = item.pending ? ' (pending)' : '';
    const isNew = item.isNew ? ' <span class="new">[new]</span>' : '';
    const security = item.securityRelevant ? ' <span class="new">[security]</span>' : '';
    return `<tr><th>${escapeHtml(item.id)}</th><td>${renderField(item)}</td>` +
      `<td class="display">${escapeHtml(item.display)}${pending} <span class="tag tag-${tag}">[${tag}]</span>${isNew}${security}</td><td>${probe}</td></tr>`;
  };

  const anchorOf = (key) => `settings-${String(key).replace(/[^a-z0-9_-]/gi, '-')}`;
  const groups = groupSettings(items);
  const jump =
    groups.length > 1
      ? `<nav class="jump" aria-label="Setting groups"><span class="toc-label">Jump to</span>` +
        groups.map((group) => `<a href="#${anchorOf(group.key)}">${escapeHtml(group.label)}</a>`).join('') +
        '</nav>'
      : '';
  const sections = groups
    .map((group) => {
      const restartCount = group.items.filter((item) => item.restart).length;
      const securityCount = group.items.filter((item) => item.securityRelevant).length;
      const summary =
        `${group.items.length} settings` +
        ` &middot; ${restartCount} need a restart` +
        (securityCount ? ` &middot; ${securityCount} security-relevant` : '');
      return (
        `<section class="group" id="${anchorOf(group.key)}">` +
        `<h2 class="group-title">${escapeHtml(group.label)} <span class="count">${summary}</span></h2>` +
        '<table><thead><tr><th>Setting</th><th>Value</th><th>Current</th><th></th></tr></thead>' +
        `<tbody>${group.items.map(rowHtml).join('')}</tbody></table></section>`
      );
    })
    .join('');

  const banners = [
    error ? banner('error', 'alert', `<strong>Rejected:</strong> ${escapeHtml(error)}`) : '',
    test ? banner('test', 'info', `${escapeHtml(test.id)}: ${test.ok ? 'ok' : 'failed'} - ${escapeHtml(test.detail)}`) : '',
    newItems.length > 0
      ? banner(
          'newbanner',
          'alert',
          `<strong>${newItems.length} setting(s) added since your last review</strong> ` +
            '(marked <span class="new">[new]</span>, security-relevant first): ' +
            offeredItems.map((item) => `<code>${escapeHtml(item.id)}</code>`).join(', ')
        )
      : '',
  ].join('');

  const sessionParam = escapeHtml(session);
  const body =
    banners +
    `<nav class="links"><a href="/solve?session=${sessionParam}">Solve an uploaded image &rarr;</a> ` +
    `<a href="/stats?session=${sessionParam}">Statistics &rarr;</a></nav>` +
    '<p class="display">Every setting is shown; nothing is hidden behind a disclosure. ' +
    'The tag on each row says whether a save takes effect live or needs a restart, and ' +
    '<span class="new">[security]</span> marks a setting whose default matters for safety.</p>' +
    jump +
    `<form method="post" action="/save"><input type="hidden" name="session" value="${sessionParam}">` +
    sections +
    `<div class="actions"><button class="primary" type="submit">Save</button>` +
    `<button type="submit" formaction="/cancel" formnovalidate>Cancel</button></div></form>`;
  return page({ body, theme, themeBase: `/?session=${sessionParam}`, configPath, credentialPath });
}

/** The solve form and, after a post, the result. Exported for a direct render test. */
export function renderSolvePage({ session, result = null, timingMs = null, theme = null, error = null, configPath = null, credentialPath = null }) {
  const banners = error ? banner('error', 'alert', `<strong>Rejected:</strong> ${escapeHtml(error)}`) : '';
  let outcome = '';
  if (result) {
    // Solved, withheld and unresolved are three different facts. The card carries a
    // distinct shape and word for each, so the verdict is readable without colour.
    const state = solveOutcome(result);
    const acknowledgement =
      state.kind === 'unresolved'
        ? (result.unresolvedReply?.text ?? 'No answer passed validation, so nothing was sent. The image was left unresolved.')
        : state.detail;
    const timing = timingMs == null ? 'unknown' : `${Math.round(timingMs)} ms`;
    let detail = '';
    if (state.kind === 'solved') {
      detail =
        `<p class="answer">${escapeHtml(result.answer)}</p>` +
        '<table><tbody>' +
        `<tr><th>method</th><td>${escapeHtml(result.method ?? 'unknown')}</td></tr>` +
        `<tr><th>confident</th><td>${result.confident === true ? 'true' : 'false'}</td></tr>` +
        `<tr><th>took</th><td>${timing}</td></tr>` +
        '</tbody></table>';
    } else {
      // A withheld answer was never shown, so the candidate value is deliberately
      // absent from the page too - only the fact that it was withheld. An unresolved
      // puzzle shows the same acknowledgement wording a Pushbullet reply would use.
      detail =
        '<table><tbody>' +
        `<tr><th>method</th><td>${escapeHtml(result.method ?? 'unknown')}</td></tr>` +
        `<tr><th>confident</th><td>${result.confident === true ? 'true' : 'false'}</td></tr>` +
        `<tr><th>took</th><td>${timing}</td></tr>` +
        `<tr><th>reason</th><td>${escapeHtml(result.reason ?? 'no valid answer')}</td></tr>` +
        '</tbody></table>';
    }
    outcome = outcomeCard({ ...state, detail: acknowledgement }, detail);
  }
  const form =
    '<h2>Solve an image</h2>' +
    '<p>Uploaded through the same paths the HTTP ingress accepts and solved by the same core: ' +
    'one solve lock, the same queue bound and the same image caps.</p>' +
    `<form method="post" action="/solve?session=${escapeHtml(session)}" enctype="multipart/form-data">` +
    '<input type="file" name="image" accept="image/*" required> ' +
    '<button class="primary" type="submit">Solve</button></form>';
  return page({ body: banners + form + outcome, theme, themeBase: `/solve?session=${escapeHtml(session)}`, configPath, credentialPath });
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
      `<tr><th>${escapeHtml(name)}</th><td class="num">${summary.seen}</td><td class="num">${summary.valid}</td>` +
      `<td class="num">${summary.withheld}</td><td class="num">${summary.sentable}/${summary.seen} (${escapeHtml(percent(summary.sentableRate))})</td></tr>`
    )
    .join('');
}

function summaryTable(title, group) {
  const rows = summaryRows(group);
  if (!rows) return '';
  return (
    `<h3>${escapeHtml(title)}</h3>` +
    '<table><thead><tr><th></th><th class="num">distinct puzzles</th><th class="num">solved</th><th class="num">withheld</th><th class="num">sent-able</th></tr></thead>' +
    `<tbody>${rows}</tbody></table>`
  );
}

/**
 * The review-copy cell. The URL is the row id plus the session, never a path: the
 * route reads the path from the database. A row whose file is gone renders a
 * placeholder rather than a broken image or a 500 (#100).
 */
function thumbnailCell(image, session) {
  if (!image || image.id == null) return '<span class="thumb-none">-</span>';
  if (image.exists !== true) return '<span class="thumb-missing">file missing</span>';
  const href = `/images/${encodeURIComponent(String(image.id))}?session=${encodeURIComponent(session)}`;
  return (
    `<a class="thumb" href="${escapeHtml(href)}" target="_blank" rel="noopener">` +
    `<img src="${escapeHtml(href)}" alt="puzzle image" width="64" height="64" loading="lazy">` +
    '</a>'
  );
}

/**
 * The statistics page. Read-only by construction: it takes already-read data and a
 * session token, and has no store, controller or POST target. Exported so a test can
 * assert the numbers and labels without an HTTP server.
 */
export function renderStatsPage({
  session,
  theme = null,
  recent = [],
  stats = null,
  corpusReport = null,
  retainDays = null,
  error = null,
  configPath = null,
  credentialPath = null,
}) {
  const banners = error ? banner('error', 'alert', `<strong>Rejected:</strong> ${escapeHtml(error)}`) : '';

  const recentRows = recent
    .map((row) => {
      const outcome = rowOutcome(row);
      // The verdict is folded into the answer cell as a shape + word, so the table
      // keeps its column count and the outcome is still readable without colour.
      const answer =
        `${verdictBadge(outcome, outcome)} ` + (row.answer == null ? '<em>none</em>' : escapeHtml(row.answer));
      return (
        '<tr>' +
        `<td>${escapeHtml(formatWhen(row.at))}</td>` +
        `<td class="thumb">${thumbnailCell(row.image, session)}</td>` +
        `<td><code>${escapeHtml(row.subject)}</code></td>` +
        `<td>${answer}</td>` +
        `<td>${escapeHtml(row.method ?? 'none')}</td>` +
        `<td>${escapeHtml(deliveryLabel(row))}</td>` +
        `<td class="num">${row.ms == null ? 'unknown' : `${Math.round(Number(row.ms))} ms`}</td>` +
        `<td class="num">${row.confident === true ? 'true' : 'false'}</td>` +
        '</tr>'
      );
    })
    .join('');
  const recentTable = recentRows
    ? '<table><thead><tr><th>when</th><th>image</th><th>puzzle</th><th>answer</th><th>method</th><th>sent / withheld</th><th class="num">took</th><th class="num">confident</th></tr></thead>' +
      `<tbody>${recentRows}</tbody></table>`
    : emptyState({
        title: 'No solves recorded yet',
        body:
          'A fresh install has no history. Solve an image and the result - answer, method, ' +
          'delivery verdict and timing - will appear here, newest first.',
        action: `<p><a href="/solve?session=${escapeHtml(session)}">Solve the first image &rarr;</a></p>`,
      });

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
      '<table><thead><tr><th class="num">distinct puzzles</th><th class="num">solved (valid)</th><th class="num">unresolved</th><th class="num">withheld</th><th class="num">sent-able</th></tr></thead>' +
      `<tbody><tr><td class="num">${overall.seen}</td><td class="num">${overall.valid}</td><td class="num">${unresolved}</td>` +
      `<td class="num">${overall.withheld}</td><td class="num">${overall.sentable}/${overall.seen} (${escapeHtml(percent(overall.sentableRate))})</td></tr></tbody></table>` +
      summaryTable('By tier (how the answer was produced)', traffic.byTier) +
      summaryTable('By puzzle class', traffic.byClass) +
      `<p>Model calls made (recorded <code>model-text</code> + <code>model-vision</code> stages): <strong>${stats.modelCalls}</strong></p>`
    : '<h2>Recorded traffic (real)</h2>' +
      emptyState({
        title: 'No recorded traffic yet',
        body: 'Once the app sees a puzzle over Pushbullet or HTTP, its totals appear here - counted once per puzzle, never blended with the offline corpus below.',
      });

  const corpus = corpusReport?.overall ?? null;
  const corpusSection =
    '<h2>Offline corpus (synthetic fixtures)</h2>' +
    '<p><strong>This is a regression guard, not real-world accuracy.</strong> The corpus is ' +
    'our own generated fixtures, chosen for solvability, run through the same pipeline. ' +
    'It is shown separately from recorded traffic and is never blended with it.</p>' +
    (corpus
      ? `<table><thead><tr><th class="num">correct</th><th class="num">graded</th><th class="num">accuracy</th></tr></thead>` +
        `<tbody><tr><td class="num">${corpus.correct}</td><td class="num">${corpus.gradeable}</td><td class="num">${escapeHtml(percent(corpus.accuracy))}</td></tr></tbody></table>`
      : emptyState({
          title: 'No offline corpus report cached',
          body: 'Run <code>npm run accuracy</code> to grade the committed fixtures and cache a report.',
        }));

  const windowText =
    retainDays == null
      ? 'The store deletes attempts older than the configured retention window, so this page shows a moving window rather than everything ever seen.'
      : `Attempts older than <strong>${escapeHtml(String(retainDays))} day(s)</strong> are deleted by the retention window ` +
        '(<code>storage.retain_days</code>), so this page shows a moving window rather than everything ever seen.';

  const sessionParam = escapeHtml(session);
  const recentIntro = recent.length
    ? `Newest first, at most ${escapeHtml(String(recent.length))} shown. Read on request only; ` +
      'there is no auto-refresh. The answer and method come from the same recorded verdict the ' +
      'solve page formats, so the two cannot disagree. <strong>took</strong> is that solve\'s own ' +
      'recorded duration; <em>unknown</em> means no timing was recorded for it.'
    : 'This page is read on request only; there is no auto-refresh. Each recorded solve appears ' +
      'newest first with its own outcome, answer, method and duration.';
  const body =
    banners +
    `<nav class="links"><a href="/solve?session=${sessionParam}">Solve an uploaded image &rarr;</a> ` +
    `<a href="/stats?session=${sessionParam}">Refresh &rarr;</a></nav>` +
    `<h2>Recent solves</h2>` +
    `<p>${recentIntro}</p>` +
    recentTable +
    trafficSection +
    corpusSection +
    `<p class="display">${windowText}</p>`;
  return page({ body, theme, themeBase: `/stats?session=${sessionParam}`, configPath, credentialPath });
}

/**
 * The statistics row's own outcome, kept separate from `deliveryLabel`: a withheld
 * candidate still has a value in the row, so `answer != null` alone would call it
 * solved. `formatSolveResponse` marks the withheld case with `reason: 'unconfirmed'`.
 */
export function rowOutcome(row) {
  if (row?.reason === 'unconfirmed') return 'withheld';
  if (row?.answer != null) return 'solved';
  return 'unresolved';
}

/** The login form for a non-loopback client. No username: only a password exists. */
export function renderLoginPage({ error = null, theme = null, configPath = null, credentialPath = null } = {}) {
  const bannerHtml = error ? banner('error', 'alert', escapeHtml(error)) : '';
  const body =
    bannerHtml +
    '<h2>Sign in</h2>' +
    '<p>This web UI is reachable from a non-loopback address, so it requires the configured credential.</p>' +
    '<form method="post" action="/login">' +
    '<input type="password" name="password" autocomplete="current-password" required> ' +
    '<button class="primary" type="submit">Sign in</button></form>';
  return page({ body, theme, themeBase: '/login', configPath, credentialPath });
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
  const body =
    statePage('ok', 'Saved.', 'Your changes were written.') +
    (changed ? `<ul>${changed}</ul>` : '') +
    restart +
    live +
    backup +
    '<p>You can close this tab.</p>';
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
  // #100: the bounded review-copy store. Without it the thumbnail route is a 404 and
  // the statistics page renders no thumbnails, exactly like the solve page without a
  // core. Reads are by row id; the path always comes from the database.
  imageStore = null,
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
      // `img-src 'self'` is the minimal widening for the statistics page's review
      // copies (#100/#111). `img-src` falls back to `default-src` when absent, so
      // without it the `default-src 'none'` above is `img-src 'none'` and every
      // same-origin `/images/<id>` thumbnail is refused. `'self'` is enough because
      // the route is same-origin, session-gated and addresses rows by id; `data:`
      // (the old screenshot trick) and any external host remain refused.
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
      ...headers,
    });
    res.end(buffer);
  }

  /**
   * Serve one stored image. The content type is fixed server-side - the encoder
   * always writes WebP - so it is never echoed from the request. `no-store` matches
   * every other page: a stored image is as sensitive as the statistics page linking
   * to it.
   */
  function sendImage(res, buffer) {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': String(buffer.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    });
    res.end(buffer);
  }

  const view = (theme = null) => ({ items: controller.list(), configPath, credentialPath, theme });

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

  async function handleLogin(req, res, remote, theme = null) {
    if (!credentialVerifier) {
      return send(res, 403, messagePage('Refused', 'Login is not configured on this web UI.', { theme }));
    }
    const gate = loginThrottle.check(remote);
    if (!gate.allowed) {
      return send(
        res,
        429,
        renderLoginPage({ error: `Too many failed attempts. Try again in ${gate.retryAfterSec}s.`, theme, configPath, credentialPath }),
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
          renderLoginPage({ error: `Too many failed attempts. Try again in ${outcome.retryAfterSec}s.`, theme, configPath, credentialPath }),
          { 'retry-after': String(outcome.retryAfterSec) }
        );
      }
      return send(res, 401, renderLoginPage({ error: LOGIN_FAILED_MESSAGE, theme, configPath, credentialPath }));
    }
    loginThrottle.succeed(remote);
    openSession(remote);
    return send(res, 200, renderSettingsPage({ ...view(theme), session: sessionToken }));
  }

  async function handleSolve(req, res, url, remote, theme = null) {
    if (!solveCore || typeof solveCore.solve !== 'function') {
      return send(res, 404, messagePage('Not found', 'Solving is not available from this web UI.', { theme }));
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
        return send(res, status, renderSolvePage({ session: sessionToken, theme, error: reason, configPath, credentialPath }));
      }

      if (!acquire()) {
        return send(
          res,
          503,
          renderSolvePage({ session: sessionToken, theme, error: 'The solver queue is full; try again shortly.', configPath, credentialPath }),
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
      return send(res, 200, renderSolvePage({ session: sessionToken, theme, result: formatted, timingMs, configPath, credentialPath }));
    } catch (err) {
      logger?.warn?.(`web ui solve failed: ${err?.message ?? err}`);
      return send(res, Number.isInteger(err?.status) ? err.status : 500, renderSolvePage({ session: sessionToken, theme, error: 'The solve failed; check the log.', configPath, credentialPath }));
    }
  }

  /**
   * The statistics page's handler. It only reads: a bounded recent-list query and a
   * SQL-aggregated totals query. There is no POST behind it and no store write on the
   * path. The recorded verdict is passed through `formatSolveResponse` - the same
   * serialiser the solve page uses - so the two pages cannot disagree on
   * answer/method/confidence/reason.
   */
  async function handleStats(res, theme = null) {
    if (!store) {
      return send(res, 404, messagePage('Not found', 'Statistics are not available from this web UI.', { theme }));
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
      return {
        ...row,
        status: formatted.status,
        reason: formatted.reason ?? null,
        // The row id is the only thing the page needs; existence is checked here so
        // a vanished file becomes a placeholder, not a broken image (#100).
        image:
          row.imageId == null
            ? null
            : { id: row.imageId, exists: imageStore ? imageStore.exists(row.imageId) : false },
      };
    });
    return send(
      res,
      200,
      renderStatsPage({
        session: sessionToken,
        theme,
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
    // Read before any refusal so even a 403 is themed, and before the URL parse so it
    // is available if parsing the URL were ever to fail.
    const cookieTheme = themeFromCookie(req?.headers?.cookie);
    try {
      const remote = getRemoteAddress(req);
      // 1. The one access rule, before Host, before token, before any handler. Every
      //    page and every POST goes through it by construction, including an unknown
      //    path (the 404 default is below).
      if (!remote || !addressAllowed(remote, allowedCidrs)) {
        return send(res, 403, messagePage('Refused', 'This web UI only answers requests from an allowed address.', { theme: cookieTheme }));
      }
      // 2. DNS-rebinding defence. Widening the bind enumerates more names, never "any".
      if (!isAllowedHostHeader(req.headers.host, { boundAddress, allowedHosts })) {
        return send(
          res,
          403,
          messagePage('Refused', 'This web UI only answers requests addressed to an allowed hostname (loopback by default).', {
            theme: cookieTheme,
          })
        );
      }
      const url = new URL(req.url ?? '/', `http://${WEB_UI_BIND}`);
      const method = String(req.method ?? 'GET').toUpperCase();
      const loopbackClient = isLoopbackAddress(remote);

      // `?theme=light|dark|auto` is the toggle's no-JS GET: it renders with the chosen
      // theme and sets (or clears) the cookie on the way out. The value is allowlisted,
      // so the cookie and the `data-theme` attribute are never caller-supplied text.
      const themeChoice = themeFromParam(url.searchParams.get('theme'));
      const theme = themeChoice === 'auto' ? null : (themeChoice ?? cookieTheme);
      // Persist the choice on the response itself, not by threading a header into
      // each `send()` call: a route that forgets the argument (`/stats`, before this
      // fix) silently drops the cookie. `writeHead` merges with headers set here, so
      // every response for a `?theme=` request carries it (#112).
      if (themeChoice) res.setHeader('set-cookie', themeCookieHeader(themeChoice));

      if (method === 'GET' && url.pathname === '/login') {
        return send(res, 200, renderLoginPage({ theme, configPath, credentialPath }));
      }
      if (method === 'POST' && url.pathname === '/login') {
        return handleLogin(req, res, remote, theme);
      }

      if (method === 'GET' && url.pathname === '/') {
        if (loopbackClient) {
          // An existing session may revisit the editor (the theme toggle does): the
          // launch token is single-use, so a second GET with it is still refused.
          if (sessionValid(url.searchParams.get('session') ?? '', remote)) {
            return send(res, 200, renderSettingsPage({ ...view(theme), session: sessionToken }));
          }
          // Loopback keeps #56's behaviour: the one-time launch token is enough.
          const provided = url.searchParams.get('token') ?? '';
          const fresh = launchToken && !launchToken.used && now() - launchToken.issuedAt <= launchTokenTtlMs;
          if (!fresh || !constantTimeEqual(provided, launchToken.token)) {
            return send(
              res,
              403,
              messagePage('Link no longer valid', 'The one-time settings link was already used or has expired. Open Settings again to get a new one.', {
                theme: cookieTheme,
              })
            );
          }
          launchToken.used = true;
          openSession(remote);
          return send(res, 200, renderSettingsPage({ ...view(theme), session: sessionToken }));
        }
        // Non-loopback already authenticated (session in the query) gets the page;
        // otherwise it must log in. The launch token is not enough there.
        if (sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return send(res, 200, renderSettingsPage({ ...view(theme), session: sessionToken }));
        }
        return send(res, 200, renderLoginPage({ theme, configPath, credentialPath }));
      }

      if (method === 'GET' && url.pathname === '/solve') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return loopbackClient
            ? send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.', { theme: cookieTheme }))
            : send(res, 200, renderLoginPage({ theme, configPath, credentialPath }));
        }
        return send(res, 200, renderSolvePage({ session: sessionToken, theme, configPath, credentialPath }));
      }

      if (method === 'POST' && url.pathname === '/solve') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.', { theme: cookieTheme }));
        }
        return handleSolve(req, res, url, remote, theme);
      }

      // Read-only: GET only. There is deliberately no POST /stats branch, so a write
      // cannot be reached from the statistics page (#64). An unknown method falls
      // through to the 404 below.
      if (method === 'GET' && url.pathname === '/stats') {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return loopbackClient
            ? send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.', { theme: cookieTheme }))
            : send(res, 200, renderLoginPage({ theme, configPath, credentialPath }));
        }
        return handleStats(res, theme);
      }

      // A stored image (#100). It sits behind the very same gate as every other page -
      // the address/Host checks above, then the session - so a thumbnail URL is not an
      // unauthenticated side door that merely looks like a static asset. The id is a
      // row id; the path is read from the database inside `imageStore.pathFor`, never
      // built from the request. Anything that is not a known numeric row is a 404.
      const imageMatch = method === 'GET' ? /^\/images\/(\d+)$/.exec(url.pathname) : null;
      if (imageMatch) {
        if (!sessionValid(url.searchParams.get('session') ?? '', remote)) {
          return loopbackClient
            ? send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.', { theme: cookieTheme }))
            : send(res, 200, renderLoginPage({ theme, configPath, credentialPath }));
        }
        if (!imageStore) {
          return send(res, 404, messagePage('Not found', 'Stored images are not available from this web UI.', { theme: cookieTheme }));
        }
        const path = imageStore.pathFor(imageMatch[1]);
        if (!path) {
          return send(res, 404, messagePage('Not found', 'There is no stored image with that id.', { theme: cookieTheme }));
        }
        let bytes;
        try {
          bytes = readFileSync(path);
        } catch {
          // The row exists but the file is gone. 404 (and the page shows a
          // placeholder) rather than a 500.
          return send(res, 404, messagePage('Not found', 'The stored image file is missing.', { theme: cookieTheme }));
        }
        return sendImage(res, bytes);
      }

      if (method === 'POST' && (url.pathname === '/save' || url.pathname === '/test' || url.pathname === '/cancel')) {
        const body = await readBodyCapped(req, WEB_UI_MAX_BODY_BYTES);
        const form = new URLSearchParams(body.toString('utf8'));
        if (!sessionValid(form.get('session') ?? '', remote)) {
          return send(res, 403, messagePage('Session expired', 'Reopen Settings to get a fresh session.', { theme: cookieTheme }));
        }

        if (url.pathname === '/cancel') {
          finish({ saved: false, cancelled: true });
          send(res, 200, messagePage('Cancelled', 'No changes were saved. This settings UI is now closed.', { ...view(theme), tone: 'notice' }));
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
          return send(res, 200, renderSettingsPage({ ...view(theme), session: sessionToken, test: result ? { id, ...result } : null, error: errors.map((e) => `${e.id}: ${e.message}`).join('; ') || null }));
        }

        // /save: reject every invalid value first; nothing is written while any error
        // is outstanding, and the wording names the setting.
        const errors = applySettingsForm(controller, form);
        if (errors.length > 0) {
          return send(res, 400, renderSettingsPage({ ...view(theme), session: sessionToken, error: errors.map((e) => `${e.id}: ${e.message}`).join('; ') }));
        }
        let result;
        try {
          result = await controller.save();
        } catch (err) {
          result = { saved: false, failed: true, detail: err?.message ?? String(err) };
        }
        if (result.failed) {
          return send(res, 400, renderSettingsPage({ ...view(theme), session: sessionToken, error: result.detail ?? 'nothing was saved' }));
        }
        finish(result);
        send(res, result.saved ? 200 : 200, result.saved ? renderDonePage(result, view(theme)) : messagePage('No changes', 'Nothing was changed, so nothing was saved.', { ...view(theme), tone: 'notice' }));
        res.on('finish', () => void stop());
        return undefined;
      }

      return send(res, 404, messagePage('Not found', 'There is nothing at that address.', { theme: cookieTheme }));
    } catch (err) {
      logger?.warn?.(`settings UI request failed: ${err?.message ?? err}`);
      return send(res, Number.isInteger(err?.status) ? err.status : 500, messagePage('Error', 'The settings UI hit an error. Check the log, then reopen Settings.', { theme: cookieTheme }));
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
  imageStore = null,
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
      imageStore,
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
