/**
 * In-memory rate and failed-auth limiters, kept in a leaf module.
 *
 * These live apart from `server.js` so `src/ui/web-config.js` can reuse the exact
 * backoff from #47 on its login path without importing the image gate (which drags
 * `sharp` in). `server.js` re-exports them, so its public surface is unchanged.
 * In-memory is deliberate: one process, low volume.
 */

/** Fixed-window per-client limiter (DESIGN 3). */
export function createRateLimiter({ limit, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    take(key) {
      // `rate_limit_per_min = 0` means disabled, not "allow one then refuse".
      if (!(limit > 0)) return { allowed: true, remaining: null, retryAfterSec: 0 };
      const at = now();
      const entry = hits.get(key);
      if (!entry || at - entry.start >= windowMs) {
        hits.set(key, { start: at, count: 1 });
        return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSec: 0 };
      }
      if (entry.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000)),
        };
      }
      entry.count += 1;
      return { allowed: true, remaining: Math.max(0, limit - entry.count), retryAfterSec: 0 };
    },
    size: () => hits.size,
  };
}

/**
 * Bounded failed-auth throttle, per client (#47).
 *
 * The request limiter only runs after a token check, so before this a caller could
 * hammer 401s forever. After `limit` failures the client is blocked for a backoff
 * that doubles with each further trip (1s, 2s, 4s … capped), and a success clears
 * the record so a user who finally types the right token is not locked out. In-memory
 * like the rate limiter: one process, low volume.
 */
export const DEFAULT_AUTH_FAILURE_LIMIT = 5;

export function createAuthThrottle({
  limit = DEFAULT_AUTH_FAILURE_LIMIT,
  windowMs = 60_000,
  baseBackoffSec = 1,
  maxBackoffSec = 900,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const blocked = (entry, at) => entry.blockedUntil > at;
  const retryAfter = (entry, at) => Math.max(1, Math.ceil((entry.blockedUntil - at) / 1000));
  return {
    /** Check before the token comparison so a blocked client never reaches the compare. */
    check(key) {
      const at = now();
      const entry = entries.get(key);
      if (!entry || !blocked(entry, at)) return { allowed: true, retryAfterSec: 0 };
      return { allowed: false, retryAfterSec: retryAfter(entry, at) };
    },
    /** Record a failed attempt; the trip itself already returns `allowed: false`. */
    fail(key) {
      const at = now();
      let entry = entries.get(key);
      if (!entry || (entry.blockedUntil <= at && at - entry.windowStart >= windowMs)) {
        entry = { count: 0, windowStart: at, blockedUntil: 0, trips: 0 };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entry.count < limit) return { allowed: true, retryAfterSec: 0 };
      entry.trips += 1;
      const backoff = Math.min(maxBackoffSec, baseBackoffSec * 2 ** (entry.trips - 1));
      entry.blockedUntil = at + backoff * 1000;
      entry.count = 0;
      entry.windowStart = at;
      return { allowed: false, retryAfterSec: backoff };
    },
    succeed(key) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
}
