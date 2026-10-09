/**
 * Access control for the web UI (issue #65).
 *
 * The web UI is an oracle: it can write the config, spend provider credits and burn
 * CPU. #56 bound it to loopback and stopped there; this module is the *one* control
 * that decides who may reach any of its pages, so a page added later cannot ship with
 * a weaker rule by accident.
 *
 * Three traps from earlier issues are designed out here, not merely avoided:
 *
 *  - **Numerical, never prefix.** `isLoopbackHost('127.evil.example')` was true in
 *    #47 because it compared a string prefix. Addresses are parsed to bytes and
 *    compared bit by bit, so a hostname that starts with `127.` is not an address.
 *  - **IPv4-mapped IPv6 is normalised.** `::ffff:192.168.1.5` and `192.168.1.5` are
 *    the same host; comparing the raw 16-byte form against an IPv4 CIDR would fail
 *    and silently bypass an allowlist. A mapped address *and* a mapped CIDR are both
 *    folded down to IPv4.
 *  - **The caller never supplies the address.** `addressAllowed` is given the socket
 *    remote address by the server. `X-Forwarded-For` is not read anywhere here.
 *
 * The credential half (`hashWebUiPassword` / `verifyWebUiPassword`) uses `node:crypto`
 * scrypt and a constant-time comparison. A verifier - salt plus hash - is what is
 * stored, never the password, so a leaked credential store does not reveal the input.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Where the remote-access credential lives in the credential store. */
export const WEB_UI_CREDENTIAL_KEY = 'web_ui_password_hash';
/** The settings id an operator uses to set it. Named in the refusal message. */
export const WEB_UI_CREDENTIAL_SETTING = 'web_ui.password';

/** scrypt parameters. 16 MiB of memory per derivation, one derivation per login. */
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 });

function parseIpv4(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4) return null;
  const bytes = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > 255) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIpv6(text) {
  let work = String(text).toLowerCase();
  if (work.includes('%')) return null; // a zone id is scope, not an address
  // An embedded IPv4 tail (`::ffff:192.168.1.5`) becomes two hex groups.
  const lastColon = work.lastIndexOf(':');
  const tail = lastColon === -1 ? '' : work.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return null;
    work = `${work.slice(0, lastColon + 1)}${v4.readUInt16BE(0).toString(16)}:${v4.readUInt16BE(2).toString(16)}`;
  }
  const halves = work.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tailGroups = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && head.length + tailGroups.length > 7) return null;
  const groups = [];
  for (const group of head) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups.length;
    for (let i = 0; i < fill; i++) groups.push(0);
  }
  for (const group of tailGroups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    groups.push(parseInt(group, 16));
  }
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) bytes.writeUInt16BE(groups[i], i * 2);
  return bytes;
}

/** True when 16 bytes are the `::ffff:a.b.c.d` mapped form. */
function isMappedBytes(bytes) {
  if (bytes.length !== 16) return false;
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return false;
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

/**
 * Parse one address literal to `{ family, bytes }`, or `null`.
 *
 * An IPv4-mapped IPv6 address is returned as family 4 with its 4-byte form, so two
 * spellings of the same host compare equal. A hostname is not an address and never
 * parses - that is the #47 fix.
 */
/**
 * Parse an address without folding the mapped form. `parseCidr` needs the 16-byte
 * view to know that `/120` means 24 IPv4 bits; `parseIp` folds for comparison.
 */
function parseIpRaw(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === '') return null;
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (bare.includes(':')) {
    const bytes = parseIpv6(bare);
    return bytes ? { family: 6, bytes } : null;
  }
  const bytes = parseIpv4(bare);
  return bytes ? { family: 4, bytes } : null;
}

/**
 * Parse one address literal to `{ family, bytes }`, or `null`.
 *
 * An IPv4-mapped IPv6 address is returned as family 4 with its 4-byte form, so two
 * spellings of the same host compare equal. A hostname is not an address and never
 * parses - that is the #47 fix.
 */
export function parseIp(value) {
  const parsed = parseIpRaw(value);
  if (!parsed) return null;
  if (parsed.family === 6 && isMappedBytes(parsed.bytes)) return { family: 4, bytes: parsed.bytes.subarray(12) };
  return parsed;
}

function maskBytes(bytes, prefix) {
  const out = Buffer.from(bytes);
  const full = Math.floor(prefix / 8);
  const rem = prefix % 8;
  if (rem) {
    const mask = (0xff << (8 - rem)) & 0xff;
    out[full] &= mask;
    for (let i = full + 1; i < out.length; i++) out[i] = 0;
  } else {
    for (let i = full; i < out.length; i++) out[i] = 0;
  }
  return out;
}

/**
 * Parse `192.168.1.0/24` or `fd00::/8` to `{ family, bytes, prefix, text }`, or `null`.
 * The host bits are masked, so the network address is what is compared - a config
 * entry of `192.168.1.5/24` behaves exactly like `192.168.1.0/24`.
 */
