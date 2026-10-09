/**
 * App assembly tests, all against the local Pushbullet double.
 *
 * These cover the leg-1 gaps the runtime closes: the inbox prune on startup, the
 * `offline_only` and `reply.enabled` switches, and a shutdown that closes the
 * socket and the database. The solver and OCR worker are injected so the tests stay
 * fast and offline; the real vertical slice is in pushbullet.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { startFakePushbullet } from './fake-pushbullet.js';
import { createApp, buildReasonerFromConfig, runApp } from '../src/app.js';
import { validateConfig } from '../src/config.js';
import { defaultLogPath } from '../src/logging.js';
import { createPushbulletClient } from '../src/pushbullet/client.js';
import { createFileCredentialProvider } from '../src/secrets.js';

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, { timeoutMs = 5_000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await realSleep(intervalMs);
  }
}

function makePng({ width = 200, height = 44 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

function collectingLogger() {
  const logs = [];
  const logger = { logs };
  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = (...args) => logs.push({ level, args });
  }
  return logger;
}

function scriptedSolve(result = { answer: '2', confident: true }) {
  return async () => ({
    ...result,
    solved: true,
    method: 'tier0:count',
    unresolved: result.answer == null,
  });
}

function fakeClient(fake) {
  return createPushbulletClient({ token: fake.token, baseUrl: fake.baseUrl, sleep: fake.clock.sleep, backoffBaseMs: 10 });
}

/**
 * Assemble an app against a fresh fake server and a temp state database.
 * `solve` and the OCR worker are injected; the listener, filter, fetcher, responder
 * and handler chain are the real ones.
 */
async function makeApp(t, { rawConfig = {}, solve = scriptedSolve(), reasoner = null, ...overrides } = {}) {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  const logger = overrides.logger ?? collectingLogger();
  const client = overrides.client ?? fakeClient(fake);
  const worker = { terminated: false, async terminate() { this.terminated = true; } };

  const app = await createApp({
    ...overrides,
    config: overrides.config ?? validateConfig(rawConfig).config,
    env: {},
    providers: [],
    client,
    reasoner,
    solveImage: solve,
    createWorker: async () => worker,
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger,
    now: () => Date.now() / 1000,
  });

  t.after(async () => {
    try {
      await app.stop();
    } catch {
      // already stopped
    }
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  return { fake, app, inboxDir, worker, logger, dir };
}

// ---------------------------------------------------------------------------
// Startup prune - the leg-1 gap
// ---------------------------------------------------------------------------

test('the inbox is pruned on startup, keeping fresh files', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(join(inboxDir, 'old.png'), 'old');
  writeFileSync(join(inboxDir, 'fresh.png'), 'fresh');
  const oldMs = Date.now() - 30 * 86_400_000;
  utimesSync(join(inboxDir, 'old.png'), new Date(oldMs), new Date(oldMs));

  const logger = collectingLogger();
  const app = await createApp({
    config: validateConfig({ storage: { retain_days: 7 } }).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger,
    now: () => Date.now() / 1000,
  });
  t.after(() => app.stop());

  assert.equal(existsSync(join(inboxDir, 'old.png')), false, 'leg 1 built pruneInbox but nothing called it');
  assert.equal(existsSync(join(inboxDir, 'fresh.png')), true);
  assert.ok(logger.logs.some((l) => /pruned 1 inbox file/.test(l.args.join(' '))));
});

// ---------------------------------------------------------------------------
// The full chain against the fake: tickle -> download -> solve -> respond
// ---------------------------------------------------------------------------

test('a tickle downloads, solves and replies through the assembled app', async (t) => {
  const { fake, app } = await makeApp(t, { rawConfig: { pushbullet: { poll_interval_sec: 0 } } });
  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });

  const bytes = await makePng();
  const push = fake.pushImage({ iden: 'app-1', fileName: 'puzzle.png', data: bytes, sourceDeviceIden: 'dev-phone' });
  fake.tickle();

  await waitFor(
    () => fake.notePushes.length === 1 && app.store.getPush(push.iden)?.status === 'solved',
    { label: 'one note push and a solved status' }
  );
  assert.equal(fake.notePushes[0].body, '2');
  assert.equal(fake.notePushes[0].title, 'Antwoord');
  assert.equal(fake.notePushes[0].device_iden, 'dev-phone');
  assert.equal(app.store.getPush(push.iden).status, 'solved');

  const download = fake.requests.find((r) => r.path === `/files/${push.iden}`);
  assert.ok(download);
  assert.equal(download.headers['access-token'], undefined, 'the token stays away from the pre-signed URL');
});

