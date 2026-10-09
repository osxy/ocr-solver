/**
 * Notification tests. `node-notifier` is never loaded - the module is injected - so
 * this proves the lazy import, the never-throw guarantee and the redaction path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createNotifier } from '../src/ui/notifications.js';

test('the backend is not loaded until the first notification', async () => {
  let loads = 0;
  const notifier = createNotifier({ loadModule: async () => { loads += 1; return { default: { notify() {} } }; } });
  assert.equal(loads, 0, 'constructing a notifier must not import anything');
  await notifier.notify({ title: 'a', message: 'b' });
  assert.equal(loads, 1);
  await notifier.notify({ title: 'c', message: 'd' });
  assert.equal(loads, 1, 'the backend is resolved once');
});

test('an available backend receives the toast', async () => {
  const toasts = [];
  const notifier = createNotifier({ loadModule: async () => ({ default: { notify: (n) => toasts.push(n) } }) });
  const result = await notifier.notify({ title: 'PuzzleSolver', message: '2' });
  assert.deepEqual(result, { shown: true });
  assert.deepEqual(toasts, [{ title: 'PuzzleSolver', message: '2', sound: false }]);
});

test('a missing backend falls back to the log and does not throw', async () => {
  const logged = [];
  const notifier = createNotifier({
    loadModule: async () => { throw new Error('MODULE_NOT_FOUND'); },
    logger: { info: (...a) => logged.push(a.join(' ')), debug() {}, warn() {} },
  });
  const result = await notifier.notify({ title: 'PuzzleSolver', message: 'unresolved' });
  assert.equal(result.shown, false);
  assert.equal(result.reason, 'unavailable');
  assert.ok(logged.some((l) => l.includes('unresolved')), 'the message is still visible somewhere');
});

test('a backend that throws is swallowed - a toast must never break solving', async () => {
  const notifier = createNotifier({
    loadModule: async () => ({ default: { notify: () => { throw new Error('no display'); } } }),
    logger: { info() {}, debug() {}, warn() {} },
  });
  const result = await notifier.notify({ title: 'a', message: 'b' });
  assert.equal(result.shown, false);
  assert.equal(result.reason, 'error');
});

test('a secret in a notification is redacted', async () => {
  const toasts = [];
  const notifier = createNotifier({ loadModule: async () => ({ default: { notify: (n) => toasts.push(n) } }) });
  await notifier.notify({ title: 'x', message: 'key sk-abcdefghijklmnopqrstuvwxyz was rejected' });
  assert.equal(toasts[0].message.includes('sk-abcdefghijklmnopqrstuvwxyz'), false);
  assert.ok(toasts[0].message.includes('sk-abc…'), toasts[0].message);
});
