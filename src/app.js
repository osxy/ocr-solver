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
import { loadConfig, defaultStatePath } from './config.js';
import { loadSecrets, describeSecret } from './secrets.js';
import { createLogger, defaultLogPath } from './logging.js';
import { openStore } from './state/db.js';
import { createPushbulletClient } from './pushbullet/client.js';
import { createListener } from './pushbullet/listener.js';
import { fetchImage as fetchImageImpl, pruneInbox, defaultInboxDir } from './pushbullet/files.js';
import { createResponder } from './pushbullet/respond.js';
import { createChatClient } from './model/client.js';
import { createReasoner } from './solver/reason.js';
import { createOcrWorker } from './ocr/recognize.js';
import { solveImage } from './solver/pipeline.js';

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
  const built = createReasonerImpl({
    client,
    textModel: config.solver.llm_text_model,
    visionModel: config.solver.llm_vision_model,
    sampleCounts,
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

  // Dependency injection - everything below can be replaced by a test.
  store: providedStore = null,
  client: providedClient = null,
  worker: providedWorker = null,
  // `undefined` means "build from config"; `null` means "offline, build nothing".
  reasoner: providedReasoner = undefined,
  responder: providedResponder = null,
  listener: providedListener = null,
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

  const secrets = await loadSecrets({
    explicit: explicitSecrets,
    env,
    providers,
    platform,
    homedir,
    logger,
  });
  const pushbulletToken = secrets.pushbullet.value;
  const llmApiKey = secrets.llm.value;
  logger.debug?.(`secrets: pushbullet=${JSON.stringify(describeSecret(secrets.pushbullet))} llm=${JSON.stringify(describeSecret(secrets.llm))}`);

  // Open the store before pruning: the prune is housekeeping and the store is what
  // makes a solve idempotent across restarts, so a store failure must be louder.
  const store = providedStore ?? openStore({ path: statePath ?? defaultStatePath({ platform, env, homedir }) });
  const ownsStore = !providedStore;

  const effectiveInbox = inboxDir ?? defaultInboxDir();
  const removed = pruneInbox({ inboxDir: effectiveInbox, retainDays: config.storage.retain_days, now });
  if (removed.length) logger.info(`pruned ${removed.length} inbox file(s) older than ${config.storage.retain_days} day(s)`);

  if (!providedClient && !pushbulletToken) {
    if (ownsStore) store.close();
    throw new Error(
      'no Pushbullet token found. Set PUSHBULLET_TOKEN, pass --token, or put it in the credential store; ' +
        'secrets are never read from config.toml.'
    );
  }

  const client = providedClient ?? createClient({ token: pushbulletToken });
  const worker = providedWorker ?? (await createWorker());
  const ownsWorker = !providedWorker;

  let reasoner = providedReasoner;
  let reasonerMode = 'injected';
  if (reasoner === undefined) {
    const built = buildReasonerFromConfig(config, { llmApiKey, store, logger, createChatClientImpl, createReasonerImpl });
    reasoner = built.reasoner;
    reasonerMode = built.reason;
  }

  let responder = providedResponder;
  if (!responder && config.reply.enabled) {
    responder = responderFactory({
      client,
      store,
      title: config.reply.title,
      prefix: config.reply.prefix,
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

    const result = await solveImageImpl(worker, image.path, {
      variants: config.ocr.variants,
      minConfidence: config.ocr.min_confidence,
      reasoner,
      store: handlerStore,
      subject: push.iden,
      logger,
      useTier0: config.solver.tier0,
    });

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
    return { image, result, response };
  }

  const listener =
    providedListener ??
    listenerFactory({
      client,
      store,
      historyMode: config.pushbullet.history_mode,
      pollIntervalMs: config.pushbullet.poll_interval_sec * 1000,
      onPush: handlePush,
      logger,
      WebSocketImpl,
    });

  let started = false;
  let stopped = false;

  async function start() {
    if (started) return status();
    started = true;
    logger.info(
      `listening for Pushbullet pushes (history_mode=${config.pushbullet.history_mode}, ` +
        `offline_only=${config.solver.offline_only}, reply=${config.reply.enabled}, reasoner=${reasonerMode})`
    );
    await listener.start();
    return status();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      listener.stop();
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
    return { ...listener.status?.(), reasoner: reasonerMode, reply: Boolean(responder) };
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
    inboxDir: effectiveInbox,
    secrets: { pushbullet: describeSecret(secrets.pushbullet), llm: describeSecret(secrets.llm) },
    handlePush,
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
  const app = await createApp(options);
  let closing = false;

  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    app.logger?.info?.(`received ${signal}; shutting down`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await app.start();
  return app;
}
