/**
 * The runtime glue: assemble the pieces leg 1 built and run them.
 *
 * Order is deliberate and follows DESIGN 5:
 *
 *   load config -> resolve secrets -> open the store -> prune the inbox on startup
 *   -> build client/filter/fetcher/responder -> chain: filter -> download ->
 *      solveImage -> respond -> graceful shutdown
 *
 * Two pieces of leg 1 existed but were never on a startup path; both are here now:
 * the inbox prune and the `offline_only` switch that decides whether a model
 * reasoner is constructed *at all*.
 *
 * Everything is injectable (`client`, `worker`, `store`, `reasoner`, `solveImage`,
 * ...) so the whole app can be exercised against the local Pushbullet double with
 * no token, no key and no network.
 */
import { homedir as osHomedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { loadConfig, defaultStatePath } from './config.js';
import { loadSecrets, describeSecret, saveSecrets, defaultCredentialPath } from './secrets.js';
import { createLogger, defaultLogPath } from './logging.js';
import { openStore } from './state/db.js';
import { createPushbulletClient } from './pushbullet/client.js';
import { createListener } from './pushbullet/listener.js';
import { fetchImage as fetchImageImpl, pruneInbox, defaultInboxDir } from './pushbullet/files.js';
import { createResponder } from './pushbullet/respond.js';
import { createChatClient } from './model/client.js';
import { createCircuitBreaker } from './model/breaker.js';
import { createReasoner } from './solver/reason.js';
import { createOcrWorker } from './ocr/recognize.js';
import { solveImage } from './solver/pipeline.js';
import { createSolveCore } from './solver/core.js';
import { createHttpServer } from './http/server.js';
import { createNotifier } from './ui/notifications.js';
import { resolveTrayMode } from './ui/mode.js';
import { createSetup } from './ui/setup.js';
import { defaultSetupDialog } from './ui/setup-dialog.js';
import { applyLiveSettings, createSettingsEditor } from './ui/settings.js';
import { defaultSettingsDialog } from './ui/settings-dialog.js';
import { storeReport, loadReportCache, defaultAccuracyCachePath } from './accuracy.js';

/**
 * No token could be resolved and there was no dialog to ask for one. The CLI turns
 * the message into the exit line, so it names both routes rather than a stack.
 */
export class MissingTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingTokenError';
  }
}

/** The first-run dialog ended without saving, or could not present at all. */
export class SetupCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupCancelledError';
  }
}

/** The dialog itself threw, or reported a save that did not actually resolve a token. */
export class SetupFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SetupFailedError';
  }
}

/** `http.enabled` is on but no bearer token could be resolved. */
export class MissingHttpTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingHttpTokenError';
  }
}

/**
 * Build one reasoner from config, or `null` when the model tiers are off.
 *
 * `offline_only` is the switch that matters: when true no chat client and no model
 * client are constructed, so there is no code path by which an image could leave
 * the machine. A missing key under `offline_only = false` degrades to offline with
 * a warning instead of refusing to start, because a background service that cannot
 * run its deterministic tiers just because a key is absent is worse than useless.
 */
