/**
 * `systray2` adapter tests. The native tray is never started: the module loader and
 * the SysTray class are injected, so the forwarding logic and - critically - the
 * actionable failure when the module is missing are both testable on Linux.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { startTray, resolveSysTray, TrayUnavailableError } from '../src/ui/tray-systray.js';

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

// The interop regression guard. This is the assertion that fails on the code the
// repository shipped: the old `mod?.default ?? mod` resolved the real module to an
// object, so the tray threw before it ever constructed a widget. It imports the real
// `systray2` - the dependency is mandatory, and importing it does not start the
// native binary - so it exercises the actual Babel/CJS shape rather than a stand-in.
test('the real systray2 import resolves to a SysTray function', async () => {
  const mod = await import('systray2');
  const resolved = resolveSysTray(mod);
  assert.equal(
    typeof resolved,
    'function',
    `systray2 resolved to ${typeof resolved}; exports seen: ${Object.keys(mod).join(', ')}`
  );
});

// Every interop shape that is realistic, so the resolution does not quietly depend on
// the one shape seen on this host.
test('resolveSysTray accepts each realistic interop shape', () => {
  class C {}
  assert.equal(resolveSysTray({ SysTray: C }), C, 'an ESM build exposing the class by name');
  assert.equal(resolveSysTray({ default: { SysTray: C } }), C, 'a CJS namespace holding the class under default');
  assert.equal(resolveSysTray({ default: { default: C } }), C, 'the Babel __esModule shape shipped today');
  assert.equal(resolveSysTray({ default: C }), C, 'a plain default export');
  assert.equal(resolveSysTray({}), undefined, 'nothing resolvable yields undefined, never a throw');
  assert.equal(resolveSysTray({ default: {} }), undefined, 'default without a function is not accepted');
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

  // The systray2 contract is a *path*, not base64: the library calls pathExists on
  // it and reads the file itself. An embedded base64 string is not a path, so the
  // bytes reached the native side undecoded and the tile rendered blank (#185).
  const icon = instance.conf.menu.icon;
  assert.match(icon, process.platform === 'win32' ? /\.ico$/ : /\.png$/, 'the platform chooses the format');
  assert.ok(existsSync(icon), `systray2 reads this path itself, so it must exist: ${icon}`);

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
