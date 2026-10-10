/**
 * `systray2` adapter tests. The native tray is never started: the module loader and
 * the SysTray class are injected, so the forwarding logic and - critically - the
 * actionable failure when the module is missing are both testable on Linux.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTray, TrayUnavailableError } from '../src/ui/tray-systray.js';

function fakeApp() {
  return {
    listener: { status: () => ({ connected: true, lastActivityAt: Date.now() / 1000 }), stop() {}, start() {} },
    logger: { path: '/tmp/app.log' },
    configPath: '/tmp/config.toml',
  };
}

class FakeSysTray {
  static last = null;
  constructor(conf) {
    this.conf = conf;
    this.actions = [];
    this.clicks = null;
    this.killed = false;
    FakeSysTray.last = this;
  }
  async onClick(cb) {
    this.clicks = cb;
    return this;
  }
  async sendAction(action) {
    this.actions.push(action);
    return this;
  }
  async kill() {
    this.killed = true;
  }
}

test('a missing systray2 fails with an actionable --headless message, not a stack', async () => {
  await assert.rejects(
    () => startTray({ app: fakeApp(), loadSystray: async () => { throw new Error('Cannot find module systray2'); } }),
    (err) => {
      assert.ok(err instanceof TrayUnavailableError);
      assert.match(err.message, /--headless/);
      assert.match(err.message, /systray2/);
      return true;
    }
  );
});

test('a module that exports no SysTray class is reported the same way', async () => {
  await assert.rejects(
    () => startTray({ app: fakeApp(), loadSystray: async () => ({ default: {} }) }),
    (err) => err instanceof TrayUnavailableError && /--headless/.test(err.message)
  );
});

test('the adapter renders the controller menu and forwards clicks back by id', async (t) => {
  const tray = await startTray({
    app: fakeApp(),
    loadSystray: async () => ({ default: FakeSysTray }),
    solveLastImage: async () => ({ answer: '7' }),
    notify: null,
    pollIntervalMs: 0,
  });
  t.after(() => tray.stop());

  const instance = FakeSysTray.last;
  assert.deepEqual(
    instance.conf.menu.items.map((i) => i.tooltip),
    ['status', 'accuracy', 'pause', 'solve-last', 'open-log', 'open-config', 'settings', 'restart', 'quit']
  );
  assert.equal(instance.conf.menu.title, 'PuzzleSolver');
  assert.ok(instance.conf.menu.icon.length > 0, 'an icon payload is required');

  const result = await instance.clicks({ item: { tooltip: 'status' } });
  assert.equal(result.id, 'status');
  assert.match(result.text, /PuzzleSolver/);
});

test('the adapter forwards the Settings click to the injected editor', async (t) => {
  let opened = 0;
  const tray = await startTray({
    app: fakeApp(),
    loadSystray: async () => ({ default: FakeSysTray }),
    openSettings: async () => {
      opened += 1;
      return { saved: true, changed: ['ui.tray'] };
    },
    pollIntervalMs: 0,
  });
  t.after(() => tray.stop());
  const instance = FakeSysTray.last;
  const result = await instance.clicks({ item: { tooltip: 'settings' } });
  assert.equal(opened, 1, 'the adapter must pass openSettings into the controller');
  assert.equal(result.id, 'settings');
  assert.equal(result.opened, true);
});

test('clicking Pause updates the menu item title', async (t) => {
  const tray = await startTray({
    app: fakeApp(),
    loadSystray: async () => ({ default: FakeSysTray }),
    pollIntervalMs: 0,
  });
  t.after(() => tray.stop());
  const instance = FakeSysTray.last;

  await instance.clicks({ item: { tooltip: 'pause' } });
  const update = instance.actions.find((a) => a.type === 'update-item');
  assert.ok(update, 'the Pause item must be relabelled to Resume');
  assert.equal(update.item.title, 'Resume');
});
