/**
 * Listen-quiet watchdog.
 *
 * The failure it exists to make visible: the Pushbullet stream can die without
 * firing `close` (a dropped NAT mapping, a suspended laptop resuming), and the
 * poll fallback can fail silently. A tray app that looks healthy while nothing is
 * arriving is worse than one that admits it - so after `quietMs` with no evidence
 * that the listener did anything, the tray icon goes grey.
 *
 * This module is pure and platform-free: it holds no widget and no timer, takes an
 * injectable clock, and only reports state. The tray adapter owns the timer and the
 * pixels, which is what lets the 10-minute rule be tested on Linux by advancing a
 * number instead of waiting.
 *
 * Activity is *evidence*, not a heartbeat sent for its own sake: callers feed in the
 * listener's last successful poll/stream event with `noteActivity`. `noteActivity(0)`
 * from a listener that has never heard anything must not count as fresh, so the
 * watchdog seeds itself with `now()` at construction and only ever moves forward.
 */

export const DEFAULT_QUIET_MS = 10 * 60 * 1000;

export const WATCHDOG_STATES = ['alive', 'quiet'];

/**
 * @param {object} options
 * @param {() => number} [options.now] epoch milliseconds
 * @param {number} [options.quietMs] how long without activity before "quiet"
 * @param {(change: {state: string, quiet: boolean, since: number|null}) => void} [options.onStateChange]
 */
export function createWatchdog({ now = () => Date.now(), quietMs = DEFAULT_QUIET_MS, onStateChange = null } = {}) {
  if (!(quietMs > 0)) throw new Error(`quietMs must be > 0, got ${quietMs}`);

  let lastActivityAt = now();
  let quiet = false;

  function setQuiet(next, reason) {
    if (next === quiet) return;
    quiet = next;
    onStateChange?.({
      state: quiet ? 'quiet' : 'alive',
      quiet,
      // `since` is how long the opposite state lasted, useful for a log line.
      since: Math.max(0, now() - lastActivityAt),
      reason,
    });
  }

  return {
    /** Record evidence the listener is doing something. Never moves backwards. */
    noteActivity(at = now()) {
      const value = Number(at);
      if (!Number.isFinite(value) || value <= lastActivityAt) return;
      lastActivityAt = value;
      // Fresh evidence clears grey immediately, without waiting for the next check.
      if (quiet) setQuiet(false, 'activity');
    },
    /** Evaluate the rule. Returns true while quiet; fires `onStateChange` on edges. */
    check() {
      const isQuiet = now() - lastActivityAt > quietMs;
      setQuiet(isQuiet, 'timeout');
      return quiet;
    },
    get quiet() {
      return quiet;
    },
    get lastActivityAt() {
      return lastActivityAt;
    },
    get quietMs() {
      return quietMs;
    },
  };
}

/** Map watchdog state to the tray icon name; the adapter owns the actual bitmap. */
export function iconState(quiet) {
  return quiet ? 'grey' : 'normal';
}
