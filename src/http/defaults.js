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