export function buildReasonerFromConfig(config, { llmApiKey, store, logger, createChatClientImpl = createChatClient, createReasonerImpl = createReasoner } = {}) {
  if (config.solver.offline_only) {
    logger?.info?.('solver.offline_only=true: text and vision tiers are disabled');
    return { reasoner: null, reason: 'offline_only' };
  }
  if (!llmApiKey) {
    logger?.warn?.('no LLM key (LLM_API_KEY or credential store); running offline only for now');
    return { reasoner: null, reason: 'no-key' };
  }

  const client = createChatClientImpl({ baseUrl: config.solver.llm_base_url, apiKey: llmApiKey });
  const n = config.solver.self_consistency_n;
  const sampleCounts = {
    count: 1,
    arithmetic: 1,
    'ordinal-pick': n,
    unknown: n,
  };

  // One breaker per tier. Transitions go to the attempts store (so a silence can be
  // explained after the fact) and a trip notifies once, here through the logger;
  // M3 swaps the log line for a desktop notification without touching this logic.
  const makeBreaker = (name) =>
    createCircuitBreaker({
      name,
      threshold: config.solver.breaker_threshold,
      cooldownMs: config.solver.breaker_cooldown_sec * 1000,
      onStateChange: (t) => {
        store?.record({
          subject: 'circuit-breaker',
          stage: 'breaker',
          variant: name,
          payload: { from: t.from, to: t.to, reason: t.reason, failures: t.failures, at: t.at },
          ok: t.to !== 'open',
        });
      },
      onTrip: (t) =>
        logger?.warn?.(
          `model tier ${name} circuit opened (${t.reason}); ` +
            `Tier 0 only for ${config.solver.breaker_cooldown_sec}s`
        ),
    });
  const breakers = { text: makeBreaker('text'), vision: makeBreaker('vision') };

  const built = createReasonerImpl({
    client,
    textModel: config.solver.llm_text_model,
    visionModel: config.solver.llm_vision_model,
    sampleCounts,
    breakers,
    store,
  });

  // The vision tier is a separate opinion; disabling escalation withholds it by
  // wrapping the reasoner rather than by reimplementing the pipeline.
  if (!config.solver.escalate_to_vision) {
    return { reasoner: { ...built, solveVision: async () => null }, reason: 'no-vision' };
  }
  return { reasoner: built, reason: 'model' };
}

/**
 * Assemble the running app. Side effects (opening the database, pruning the inbox)
 * happen here, before `start()` begins watching for pushes.
 */
