/**
 * Access-control and credential unit tests (issue #65).
 *
 * These are deliberately pure: a denied remote address is awkward to simulate over a
 * real socket, and the properties that matter are numerical (a range boundary, an
 * IPv4-mapped form) rather than in the wiring. The integration half lives in
 * `tests/web-solve.test.js`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConfigError, validateConfig } from '../src/config.js';
import {
  addressAllowed,
  cidrContains,
  cidrIsWithinLoopback,
  cidrsCoverAddressSpace,
  hashWebUiPassword,
  isAllowedHostHeader,
  isCatchAllCidr,
  isLoopbackAddress,
  parseAllowedCidrs,
  parseCidr,
  parseIp,
  verifyWebUiPassword,
  webUiAdmitsNonLoopback,
} from '../src/ui/access.js';

const p = (text) => parseCidr(text);

// ---------------------------------------------------------------------------
// Numerical, not prefix
// ---------------------------------------------------------------------------

test('an address is parsed to bytes, so a hostname is never loopback (#47)', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.0.0.2'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('128.0.0.1'), false);
  assert.equal(isLoopbackAddress('0.0.0.0'), false);
  // The #47 bug, repeated here so a `startsWith('127.')` regression cannot return.
  assert.equal(isLoopbackAddress('127.evil.example'), false);
  assert.equal(isLoopbackAddress('localhost'), false, 'a name is not an address');
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(null), false);
});

test('IPv4-mapped IPv6 is normalised to the same 4 bytes as IPv4', () => {
  assert.deepEqual(parseIp('::ffff:192.168.1.5'), parseIp('192.168.1.5'));
  assert.equal(parseIp('::ffff:192.168.1.5').family, 4);
  assert.equal(parseIp('::1').family, 6);
  assert.equal(parseIp('[::1]').family, 6, 'bracketed literals are accepted');
  assert.equal(parseIp('not:an:ip'), null);
  assert.equal(parseIp('999.1.1.1'), null);
});

// ---------------------------------------------------------------------------
// CIDR boundaries
// ---------------------------------------------------------------------------

test('an IPv4 range matches its network and broadcast addresses and refuses a near miss', () => {
  const range = p('192.168.1.0/24');
  assert.equal(cidrContains(range, '192.168.1.0'), true, 'network address is inside');
  assert.equal(cidrContains(range, '192.168.1.255'), true, 'broadcast address is inside');
  assert.equal(cidrContains(range, '192.168.1.1'), true);
  assert.equal(cidrContains(range, '192.168.0.255'), false, 'one bit below the range');
  assert.equal(cidrContains(range, '192.168.2.0'), false, 'one bit above the range');

  const half = p('192.168.1.0/25');
  assert.equal(cidrContains(half, '192.168.1.127'), true);
  assert.equal(cidrContains(half, '192.168.1.128'), false, 'the first address of the other half');
});

test('an IPv6 range matches boundaries and refuses a one-bit miss', () => {
  const ula = p('fd00::/8');
  assert.equal(cidrContains(ula, 'fd00::1'), true);
  assert.equal(cidrContains(ula, 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true);
  assert.equal(cidrContains(ula, 'fe00::1'), false, 'one bit outside fd00::/8');

  const doc = p('2001:db8::/32');
  assert.equal(cidrContains(doc, '2001:db8::'), true);
  assert.equal(cidrContains(doc, '2001:db8:ffff::1'), true);
  assert.equal(cidrContains(doc, '2001:db9::1'), false);
});

test('an IPv4-mapped client matches the IPv4 range (the bypass this must not have)', () => {
  const range = p('192.168.1.0/24');
  assert.equal(cidrContains(range, '::ffff:192.168.1.5'), true);
  assert.equal(cidrContains(range, '::ffff:192.168.2.5'), false);
  // A mapped CIDR is folded down to IPv4 too.
  const mapped = p('::ffff:192.168.1.0/120');
  assert.equal(mapped.family, 4);
  assert.equal(mapped.prefix, 24);
  assert.deepEqual(mapped.bytes, p('192.168.1.0/24').bytes);
  assert.equal(cidrContains(mapped, '192.168.1.5'), true);
});

test('host bits in a CIDR are masked, so 192.168.1.5/24 is 192.168.1.0/24', () => {
  assert.deepEqual(p('192.168.1.5/24').bytes, p('192.168.1.0/24').bytes);
  assert.equal(p('10.1.2.3/8').bytes[0], 10);
  assert.equal(p('10.1.2.3/8').bytes[1], 0);
});

test('a malformed range is refused rather than matching nothing', () => {
  for (const bad of ['192.168.1.0', '192.168.1.0/', '192.168.1.0/33', 'fe80::/129', 'host.example/24', '::ffff:0:0/95', '']) {
    assert.equal(p(bad), null, `${bad} must not parse`);
  }
});

// ---------------------------------------------------------------------------
// The one access decision
// ---------------------------------------------------------------------------

test('loopback is always allowed; other addresses must match a range', () => {
  const ranges = parseAllowedCidrs(['192.168.1.0/24', 'fd00::/8']);
  assert.equal(addressAllowed('127.0.0.1', ranges), true);
  assert.equal(addressAllowed('::1', ranges), true);
  assert.equal(addressAllowed('192.168.1.42', ranges), true);
  assert.equal(addressAllowed('::ffff:192.168.1.42', ranges), true);
  assert.equal(addressAllowed('fd00::99', ranges), true);
  assert.equal(addressAllowed('10.0.0.1', ranges), false);
  assert.equal(addressAllowed('192.168.2.42', ranges), false, 'a near miss is refused');
  assert.equal(addressAllowed(null, ranges), false, 'an unknown client is not trusted');
  assert.equal(addressAllowed('host.example', ranges), false);
});

test('the catch-all is detected and refused at config load, naming the reverse proxy', () => {
  assert.equal(isCatchAllCidr(p('0.0.0.0/0')), true);
  assert.equal(isCatchAllCidr(p('::/0')), true);
  assert.equal(isCatchAllCidr(p('::ffff:0.0.0.0/96')), true, 'the mapped catch-all folds to IPv4 /0');
  assert.equal(isCatchAllCidr(p('192.168.1.0/24')), false);

  for (const range of ['0.0.0.0/0', '::/0']) {
    assert.throws(
      () => validateConfig({ web_ui: { allowed_cidrs: [range] } }),
      (err) => err instanceof ConfigError && /catch-all/.test(err.message) && /reverse proxy/i.test(err.message),
      `${range} must be refused with a reverse-proxy reason`
    );
  }
});

test('#89: a set of ranges that only together cover the address space is refused too', () => {
  // The reproduction: each half passes the literal `/0` check, together they are a catch-all.
  const halves = parseAllowedCidrs(['0.0.0.0/1', '128.0.0.0/1']);
  assert.equal(halves.every((c) => !isCatchAllCidr(c)), true, 'neither half is a literal catch-all');
  assert.equal(cidrsCoverAddressSpace(halves), true, 'together they cover every IPv4 address');
  assert.equal(
    ['8.8.8.8', '203.0.113.9', '10.1.2.3'].every((a) => addressAllowed(a, halves)),
    true,
    'which is the exposure the refusal exists to stop'
  );
  assert.throws(
    () => validateConfig({ web_ui: { allowed_cidrs: ['0.0.0.0/1', '128.0.0.0/1'] } }),
    (err) => err instanceof ConfigError && /cover every address/.test(err.message),
    'the pair must be refused at config load'
  );
  // The IPv6 equivalent.
  assert.equal(cidrsCoverAddressSpace(parseAllowedCidrs(['::/1', '8000::/1'])), true);
  assert.throws(
    () => validateConfig({ web_ui: { allowed_cidrs: ['::/1', '8000::/1'] } }),
    (err) => err instanceof ConfigError && /cover every address/.test(err.message)
  );
  // A guard against "reachable from everywhere", not a width ceiling: one wide half
  // stays allowed, and a gap stays a gap.
  assert.equal(cidrsCoverAddressSpace(parseAllowedCidrs(['0.0.0.0/1'])), false);
  assert.equal(cidrsCoverAddressSpace(parseAllowedCidrs(['10.0.0.0/8', '192.168.0.0/16'])), false);
  assert.doesNotThrow(() => validateConfig({ web_ui: { allowed_cidrs: ['0.0.0.0/1'] } }));
  // Overlapping ranges that still leave a hole are not refused.
  assert.equal(cidrsCoverAddressSpace(parseAllowedCidrs(['0.0.0.0/1', '192.0.0.0/2'])), false);
});

test('a range wider than loopback is detected and warned about', () => {
  assert.equal(cidrIsWithinLoopback(p('127.0.0.0/8')), true);
  assert.equal(cidrIsWithinLoopback(p('127.0.0.1/32')), true);
  assert.equal(cidrIsWithinLoopback(p('::1/128')), true);
  assert.equal(cidrIsWithinLoopback(p('0.0.0.0/1')), false);
  assert.equal(cidrIsWithinLoopback(p('192.168.1.0/24')), false);

  assert.equal(webUiAdmitsNonLoopback({ allowed_cidrs: [] }), false, 'the default is not wider');
  assert.equal(webUiAdmitsNonLoopback({ allowed_cidrs: ['127.0.0.0/8'] }), false);
  assert.equal(webUiAdmitsNonLoopback({ allowed_cidrs: ['192.168.1.0/24'] }), true);

  const { warnings } = validateConfig({ web_ui: { allowed_cidrs: ['192.168.1.0/24'] } });
  assert.ok(
    warnings.some((w) => /beyond loopback/.test(w)),
    'a wider rule must produce a loud warning'
  );
  const loopback = validateConfig({}).warnings;
  assert.equal(loopback.some((w) => /beyond loopback/.test(w)), false, 'the default stays quiet');
});

// ---------------------------------------------------------------------------
// The Host allowlist stays explicit when the bind widens
// ---------------------------------------------------------------------------

test('a widened bind enumerates its Host names and still refuses anything else', () => {
  const bound = '192.168.1.5';
  assert.equal(isAllowedHostHeader('192.168.1.5:43871', { boundAddress: bound }), true);
  assert.equal(isAllowedHostHeader('127.0.0.1:43871', { boundAddress: bound }), true);
  assert.equal(isAllowedHostHeader('localhost:43871', { boundAddress: bound }), true);
  assert.equal(isAllowedHostHeader('evil.example:43871', { boundAddress: bound }), false);
  // #85: the name is the security-relevant part, not the port.
  assert.equal(isAllowedHostHeader('192.168.1.5:1', { boundAddress: bound }), true);
  assert.equal(isAllowedHostHeader('192.168.1.5', { boundAddress: bound }), true, 'the portless form is a valid name');

  // A configured name (a LAN hostname or reverse-proxy vhost) is admitted, with or
  // without the public port the proxy forwarded.
  assert.equal(
    isAllowedHostHeader('ui.lan:43871', { boundAddress: bound, allowedHosts: ['ui.lan'] }),
    true
  );
  assert.equal(isAllowedHostHeader('ui.lan:443', { boundAddress: bound, allowedHosts: ['ui.lan'] }), true);
  assert.equal(isAllowedHostHeader('ui.lan', { boundAddress: bound, allowedHosts: ['ui.lan'] }), true);
  assert.equal(isAllowedHostHeader('other.lan:43871', { boundAddress: bound, allowedHosts: ['ui.lan'] }), false);

  // A wildcard bind is not itself a Host anyone types.
  assert.equal(isAllowedHostHeader('0.0.0.0:43871', { boundAddress: '0.0.0.0' }), false);
  assert.equal(isAllowedHostHeader('192.168.1.5:43871', { boundAddress: '0.0.0.0', allowedHosts: ['192.168.1.5'] }), true);
});

// ---------------------------------------------------------------------------
// The credential verifier
// ---------------------------------------------------------------------------

test('the credential is stored as a salt + scrypt verifier, never the password', () => {
  const verifier = hashWebUiPassword('correct horse battery staple');
  assert.match(verifier, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(verifier.includes('correct horse battery staple'), false, 'the password is not in the verifier');
  assert.equal(verifyWebUiPassword('correct horse battery staple', verifier), true);
  assert.equal(verifyWebUiPassword('wrong password', verifier), false);
  assert.equal(verifyWebUiPassword('', verifier), false);
});

test('a fresh salt makes two verifiers of the same password differ', () => {
  const a = hashWebUiPassword('same-password');
  const b = hashWebUiPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(verifyWebUiPassword('same-password', a), true);
  assert.equal(verifyWebUiPassword('same-password', b), true);
});

test('a password key in config.toml is refused by the secret guard (#65)', () => {
  assert.throws(
    () => validateConfig({ web_ui: { password: 'hunter2' } }),
    (err) => err instanceof ConfigError && /looks like a secret/.test(err.message),
    'the credential must never be representable in config.toml'
  );
});

test('a malformed or tampered verifier fails closed, never throws', () => {
  assert.equal(verifyWebUiPassword('x', ''), false);
  assert.equal(verifyWebUiPassword('x', null), false);
  assert.equal(verifyWebUiPassword('x', 'not-a-verifier'), false);
  const verifier = hashWebUiPassword('secret');
  const [algo, n, r, pp, salt, hash] = verifier.split('$');
  // Flip a high bit (the first hash character) so the decoded bytes really differ; a
  // trailing base64 character can encode only padding bits and decode identically.
  const flipped = `${hash[0] === 'A' ? 'B' : 'A'}${hash.slice(1)}`;
  assert.equal(verifyWebUiPassword('secret', [algo, n, r, pp, salt, flipped].join('$')), false);
  const otherSalt = Buffer.alloc(16, 7).toString('base64url');
  assert.equal(verifyWebUiPassword('secret', [algo, n, r, pp, otherSalt, hash].join('$')), false);
});
