/**
 * The web UI dark-mode decision (issue #99).
 *
 * The theme is a cookie plus a server-side render, not `localStorage` + an inline
 * script: the served CSP forbids scripts, so a JS switch would mean relaxing it, and a
 * cookie cannot flash the wrong theme because the server writes the choice into the
 * HTML before the browser paints. `prefers-color-scheme` stays the default via CSS, so
 * an OS-dark visitor is dark on the first load with no toggle.
 *
 * These tests exercise the parts that can be checked without a browser: the allowlist,
 * the cookie the server actually sets, and the `data-theme` attribute it actually
 * renders. The media query itself is CSS and is asserted by its selector, not by a
 * rendered pixel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig } from '../src/config.js';
import { createSettingsEditor, SETTINGS } from '../src/ui/settings.js';
import { memoryStore } from '../src/state/db.js';
import {
  createWebSettingsServer,
  normalizeTheme,
  renderLoginPage,
  renderSettingsPage,
  renderSolvePage,
  renderStatsPage,
  themeCookieHeader,
  themeFromCookie,
  themeFromParam,
  THEME_CHOICE_LABELS,
} from '../src/ui/web-config.js';

function makeController() {
  const items = [
    { id: 'storage.retain_days', label: 'Retain days', secret: false, restart: true, type: 'number', value: 7, display: '7', pending: false },
  ];
  return {
    list: () => items,
    set: () => {},
    reset: () => {},
    save: async () => ({ saved: true, changed: [], restartRequired: [], live: [] }),
  };
}

async function startUi(t, overrides = {}) {
  const server = createWebSettingsServer({ controller: makeController(), ...overrides });
  await server.start();
  t.after(() => server.stop());
  return server;
}

function sessionFrom(html) {
  const match = /name="session" value="([^"]+)"/.exec(html);
  assert.ok(match, 'the settings page must carry a session token');
  return match[1];
}

// ---------------------------------------------------------------------------
// The allowlist and the cookie value
// ---------------------------------------------------------------------------

test('only the two concrete themes are renderable values', () => {
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  // Everything else is ignored, including anything that could carry markup.
  for (const bad of ['auto', '', null, undefined, 'DARK', '"><script>alert(1)</script>', 'dark; Path=/']) {
    assert.equal(normalizeTheme(bad), null, `${bad} must not be a theme`);
  }
});

test('the toggle accepts auto, the cookie does not', () => {
  for (const choice of ['light', 'dark', 'auto']) assert.equal(themeFromParam(choice), choice);
  for (const bad of ['', null, 'system', '"><img src=x>']) assert.equal(themeFromParam(bad), null);
  // `auto` means "follow the OS", so it is a control value, never a cookie value.
  assert.equal(themeFromCookie('theme=auto'), null);
  assert.equal(themeFromCookie('theme=dark'), 'dark');
  assert.equal(themeFromCookie('theme=light; other=1'), 'light');
  assert.equal(themeFromCookie('session=abc'), null);
});

test('the Set-Cookie value is built from the allowlist, never from caller text', () => {
  assert.match(themeCookieHeader('dark'), /^theme=dark; Path=\/; Max-Age=\d+; SameSite=Lax; HttpOnly$/);
  assert.match(themeCookieHeader('auto'), /^theme=; .*Max-Age=0/);
  assert.equal(themeCookieHeader('"><script>'), null, 'an unknown choice sets no cookie');
  assert.equal(themeCookieHeader('light').includes('"><'), false, 'the raw value is never echoed');
});

test('every theme choice has a visible label in the toggle', () => {
  assert.deepEqual(Object.keys(THEME_CHOICE_LABELS).sort(), ['auto', 'dark', 'light']);
});

// ---------------------------------------------------------------------------
// The rendered page
// ---------------------------------------------------------------------------

test('an explicit theme is written to data-theme; no theme falls through to the OS', () => {
  const dark = renderSettingsPage({ items: [], session: 's', theme: 'dark' });
  assert.match(dark, /<html lang="en" data-theme="dark">/);
  const light = renderSettingsPage({ items: [], session: 's', theme: 'light' });
  assert.match(light, /<html lang="en" data-theme="light">/);
  const auto = renderSettingsPage({ items: [], session: 's' });
  assert.match(auto, /<html lang="en">/, 'no explicit choice must leave the OS in charge');
  assert.doesNotMatch(auto, /<html[^>]*data-theme=/);
});

test('the OS preference is the default: no cookie renders no data-theme and the dark rule', async (t) => {
  const server = await startUi(t);
  const page = await fetch(server.url);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /<html[^>]*data-theme=/, 'with no cookie the attribute must be absent');
  // The dark palette is applied by the media query when no explicit choice was made.
  assert.match(html, /@media \(prefers-color-scheme: dark\)/);
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
});

test('the theme cookie selects the rendered theme over HTTP', async (t) => {
  const server = await startUi(t);
  const first = await fetch(server.url);
  const session = sessionFrom(await first.text());
  const base = `http://127.0.0.1:${server.port}/?session=${encodeURIComponent(session)}`;

  const dark = await fetch(base, { headers: { cookie: 'theme=dark' } });
  assert.match(await dark.text(), /<html lang="en" data-theme="dark">/);

  const light = await fetch(base, { headers: { cookie: 'theme=light' } });
  assert.match(await light.text(), /<html lang="en" data-theme="light">/);
});

test('an unknown cookie is ignored and never echoed into the page', async (t) => {
  const server = await startUi(t);
  const first = await fetch(server.url);
  const session = sessionFrom(await first.text());
  const base = `http://127.0.0.1:${server.port}/?session=${encodeURIComponent(session)}`;
  const injected = '"><script>alert(1)</script>';
  const res = await fetch(base, { headers: { cookie: `theme=${encodeURIComponent(injected)}` } });
  const html = await res.text();
  assert.match(html, /<html lang="en">/, 'an unknown cookie must be treated as absent');
  assert.equal(html.includes('<script>'), false, 'the cookie must never reach the document');
});

// Every route whose response renders the page shell (and so the Light/Dark/Auto
// toggle). Enumerated rather than spot-checked: #112 was a single route that dropped
// the Set-Cookie, and checking one or two routes by hand is how it was missed. The
// server now persists `?theme=` on the response itself (see `handle`), so a later
// route inherits it; this list fails loudly if one stops carrying it.
const THEMED_ROUTES = ['/', '/solve', '/stats', '/login'];

test('every page that renders the toggle persists an explicit ?theme= choice', async (t) => {
  // A store is needed so `/stats` renders the real page (with its toggle) rather than
  // the "not available" message page.
  const server = await startUi(t, { store: memoryStore() });
  // The launch URL both opens the session and carries the initial choice.
  const launched = await fetch(`${server.url}&theme=dark`);
  const session = sessionFrom(await launched.text());
  const base = `http://127.0.0.1:${server.port}`;

  for (const route of THEMED_ROUTES) {
    const dark = await fetch(`${base}${route}?session=${encodeURIComponent(session)}&theme=dark`);
    assert.match(dark.headers.get('set-cookie') ?? '', /^theme=dark;/, `${route} must persist the dark choice`);
    const darkHtml = await dark.text();
    assert.match(darkHtml, /<html lang="en" data-theme="dark">/, `${route} must render dark`);
    assert.match(darkHtml, /class="theme"/, `${route} must render the toggle`);

    const auto = await fetch(`${base}${route}?session=${encodeURIComponent(session)}&theme=auto`);
    assert.match(auto.headers.get('set-cookie') ?? '', /Max-Age=0/, `${route} must clear the choice on auto`);
    assert.match(await auto.text(), /<html lang="en">/, `${route} must follow the OS again`);
  }
});

test('the toggle is on every page and carries the current session', () => {
  const settings = renderSettingsPage({ items: [], session: 's3s', theme: 'dark' });
  assert.match(settings, /href="\/\?session=s3s&theme=light"/);
  assert.match(settings, /href="\/\?session=s3s&theme=auto"/);
  assert.match(settings, /class="active" aria-current="true">Dark<\/a>/);

  const solve = renderSolvePage({ session: 's3s', theme: 'dark' });
  assert.match(solve, /<html lang="en" data-theme="dark">/);
  assert.match(solve, /href="\/solve\?session=s3s&theme=light"/);

  const stats = renderStatsPage({ session: 's3s', theme: 'dark' });
  assert.match(stats, /href="\/stats\?session=s3s&theme=light"/);

  const login = renderLoginPage({ theme: 'light' });
  assert.match(login, /href="\/login\?theme=dark"/);
});

// ---------------------------------------------------------------------------
// The access-control invariants are untouched by the theme
// ---------------------------------------------------------------------------

test('the theme toggle cannot reach the settings page without a launch token or session', async (t) => {
  const server = await startUi(t);
  // No token, no session: the theme param must not become an access path.
  const res = await fetch(`http://127.0.0.1:${server.port}/?theme=dark`);
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('a real editor still renders every descriptor with a theme applied', async (t) => {
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: null,
    secrets: null,
    saveSecrets: async () => ({ saved: [], providers: [] }),
  });
  const server = createWebSettingsServer({ controller: editor });
  await server.start();
  t.after(() => server.stop());
  const first = await fetch(`${server.url}&theme=dark`);
  const html = await first.text();
  assert.match(html, /<html lang="en" data-theme="dark">/);
  for (const setting of SETTINGS) {
    // The id is rendered as the row's identity beneath the label (#139).
    assert.ok(html.includes(`<code class="setting-id">${setting.id}</code>`), `${setting.id} must still render`);
    assert.ok(html.includes(`<span class="setting-label">${setting.label}</span>`), `${setting.id}'s label must still render`);
  }
});
