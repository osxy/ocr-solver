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
import { loadConfig, defaultStatePath, autoRouterOptions } from './config.js';
import { loadSecrets, describeSecret, saveSecrets, defaultCredentialPath } from './secrets.js';
import { createLogger, defaultLogPath } from './logging.js';
import { openStore } from './state/db.js';
import { createImageStore, defaultImagesDir } from './state/images.js';
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
import { createHttpServer, httpTokenProblem } from './http/server.js';
import { registerSecrets } from './redact.js';
import { createNotifier } from './ui/notifications.js';
import { resolveTrayMode } from './ui/mode.js';
import { createSetup } from './ui/setup.js';
import { applyLiveSettings, createSettingsEditor } from './ui/settings.js';
import { APP_VERSION } from './version.js';
import { computeSettingsReview, planStartupReview, recordDismissal, recordReview } from './ui/settings-review.js';
import { defaultWebSettingsDialog, defaultWebSetupDialog } from './ui/web-config.js';
import { createShutdownHandler, planRestart } from './deploy/restart.js';
import { WEB_UI_CREDENTIAL_SETTING, webUiAdmitsNonLoopback } from './ui/access.js';
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

/** `http.enabled` is on but the resolved bearer token is too weak to guard the endpoint (#47). */
export class WeakHttpTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WeakHttpTokenError';
  }
}

/**
 * The web UI is configured to admit non-loopback addresses but has no credential
 * (#65). Refusing to start is the point: an unauthenticated UI that writes secrets
 * and spends provider credits must not come up just because a range was typed.
 */
