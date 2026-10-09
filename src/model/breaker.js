/**
 * Circuit breaker for one model tier.
 *
 * The layer above the per-call retries. When a provider is down, retrying per puzzle
 * is merely wasteful now and becomes a problem once the app answers unattended
 * traffic. The breaker bounds that: after `threshold` consecutive failures the tier
 * is `open`, calls are skipped entirely, and Tier 0 keeps answering.
 *
 * Design points that matter:
 *
 *  - **`open` / `half-open` / `closed` per tier.** Text and vision fail for different
 *    reasons (routing vs image handling), so a dead text model must not disable
 *    vision.
 *  - **The clock is injectable.** A 10-minute cooldown is the default, so tests must
 *    advance a clock rather than sleep for ten minutes. Nothing here calls `setTimeout`.
 *  - **Permanent failures trip immediately.** A 401/403 (bad key), a 404 (unknown
 *    model or an `allowed_models` set that matched nothing) and a bad cost tier do not
 *    fix themselves. Waiting for N of them only delays the error; the breaker opens on
 *    the first.
 *  - **`half-open` admits exactly one probe.** If it succeeds the tier closes; if it
 *    fails the cooldown restarts. That is what makes recovery automatic without a
 *    thundering herd of retries.
 */

export const BREAKER_STATES = ['closed', 'open', 'half-open'];
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

export class CircuitOpenError extends Error {
  constructor(name, stats) {
    super(`circuit breaker open for ${name}`);
    this.name = 'CircuitOpenError';
    this.breaker = name;
    this.stats = stats;
    this.retryable = false;
    this.permanent = false;
  }
}

/**
 * Classify a thrown model error.
 *
 * Permanent means "will not fix itself": wrong credentials, an unknown model, or a
 * configuration error such as an unknown cost tier. Everything else (timeouts, 429s
 * and 5xx) is transient and gets the full failure budget.
 */
export function isPermanentFailure(err) {
  if (!err) return false;
  if (err.permanent === true) return true;
  const status = Number(err.status);
  if (status === 401 || status === 403 || status === 404) return true;
  const text = `${err.message ?? ''} ${err.body ?? ''}`.toLowerCase();
  return /unknown cost tier|invalid cost tier|unknown model|model not found|does not exist|no allowed model/.test(text);
}

/**
 * @param {object}   options
 * @param {string}   [options.name]        tier name, used in logs and state records
 * @param {number}   [options.threshold]   consecutive transient failures before it trips
 * @param {number}   [options.cooldownMs]  how long `open` lasts before a probe
 * @param {Function} [options.now]         injectable clock (ms since epoch)
 * @param {Function} [options.onStateChange] called on every transition
 * @param {Function} [options.onTrip]      called once when the breaker opens
 */
export function createCircuitBreaker({
  name = 'model',
  threshold = DEFAULT_FAILURE_THRESHOLD,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  now = Date.now,
  onStateChange = null,
  onTrip = null,
} = {}) {
  if (!Number.isFinite(threshold) || threshold < 1) {
    throw new Error(`breaker threshold must be a positive integer, got ${threshold}`);
  }
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error(`breaker cooldownMs must be >= 0, got ${cooldownMs}`);
  }

  let state = 'closed';
  let failures = 0;
  let openedAt = null;
  let probeInFlight = false;
  let lastError = null;

  function transition(next, reason) {
    if (state === next) return;
    const from = state;
    state = next;
    onStateChange?.({ name, from, to: next, reason, failures, at: now() });
  }

  function trip(reason) {
    failures = failures || threshold;
    // Only a real transition to `open` notifies. Repeated failures while already
    // open must not produce a notification per puzzle - that is the bug the issue
    // calls out explicitly.
    const changed = state !== 'open';
    transition('open', reason);
    openedAt = now();
    probeInFlight = false;
    if (changed) onTrip?.({ name, reason, failures, error: lastError, openedAt });
  }

  /** Resolve `open` -> `half-open` lazily, so no timer is ever involved. */
  function currentState() {
    if (state === 'open' && openedAt != null && now() - openedAt >= cooldownMs) {
      transition('half-open', 'cooldown elapsed');
      probeInFlight = false;
    }
    return state;
  }

  return {
    name,
    threshold,
    cooldownMs,
    state: currentState,

    /** True when a call may proceed. In `half-open` only the first caller gets through. */
    allow() {
      const current = currentState();
      if (current === 'closed') return true;
      if (current === 'half-open') {
        if (probeInFlight) return false;
        probeInFlight = true;
        return true;
      }
      return false;
    },

    /** A successful call closes the breaker and clears the failure count. */
    success() {
      failures = 0;
      lastError = null;
      probeInFlight = false;
      transition('closed', 'call succeeded');
    },

    /**
     * Record a failure. `permanent` failures trip on the first occurrence; transient
     * ones trip once `threshold` have accumulated, and a failed half-open probe
     * reopens the breaker immediately.
     */
    failure({ permanent = false, error = null } = {}) {
      lastError = error;
      failures += 1;
      probeInFlight = false;
      if (permanent) {
        trip(error?.message ? `permanent failure: ${error.message}` : 'permanent failure');
        return;
      }
      if (state === 'half-open') {
        trip('half-open probe failed');
        return;
      }
      if (failures >= threshold) trip(`${failures} consecutive failures`);
    },

    stats() {
      return { name, state: currentState(), failures, openedAt, threshold, cooldownMs };
    },

    reset() {
      state = 'closed';
      failures = 0;
      openedAt = null;
      probeInFlight = false;
      lastError = null;
    },
  };
}
