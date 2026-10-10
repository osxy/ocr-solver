/**
 * Restart decision logic (issue #128). Fully offline: no process is started, no shell
 * runs and no Windows is needed. The claims that matter are the *decisions* - which
 * mechanism applies, what is printed when none does, and that a deliberate restart
 * exits 0 so the task's RestartOnFailure never fires.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createShutdownHandler,
  deriveLauncherPath,
  drainSolves,
  planRestart,
  quoteCommandPart,
  spawnSuccessor,
  wscriptFor,
} from '../src/deploy/restart.js';
import { buildLauncherVbs, RESTART_LAUNCHER_ENV } from '../src/deploy/launcher.js';

const LAUNCHER = 'C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver\\PuzzleSolver.vbs';
const NODE = 'C:\\Users\\Andre de Vries\\AppData\\Local\\Programs\\PuzzleSolver\\node.exe';

// ---------------------------------------------------------------------------
// Which mechanism applies
// ---------------------------------------------------------------------------

test('the launcher marker makes the shim restartable, and names the absolute wscript', () => {
  const plan = planRestart({
    platform: 'win32',
    execPath: NODE,
    argv: [NODE, 'C:\\app\\src\\cli.js', 'listen'],
    env: { SystemRoot: 'C:\\Windows', [RESTART_LAUNCHER_ENV]: LAUNCHER },
    fileExists: () => true,
  });
  assert.equal(plan.restartable, true);
  assert.equal(plan.mechanism, 'launcher');
  assert.equal(plan.command, 'C:\\Windows\\System32\\wscript.exe');
  assert.deepEqual(plan.args, [LAUNCHER]);
  assert.equal(plan.display, `C:\\Windows\\System32\\wscript.exe "${LAUNCHER}"`);
  assert.equal(plan.reason, 'started-by-launcher');
});

test('without the marker, a shim beside the bundled node.exe is found anyway', () => {
  const plan = planRestart({
    platform: 'win32',
    execPath: NODE,
    argv: [NODE, 'C:\\app\\src\\cli.js', 'listen'],
    env: {},
    fileExists: (p) => p === LAUNCHER,
  });
  assert.equal(plan.restartable, true);
  assert.equal(plan.mechanism, 'launcher');
  assert.deepEqual(plan.args, [LAUNCHER]);
  assert.equal(plan.reason, 'installed-launcher');
});

test('a Windows shell run with no shim is manual, and prints the exact command', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe';
  const plan = planRestart({
    platform: 'win32',
    execPath,
    argv: [execPath, 'C:\\dev\\ocr-solver\\src\\cli.js', 'listen', '--headless'],
    env: {},
    fileExists: () => false,
  });
  assert.equal(plan.restartable, false);
  assert.equal(plan.mechanism, 'manual');
  assert.equal(
    plan.display,
    '"C:\\Program Files\\nodejs\\node.exe" C:\\dev\\ocr-solver\\src\\cli.js listen --headless'
  );
  assert.equal(plan.reason, 'no-launcher');
});

test('the marker is ignored when the shim is gone, rather than spawning nothing', () => {
  const plan = planRestart({
    platform: 'win32',
    execPath: NODE,
    argv: [NODE, 'C:\\app\\src\\cli.js', 'listen'],
    env: { [RESTART_LAUNCHER_ENV]: 'C:\\moved\\PuzzleSolver.vbs' },
    // The derived shim does not exist either.
    fileExists: () => false,
  });
  assert.equal(plan.restartable, false);
  assert.equal(plan.mechanism, 'manual');
  assert.match(plan.display, /listen$/);
});

test('off Windows there is no launcher mechanism and the command is manual', () => {
  const plan = planRestart({
    platform: 'linux',
    execPath: '/usr/bin/node',
    argv: ['/usr/bin/node', '/app/src/cli.js', 'listen'],
    env: { [RESTART_LAUNCHER_ENV]: '/app/PuzzleSolver.vbs' },
    fileExists: () => true,
  });
  assert.equal(plan.restartable, false);
  assert.equal(plan.mechanism, 'manual');
  assert.equal(plan.reason, 'not-windows');
  assert.equal(plan.display, '/usr/bin/node /app/src/cli.js listen');
});

test('deriveLauncherPath only applies on Windows and only with a directory part', () => {
  assert.equal(deriveLauncherPath({ platform: 'linux', execPath: '/usr/bin/node' }), null);
  assert.equal(deriveLauncherPath({ platform: 'win32', execPath: 'node.exe' }), null);
  assert.equal(deriveLauncherPath({ platform: 'win32', execPath: NODE }), LAUNCHER);
});

test('quoteCommandPart only quotes when it must, and doubles embedded quotes', () => {
  assert.equal(quoteCommandPart('node'), 'node');
  assert.equal(quoteCommandPart('C:\\Program Files\\node.exe'), '"C:\\Program Files\\node.exe"');
  assert.equal(quoteCommandPart('a"b'), '"a""b"');
});

test('wscriptFor falls back to the bare name without a system root', () => {
  assert.equal(wscriptFor({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\wscript.exe');
  assert.equal(wscriptFor({}), 'wscript.exe');
});

// ---------------------------------------------------------------------------
// Spawning the successor
// ---------------------------------------------------------------------------

function fakeSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = { pid: 4242, unrefed: false, unref() { this.unrefed = true; } };
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls };
}

test('a restartable plan spawns exactly one detached, unrefed, windowless successor', () => {
  const { spawn, calls } = fakeSpawn();
  const result = spawnSuccessor(
    { restartable: true, command: 'wscript.exe', args: [LAUNCHER], display: 'wscript.exe ...' },
    { spawn }
  );
  assert.equal(result.spawned, true);
  assert.equal(calls.length, 1, 'exactly one successor: a second would contend for the port');
  assert.equal(calls[0].command, 'wscript.exe');
  assert.deepEqual(calls[0].args, [LAUNCHER]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].child.unrefed, true);
});

test('a non-restartable plan spawns nothing and says why', () => {
  const { spawn, calls } = fakeSpawn();
  const result = spawnSuccessor({ restartable: false, reason: 'no-launcher', display: 'node cli.js listen' }, { spawn });
  assert.equal(result.spawned, false);
  assert.equal(result.reason, 'no-launcher');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Draining an in-flight solve
// ---------------------------------------------------------------------------

test('drainSolves waits for the shared lock before resolving', async () => {
  let release;
  const idle = new Promise((resolve) => { release = resolve; });
  let settled = false;
  const core = { whenIdle: () => idle };
  const pending = drainSolves(core, { timeoutMs: 1_000 }).then((r) => { settled = true; return r; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, 'a running solve must keep the restart waiting');
  release();
  assert.deepEqual(await pending, { drained: true, reason: 'idle' });
});

test('drainSolves is bounded: a stuck solve cannot make the process unkillable', async () => {
  const warnings = [];
  const core = { whenIdle: () => new Promise(() => {}) };
  const result = await drainSolves(core, { timeoutMs: 20, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(result.drained, false);
  assert.equal(result.reason, 'timeout');
  assert.match(warnings[0], /still running/);
});

test('drainSolves treats a rejected lock as drained and a missing core as idle', async () => {
  assert.deepEqual(await drainSolves({ whenIdle: () => Promise.reject(new Error('x')) }), { drained: true, reason: 'idle' });
  assert.deepEqual(await drainSolves(null), { drained: true, reason: 'no-core' });
});

// ---------------------------------------------------------------------------
// The one shutdown handler: exit code 0, and ordering
// ---------------------------------------------------------------------------

function recordingApp() {
  const events = [];
  return {
    events,
    logger: { info: () => {}, warn: () => {} },
    core: { whenIdle: () => Promise.resolve() },
    quiesce: async () => events.push('quiesce'),
    stop: async () => events.push('stop'),
  };
}

test('a restart quiesces, drains, stops, spawns and exits 0 - in that order', async () => {
  const app = recordingApp();
  const { spawn, calls } = fakeSpawn();
  const exits = [];
  const shutdown = createShutdownHandler({
    app,
    tray: { stop: async () => app.events.push('tray') },
    plan: { restartable: true, command: 'wscript.exe', args: [LAUNCHER], display: 'wscript.exe ...' },
    spawn,
    exit: (code) => exits.push(code),
  });

  await shutdown('restart');

  assert.deepEqual(app.events, ['tray', 'quiesce', 'stop']);
  assert.deepEqual(calls.map((c) => c.command), ['wscript.exe']);
  // The double-start proof: the scheduler only starts its own process on a non-zero
  // exit. A restart that exited 1 here would make Task Scheduler launch a second
  // process a minute later.
  assert.deepEqual(exits, [0], 'a deliberate restart must exit 0');
});

test('the successor is spawned only after the port and database were released', async () => {
  const order = [];
  let stopDone = false;
  const app = {
    logger: { info: () => {}, warn: () => {} },
    core: { whenIdle: () => Promise.resolve() },
    quiesce: async () => order.push('quiesce'),
    stop: async () => { order.push('stop'); stopDone = true; },
  };
  const shutdown = createShutdownHandler({
    app,
    plan: { restartable: true, command: 'wscript.exe', args: [LAUNCHER], display: 'x' },
    spawn: (command, args, options) => {
      order.push('spawn');
      assert.equal(stopDone, true, 'the spawn must happen after stop() resolved');
      return { pid: 1, unref() {} };
    },
    exit: () => {},
  });
  await shutdown('restart');
  assert.deepEqual(order, ['quiesce', 'stop', 'spawn']);
});

test('an in-flight solve delays the stop and the successor until it drains', async () => {
  let release;
  const app = {
    logger: { info: () => {}, warn: () => {} },
    core: { whenIdle: () => new Promise((resolve) => { release = resolve; }) },
    quiesce: async () => {},
    stop: async () => {},
  };
  const order = [];
  const shutdown = createShutdownHandler({
    app,
    plan: { restartable: true, command: 'wscript.exe', args: [LAUNCHER], display: 'x' },
    spawn: () => { order.push('spawn'); return { pid: 1, unref() {} }; },
    exit: () => order.push('exit'),
    drainTimeoutMs: 5_000,
  });
  const running = shutdown('restart');
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, [], 'nothing may be released or started while a solve runs');
  release();
  await running;
  assert.deepEqual(order, ['spawn', 'exit']);
});

test('a restart is refused, without exiting, when no mechanism applies', async () => {
  const app = recordingApp();
  let spawns = 0;
  const exits = [];
  const shutdown = createShutdownHandler({
    app,
    plan: { restartable: false, mechanism: 'manual', display: 'node cli.js listen' },
    spawn: () => { spawns += 1; return { pid: 1, unref() {} }; },
    exit: (code) => exits.push(code),
  });

  const result = await shutdown('restart');
  assert.equal(result.closed, false);
  assert.equal(result.reason, 'restart-unavailable');
  assert.equal(result.display, 'node cli.js listen');
  assert.deepEqual(app.events, [], 'a refused restart must not take the service down');
  assert.equal(spawns, 0);
  assert.deepEqual(exits, [], 'a refused restart must not exit at all');
});

test('SIGINT/SIGTERM stop and exit 0 without spawning', async () => {
  const app = recordingApp();
  const exits = [];
  let spawns = 0;
  const shutdown = createShutdownHandler({
    app,
    plan: { restartable: true, command: 'wscript.exe', args: [LAUNCHER], display: 'x' },
    spawn: () => { spawns += 1; return { pid: 1, unref() {} }; },
    exit: (code) => exits.push(code),
  });
  await shutdown('SIGINT');
  assert.deepEqual(app.events, ['stop'], 'a signal shuts down but does not restart');
  assert.equal(spawns, 0);
  assert.deepEqual(exits, [0]);
});

test('shutdown runs once; a second signal is ignored', async () => {
  const app = recordingApp();
  let stops = 0;
  app.stop = async () => { stops += 1; };
  const exits = [];
  const shutdown = createShutdownHandler({ app, exit: (code) => exits.push(code) });
  await shutdown('SIGINT');
  const second = await shutdown('SIGTERM');
  assert.equal(stops, 1);
  assert.equal(second.closed, false);
  assert.deepEqual(exits, [0]);
});

// ---------------------------------------------------------------------------
// The launcher marker the whole thing depends on
// ---------------------------------------------------------------------------

test('the launcher sets the restart marker to its own path before starting node', () => {
  const vbs = buildLauncherVbs();
  assert.ok(
    vbs.includes(`env("${RESTART_LAUNCHER_ENV}") = WScript.ScriptFullName`),
    'the shim must export its own path so a restart can find it'
  );
  const markerAt = vbs.indexOf(RESTART_LAUNCHER_ENV);
  const runAt = vbs.indexOf('shell.Run');
  assert.ok(markerAt !== -1 && runAt !== -1 && markerAt < runAt, 'the marker must be set before node starts');
});
