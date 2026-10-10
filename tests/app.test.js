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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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

test('an unresolved push sends the acknowledgement and the toast reports it', async (t) => {
  const calls = [];
  const notifier = { notify: async (n) => calls.push(n) };
  const { fake, app } = await makeApp(t, {
    rawConfig: { pushbullet: { poll_interval_sec: 0 } },
    solve: scriptedSolve({ answer: null, confident: true }),
    notifier,
  });
  await app.start();
  await waitFor(() => app.listener.connected, { label: 'stream connection' });

  const push = fake.pushImage({ iden: 'app-ack', data: await makePng() });
  fake.tickle();

  await waitFor(() => fake.notePushes.length === 1, { label: 'one acknowledgement' });
  await waitFor(() => app.store.getPush(push.iden)?.status === 'unresolved', { label: 'unresolved status' });
  assert.equal(fake.notePushes[0].title, 'Puzzel niet opgelost');
  assert.match(fake.notePushes[0].body, /niet automatisch worden opgelost/);

  await waitFor(() => calls.length === 1, { label: 'one notification' });
  assert.match(calls[0].message, /acknowledgement sent/, 'the toast must not claim silence when a reply went out');
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

// #78: the service ignored the auto-router settings because buildReasonerFromConfig
// built the client with baseUrl/apiKey only. Capture the client's options here, the
// same seam that exposed the bug.
test('#78: buildReasonerFromConfig passes the auto-router settings to the client', () => {
  const config = validateConfig({
    solver: {
      llm_base_url: 'https://openrouter.ai/api/v1',
      llm_text_model: 'openrouter/auto',
      cost_tier: 'high',
      allowed_models: ['openai/*'],
      excluded_models: ['anthropic/*'],
    },
  }).config;
  let seen = null;
  const built = buildReasonerFromConfig(config, {
    llmApiKey: 'sk-test-key-not-real',
    logger: collectingLogger(),
    createChatClientImpl: (options) => {
      seen = options;
      return { tag: 'chat' };
    },
    createReasonerImpl: () => ({ solveVision: async () => null }),
  });
  assert.equal(built.reason, 'model');
  assert.ok(seen, 'the service client must be built');
  assert.deepEqual(seen.autoRouter, {
    costTier: 'high',
    allowedModels: ['openai/*'],
    excludedModels: ['anthropic/*'],
  });
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

test('headless startup with no token names `config set` and not the plaintext file (#172)', async (t) => {
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
      assert.match(err.message, /config set pushbullet\.token/, 'the message must lead with the command that writes the store');
      assert.match(err.message, /PUSHBULLET_TOKEN/);
      assert.doesNotMatch(err.message, /credentials\.json/, 'the plaintext migration file must not be presented as a route');
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
      assert.match(err.message, /config set pushbullet\.token/, 'a cancelled dialog must still name the command that works');
      assert.doesNotMatch(err.message, /credentials\.json/);
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

// The settings-editor reachability test. Remove the `openSettings` wiring from `runApp`
// (or the `settings` menu item) and the captured handler is undefined, so this fails.
// It also proves a successful save reaches the live config and the file.
test('runApp wires the tray Settings item to the injected editor, which persists and applies live', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, '[storage]\nlog_images = false\n');
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const provider = createFileCredentialProvider({ path: join(dir, 'credentials.json') });
  provider.set('pushbullet', 'o.tray-settings');

  let captured = null;
  let dialogCalls = 0;
  const app = await runApp({
    ...firstRunOptions(dir, {
      providers: [provider],
      client: fakeClient(fake),
      configPath,
    }),
    tray: true,
    settingsDialog: async ({ editor }) => {
      dialogCalls += 1;
      editor.set('storage.log_images', 'true');
      editor.set('pushbullet.token', 'o.rotated-through-editor');
      return editor.save();
    },
    startTray: async (options) => {
      captured = options;
      return { controller: {}, tray: {}, stop: async () => {} };
    },
  });
  t.after(async () => {
    await app.tray?.stop?.();
    await app.stop();
  });

  assert.equal(typeof captured?.openSettings, 'function', 'the tray must receive an openSettings handler');
  const outcome = await captured.openSettings();
  assert.equal(dialogCalls, 1, 'the Settings item must reach the injected editor');
  assert.equal(outcome.saved, true);
  assert.equal(app.config.storage.log_images, true, 'a live setting is applied to the running config');
  assert.match(readFileSync(configPath, 'utf8'), /log_images = true/);
  assert.equal(readFileSync(configPath, 'utf8').includes('rotated-through-editor'), false, 'the token stays out of the config');
  assert.equal(provider.get('pushbullet'), 'o.rotated-through-editor', 'the editor wrote the credential store');
  assert.equal(app.secrets.pushbullet.hint, 'o.r…', 'the app re-resolved the rotated secret');
});

// #128: the settings UI asks, the app performs. The plan travels to the dialog and a
// `restarted` outcome is the only thing that reaches the restart handler. Remove either
// the `restartPlan` pass-through or the `onRestart` call and this fails.
test('a settings save that requests a restart reaches the injected restart handler', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seenPlans = [];
  let restarted = 0;
  let nextRestarted = true;
  const plan = { restartable: true, display: 'wscript.exe "C:\\x\\PuzzleSolver.vbs"' };
  const app = await createApp(
    firstRunOptions(dir, {
      client: {},
      responder: {},
      listener: { start() {}, stop() {}, status: () => ({}) },
      settingsDialog: async (options) => {
        seenPlans.push(options.restartPlan);
        return { saved: true, changed: [], restartRequired: ['solver.llm_text_model'], restarted: nextRestarted };
      },
      restartPlan: plan,
      onRestart: async () => {
        restarted += 1;
      },
    })
  );
  t.after(() => app.stop());

  const outcome = await app.openSettings();
  assert.equal(outcome.restarted, true);
  assert.equal(restarted, 1, 'a requested restart reaches the restart handler');
  assert.deepEqual(seenPlans[0], plan, 'the settings dialog receives the plan it can act on');

  nextRestarted = false;
  await app.openSettings();
  assert.equal(restarted, 1, 'a save with no restart request must never restart');
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

// #167: the ordinary double-start. The second start must be refused before it starts a
// listener - two listeners both answer every Pushbullet push. `--headless` and the tray
// both reach `start()`, so this one guard covers both. Remove the lock from `start()`
// and this test fails on the listener count, not on the error name.
test('a second start on the same state path is refused and starts no listener (#167)', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-instance-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const starts = [];
  const makeListener = () => ({
    start: async () => { starts.push(1); },
    stop() {},
    status: () => ({}),
  });
  const base = {
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
  };

  const first = await createApp({ ...base, listener: makeListener() });
  t.after(() => first.stop());
  await first.start();
  assert.equal(starts.length, 1);

  const second = await createApp({ ...base, listener: makeListener() });
  t.after(() => second.stop());
  await assert.rejects(
    () => second.start(),
    (err) => err.name === 'AlreadyRunningError' && /already running/.test(err.message)
  );
  assert.equal(starts.length, 1, 'the refused start must not have started a second listener');

  // The lock is released on stop, so a legitimate start after the first stops works and
  // a dead holder is not a permanent refusal.
  await first.stop();
  await second.start();
  assert.equal(starts.length, 2, 'after the first stopped, the second may start');
  await second.stop();
});

// #167: the guard is per data directory, not per checkout. The test suite runs many
// processes in this one checkout (node:test runs each file in its own process) and each
// app has its own temp state path, so both must start and listen. A guard keyed on the
// working directory would make this fail.
test('two apps in one checkout with different state paths both start (#167)', async (t) => {
  const fake = await startFakePushbullet();
  const root = mkdtempSync(join(tmpdir(), 'puzzlesolver-parallel-'));
  t.after(async () => {
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  });

  const started = [];
  const makeAppAt = (name) => {
    const dir = join(root, name);
    mkdirSync(join(dir, 'inbox'), { recursive: true });
    return createApp({
      env: {},
      providers: [],
      client: fakeClient(fake),
      reasoner: null,
      solveImage: scriptedSolve(),
      createWorker: async () => ({ terminate: async () => {} }),
      listener: { start: async () => started.push(name), stop() {}, status: () => ({}) },
      inboxDir: join(dir, 'inbox'),
      statePath: join(dir, 'state.db'),
      logger: collectingLogger(),
    });
  };

  const a = await makeAppAt('a');
  const b = await makeAppAt('b');
  t.after(() => Promise.all([a.stop(), b.stop()]));
  await a.start();
  await b.start();
  assert.deepEqual(started.sort(), ['a', 'b'], 'separate data directories must not contend for one lock');
});

// The user path: `runApp` takes the lock before any UI, so a second launch refuses here
// rather than in `createApp`. The launcher has no console, so the refusal must reach the
// log; this pins both the clean error and the logged reason.
test('runApp refuses a second start, exits cleanly and logs why (#167)', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-runapp-instance-'));
  mkdirSync(join(dir, 'inbox'), { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const beforeSigint = new Set(process.listeners('SIGINT'));
  const beforeSigterm = new Set(process.listeners('SIGTERM'));
  t.after(() => {
    for (const handler of [...process.listeners('SIGINT'), ...process.listeners('SIGTERM')]) {
      if (!beforeSigint.has(handler) && !beforeSigterm.has(handler)) {
        process.removeListener('SIGINT', handler);
        process.removeListener('SIGTERM', handler);
      }
    }
  });

  const base = {
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    createWorker: async () => ({ terminate: async () => {} }),
    listener: { start() {}, stop() {}, status: () => ({}) },
    inboxDir: join(dir, 'inbox'),
    statePath: join(dir, 'state.db'),
  };
  const first = await runApp({ ...base, logger: collectingLogger() });
  t.after(() => first.stop());

  const warnings = [];
  const secondLogger = { warn: (m) => warnings.push(String(m)), info() {}, debug() {}, error() {} };
  await assert.rejects(
    () => runApp({ ...base, logger: secondLogger }),
    (err) => err.name === 'AlreadyRunningError' && /already running/.test(err.message)
  );
  assert.ok(
    warnings.some((m) => /already running/.test(m)),
    `the refusal must be logged for the console-less launcher: ${warnings.join(' | ')}`
  );
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
  // The default logger really writes to `%LOCALAPPDATA%`, so a fake Windows path
  // here created a literal `C:\Users\Andre\AppData\Local` directory in the repo root
  // (issue #50). Point the fake Windows environment at a temp directory instead: the
  // path the app builds is still `%LOCALAPPDATA%\PuzzleSolver\logs\app.log`, but the
  // write lands under tmp and is cleaned up.
  const localAppData = mkdtempSync(join(tmpdir(), 'puzzlesolver-localappdata-'));
  t.after(() => rmSync(localAppData, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: localAppData };
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
  assert.equal(app.logger.path, join(localAppData, 'PuzzleSolver', 'logs', 'app.log'));
  assert.ok(app.logger.path.startsWith(localAppData), 'the log path must stay under the temp LOCALAPPDATA');
});

test('#143: the app builds the OCR worker from the configured languages', async (t) => {
  const fake = await startFakePushbullet();
  const dir = mkdtempSync(join(tmpdir(), 'puzzlesolver-app-'));
  const inboxDir = join(dir, 'inbox');
  mkdirSync(inboxDir, { recursive: true });
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const calls = [];
  const app = await createApp({
    config: validateConfig({ ocr: { languages: ['nld'] } }).config,
    env: {},
    providers: [],
    client: fakeClient(fake),
    reasoner: null,
    solveImage: scriptedSolve(),
    // The seam `runApp` uses for the real factory; it must receive the configured
    // languages, not be called with no arguments (#143).
    createWorker: async (options) => {
      calls.push(options);
      return { terminate: async () => {} };
    },
    inboxDir,
    statePath: join(dir, 'state.db'),
    logger: collectingLogger(),
    now: () => Date.now() / 1000,
  });
  t.after(() => app.stop());

  assert.deepEqual(calls, [{ languages: ['nld'] }], 'the worker is built from config.ocr.languages (#143)');
});