export class MissingWebUiCredentialError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MissingWebUiCredentialError';
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

  const client = createChatClientImpl({
    baseUrl: config.solver.llm_base_url,
    apiKey: llmApiKey,
    // #78: the auto-router policy has to reach the client the service builds, or
    // `allowed_models`/`cost_tier` silently do nothing for a routed text tier.
    autoRouter: autoRouterOptions(config),
  });
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
  // Where the offline-corpus report cache lives, for the statistics page (#64).
  // `null` means derive it from the store path, exactly like the tray does.
  accuracyCachePath = null,
  // The browser launcher the web UI uses. Injected so the startup and tray paths are
  // testable without a display, exactly like the tray's `openPath`.
  openBrowser = undefined,
  // #128: how this process can start its successor. Injected so the decision and the
  // settings dialog are testable without a launcher; `runApp` supplies the real one.
  restartPlan = null,
  // Called after the settings UI asked for a restart and the save was already applied.
  // `runApp` points it at the graceful shutdown. A library caller leaves it null, and
  // then a save that needs a restart simply reports it.
  onRestart = null,

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
  // #100: where the bounded review copies live, and an injectable store for tests.
  imagesDir = null,
  imageStore: providedImageStore = null,
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now() / 1000,
  logPath = null,
} = {}) {
  const logger = providedLogger ?? createLogger({ path: logPath ?? defaultLogPath({ platform, env, homedir }) });
  // Computed once, from how this process was actually started. `planRestart` is pure
  // and reads the launcher marker the shim set (#128).
  const processRestartPlan = restartPlan ?? planRestart();

  let config = providedConfig;
  let resolvedConfigPath = configPath;
  // `loaded` is false only for a genuine fresh install (no config file). The upgrade
  // review (#67) uses it to skip the first run, where setup already walks the user
  // through everything and "here is what is new" is noise.
  let configFileLoaded = false;
  if (!config) {
    const loaded = loadConfig({ explicitPath: configPath, env, platform, homedir });
    config = loaded.config;
    resolvedConfigPath = loaded.path;
    configFileLoaded = loaded.loaded;
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
  // Register the configured secrets so the shared redactor hides their exact value
  // at every sink, independent of whether the provider's key shape is documented (#45).
  registerSecrets([pushbulletToken, llmApiKey, httpToken]);
  logger.debug?.(`secrets: pushbullet=${JSON.stringify(describeSecret(secrets.pushbullet))} llm=${JSON.stringify(describeSecret(secrets.llm))}`);

  // Open the store before pruning: the prune is housekeeping and the store is what
  // makes a solve idempotent across restarts, so a store failure must be louder.
  const store = providedStore ?? openStore({ path: statePath ?? defaultStatePath({ platform, env, homedir }) });
  const ownsStore = !providedStore;

  // #67: notice settings introduced since the last reviewed version. This is a
  // notification, not a gate - it must never block or fail startup, so a store error
  // is logged and the app continues with defaults. `planStartupReview` advances the
  // offered baseline (one log line, never a repeat) but leaves the editor's `isNew`
  // badges until the user actually opens the editor or runs `config review`.
  let settingsReview = null;
  try {
    settingsReview = planStartupReview({ store, appVersion: APP_VERSION, configLoaded: configFileLoaded, logger });
  } catch (err) {
    logger.warn(`settings review failed: ${err?.message ?? err}`);
  }

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

  // #100: the bounded review copies. The store always exists so the settings editor
  // can turn `storage.keep_images` on live; the pipeline decides per solve whether to
  // write. Retention is the shared `retain_days` window plus the count cap, and a
  // failure here is housekeeping, not a reason to refuse to start.
  const effectiveImagesDir = imagesDir ?? defaultImagesDir({ platform, env, homedir });
  const imageStore =
    providedImageStore ??
    createImageStore({
      store,
      dir: effectiveImagesDir,
      maxCount: config.storage.max_images,
      retainDays: config.storage.retain_days,
      now,
      logger,
    });
  const imagePrune = imageStore.prune({ retainDays: config.storage.retain_days });
  const imageRemoved = imagePrune.removed + imagePrune.byCount + imagePrune.orphans + imagePrune.missing + imagePrune.staleFiles;
  if (imageRemoved) {
    logger.info(
      `pruned ${imageRemoved} stored image(s) ` +
        `(${imagePrune.removed} expired, ${imagePrune.byCount} over the cap, ${imagePrune.orphans} orphaned, ` +
        `${imagePrune.missing} missing, ${imagePrune.staleFiles} stray)`
    );
  }

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
        // #79: Test connection probes the provider the user configured, not a
        // hardwired OpenAI endpoint.
        modelProbe: { baseUrl: config.solver.llm_base_url, model: config.solver.llm_text_model },
        logger,
      });
      let outcome;
      try {
        // Even the first-run UI is gated by the same access rule; a widened web_ui
        // with no credential is refused before this point.
        outcome = await setupDialog({
          setup,
          logger,
          credentialPath,
          credentialStore: secrets.store,
          openBrowser,
          webUi: config.web_ui,
          credentialVerifier: secrets.web_ui?.value ?? null,
        });
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
      registerSecrets([pushbulletToken, llmApiKey, httpToken]);
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

  // A short or obvious token is an oracle with a guessable key; refuse it at startup
  // rather than listen with a lock that opens to a dictionary (#47).
  if (httpEnabled) {
    const problem = httpTokenProblem(httpToken);
    if (problem) {
      if (ownsStore) store.close();
      throw new WeakHttpTokenError(
        `http.enabled = true but ${problem}. Generate one with \`openssl rand -hex 24\` ` +
          'and set HTTP_AUTH_TOKEN (or the http_auth_token credential).'
      );
    }
  }

  // The web UI may be widened to a non-loopback range; #65 requires a configured
  // credential for that. The credential store is not consulted by `validateConfig`,
  // so the check happens here, where both the range and the resolved verifier exist.
  let webUiCredential = secrets.web_ui?.value ?? null;
  if (webUiAdmitsNonLoopback(config.web_ui) && !webUiCredential) {
    if (ownsStore) store.close();
    throw new MissingWebUiCredentialError(
      'web_ui.allowed_cidrs admits addresses beyond loopback but no web UI credential is configured. ' +
        `Run \`node src/cli.js config set ${WEB_UI_CREDENTIAL_SETTING} <password>\`, or set the ` +
        '"web_ui_password_hash" entry in the credential store. The service refuses to start rather than ' +
        'expose the config and solve UI without authentication.'
    );
  }

  // A Pushbullet client only exists when there is a token (or a test injected one).
  // An HTTP-only deployment has none at all - that is the point of the ingress seam:
  // the same core runs with no Pushbullet account anywhere in the process.
  const client = providedClient ?? (pushbulletToken ? createClient({ token: pushbulletToken }) : null);
  // #143: the configured OCR languages are resolved when the worker is built, which is
  // why the setting is `[restart]`. A language with no bundled traineddata is refused by
  // `createOcrWorker` by name rather than silently loading `nld`.
  const worker = providedWorker ?? (await createWorker({ languages: config.ocr.languages }));
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
    imageStore,
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
      unresolvedMaxPerHour: config.reply.unresolved_max_per_hour,
      strategy: config.reply.strategy,
      logger,
    });
  }

  /** filter -> download -> solveImage -> respond, with the push status updated at each step. */
  async function handlePush(push, { store: handlerStore = store } = {}) {
    const image = await fetchImage(push, {
      inboxDir: effectiveInbox,
      maxWidth: config.image?.max_width,
      maxPixels: config.image?.max_pixels,
    });
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

  /**
   * Stop accepting new work, without releasing the store or the worker yet. A restart
   * drains the in-flight solve between this and `stop()`, so the successor starts only
   * after the port and the database are actually released (#128, hazard 5).
   */
  async function quiesce() {
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
    imagesDir: effectiveImagesDir,
    imageStore,
    // #67: the settings found to be new at startup (or `null` when there was
    // nothing to offer). `openSettings` refreshes it after a review. Exposed so the
    // startup offer is inspectable without opening an editor.
    get settingsReview() {
      return settingsReview;
    },
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
      // Which settings are still new to this user (#67). Re-read on every open: a
      // previous review advances the baseline in the store. The ids feed the editor's
      // `isNew` flags; the dialog also receives the descriptors so it can list them.
      const review = computeSettingsReview({ store });
      const editor = createSettingsEditor({
        config,
        configPath: resolvedConfigPath,
        // The live resolved secrets are used only by `editor.test()`; `list()` never
        // returns a value, only presence and source.
        secrets,
        saveSecrets: (args) => saveSecrets({ ...args, providers, platform, env, homedir, logger }),
        logger,
        newSettingIds: review.newSettings.map((setting) => setting.id),
      });
      const outcome = await settingsDialog({
        editor,
        config,
        configPath: resolvedConfigPath,
        credentialPath,
        credentialStore: secrets.store,
        secrets,
        logger,
        openBrowser,
        // #67: the new settings, security-relevant first, so the web shell can show
        // them without re-reading the store.
        settingsReview: review,
        // #65: the solve page solves through the same core and against the same caps
        // as the HTTP ingress, and the access/credential options gate every page.
        solveCore: core,
        inboxDir: effectiveInbox,
        webUi: config.web_ui,
        credentialVerifier: webUiCredential,
        // #64: the statistics page reads the real store and the cached offline-corpus
        // report. They are passed as two separate inputs, so the page cannot blend the
        // synthetic figure into the real one.
        store,
        imageStore,
        corpusReport: loadReportCache(accuracyCachePath ?? defaultAccuracyCachePath(store.path))?.corpus ?? null,
        // #128: the settings UI offers the restart only when this process can perform
        // it. The web server answers the browser before the process goes down.
        restartPlan: processRestartPlan,
      });
      // The editor presented the settings, so they are no longer "new". A dialog that
      // never came up (`failed`) did not present them, and a web UI whose page was never
      // fetched (`sessionOpened === false`: timed out, or the link was printed where
      // nobody could click it) did not either. #87: the timed-out case still advances the
      // *prompt* baseline so it does not nag next start, but leaves the `[new]` badges.
      // Recording is best-effort: a store failure must not turn a successful save into
      // an error.
      if (outcome && !outcome.failed) {
        try {
          if (outcome.sessionOpened === false) recordDismissal(store, APP_VERSION);
          else recordReview(store, APP_VERSION);
        } catch (err) {
          logger.warn?.(`could not record the settings review: ${err?.message ?? err}`);
        }
        settingsReview = computeSettingsReview({ store });
      }
      if (outcome?.saved && outcome.config) {
        outcome.liveApplied = applyLiveSettings(config, outcome.config, outcome.changed ?? []);
      }
      if (outcome?.saved && outcome.secretsSaved?.length) {
        // Re-resolve through the same providers the editor wrote through, the same way
        // first-run setup does. Trusting the editor's "saved" flag would let a broken
        // credential store look configured.
        secrets = await loadSecrets({ explicit: explicitSecrets, env, providers, platform, homedir, logger });
        // A password set in this very session must be visible to the next open.
        webUiCredential = secrets.web_ui?.value ?? null;
      }
      if (outcome?.restarted) {
        // The browser already has its response; now take the service down and start the
        // successor. `onRestart` is the graceful shutdown (hazard 3 then hazards 4/5).
        if (typeof onRestart === 'function') await onRestart();
        else logger.warn?.('a restart was requested but no restart handler is wired');
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
    quiesce,
    // #128: the decision this process made about restarting itself, exposed so the
    // tray can present it and `runApp` can act on exactly the same plan.
    restartPlan: processRestartPlan,
    status,
  };
}

/**
 * Create the app, start it, and shut down cleanly on SIGINT/SIGTERM.
 * The signal handlers close the listener socket and the database (DESIGN 5).
 */
export async function runApp(options = {}) {
  // `shutdown` is created after the tray is wired (it must be able to stop it), but
  // the settings dialog is assembled before that. The closure reads the variable when
  // a restart is actually requested, by which time it is assigned.
  let shutdown = null;
  // Tray mode is decided inside `createApp` from the config it loads, because the
  // first-run dialog is part of assembly: it must run before the listener starts and
  // must not exist under `--headless`. The requested tray flag and the dialog seam
  // travel together so the two decisions cannot drift.
  const app = await createApp({
    ...options,
    trayRequested: options.tray === true,
    // The default UI is the loopback web editor (issue #56): the Windows launcher runs
    // the tray with no console, so a terminal prompt cannot be presented there. The
    // terminal editor is still reachable through `config edit`.
    setupDialog: options.setupDialog ?? defaultWebSetupDialog,
    settingsDialog: options.settingsDialog ?? defaultWebSettingsDialog,
    // The settings UI may request a restart; this is the one path that performs it.
    onRestart: options.onRestart ?? (() => shutdown?.('restart')),
  });
  let tray = null;

  // The tray is opt-in at this API level (`tray: true`) and the CLI turns it on by
  // default. `ui.tray = false` in the config can still veto it. Keeping the default
  // off here is what lets tests and the corpus run drive runApp without a display.
  const wantTray = resolveTrayMode({ requested: options.tray === true, configTray: app.config.ui.tray });

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
      // Both the Settings page and the tray item request the same restart; `shutdown`
      // refuses it (without exiting) when `restartPlan` says no mechanism applies.
      restart: () => shutdown?.('restart'),
      restartPlan: app.restartPlan,
      quit: () => shutdown?.('tray'),
    });
    app.logger?.info?.('tray started');
  }

  // One shutdown path for SIGINT/SIGTERM, Quit and Restart. A restart quiesces the
  // ingresses, drains the in-flight solve, releases the port and the database, starts
  // exactly one successor and exits 0, so nothing starts a second copy (#128). If that
  // successor cannot be started it exits non-zero instead; since #163 there is no
  // scheduler recovery, so that leaves the service down until the next logon rather than
  // reporting a dead process as alive (#135).
  shutdown = createShutdownHandler({ app, tray, plan: app.restartPlan, logger: app.logger });
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.start();
  app.tray = tray;
  return app;
}
