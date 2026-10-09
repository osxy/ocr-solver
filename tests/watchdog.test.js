/**
 * Watchdog tests. The clock is a number, so the 10-minute rule is tested by
 * advancing it rather than sleeping - and every assertion is on the edge, not in the
 * comfortable middle.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWatchdog, iconState, DEFAULT_QUIET_MS } from '../src/ui/watchdog.js';

test('the quiet window is the documented 10 minutes', () => {
  assert.equal(DEFAULT_QUIET_MS, 10 * 60 * 1000);
});

test('a watchdog is not quiet while activity is recent', () => {
  let t = 1_000_000;
  const wd = createWatchdog({ now: () => t, quietMs: 600_000 });
  assert.equal(wd.check(), false);
  t += 599_999;
  assert.equal(wd.check(), false, 'just under the window must stay alive');
});

test('exactly the quiet window is still alive; a millisecond more is quiet', () => {
  let t = 0;
  const wd = createWatchdog({ now: () => t, quietMs: 600_000 });
  t = 600_000; // lastActivityAt was 0 at construction
  assert.equal(wd.check(), false, 'the boundary is exclusive');
  t = 600_001;
  assert.equal(wd.check(), true);
});

test('activity clears quiet and resets the countdown', () => {
  let t = 0;
  const wd = createWatchdog({ now: () => t, quietMs: 100 });
  t = 200;
  assert.equal(wd.check(), true);
  wd.noteActivity(t);
  assert.equal(wd.quiet, false, 'fresh evidence clears grey immediately');
  t = 250;
  assert.equal(wd.check(), false, 'the countdown restarted from the activity');
  t = 301;
  assert.equal(wd.check(), true, 'and runs out again one window later');
});

test('noteActivity never moves the clock backwards', () => {
  let t = 1_000;
  const wd = createWatchdog({ now: () => t, quietMs: 100 });
  wd.noteActivity(t);
  wd.noteActivity(1); // a stale event from a scrambled source
  assert.equal(wd.lastActivityAt, 1_000, 'an older event is ignored');
});

test('onStateChange fires exactly once per edge', () => {
  let t = 0;
  const seen = [];
  const wd = createWatchdog({ now: () => t, quietMs: 100, onStateChange: (c) => seen.push(c.state) });
  t = 101;
  assert.equal(wd.check(), true);
  assert.equal(wd.check(), true, 'repeat checks must not re-fire');
  wd.noteActivity(t);
  assert.equal(wd.check(), false);
  assert.deepEqual(seen, ['quiet', 'alive']);
});

test('iconState is grey only when quiet', () => {
  assert.equal(iconState(true), 'grey');
  assert.equal(iconState(false), 'normal');
});

test('a non-positive quiet window is rejected rather than made to mean "always quiet"', () => {
  assert.throws(() => createWatchdog({ quietMs: 0 }), /quietMs must be > 0/);
});