export async function createApp({
  config: providedConfig = null,
  configPath = null,
  env = process.env,
  platform = process.platform,
  homedir = osHomedir,
  explicitSecrets = {},
  providers = null,
  logger: providedLogger = null,

  // M3 first run. `trayRequested` is the caller's wish; `ui.tray = false` can still
  // veto it (resolveTrayMode decides). `setupDialog` is the UI seam: the wiring only
  // exists when a dialog can actually be presented, so `--headless` never reaches it.
  trayRequested = false,
  setupDialog = null,
  // The post-setup settings editor, reached by the tray's Settings item. Same shape as
  // `setupDialog`: injected so the UI is out of the assembly logic, and defaulted by
  // `runApp` rather than here so a library caller gets no prompt.
  settingsDialog = null,

  // Dependency injection - everything below can be replaced by a test.
  store: providedStore = null,
  client: providedClient = null,
  worker: providedWorker = null,
  // `undefined` means "build from config"; `null` means "offline, build nothing".
  reasoner: providedReasoner = undefined,
  responder: providedResponder = null,
  listener: providedListener = null,
  // M3: notifications default off. `runApp` installs the real notifier only in tray
  // mode, so `--headless` leaves this null and nothing can toast.
  notifier = null,
  fetchImage = fetchImageImpl,
  solveImage: solveImageImpl = solveImage,
  createWorker = createOcrWorker,
  createClient = createPushbulletClient,
  createChatClientImpl = createChatClient,
  createReasonerImpl = createReasoner,
  responderFactory = createResponder,
  listenerFactory = createListener,
  inboxDir = null,
  statePath = null,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now() / 1000,
  logPath = null,
} = {}) {
  const logger = providedLogger ?? createLogger({ path: logPath ?? defaultLogPath({ platform, env, homedir }) });

  let config = providedConfig;
  let resolvedConfigPath = configPath;
  if (!config) {
    const loaded = loadConfig({ explicitPath: configPath, env, platform, homedir });
    config = loaded.config;
    resolvedConfigPath = loaded.path;
    for (const warning of loaded.warnings) logger.warn(warning);
    logger.info(loaded.loaded ? `config loaded from ${loaded.path}` : `no config file at ${loaded.path}; using defaults`);
  }

  let notificationSink = notifier;

  let secrets = await loadSecrets({
    explicit: explicitSecrets,
    env,
    providers,
    platform,
    homedir,
    logger,
  });
  let pushbulletToken = secrets.pushbullet.value;
  let llmApiKey = secrets.llm.value;
  let httpToken = secrets.http?.value ?? null;
  const httpEnabled = config.http?.enabled === true;
  logger.debug?.(`secrets: pushbullet=${JSON.stringify(describeSecret(secrets.pushbullet))} llm=${JSON.stringify(describeSecret(secrets.llm))}`);

  // Open the store before pruning: the prune is housekeeping and the store is what
  // makes a solve idempotent across restarts, so a store failure must be louder.
  const store = providedStore ?? openStore({ path: statePath ?? defaultStatePath({ platform, env, homedir }) });
  const ownsStore = !providedStore;

  const effectiveInbox = inboxDir ?? defaultInboxDir();
  const removed = pruneInbox({ inboxDir: effectiveInbox, retainDays: config.storage.retain_days, now });
  if (removed.length) logger.info(`pruned ${removed.length} inbox file(s) older than ${config.storage.retain_days} day(s)`);

  // Retention is enforced, not just documented. `attempts` hold transcripts, which
  // are the rows with privacy value; pushes/outbox are the dedupe and duplicate-send
  // guards and are deliberately kept (DESIGN 8).
  const prunedAttempts = store.pruneAttempts
    ? store.pruneAttempts({ retainDays: config.storage.retain_days, now })
    : 0;
  if (prunedAttempts) logger.info(`pruned ${prunedAttempts} attempt row(s) older than ${config.storage.retain_days} day(s)`);

  const wantTray = resolveTrayMode({ requested: trayRequested === true, configTray: config.ui.tray });
  const credentialPath = defaultCredentialPath({ platform, env, homedir });

  if (!providedClient && !pushbulletToken && !httpEnabled) {
    // Tray mode is the only place a dialog can be shown, so that is the only place
    // the first-run path exists. --headless (and every test that injects no dialog)
    // falls through to the actionable error below rather than a silent no-op.
    if (wantTray && setupDialog) {
      const setup = createSetup({
        // The dialog writes through the same provider interface the app reads through,
        // so the reload below proves the credential round-tripped. The model key is
        // optional, matching the documented behaviour.
        saveSecrets: (args) => saveSecrets({ ...args, providers, platform, env, homedir, logger }),
        requireModelKey: false,
        logger,
      });
      let outcome;
      try {
        outcome = await setupDialog({ setup, logger, credentialPath });
      } catch (err) {
        if (ownsStore) store.close();
        throw new SetupFailedError(`the first-run setup dialog failed: ${err?.message ?? err}`);
      }
      if (!outcome?.saved) {
        if (ownsStore) store.close();
        throw new SetupCancelledError(
          'first-run setup ended without a Pushbullet token; the service was not started. ' +
            `Set PUSHBULLET_TOKEN, or add "pushbullet_token" to ${credentialPath}.`
        );
      }

      // Re-resolve through the same providers the dialog wrote through. Trusting the
      // dialog's "saved" flag would make a broken credential store look configured.
      secrets = await loadSecrets({ explicit: explicitSecrets, env, providers, platform, homedir, logger });
      pushbulletToken = secrets.pushbullet.value;
      llmApiKey = secrets.llm.value;
      httpToken = secrets.http?.value ?? null;
      logger.debug?.(`secrets after setup: pushbullet=${JSON.stringify(describeSecret(secrets.pushbullet))} llm=${JSON.stringify(describeSecret(secrets.llm))}`);
      if (!pushbulletToken) {
        if (ownsStore) store.close();
        throw new SetupFailedError(
          `the setup dialog reported success but no token was resolvable; add "pushbullet_token" to ${credentialPath}`
        );
      }
    } else {
      if (ownsStore) store.close();
      throw new MissingTokenError(
        'no Pushbullet token found. Set PUSHBULLET_TOKEN (or pass --token), or add ' +
          `"pushbullet_token" to ${credentialPath}; secrets are never read from config.toml.`
      );
    }
  }

  // The HTTP endpoint is an oracle; enabling it without a bearer token is refused
  // rather than silently downgraded to anonymous.
  if (httpEnabled && !httpToken) {
    if (ownsStore) store.close();
    throw new MissingHttpTokenError(
      'http.enabled = true but no HTTP bearer token was found. Set HTTP_AUTH_TOKEN, or add ' +
        `"http_auth_token" to ${credentialPath}; secrets are never read from config.toml.`
    );
  }

  // A Pushbullet client only exists when there is a token (or a test injected one).
  // An HTTP-only deployment has none at all - that is the point of the ingress seam:
  // the same core runs with no Pushbullet account anywhere in the process.
  const client = providedClient ?? (pushbulletToken ? createClient({ token: pushbulletToken }) : null);
  const worker = providedWorker ?? (await createWorker());
  const ownsWorker = !providedWorker;

  let reasoner = providedReasoner;
  let reasonerMode = 'injected';
  if (reasoner === undefined) {
    const built = buildReasonerFromConfig(config, { llmApiKey, store, logger, createChatClientImpl, createReasonerImpl });
    reasoner = built.reasoner;
    reasonerMode = built.reason;
  }

  // The transport-agnostic core. Pushbullet, HTTP and the tray all call this; none of
  // them re-wires the pipeline options (DESIGN 4.15).
  const core = createSolveCore({
    worker,
    reasoner,
    store,
    config,
    solveImage: solveImageImpl,
    logger,
  });

  let responder = providedResponder;
  if (!responder && client && config.reply.enabled) {
    responder = responderFactory({
      client,
      store,
      title: config.reply.title,
      prefix: config.reply.prefix,
      unresolvedTitle: config.reply.unresolved_title,
      unresolvedText: config.reply.unresolved_text,
      requireConfidence: config.reply.require_confidence,
      minIntervalMs: config.reply.min_interval_sec * 1000,
      maxPerHour: config.reply.max_per_hour,
      strategy: config.reply.strategy,
      logger,
    });
  }

  /** filter -> download -> solveImage -> respond, with the push status updated at each step. */
  async function handlePush(push, { store: handlerStore = store } = {}) {
    const image = await fetchImage(push, { inboxDir: effectiveInbox });
    handlerStore?.setPushStatus(push.iden, 'downloaded');

    const result = await core.solve(image.path, { subject: push.iden, store: handlerStore });

    let response;
    if (responder) {
      response = await responder.respond(push, result);
    } else {
      response = { sent: false, reason: config.reply.enabled ? 'no-responder' : 'reply-disabled' };
    }

    // `solved` means an answer was produced *and* (when replying is on) delivered;
    // an unconfirmed answer that the responder suppressed is `unresolved`, matching
    // the leg-1 vertical slice. With replies disabled a local answer is still solved.
    const solved = result.answer != null && (responder ? response.sent === true : true);
    handlerStore?.setPushStatus(push.iden, solved ? 'solved' : 'unresolved');

    // An unresolved puzzle is the one outcome worth a toast: a solved one needs no
    // attention, and a wrong answer is never sent (DESIGN 7). The wording tracks what
    // actually went out - since #29 an unresolved puzzle gets an acknowledgement, so
    // "nothing sent" would be a lie. Headless mode passes no notifier, so it stays
    // completely silent.
    if (!solved && config.ui.notify_on_unresolved && notificationSink) {
      const acknowledged = response?.sent === true && response?.unresolved === true;
      await notificationSink.notify?.({
        title: 'PuzzleSolver: unresolved',
        message: `${basename(image.path)} - no corroborated answer, ${
          acknowledged ? 'acknowledgement sent' : 'nothing sent'
        }`,
      });
    }
    return { image, result, response };
  }

  const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.webp', '.tif', '.tiff', '.gif']);

  /** Newest image in the inbox, or null. Drives the tray's "Solve last image". */
  function lastImagePath() {
    let names;
    try {
      names = readdirSync(effectiveInbox);
    } catch {
      return null;
    }
    let best = null;
    for (const name of names) {
      if (!IMAGE_EXT.has(extname(name).toLowerCase())) continue;
      const path = join(effectiveInbox, name);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) best = { path, mtimeMs: stat.mtimeMs };
    }
    return best?.path ?? null;
  }

  /** Solve the newest inbox image without replying - for tuning without a push. */
  async function solveLastImage() {
    const path = lastImagePath();
    if (!path) return { answer: null, reason: 'no-image', imagePath: null };
    const result = await core.solve(path, { subject: basename(path) });
    logger?.info?.(`tray: re-solved ${basename(path)} -> ${result.answer ?? 'unresolved'}`);
    return { ...result, imagePath: path, reason: result.answer == null ? 'unresolved' : 'solved' };
  }

  // Two ingresses, one core. Either can be absent: HTTP-only with no Pushbullet
  // token is a supported (and tested) mode.
  const listener =
    providedListener ??
    (client
      ? listenerFactory({
          client,
          store,
          historyMode: config.pushbullet.history_mode,
          pollIntervalMs: config.pushbullet.poll_interval_sec * 1000,
          onPush: handlePush,
          logger,
          WebSocketImpl,
        })
      : null);

  const httpServer = httpEnabled
    ? createHttpServer({
        core,
        token: httpToken,
        config,
        inboxDir: effectiveInbox,
        responder,
        logger,
      })
    : null;

  let started = false;
  let stopped = false;

  async function start() {
    if (started) return status();
    started = true;
    logger.info(
      `starting ingresses (pushbullet=${Boolean(listener)}, http=${Boolean(httpServer)}, ` +
        `history_mode=${config.pushbullet.history_mode}, offline_only=${config.solver.offline_only}, ` +
        `reply=${config.reply.enabled}, reasoner=${reasonerMode})`
    );
    if (httpServer) await httpServer.start();
    if (listener) await listener.start();
    return status();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      listener?.stop();
    } catch {
      // already down
    }
    try {
      await httpServer?.stop();
    } catch {
      // already down
    }
    if (ownsWorker) {
      try {
        await worker?.terminate?.();
      } catch {
        // worker teardown must not block exit
      }
    }
    if (ownsStore) store.close();
    logger.info('shut down');
  }

  function status() {
    return {
      ...(listener?.status?.() ?? {}),
      reasoner: reasonerMode,
      reply: Boolean(responder),
      http: httpServer?.status?.() ?? null,
    };
  }

  return {
    config,
    configPath: resolvedConfigPath,
    logger,
    store,
    client,
    worker,
    reasoner,
    responder,
    listener,
    core,
    httpServer,
    inboxDir: effectiveInbox,
    // A getter, not a snapshot: rotating a secret through the settings editor
    // re-resolves it so the next editor or diagnostic sees the new value. The running
    // client still holds the old token until a restart, which is why the editor labels
    // a secret change `[restart]`.
    get secrets() {
      return {
        pushbullet: describeSecret(secrets.pushbullet),
        llm: describeSecret(secrets.llm),
        http: describeSecret(secrets.http),
      };
    },
    handlePush,
    lastImagePath,
    solveLastImage,
    /**
     * Open the settings editor. The tray's Settings item calls this; the CLI's
     * `config edit` drives the same editor directly. After a successful save the
     * settings the running process re-reads per solve are applied in place, and the
     * rest are reported as needing a restart - never silently swallowed.
     */
    async openSettings() {
      if (!settingsDialog) return { saved: false, failed: true, detail: 'no settings editor is available' };
      const editor = createSettingsEditor({
        config,
        configPath: resolvedConfigPath,
        // The live resolved secrets are used only by `editor.test()`; `list()` never
        // returns a value, only presence and source.
        secrets,
        saveSecrets: (args) => saveSecrets({ ...args, providers, platform, env, homedir, logger }),
        logger,
      });
      const outcome = await settingsDialog({
        editor,
        config,
        configPath: resolvedConfigPath,
        credentialPath,
        secrets,
        logger,
      });
      if (outcome?.saved && outcome.config) {
        outcome.liveApplied = applyLiveSettings(config, outcome.config, outcome.changed ?? []);
      }
      if (outcome?.saved && outcome.secretsSaved?.length) {
        // Re-resolve through the same providers the editor wrote through, the same way
        // first-run setup does. Trusting the editor's "saved" flag would let a broken
        // credential store look configured.
        secrets = await loadSecrets({ explicit: explicitSecrets, env, providers, platform, homedir, logger });
      }
      return outcome;
    },
    /** Install/replace the notification sink; `null` disables toasts. */
    setNotifier(next) {
      notificationSink = next;
    },
    get notifier() {
      return notificationSink;
    },
    start,
    stop,
    status,
  };
}

