/**
 * The Pushbullet listener: real-time stream plus a poll fallback.
 *
 * Pushbullet has no webhooks, so there are two mechanisms and both are used:
 *
 *   1. `wss://stream.pushbullet.com/websocket/<token>` - tickles arrive in near
 *      real time. The stream carries `{"type":"tickle","subtype":"push"}` (fetch over
 *      REST), an inline `{"type":"push",...}`, and `{"type":"nop"}` keepalives.
 *   2. A 60 s poll of `GET /v2/pushes?modified_after=<watermark>` - because a
 *      WebSocket can die silently. A tickle may be lost, but the watermark cannot
 *      lose a push that the server still holds.
 *
 * Deduplication is durable, not in memory: every push is claimed in the `pushes`
 * table with an `INSERT ... ON CONFLICT DO NOTHING`, so a duplicate tickle, a
 * replayed stream message and a restart all see the same "already mine" answer.
 * A Set would forget everything on restart, which is exactly when the duplicates
 * happen.
 *
 * The watermark is a `modified` timestamp persisted in `kv`. It advances for every
 * push the listener sees, including ones the filter rejects - otherwise a rejected
 * push would be re-fetched on every poll forever.
 *
 * `history_mode`:
 *   - `ignore` (default): on first run, whatever is already in the account is
 *     marked as seen without being answered. Coming online must not fire off
 *     answers to a week of backlog.
 *   - `watermark`: start from the stored watermark (0 if there is none) and answer
 *     the backlog.
 */
import { classifyPush } from './filter.js';
import { redactPushbullet } from './client.js';

export const DEFAULT_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 60_000;
export const DEFAULT_STARTUP_FETCH_LIMIT = 100;
export const WATERMARK_KEY = 'pushbullet_watermark';
export const HISTORY_MODES = ['ignore', 'watermark'];

const WS_OPEN = 1;

function describeSocketError(event) {
  if (!event) return 'unknown socket error';
  const error = event.error ?? event;
  // Undici's ErrorEvent can carry an Error with an empty message; `??` would keep
  // the empty string and log a blank line, so fall through on falsy values.
  const message = error?.message || event.message || error?.type || error?.code;
  return message ? String(message) : 'socket error';
}

/** A flat inline push loses its envelope; `file_*` fields are the only tell. */
function normalizeInlinePush(message) {
  if (message.push && typeof message.push === 'object') return message.push;
  const { type, ...push } = message;
  if (type === 'push' && (push.file_url || push.file_name)) return { ...push, type: 'file' };
  return { ...push, type };
}

