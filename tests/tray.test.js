/**
 * Tray menu tests. No `systray2`, no display: the controller is pure, so every
 * action is driven directly and asserted on its effects and return value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTrayController, TRAY_MENU } from '../src/ui/tray.js';
import { createWatchdog, DEFAULT_QUIET_MS } from '../src/ui/watchdog.js';
import { resolveTrayMode } from '../src/ui/mode.js';
import { openPathCommand } from '../src/ui/open-path.js';

function fakeListener(overrides = {}) {
  return {
    started: true,
    startedCount: 0,
    stoppedCount: 0,
    status: () => ({ connected: true, lastActivityAt: 1_000, watermark: 4, reasoner: 'model', reply: true, ...overrides.status }),
    stop() {
      this.stoppedCount += 1;
      this.started = false;
    },
    start() {
      this.startedCount += 1;
      this.started = true;
      return { connected: true };
    },
  };
}

test('the menu is the seven documented actions, in order', () => {
  assert.deepEqual(
    TRAY_MENU.map((i) => i.id),
    ['status', 'accuracy', 'pause', 'solve-last', 'open-log', 'open-config', 'quit']
  );
  assert.deepEqual(TRAY_MENU.map((i) => i.title), [
    'Status',
    'Accuracy',
    'Pause',
    'Solve last image',
    'Open log',
    'Open config',
    'Quit',
  ]);
});

test('the controller returns a fresh menu each time (the adapter must not mutate ours)', () => {
  const c = createTrayController({ listener: fakeListener(), watchdog: createWatchdog({ quietMs: DEFAULT_QUIET_MS }) });
  const first = c.menu();
  first[0].title = 'mutated';
  assert.equal(c.menu()[0].title, 'Status');
});

test('pause toggles the menu title and stops then starts the listener', async () => {
  const listener = fakeListener();
  const c = createTrayController({ listener, watchdog: createWatchdog() });

  assert.equal(c.menu().find((i) => i.id === 'pause').title, 'Pause');
  await c.handleClick('pause');
  assert.equal(listener.stoppedCount, 1, 'pausing must actually stop the listener');
  assert.equal(c.paused, true);
  assert.equal(c.menu().find((i) => i.id === 'pause').title, 'Resume');

  await c.handleClick('pause');
  assert.equal(listener.startedCount, 1, 'resuming must start it again');
  assert.equal(c.paused, false);
  assert.equal(c.menu().find((i) => i.id === 'pause').title, 'Pause');
});

test('status reports the listener connection and pause state, not a constant', async () => {
  const listener = fakeListener({ status: { connected: false } });
  const c = createTrayController({ listener, watchdog: createWatchdog() });
  assert.match(c.statusText(), /reconnecting/);
  await c.handleClick('pause');
  assert.equal(c.statusText(), 'PuzzleSolver: paused');
  const result = await c.handleClick('status');
  assert.equal(result.text, 'PuzzleSolver: paused');
});

test('solve-last delegates, returns the answer and notifies', async () => {
  const calls = [];
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    solveLastImage: async () => {
      calls.push('solve');
      return { answer: '7', imagePath: '/inbox/x.png' };
    },
    notify: async (n) => calls.push(['notify', n.title, n.message]),
  });
  const result = await c.handleClick('solve-last');
  assert.equal(result.solved, true);
  assert.equal(result.answer, '7');
  assert.deepEqual(calls, ['solve', ['notify', 'PuzzleSolver: solved', '7']]);
});

test('solve-last reports an unavailable callback rather than throwing', async () => {
  const c = createTrayController({ listener: fakeListener(), watchdog: createWatchdog() });
  assert.deepEqual(await c.handleClick('solve-last'), { id: 'solve-last', solved: false, reason: 'unavailable' });
});

test('solve-last survives a throwing solver', async () => {
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    solveLastImage: async () => {
      throw new Error('OCR exploded');
    },
  });
  const result = await c.handleClick('solve-last');
  assert.equal(result.solved, false);
  assert.equal(result.reason, 'error');
});

test('open-log and open-config pass the real resolved paths to the opener', async () => {
  const opened = [];
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    paths: { log: 'C:\\Users\\a\\AppData\\Local\\PuzzleSolver\\logs\\app.log', config: 'C:\\Users\\a\\AppData\\Roaming\\PuzzleSolver\\config.toml' },
    openPath: async (p) => opened.push(p),
  });
  await c.handleClick('open-log');
  await c.handleClick('open-config');
  assert.deepEqual(opened, [
    'C:\\Users\\a\\AppData\\Local\\PuzzleSolver\\logs\\app.log',
    'C:\\Users\\a\\AppData\\Roaming\\PuzzleSolver\\config.toml',
  ]);
});

test('quit forwards exactly once', async () => {
  let quits = 0;
  const c = createTrayController({ listener: fakeListener(), watchdog: createWatchdog(), quit: async () => { quits += 1; } });
  assert.deepEqual(await c.handleClick('quit'), { id: 'quit', quitting: true });
  assert.equal(quits, 1);
});

test('an unknown action is reported, not silently ignored', async () => {
  const c = createTrayController({ listener: fakeListener(), watchdog: createWatchdog() });
  assert.deepEqual(await c.handleClick('nope'), { id: 'nope', unknown: true });
});

// ---------------------------------------------------------------------------
// Watchdog <-> tray bridge
// ---------------------------------------------------------------------------

test('poll feeds the listener activity into the watchdog and greys when it goes stale', () => {
  let t = 1_000_000;
  const listener = fakeListener({ status: { lastActivityAt: 1_000 } });
  const watchdog = createWatchdog({ now: () => t, quietMs: 600_000 });
  const c = createTrayController({ listener, watchdog, now: () => t });

  assert.equal(c.poll().icon, 'normal', 'recent watchdog seed keeps it alive');
  t += 600_001;
  assert.equal(c.poll().icon, 'grey', 'a stale listener must be visible');
});

test('poll advances the watchdog when the listener reports new activity', () => {
  let t = 2_000_000;
  const status = { connected: true, lastActivityAt: 1_000 };
  const listener = fakeListener({ status });
  const watchdog = createWatchdog({ now: () => t, quietMs: 600_000 });
  const c = createTrayController({ listener, watchdog, now: () => t });

  t += 700_000;
  assert.equal(c.poll().icon, 'grey');
  // The listener successfully polled at the new `now`; the tray beats the watchdog.
  status.lastActivityAt = t / 1000;
  assert.equal(c.poll().icon, 'normal');
});

// ---------------------------------------------------------------------------
// Mode resolution and the platform opener
// ---------------------------------------------------------------------------

test('tray is the requested default, but the config and --headless can veto it', () => {
  assert.equal(resolveTrayMode({ requested: true, configTray: true }), true);
  assert.equal(resolveTrayMode({ requested: true, configTray: false }), false, 'ui.tray=false must win');
  assert.equal(resolveTrayMode({ requested: false, configTray: true }), false, '--headless must win');
  assert.equal(resolveTrayMode({ requested: false, configTray: false }), false);
  assert.equal(resolveTrayMode({}), false, 'the library default is off; the CLI opts in');
});

test('the opener command is the platform default-handler command', () => {
  assert.deepEqual(openPathCommand('C:\\logs\\app.log', { platform: 'win32', env: {} }), {
    command: 'explorer.exe',
    args: ['C:\\logs\\app.log'],
  });
  assert.equal(openPathCommand('/x', { platform: 'darwin' }).command, 'open');
  assert.equal(openPathCommand('/x', { platform: 'linux' }).command, 'xdg-open');
  assert.equal(openPathCommand('/x', { platform: 'win32', env: { SystemRoot: 'C:\\Windows' } }).command, 'C:\\Windows\\explorer.exe');
  assert.throws(() => openPathCommand(''), /needs a target path/);
});

test('a paused listener is never greyed out', async () => {
  let t = 3_000_000;
  const listener = fakeListener({ status: { lastActivityAt: 1_000, connected: false } });
  const watchdog = createWatchdog({ now: () => t, quietMs: 600_000 });
  const c = createTrayController({ listener, watchdog, now: () => t });
  await c.handleClick('pause');
  t += 600_001;
  const result = c.poll();
  assert.equal(result.paused, true);
  assert.equal(result.icon, 'normal', 'paused is explicit; grey must mean "silently dead"');
});

// ---------------------------------------------------------------------------
// Accuracy in the tray (M4)
// ---------------------------------------------------------------------------

const accuracyBundle = {
  version: 1,
  corpus: { overall: { accuracy: 0.9, validRate: 0.91, seen: 10, valid: 9, correct: 9, gradeable: 10, confident: 9 } },
  store: { overall: { accuracy: null, validRate: 0.8, seen: 10, valid: 8, correct: 0, gradeable: 0, confident: 7 } },
};

test('the accuracy provider is surfaced in status text and tooltip', () => {
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    accuracyProvider: () => accuracyBundle,
  });
  c.poll();
  assert.match(c.statusText(), /corpus 90\.0%/);
  assert.match(c.statusText(), /traffic 80\.0%/);
  assert.match(c.tooltip(), /corpus 90\.0%/);
});

test('the Accuracy action refreshes and reports, even when paused', async () => {
  let calls = 0;
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    accuracyProvider: () => { calls += 1; return accuracyBundle; },
  });
  const result = await c.handleClick('accuracy');
  assert.equal(result.id, 'accuracy');
  assert.match(result.text, /corpus 90\.0%/);
  assert.equal(calls, 1);
  await c.handleClick('pause');
  assert.match(c.statusText(), /paused/);
  assert.match(c.statusText(), /corpus 90\.0%/, 'accuracy stays visible while paused');
});

test('a throwing accuracy provider cannot take the tray down', () => {
  const c = createTrayController({
    listener: fakeListener(),
    watchdog: createWatchdog(),
    accuracyProvider: () => { throw new Error('db locked'); },
  });
  const result = c.poll();
  assert.equal(result.accuracy, null);
  assert.equal(c.statusText(), 'PuzzleSolver: listening (stream connected)');
});

test('with no provider the tray behaves exactly as before', () => {
  const c = createTrayController({ listener: fakeListener(), watchdog: createWatchdog() });
  c.poll();
  assert.equal(c.accuracy, null);
  assert.equal(c.statusText(), 'PuzzleSolver: listening (stream connected)');
});