test('reply.enabled = false solves locally and sends nothing', async (t) => {
  const { fake, app } = await makeApp(t, {
    rawConfig: { reply: { enabled: false }, pushbullet: { poll_interval_sec: 0 } },
  });
  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });

  const push = fake.pushImage({ iden: 'app-noreply', data: await makePng() });
  fake.tickle();

  await waitFor(() => app.store.getPush(push.iden)?.status === 'solved', { label: 'local solve' });
  await realSleep(100);
  assert.equal(fake.notePushes.length, 0, 'reply.enabled=false must never reach Pushbullet');
  assert.equal(app.responder, null);
});

test('an uncorroborated answer is not sent by default', async (t) => {
  const { fake, app } = await makeApp(t, {
    rawConfig: { pushbullet: { poll_interval_sec: 0 } },
    solve: scriptedSolve({ answer: '2', confident: false }),
  });
  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });

  const push = fake.pushImage({ iden: 'app-unconfident', data: await makePng() });
  fake.tickle();

  await waitFor(() => app.store.getPush(push.iden)?.status === 'unresolved', { label: 'unresolved status' });
  await realSleep(100);
  assert.equal(fake.notePushes.length, 0, 'require_confidence=true must suppress it');
});

// ---------------------------------------------------------------------------
// offline_only and the reasoner switch
// ---------------------------------------------------------------------------

test('offline_only builds no model client and no reasoner at all', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  let chatBuilt = 0;
  let reasonerBuilt = 0;
  const app = await createApp({
    config: validateConfig({ solver: { offline_only: true } }).config,
    env: { LLM_API_KEY: 'sk-terms-of-service-would-trip-this' },
    providers: [],
    client: fakeClient(fake),
    reasoner: undefined, // build from config
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    createChatClientImpl: () => {
      chatBuilt += 1;
      return {};
    },
    createReasonerImpl: () => {
      reasonerBuilt += 1;
      return {};
    },
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());

  assert.equal(app.reasoner, null);
  assert.equal(chatBuilt, 0, 'no chat client may be constructed under offline_only');
  assert.equal(reasonerBuilt, 0);
});

test('with a key and offline_only off, the reasoner is built from config', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const seen = {};
  const app = await createApp({
    config: validateConfig({
      solver: {
        offline_only: false,
        llm_text_model: 'text-model-x',
        llm_vision_model: 'vision-model-y',
        llm_base_url: 'https://example.test/v1',
        self_consistency_n: 5,
      },
    }).config,
    env: { LLM_API_KEY: 'sk-test-key-not-real' },
    providers: [],
    client: fakeClient(fake),
    reasoner: undefined,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    createChatClientImpl: (options) => {
      seen.chat = options;
      return { tag: 'chat' };
    },
    createReasonerImpl: (options) => {
      seen.reasoner = options;
      return { solveVision: async () => null };
    },
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());

  assert.ok(app.reasoner);
  assert.equal(seen.chat.baseUrl, 'https://example.test/v1');
  assert.equal(seen.reasoner.textModel, 'text-model-x');
  assert.equal(seen.reasoner.visionModel, 'vision-model-y');
  // self_consistency_n applies to the voting classes, not the deterministic ones.
  assert.deepEqual(seen.reasoner.sampleCounts, { count: 1, arithmetic: 1, 'ordinal-pick': 5, unknown: 5 });
});

