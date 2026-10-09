/**
 * Redaction tests for the shapes issue #45 named.
 *
 * The under-redaction half: a key whose shape is not `sk-`/`o.` used to pass
 * through unchanged, so it reached the log file and the attempts table. The
 * over-redaction half: the `sk-` rule had no word boundary, so `task-assignment`
 * became `task-ass…` and corrupted ordinary text.
 *
 * Each case asserts the full value is gone *and* that ordinary hyphenated words
 * survive, because a redactor that damages real content erodes trust in the log.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearKnownSecrets,
  redact,
  redactPushbullet,
  redactRecord,
  registerSecrets,
} from '../src/redact.js';

afterEach(() => clearKnownSecrets());

// ---------------------------------------------------------------------------
// Newly-covered value shapes
// ---------------------------------------------------------------------------

// Built by concatenation so the would-be canaries are never a contiguous literal in
// the repository and do not trip GitHub secret scanning. The redactor still sees the
// assembled value at runtime.
const canary = (...parts) => parts.join('');

const SHAPES = [
  ['Groq gsk_', canary('gsk_', 'abcdefghijklmnop1234')],
  ['Google AIza', canary('AIza', 'SyA1234567890abcdefghijk')],
  ['GitHub classic ghp_', canary('ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')],
  ['GitHub fine-grained pat', canary('github_pat_', '11ABCDEFG0abcdefghijklmnop_abcdefghijklmnop')],
  ['Stripe sk_live_', canary('sk_live_', 'abcdefghijklmnop1234')],
  ['Stripe pk_live_', canary('pk_live_', 'abcdefghijklmnop1234')],
  ['Slack xoxb-', canary('xox', 'b-123456789012-', 'abcdefghijklmnop')],
  ['AWS AKIA', canary('AKIA', 'IOSFODNN7EXAMPLE')],
];

for (const [label, secret] of SHAPES) {
  test(`a ${label} key is redacted`, () => {
    const cleaned = redact(`upstream rejected ${secret} please rotate`);
    assert.equal(cleaned.includes(secret), false, `${label} must not survive`);
    // The body must not survive either, not merely the whole token.
    assert.equal(cleaned.includes(secret.slice(4)), false, `${label} body must not survive`);
  });
}

test('a generic Authorization/x-api-key header value is redacted whatever its shape', () => {
  const header = 'x-api-key: abcd1234secretvalue';
  const auth = 'Authorization: Bearer ab';
  assert.equal(redact(header).includes('abcd1234secretvalue'), false);
  assert.match(redact(header), /x-api-key: abc…/);
  // Two characters is too short to keep any of; the whole value becomes an ellipsis.
  assert.equal(redact(auth).includes('Bearer ab'), false);
  assert.match(redact(auth), /Authorization: Bearer …/);
});

// ---------------------------------------------------------------------------
// The false positive the old rule produced
// ---------------------------------------------------------------------------

test('ordinary hyphenated words containing "sk-" are not mangled', () => {
  for (const word of ['task-assignment-failed', 'risk-management', 'disk-usage-report', 'mask-x']) {
    assert.equal(redact(word), word, `${word} must be left alone`);
  }
});

test('a real sk- key next to ordinary text is still redacted', () => {
  const cleaned = redact('task-assignment sk-abcdefghijklmnop');
  assert.equal(cleaned.includes('sk-abcdefghijklmnop'), false);
  assert.match(cleaned, /task-assignment/);
  assert.match(cleaned, /sk-abc…/);
});

// ---------------------------------------------------------------------------
// Structural redaction by key name
// ---------------------------------------------------------------------------

test('a value is redacted when it follows a credential key name, not just a shape', () => {
  const cases = [
    'api_key=opaquevalue123',
    '"api_key":"opaquevalue123"',
    'token: opaquevalue123',
    'client_secret=opaquevalue123',
    'password=opaquevalue123',
  ];
  for (const text of cases) {
    assert.equal(redact(text).includes('opaquevalue123'), false, text);
  }
});

test('repeated redaction is stable (a masked value is not reduced further)', () => {
  const once = redact('key sk-abcdefghijklmnop and task-x');
  assert.equal(redact(once), once);
  const push = redactPushbullet('access-token: o.abcdef12345678901234');
  assert.equal(redactPushbullet(push), push);
});

// ---------------------------------------------------------------------------
// Configured secrets registered by value
// ---------------------------------------------------------------------------

test('a registered secret of an undocumented shape is redacted by value', () => {
  registerSecrets(['some-arbitrary-key-that-has-no-shape']);
  const cleaned = redact('upstream echoed some-arbitrary-key-that-has-no-shape in the body');
  assert.equal(cleaned.includes('some-arbitrary-key-that-has-no-shape'), false);
  assert.match(cleaned, /\[redacted\]/);
});

test('a registered secret survives neither sink nor a second pass', () => {
  registerSecrets(['o.abcdef12345678901234']);
  const cleaned = redactRecord(`body {"access_token":"o.abcdef12345678901234"}`);
  assert.equal(cleaned.includes('o.abcdef12345678901234'), false);
  assert.equal(redactRecord(cleaned).includes('o.abcdef12345678901234'), false);
});

test('very short values are not registered (they would corrupt ordinary text)', () => {
  registerSecrets(['a', 'xy']);
  assert.equal(redact('a normal sentence with xy in it'), 'a normal sentence with xy in it');
});