export function createListener({
  client,
  store = null,
  onPush = null,
  filter = classifyPush,
  filterOptions = {},
  historyMode = 'ignore',
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  WebSocketImpl = globalThis.WebSocket,
  reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
  reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  jitter = Math.random,
  now = () => Date.now() / 1000,
  logger = null,
  watermarkKey = WATERMARK_KEY,
  startupFetchLimit = DEFAULT_STARTUP_FETCH_LIMIT,
} = {}) {
  if (!client?.getPushes) throw new Error('createListener needs a pushbullet client');
  if (!HISTORY_MODES.includes(historyMode)) {
    throw new Error(`history_mode must be one of ${HISTORY_MODES.join(', ')}, got ${JSON.stringify(historyMode)}`);
  }

  let watermark = readWatermark();
  const seen = new Set(); // best-effort fallback only when no store is configured

  let ws = null;
  let started = false;
  let stopped = true;
  let reconnectTimer = null;
  let pollTimer = null;
  let reconnectAttempts = 0;
  let reconnects = 0;
  let lastTickleAt = null;
  let lastMessageAt = null;

  // One serial queue. A tickle that arrives while a poll is running is queued
  // behind it rather than racing it, so no push is skipped and state stays ordered.
  let queue = Promise.resolve();
  function enqueue(task) {
    const run = queue.then(task, task);
    queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  function reportError(err) {
    logger?.warn?.(`pushbullet listener: ${redactPushbullet(String(err?.message ?? err))}`);
  }

  function readWatermark() {
    const raw = store ? store.get(watermarkKey, null) : null;
    const value = raw == null ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function advanceWatermark(modified) {
    if (!Number.isFinite(modified)) return;
    if (watermark != null && modified <= watermark) return;
    watermark = modified;
    store?.set(watermarkKey, String(modified));
  }

  /**
   * Establish where "now" is. In `ignore` mode this is the only place that looks at
   * existing history, and it does so without claiming or answering anything.
   *
   * Called lazily from `poll()` as well: if the app starts while Pushbullet is
   * unreachable, the first poll retries the bootstrap instead of falling back to
   * watermark 0 and answering the whole backlog.
   */
  async function bootstrap() {
    if (watermark != null) return watermark;
    if (historyMode === 'watermark') {
      advanceWatermark(0);
      logger?.info?.('history_mode=watermark: answering pushes after the stored watermark');
      return watermark;
    }
    const pushes = await client.getPushes({ limit: startupFetchLimit });
    const newest = pushes.reduce((max, push) => {
      const modified = Number(push?.modified);
      return Number.isFinite(modified) && modified > max ? modified : max;
    }, 0);
    advanceWatermark(newest);
    logger?.info?.(`history_mode=ignore: marked ${pushes.length} pre-existing push(es) as seen`);
    return watermark;
  }

  function claim(push, status) {
    if (!store) {
      if (seen.has(push.iden)) return false;
      seen.add(push.iden);
      return true;
    }
    return store.claimPush(push, { status });
  }

  async function handlePushOnce(push) {
    if (!push || typeof push !== 'object' || !push.iden) {
      return { accepted: false, reason: 'no-iden' };
    }
    advanceWatermark(Number(push.modified));

    const verdict = filter(push, filterOptions);
    const fresh = claim(push, verdict.accepted ? 'new' : 'ignored');
    if (!fresh) return { accepted: false, reason: 'duplicate' };
    if (!verdict.accepted) return { accepted: false, reason: verdict.reason };
    if (!onPush) return { accepted: true, reason: 'no-handler' };

    try {
      await onPush(push, { store });
      return { accepted: true, reason: 'processed' };
    } catch (err) {
      // A failing puzzle must not kill the listener; record it and keep watching.
      store?.setPushStatus(push.iden, 'error');
      logger?.warn?.(
        `pushbullet: handling ${push.iden} failed: ${redactPushbullet(String(err?.message ?? err))}`
      );
      return { accepted: true, reason: 'error' };
    }
  }

  async function pollOnce() {
    if (watermark == null) await bootstrap(); // may throw; the caller retries next tick
    const since = watermark ?? 0;
    const pushes = await client.getPushes({ modifiedAfter: since, limit: 100 });
    const ordered = pushes
      .filter((push) => push && typeof push === 'object' && push.iden)
      .sort((a, b) => (Number(a.modified) || 0) - (Number(b.modified) || 0));

    let processed = 0;
    for (const push of ordered) {
      const outcome = await handlePushOnce(push);
      if (outcome.accepted) processed += 1;
      // The watermark advances per push (inside handlePushOnce), so a crash
      // halfway through a batch only replays pushes whose rows do not exist yet.
    }
    return { fetched: ordered.length, processed };
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectAttempts += 1;
    const cap = Math.min(reconnectBaseMs * 2 ** (reconnectAttempts - 1), reconnectMaxMs);
    const delay = cap * (0.5 + jitter() * 0.5); // jitter inside [0.5, 1.0] of the cap
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnects += 1;
      connect();
    }, delay);
    logger?.warn?.(`pushbullet stream reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts})`);
  }

  function connect() {
    if (stopped || !started) return null;
    if (typeof WebSocketImpl !== 'function') {
      reportError(new Error('no WebSocket implementation available'));
      return null;
    }

    let socket;
    try {
      socket = new WebSocketImpl(client.streamUrl);
    } catch (err) {
      reportError(err);
      scheduleReconnect();
      return null;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      reconnectTimer = null;
      logger?.info?.('pushbullet stream connected');
    });

    socket.addEventListener('message', (event) => {
      lastMessageAt = now();
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        logger?.warn?.('pushbullet stream sent a non-JSON message');
        return;
      }
      if (!message || typeof message !== 'object') return;

      if (message.type === 'nop') return; // keepalive
      if (message.type === 'tickle') {
        lastTickleAt = now();
        // A device/chat tickle says nothing about new pushes.
        if (message.subtype && message.subtype !== 'push') return;
        enqueue(() => pollOnce()).catch(reportError);
        return;
      }
      if (message.type === 'push') {
        enqueue(() => handlePushOnce(normalizeInlinePush(message))).catch(reportError);
      }
    });

    socket.addEventListener('error', (event) => {
      logger?.warn?.(`pushbullet stream error: ${redactPushbullet(describeSocketError(event))}`);
    });

    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      if (!stopped) scheduleReconnect();
    });

    return socket;
  }

  async function start() {
    if (started) return status();
    started = true;
    stopped = false;

    try {
      await bootstrap();
    } catch (err) {
      // Keep going: the poll tick retries the bootstrap before processing anything.
      reportError(err);
    }

    connect();
    const tick = () => enqueue(() => pollOnce()).catch(reportError);
    tick(); // catch pushes that arrived between bootstrap and connecting
    if (pollIntervalMs > 0) pollTimer = setInterval(tick, pollIntervalMs);
    return status();
  }

  function stop() {
    stopped = true;
    started = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    const socket = ws;
    ws = null;
    try {
      socket?.close();
    } catch {
      // already closing
    }
  }

  function status() {
    return {
      connected: Boolean(ws) && ws.readyState === WS_OPEN,
      reconnects,
      lastTickleAt,
      lastMessageAt,
      watermark,
      historyMode,
    };
  }

  return {
    start,
    stop,
    status,
    /** Run one REST catch-up now (queued behind any in-flight work). */
    poll: () => enqueue(() => pollOnce()),
    /** Deliver one push through dedupe/filter/handler as if it came from the stream. */
    handlePush: (push) => enqueue(() => handlePushOnce(push)),
    get connected() {
      return status().connected;
    },
  };
}