test('escalate_to_vision=false withholds the vision tier', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = await createApp({
    config: validateConfig({ solver: { escalate_to_vision: false } }).config,
    env: { LLM_API_KEY: 'sk-test' },
    providers: [],
    client: fakeClient(fake),
    reasoner: undefined,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    createChatClientImpl: () => ({}),
    createReasonerImpl: () => ({ solveVision: async () => ({ answer: 'seen' }) }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());

  assert.equal(await app.reasoner.solveVision({ images: [{}], parsed: {} }), null);
});

test('a missing key degrades to offline with a warning, it does not refuse to start', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const logger = collectingLogger();

  const app = await createApp({
    config: validateConfig({}).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: undefined,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger,
  });
  t.after(() => app.stop());

  assert.equal(app.reasoner, null);
  assert.ok(logger.logs.some((l) => l.level === 'warn' && /no LLM key/.test(l.args.join(' '))));
});

test('buildReasonerFromConfig reports why it produced nothing', () => {
  const offline = buildReasonerFromConfig(validateConfig({ solver: { offline_only: true } }).config, {
    llmApiKey: 'sk-x',
  });
  assert.deepEqual(offline, { reasoner: null, reason: 'offline_only' });
  const noKey = buildReasonerFromConfig(validateConfig({}).config, { llmApiKey: null });
  assert.deepEqual(noKey, { reasoner: null, reason: 'no-key' });
});

// ---------------------------------------------------------------------------
// Missing token
// ---------------------------------------------------------------------------

test('a listen-mode app with no token refuses with a clear message', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      createApp({
        config: validateConfig({}).config,
        env: {},
        providers: [],
        reasoner: null,
        solveImage: scriptedSolve(),
        createWorker: async () => ({ terminate: async () => {} }),
        inboxDir: join(dir, 'inbox'),
        statePath: join(dir, 'state.db'),
        logger: collectingLogger(),
      }),
    /no Pushbullet token/i
  );
});

// ---------------------------------------------------------------------------
// M3 first run: the dialog must be reached, not just tested in isolation
// ---------------------------------------------------------------------------

/**
 * `createApp` options for a first-run scenario. No `client` is injected on purpose:
 * an injected client satisfies the `!providedClient` guard and skips the missing-token
 * branch entirely, so the dialog would never be reached. The real client is built only
 * after the token resolves and makes no request until the listener starts.
 */
function firstRunOptions(dir, overrides = {}) {
  return {
    config: validateConfig({}).config,
    env: {},
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
    ...overrides,
  };
}

// The reachability test: remove the `setupDialog` call from `createApp` and this one
// fails, because startup rejects instead of asking. Its siblings below cover the
// documented cancel, headless and no-re-prompt behaviours.
test('tray-mode startup with no token reaches the injected dialog and starts after it saves', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const credentialPath = join(dir, 'credentials.json');
  const provider = createFileCredentialProvider({ path: credentialPath });
  const shown = [];

  const app = await createApp(
    firstRunOptions(dir, {
      providers: [provider],
      trayRequested: true,
      setupDialog: async ({ setup, credentialPath: shownPath }) => {
        shown.push(shownPath);
        const result = await setup.apply({ pushbulletToken: 'o.first-run', llmApiKey: 'sk-first-run' });
        return { saved: result.saved, savedNames: result.savedNames };
      },
    })
  );
  t.after(() => app.stop());

  assert.equal(shown.length, 1, 'startup must present the dialog exactly once');
  assert.match(shown[0], /credentials\.json$/, 'the dialog is told where the default credential store is');
  assert.equal(provider.get('pushbullet'), 'o.first-run', 'the dialog wrote through the real saveSecrets');
  assert.equal(provider.get('llm'), 'sk-first-run');
  assert.equal(app.secrets.pushbullet.present, true, 'the app re-resolved the saved token');
  assert.equal(app.secrets.llm.present, true);
});

test('tray-mode startup with no token and no dialog provider refuses instead of proceeding', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () => createApp(firstRunOptions(dir, { providers: [], trayRequested: true })),
    (err) => {
      assert.equal(err.name, 'MissingTokenError');
      assert.match(err.message, /PUSHBULLET_TOKEN/);
      return true;
    }
  );
});

