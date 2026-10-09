/**
 * The web UI token layer (issue #104).
 *
 * "Elegant" is only checkable if it has a shape: one custom-property layer that both
 * themes are derived from and every page consumes. These tests assert that shape
 * without a browser, because the offline suite must stay browser-free:
 *
 *  - the light and dark palettes define the *same* colour roles;
 *  - every recorded foreground/background pair meets WCAG AA (the #99 baseline);
 *  - every `var(--token)` referenced in the stylesheet resolves to a defined token;
 *  - no page function emits a hard-coded colour, radius or spacing of its own;
 *  - nothing is loaded from outside the document (the CSP is unchanged);
 *  - the grouping and the three-way solve outcome are what they claim.
 *
 * The mutation that proves the palette test can fail: drop one key from the dark
 * palette and `both themes define the same colour roles` goes red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateConfig } from '../src/config.js';
import { createSettingsEditor } from '../src/ui/settings.js';
import {
  COLOR_TOKENS,
  RADIUS_TOKENS,
  SPACE_TOKENS,
  STYLE,
  TYPE_TOKENS,
  createWebSettingsServer,
  groupSettings,
  renderLoginPage,
  renderSettingsPage,
  renderSolvePage,
  renderStatsPage,
  solveOutcome,
} from '../src/ui/web-config.js';

// ---------------------------------------------------------------------------
// Colour: complete for both themes, and AA
// ---------------------------------------------------------------------------

/** Relative luminance, WCAG 2.x. */
function luminance(hex) {
  const text = String(hex).replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(text.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio between two `#rrggbb` values. */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('both themes define the same colour roles', () => {
  const light = Object.keys(COLOR_TOKENS.light).sort();
  const dark = Object.keys(COLOR_TOKENS.dark).sort();
  assert.deepEqual(dark, light, 'a role missing from one theme is a page that renders without a colour');
  assert.ok(light.length >= 20, 'the palette covers the semantic roles, not a handful of literals');
  for (const [role, value] of Object.entries(COLOR_TOKENS.light)) {
    assert.match(value, /^#[0-9a-f]{6}$/i, `${role} must be a concrete colour token`);
  }
});

test('every recorded pair meets WCAG AA in both themes', () => {
  // [foreground, background, minimum]. 4.5 is AA normal text; 3.0 is AA non-text
  // (input borders and the focus ring). Recorded in the PR body as the contrast table.
  const pairs = [
    ['fg', 'bg', 4.5],
    ['fg', 'panel', 4.5],
    ['fg-muted', 'bg', 4.5],
    ['fg-muted', 'panel', 4.5],
    ['link', 'bg', 4.5],
    ['link', 'panel', 4.5],
    ['accent-fg', 'accent', 4.5],
    ['accent-fg', 'accent-hover', 4.5],
    ['ok-fg', 'ok-bg', 4.5],
    ['info-fg', 'info-bg', 4.5],
    ['warn-fg', 'warn-bg', 4.5],
    ['err-fg', 'err-bg', 4.5],
    ['border-strong', 'bg', 3.0],
    ['border-strong', 'panel', 3.0],
    ['link', 'bg', 3.0],
  ];
  for (const [fg, bg, min] of pairs) {
    for (const theme of ['light', 'dark']) {
      const palette = COLOR_TOKENS[theme];
      const ratio = contrast(palette[fg], palette[bg]);
      assert.ok(
        ratio >= min,
        `${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the ${min}:1 floor`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The stylesheet refers only to defined tokens
// ---------------------------------------------------------------------------

test('every var(--token) in the stylesheet resolves to a defined token', () => {
  const defined = new Set([
    ...Object.keys(COLOR_TOKENS.light).map((name) => `--${name}`),
    ...Object.keys(SPACE_TOKENS).map((name) => `--space-${name}`),
    ...Object.keys(RADIUS_TOKENS).map((name) => `--radius-${name}`),
    ...Object.keys(TYPE_TOKENS).map((name) => `--text-${name}`),
    '--font-sans',
    '--font-mono',
    '--line',
    '--border-width',
    '--focus-width',
    '--content-width',
  ]);
  const referenced = new Set([...STYLE.matchAll(/var\((--[a-z0-9-]+)\)/gi)].map((m) => m[1]));
  assert.ok(referenced.size > 0, 'the stylesheet must actually use the tokens');
  for (const token of referenced) {
    assert.ok(defined.has(token), `${token} is referenced but never defined`);
  }
});

test('the stylesheet keeps focus visible and can switch motion off', () => {
  assert.match(STYLE, /:focus-visible/, 'every focusable element must keep a visible focus ring');
  assert.match(STYLE, /@media \(prefers-reduced-motion: reduce\)/, 'motion must degrade to nothing');
});

// ---------------------------------------------------------------------------
// No page function hard-codes a colour, radius or spacing
// ---------------------------------------------------------------------------

/** Everything after the inlined stylesheet, where a page's own markup lives. */
function markupOf(html) {
  return html.replace(/<style>[\s\S]*?<\/style>/, '');
}

function assertNoLiterals(html, label) {
  const markup = markupOf(html);
  assert.doesNotMatch(markup, /#[0-9a-fA-F]{3,8}\b/, `${label} hard-codes a colour`);
  assert.doesNotMatch(markup, /\brgba?\(|\bhsla?\(/, `${label} hard-codes a colour function`);
  assert.doesNotMatch(markup, /\bstyle=/, `${label} uses an inline style attribute instead of a token class`);
  assert.doesNotMatch(markup, /\d+(\.\d+)?(px|rem|em)\b/, `${label} hard-codes a spacing or size`);
}

test('the page functions render tokens, never literals', () => {
  const item = { id: 'a.b', label: 'A setting', secret: false, restart: true, type: 'string', value: 'v', display: 'v', pending: false };
  assertNoLiterals(renderSettingsPage({ items: [item], session: 's' }), 'the settings page');
  assertNoLiterals(
    renderSolvePage({ session: 's', result: { answer: '7', method: 'tier0:count', confident: true }, timingMs: 12 }),
    'the solve page'
  );
  assertNoLiterals(renderStatsPage({ session: 's', recent: [{ at: 1, subject: 'p', answer: '7', method: 'tier0', confident: true, ms: 12 }] }), 'the statistics page');
  assertNoLiterals(renderLoginPage({}), 'the login page');
});

test('the real settings page renders every row using the token layer', () => {
  const editor = createSettingsEditor({
    config: validateConfig({}).config,
    configPath: null,
    secrets: null,
    saveSecrets: async () => ({ saved: [], providers: [] }),
  });
  assertNoLiterals(renderSettingsPage({ items: editor.list(), session: 's' }), 'the real settings page');
});

// ---------------------------------------------------------------------------
// Nothing is loaded from outside the document
// ---------------------------------------------------------------------------

function assertSelfContained(html, label) {
  assert.equal(html.includes('<script'), false, `${label} must carry no script (the CSP has no script-src)`);
  assert.equal(html.includes('<link'), false, `${label} must not link a stylesheet or font`);
  assert.equal(html.includes('@import'), false, `${label} must not import CSS`);
  assert.doesNotMatch(html, /src="https?:|href="https?:|src="\/\//, `${label} must not load an external URL`);
  assert.doesNotMatch(markupOf(html), /url\(/i, `${label} imports an external resource in CSS`);
}

test('every page is self-contained: no script, no external asset', () => {
  assertSelfContained(renderSettingsPage({ items: [], session: 's' }), 'the settings page');
  assertSelfContained(renderSolvePage({ session: 's' }), 'the solve page');
  assertSelfContained(renderStatsPage({ session: 's' }), 'the statistics page');
  assertSelfContained(renderLoginPage({}), 'the login page');
});

test('the served CSP is unchanged and forbids scripts', async (t) => {
  const controller = {
    list: () => [],
    set: () => {},
    reset: () => {},
    save: async () => ({ saved: true, changed: [], restartRequired: [], live: [] }),
  };
  const server = createWebSettingsServer({ controller });
  await server.start();
  t.after(() => server.stop());
  const res = await fetch(server.url);
  const csp = res.headers.get('content-security-policy');
  assert.equal(csp, "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'");
  assert.equal(csp.includes('script-src'), false, 'the CSP must not be relaxed to allow a script');
  assertSelfContained(await res.text(), 'the served settings page');
});

// ---------------------------------------------------------------------------
// Findability and the three-way outcome
// ---------------------------------------------------------------------------

test('settings are grouped by topic, and every row lands in exactly one group', () => {
  const items = [
    { id: 'pushbullet.token' },
    { id: 'solver.tier0' },
    { id: 'http.enabled' },
    { id: 'web_ui.bind' },
    { id: 'solver.llm_text_model' },
    { id: 'future.thing' },
  ];
  const groups = groupSettings(items);
  const flattened = groups.flatMap((group) => group.items.map((item) => item.id));
  assert.deepEqual(flattened.sort(), items.map((item) => item.id).sort(), 'every row appears once');
  assert.deepEqual(
    groups.map((group) => group.key),
    ['pushbullet', 'solver', 'http', 'web_ui', 'future'],
    'known groups lead, then unknown prefixes in list order'
  );
  const settingsHtml = renderSettingsPage({ items: items.map((item) => ({ ...item, label: item.id, secret: false, restart: true, type: 'string', value: 'v', display: 'v', pending: false })), session: 's' });
  assert.match(settingsHtml, /id="settings-http"/, 'each group has an anchor');
  assert.match(settingsHtml, /class="jump"/, 'the page carries a jump list');
  assert.match(settingsHtml, /href="#settings-web_ui"/);
});

test('the solve outcome distinguishes solved, withheld and unresolved by more than colour', () => {
  const solved = solveOutcome({ answer: '7', reason: undefined });
  const withheld = solveOutcome({ answer: null, reason: 'unconfirmed' });
  const unresolved = solveOutcome({ answer: null, reason: 'no tier produced a valid answer' });
  assert.deepEqual([solved.kind, withheld.kind, unresolved.kind], ['solved', 'withheld', 'unresolved']);
  assert.notEqual(solved.label, withheld.label);
  assert.notEqual(withheld.label, unresolved.label);
  // A distinct shape, not just a distinct colour.
  const rendered = [solved, withheld, unresolved].map((outcome) =>
    renderSolvePage({ session: 's', result: outcome.kind === 'solved' ? { answer: '7' } : { answer: null, reason: outcome.kind === 'withheld' ? 'unconfirmed' : 'x' } })
  );
  assert.match(markupOf(rendered[0]), /outcome-solved/);
  assert.match(markupOf(rendered[1]), /outcome-withheld/);
  assert.match(markupOf(rendered[2]), /outcome-unresolved/);
  assert.equal(markupOf(rendered[0]).includes('outcome-withheld'), false, 'the three states do not share a card class');
});
