/**
 * HTTP ingress defaults, kept in a leaf module with no heavy imports.
 *
 * `config.js` needs these to build the `[http]` schema, and importing them from
 * `server.js` would drag `sharp` (via the image gate) into config loading. A leaf
 * module keeps the default in one place without that cost.
 */
import { isIP } from 'node:net';

export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_HTTP_BIND = '127.0.0.1';
export const DEFAULT_RATE_LIMIT_PER_MIN = 20;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
// HTTP requests admitted (running or waiting on the shared solve lock) at once. The
// rate limit bounds admission per minute; this bounds the backlog behind one worker,
// so a caller with retry-on-504 logic cannot queue work that outlives its own wait
// (issue #43). Eight is one running solve plus a short burst of waiters.
export const DEFAULT_MAX_QUEUE = 8;
export const SOLVE_PATH = '/v1/solve';

// `image_url` is a caller-supplied fetch (SSRF). Off by default and, when on, the
// host must be named in `http.image_url_hosts`. The host list is the control: the
// operator chooses the names, so DNS rebinding of a name they did not choose is
// irrelevant. See DESIGN §8 for the decision and the residual limitation.
export const DEFAULT_ALLOW_IMAGE_URL = false;
export const DEFAULT_IMAGE_URL_HOSTS = [];

/**
 * Normalise a hostname for allowlist comparison.
 *
 * WHATWG `URL.hostname` already lowercases and punycodes; this additionally removes
 * the brackets around an IPv6 literal and one trailing dot (the FQDN root). Both
 * `example.com.` and `example.com` are the same host.
 */
export function normalizeImageUrlHost(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Describe why an allowlist entry is unusable, or `null` if it is fine.
 *
 * A bare host or IP literal only: no scheme, path, wildcard or port. `host:port` is
 * refused rather than silently failing to match, because a config entry that never
 * matches is a locked door the operator thinks is open.
 */
export function imageUrlHostProblem(entry) {
  const raw = typeof entry === 'string' ? entry.trim() : '';
  if (raw === '') return 'must not be empty';
  if (/[\s/@?#*]/.test(raw)) return 'must be a bare host, without a scheme, path or wildcard';
  const bare = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  if (bare.includes(':') && isIP(bare) !== 6) return 'must be a bare host, not host:port';
  return null;
}

/**
 * True when `urlOrHost`'s host is in `hosts` by exact match (case, brackets and a
 * trailing dot normalised away).
 *
 * Exact, not suffix: allowlisting `example.com` must not admit `evil.example.com`.
 * The port is ignored - the entry names a host, and the host is the trust boundary.
 */
export function imageUrlHostAllowed(urlOrHost, hosts) {
  const host = normalizeImageUrlHost(
    urlOrHost && typeof urlOrHost === 'object' && 'hostname' in urlOrHost ? urlOrHost.hostname : urlOrHost
  );
  if (!host || !Array.isArray(hosts)) return false;
  return hosts.some((entry) => normalizeImageUrlHost(entry) === host);
}

/** Minimum HTTP bearer token length (#47). Long enough that guessing is hopeless. */
export const MIN_HTTP_TOKEN_LENGTH = 16;

// Values that are common enough to be guessed before the first request. Case-insensitive.
const WEAK_TOKENS = new Set([
  'changeme',
  'password',
  'secret',
  'token',
  'admin',
  'test',
  'letmein',
  'default',
  'http-auth-token',
  'bearer',
]);

/**
 * Describe why an HTTP bearer token is unfit to guard the solver, or `null` if it is fine.
 *
 * This lives in the leaf `defaults` module rather than `server.js` so the settings
 * editor can validate a token **before** storing it without dragging `sharp` (via the
 * image gate) into config/editor loading. `server.js` re-exports it, so there is one
 * implementation, not a second drifting opinion.
 */
export function httpTokenProblem(token) {
  const value = typeof token === 'string' ? token : '';
  if (value.trim() === '') return 'the token is empty';
  if (WEAK_TOKENS.has(value.toLowerCase())) return 'the token is a well-known weak value';
  if (value.length < MIN_HTTP_TOKEN_LENGTH) {
    return `the token is ${value.length} character(s); at least ${MIN_HTTP_TOKEN_LENGTH} are required (try \`openssl rand -hex 24\`)`;
  }
  if (new Set(value).size < 4) return 'the token has too little variation to resist guessing';
  return null;
}