test('headless startup with no token names the environment variable and the credential-store file', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let dialogCalls = 0;
  await assert.rejects(
    () =>
      createApp(
        firstRunOptions(dir, {
          providers: [],
          env: {},
          platform: 'linux',
          homedir: () => join(dir, 'home'),
          trayRequested: false,
          setupDialog: async () => {
            dialogCalls += 1;
            return { saved: false };
          },
        })
      ),
    (err) => {
      assert.equal(err.name, 'MissingTokenError');
      assert.match(err.message, /PUSHBULLET_TOKEN/);
      assert.match(err.message, /credentials\.json/, 'the message must name the credential-store file');
      return true;
    }
  );
  assert.equal(dialogCalls, 0, '--headless must never present the dialog');
});

test('a cancelled first-run dialog exits cleanly and leaves no half-configuration', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const provider = createFileCredentialProvider({ path: join(dir, 'credentials.json') });
  await assert.rejects(
    () =>
      createApp(
        firstRunOptions(dir, {
          providers: [provider],
          trayRequested: true,
          setupDialog: async () => ({ saved: false, cancelled: true }),
        })
      ),
    (err) => {
      assert.equal(err.name, 'SetupCancelledError');
      assert.match(err.message, /pushbullet_token/);
      assert.match(err.message, /PUSHBULLET_TOKEN/);
      return true;
    }
  );
  assert.equal(provider.get('pushbullet'), null, 'a cancelled dialog must not write anything');
});

test('a dialog that throws becomes a clean SetupFailedError, not a crash', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(
    () =>
      createApp(
        firstRunOptions(dir, {
          providers: [createFileCredentialProvider({ path: join(dir, 'credentials.json') })],
          trayRequested: true,
          setupDialog: async () => {
            throw new Error('the dialog window closed');
          },
        })
      ),
    (err) => {
      assert.equal(err.name, 'SetupFailedError');
      assert.match(err.message, /the dialog window closed/);
      return true;
    }
  );
});

test('a second start with a stored token does not prompt again', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const provider = createFileCredentialProvider({ path: join(dir, 'credentials.json') });

  let firstCalls = 0;
  const first = await createApp(
    firstRunOptions(dir, {
      providers: [provider],
      trayRequested: true,
      setupDialog: async ({ setup }) => {
        firstCalls += 1;
        const result = await setup.apply({ pushbulletToken: 'o.persisted' });
        return { saved: result.saved };
      },
    })
  );
  await first.stop();
  assert.equal(firstCalls, 1);

  let secondCalls = 0;
  const second = await createApp(
    firstRunOptions(dir, {
      providers: [provider],
      trayRequested: true,
      setupDialog: async () => {
        secondCalls += 1;
        return { saved: false };
      },
    })
  );
  t.after(() => second.stop());
  assert.equal(secondCalls, 0, 'a resolvable token must not re-open the dialog');
  assert.equal(second.secrets.pushbullet.present, true);
});

test('runApp supplies the dialog seam in tray mode, before the tray starts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const provider = createFileCredentialProvider({ path: join(dir, 'credentials.json') });
  let calls = 0;
  await assert.rejects(
    () =>
      runApp({
        ...firstRunOptions(dir, { providers: [provider] }),
        tray: true,
        setupDialog: async () => {
          calls += 1;
          return { saved: false, cancelled: true };
        },
      }),
    (err) => err.name === 'SetupCancelledError'
  );
  assert.equal(calls, 1, 'runApp must forward the dialog; the tray must not run before setup');
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

test('stop closes the listener socket and the database, and is idempotent', async (t) => {
  const { fake, app, worker } = await makeApp(t, { rawConfig: { pushbullet: { poll_interval_sec: 0 } } });

  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });
  assert.equal(fake.openStreams, 1);

  await app.stop();
  await waitFor(() => fake.openStreams === 0, { label: 'socket close' });
  assert.equal(app.listener.status().connected, false);
  assert.equal(worker.terminated, true, 'the OCR worker is torn down');
  assert.throws(() => app.store.get('anything'), 'the database is closed');

  await assert.doesNotReject(() => app.stop(), 'stop must be idempotent');
});