export function parseCidr(value) {
  const raw = String(value ?? '').trim();
  const slash = raw.indexOf('/');
  if (slash === -1) return null;
  const [addressPart, prefixPart] = [raw.slice(0, slash), raw.slice(slash + 1)];
  if (prefixPart === '' || !/^\d+$/.test(prefixPart)) return null;
  const prefix = Number(prefixPart);
  const address = parseIpRaw(addressPart);
  if (!address) return null;
  if (address.family === 4) {
    if (prefix > 32) return null;
    return { family: 4, bytes: maskBytes(address.bytes, prefix), prefix, text: raw };
  }
  if (prefix > 128) return null;
  // A mapped CIDR (`::ffff:192.168.1.0/120`) is the IPv4 range with 96 bits of prefix
  // folded away. A prefix that does not cover the whole mapped block is ambiguous and
  // refused rather than half-matched. `::ffff:0.0.0.0/96` folds to IPv4 `/0`, which the
  // catch-all check then refuses.
  if (isMappedBytes(address.bytes)) {
    if (prefix < 96) return null;
    return { family: 4, bytes: maskBytes(address.bytes.subarray(12), prefix - 96), prefix: prefix - 96, text: raw };
  }
  return { family: 6, bytes: maskBytes(address.bytes, prefix), prefix, text: raw };
}

/** True when every address in the range is loopback. */
export function cidrIsWithinLoopback(cidr) {
  if (!cidr) return false;
  if (cidr.family === 4) return cidr.prefix >= 8 && cidr.bytes[0] === 127;
  if (cidr.prefix < 128) return false;
  for (let i = 0; i < 15; i++) if (cidr.bytes[i] !== 0) return false;
  return cidr.bytes[15] === 1;
}

/** True when the range is the catch-all (`0.0.0.0/0` or `::/0`). */
export function isCatchAllCidr(cidr) {
  return Boolean(cidr) && cidr.prefix === 0;
}

/** True when `address` is numerically loopback (`127.0.0.0/8`, `::1`). */
export function isLoopbackAddress(address) {
  const parsed = parseIp(address);
  if (!parsed) return false;
  if (parsed.family === 4) return parsed.bytes[0] === 127;
  for (let i = 0; i < 15; i++) if (parsed.bytes[i] !== 0) return false;
  return parsed.bytes[15] === 1;
}

/** True when `address` falls inside `cidr`. Families must match after normalisation. */
export function cidrContains(cidr, address) {
  const parsed = parseIp(address);
  if (!cidr || !parsed || parsed.family !== cidr.family) return false;
  const full = Math.floor(cidr.prefix / 8);
  const rem = cidr.prefix % 8;
  for (let i = 0; i < full; i++) if (parsed.bytes[i] !== cidr.bytes[i]) return false;
  if (rem) {
    const mask = (0xff << (8 - rem)) & 0xff;
    if ((parsed.bytes[full] & mask) !== (cidr.bytes[full] & mask)) return false;
  }
  return true;
}

/**
 * The single decision: may `remoteAddress` reach the web UI?
 *
 * Loopback is always allowed and is the default rule. Anything else must fall inside
 * one of the configured ranges. A missing or unparseable address is refused - an
 * unknown client is not a trusted one.
 */
export function addressAllowed(remoteAddress, ranges = []) {
  if (isLoopbackAddress(remoteAddress)) return true;
  return ranges.some((range) => cidrContains(range, remoteAddress));
}

/** Parse the configured range strings, dropping entries that do not parse. */
export function parseAllowedCidrs(list) {
  return (Array.isArray(list) ? list : []).map((entry) => parseCidr(entry)).filter(Boolean);
}

/** True when the effective access rule admits any non-loopback address. */
export function webUiAdmitsNonLoopback(webUi) {
  return parseAllowedCidrs(webUi?.allowed_cidrs).some((cidr) => !cidrIsWithinLoopback(cidr));
}

/** Normalise one `allowed_hosts` entry (or a Host header component) for comparison. */
export function normalizeHostEntry(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * The web UI's DNS-rebinding defence, widened for a non-loopback bind.
 *
 * A session cookie/URL token is scoped to a *hostname*: a malicious page whose name
 * resolves to the UI's LAN address would have the browser send that name in `Host`
 * and its cookie along with it. Accepting any `Host` reopens exactly that attack, so
 * the legitimate names stay **explicitly enumerated**: loopback names, the concrete
 * bound address, and whatever the operator listed in `web_ui.allowed_hosts`
 * (default deny). Widening the bind does not loosen this.
 */
export function isAllowedHostHeader(hostHeader, port, { boundAddress = null, allowedHosts = [] } = {}) {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false;
  if (!Number.isInteger(Number(port)) || Number(port) <= 0) return false;
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostHeader.trim().toLowerCase());
  if (!match) return false;
  if (Number(match[2]) !== Number(port)) return false;
  const host = normalizeHostEntry(match[1].replace(/^\[|\]$/g, ''));
  const allowed = new Set(['127.0.0.1', 'localhost', '::1']);
  // A wildcard bind is not a name anyone can put in a Host header, so it is not
  // added; the operator must list the name they actually type.
  if (boundAddress && boundAddress !== '0.0.0.0' && boundAddress !== '::') {
    allowed.add(normalizeHostEntry(boundAddress));
  }
  for (const entry of allowedHosts) allowed.add(normalizeHostEntry(entry));
  return allowed.has(host);
}

/** A fresh scrypt verifier string for `password`. The password itself is discarded. */
export function hashWebUiPassword(password, { salt = randomBytes(16), params = SCRYPT } = {}) {
  const derived = scryptSync(String(password), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: params.maxmem,
  });
  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Constant-time check of a submitted password against a stored verifier.
 *
 * Returns false for a malformed verifier rather than throwing, and the caller must
 * not distinguish "no password" from "wrong password" in what it says.
 */
export function verifyWebUiPassword(password, verifier) {
  if (typeof verifier !== 'string' || verifier === '') return false;
  const parts = verifier.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltRaw, 'base64url');
    expected = Buffer.from(hashRaw, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = scryptSync(String(password), salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