/**
 * Create the app, start it, and shut down cleanly on SIGINT/SIGTERM.
 * The signal handlers close the listener socket and the database (DESIGN 5).
 */
export async function runApp(options = {}) {
  // Tray mode is decided inside `createApp` from the config it loads, because the
  // first-run dialog is part of assembly: it must run before the listener starts and
  // must not exist under `--headless`. The requested tray flag and the dialog seam
  // travel together so the two decisions cannot drift.
  const app = await createApp({
    ...options,
    trayRequested: options.tray === true,
    setupDialog: options.setupDialog ?? defaultSetupDialog,
    settingsDialog: options.settingsDialog ?? defaultSettingsDialog,
  });
  let closing = false;
  let tray = null;

  // The tray is opt-in at this API level (`tray: true`) and the CLI turns it on by
  // default. `ui.tray = false` in the config can still veto it. Keeping the default
  // off here is what lets tests and the corpus run drive runApp without a display.
  const wantTray = resolveTrayMode({ requested: options.tray === true, configTray: app.config.ui.tray });

  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.logger?.info?.(`received ${signal}; shutting down`);
    try {
      await tray?.stop?.();
    } catch {
      // a dead tray must not block shutdown
    }
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  if (wantTray) {
    // Tray mode gets the real notifier. Building it is free (the node-notifier import
    // is lazy inside it), but it is only ever wired here, so --headless and every
    // test leave it null.
    app.setNotifier(createNotifier({ logger: app.logger }));
    // Imported lazily so a machine without `systray2` (and every non-tray run) never
    // loads it. `TrayUnavailableError` carries the actionable `--headless` message.
    // Injectable so the tray wiring - including the Settings item - is testable
    // without a display.
    let startTrayImpl = options.startTray;
    if (!startTrayImpl) ({ startTray: startTrayImpl } = await import('./ui/tray-systray.js'));
    // The tray shows the live store metric plus the cached offline-corpus report.
    // The cache is written by `scripts/accuracy.js`; without it the tray still
    // reports real traffic. Never throws: a bad cache is simply no corpus number.
    const accuracyCachePath = options.accuracyCachePath ?? defaultAccuracyCachePath(app.store.path);
    const accuracyProvider = () => ({
      corpus: loadReportCache(accuracyCachePath)?.corpus ?? null,
      store: storeReport(app.store),
    });
    tray = await startTrayImpl({
      app,
      logger: app.logger,
      quietMs: options.quietMs,
      openPath: options.openPath,
      solveLastImage: options.solveLastImage ?? app.solveLastImage,
      // The tray's Settings item is the delivered form of the settings editor; without
      // this the feature exists in tests only, which is the failure #27 calls out.
      openSettings: options.openSettings ?? (() => app.openSettings()),
      accuracyProvider,
      quit: () => shutdown('tray'),
    });
    app.logger?.info?.('tray started');
  }

  await app.start();
  app.tray = tray;
  return app;
}