test('runApp installs SIGINT/SIGTERM handlers and starts listening', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const beforeSigint = new Set(process.listeners('SIGINT'));
  const beforeSigterm = new Set(process.listeners('SIGTERM'));

  const running = await runApp({
    config: validateConfig({ pushbullet: { poll_interval_sec: 0 } }).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => running.stop());

  const added = [...process.listeners('SIGINT'), ...process.listeners('SIGTERM')].filter(
    (handler) => !beforeSigint.has(handler) && !beforeSigterm.has(handler)
  );
  assert.ok(added.length >= 2, 'runApp must install both signal handlers');
  for (const handler of added) {
    process.removeListener('SIGINT', handler);
    process.removeListener('SIGTERM', handler);
  }
  assert.ok(running.listener);

  // Silence the "open handle" warning the (now detached) listener would cause.
  await running.stop();
});

// ---------------------------------------------------------------------------
// M3: solve-last, the notifier sink and the wired log path
// ---------------------------------------------------------------------------

test('solveLastImage runs the pipeline on the newest inbox image', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  writeFileSync(join(inboxDir, 'older.png'), 'old');
  writeFileSync(join(inboxDir, 'newest.png'), 'new');
  // Must be recent: createApp prunes anything older than retain_days on startup,
  // so 1970 mtimes would be deleted before solveLastImage ever looked.
  const nowMs = Date.now();
  utimesSync(join(inboxDir, 'older.png'), new Date(nowMs - 10_000), new Date(nowMs - 10_000));
  utimesSync(join(inboxDir, 'newest.png'), new Date(nowMs), new Date(nowMs));

  const seen = [];
  const app = await createApp({
    config: validateConfig({}).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: async (_worker, file) => {
      seen.push(file);
      return { answer: '7', solved: true, method: 'tier0:arithmetic', unresolved: false };
    },
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());

  const result = await app.solveLastImage();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], join(inboxDir, 'newest.png'), 'the newest image must win, not the first readdir entry');
  assert.equal(result.answer, '7');
  assert.equal(result.reason, 'solved');
});

test('solveLastImage says so when the inbox is empty', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = await createApp({
    config: validateConfig({}).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());
  assert.deepEqual(await app.solveLastImage(), { answer: null, reason: 'no-image', imagePath: null });
});

test('an unresolved push notifies the sink in tray mode, and nothing is notified without one', async (t) => {
  const calls = [];
  const notifier = { notify: async (n) => calls.push(n) };
  const { fake, app } = await makeApp(t, {
    rawConfig: { pushbullet: { poll_interval_sec: 0 } },
    solve: scriptedSolve({ answer: '2', confident: false }),
    notifier,
  });
  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });

  const push = fake.pushImage({ iden: 'app-notify', data: await makePng() });
  fake.tickle();
  await waitFor(() => app.store.getPush(push.iden)?.status === 'unresolved', { label: 'unresolved status' });
  await waitFor(() => calls.length === 1, { label: 'one notification' });
  assert.match(calls[0].title, /unresolved/);
  assert.match(calls[0].message, /nothing sent/);

  // With the sink removed (the --headless default) the same push sends nothing.
  app.setNotifier(null);
  const second = fake.pushImage({ iden: 'app-notify-2', data: await makePng() });
  fake.tickle();
  await waitFor(() => app.store.getPush(second.iden)?.status === 'unresolved', { label: 'second unresolved' });
  await realSleep(50);
  assert.equal(calls.length, 1, 'a null sink must not notify');
});

test('createApp defaults to no notifier; runApp installs one only in tray mode', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = await createApp({
    config: validateConfig({}).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  });
  t.after(() => app.stop());
  assert.equal(app.notifier, null, 'the default must not be able to toast on a headless server');
});

test('createApp wires the platform default log path when no logger is injected', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const env = { LOCALAPPDATA: 'C:\\Users\\Andre\\AppData\\Local' };
  const app = await createApp({
    config: validateConfig({}).config,
    platform: 'win32',
    env,
    homedir: () => 'C:\\Users\\Andre',
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
    // No logger: the app must build the default one.
  });
  t.after(() => app.stop());
  const expected = defaultLogPath({ platform: 'win32', env, homedir: () => 'C:\\Users\\Andre' });
  assert.equal(app.logger.path, expected, 'the real default path must be wired, not a test path');
  assert.equal(app.logger.path, join('C:\\Users\\Andre\\AppData\\Local', 'PuzzleSolver', 'logs', 'app.log'));
});
