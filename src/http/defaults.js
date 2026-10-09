/**
 * HTTP ingress defaults, kept in a leaf module with no heavy imports.
 *
 * `config.js` needs these to build the `[http]` schema, and importing them from
 * `server.js` would drag `sharp` (via the image gate) into config loading. A leaf
 * module keeps the default in one place without that cost.
 */
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
