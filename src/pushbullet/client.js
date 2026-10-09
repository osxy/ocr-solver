/**
 * Pushbullet REST client over the built-in `fetch`.
 *
 * One POST/GET with retries is all this app needs, so the API is small and the
 * transport is injectable - the offline suite swaps `fetchImpl` for the local
 * stub in `tests/fake-pushbullet.js` and never touches the real service.
 *
 * Retry policy: transient statuses (408/409/425/429/5xx) are retried with
 * exponential backoff and jitter. 401/403 fail immediately: a bad token will
 * still be bad after three attempts, and burning retries on it only delays the
 * error and trips upstream rate limiting for nothing.
 *
 * Every error body that leaves this module is redacted, because Pushbullet echoes
 * request context back in error messages and the token travels in the headers.
 */
import { redactPushbullet } from '../redact.js';

export { redactPushbullet };

export class PushbulletError extends Error {
  constructor(message, { status = null, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'PushbulletError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

export const DEFAULT_BASE_URL = 'https://api.pushbullet.com';
export const DEFAULT_STREAM_BASE_URL = 'wss://stream.pushbullet.com';
const DEFAULT_BASE_HOST = new URL(DEFAULT_BASE_URL).hostname;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The stream lives on a different host than the REST API in production
 * (`api.pushbullet.com` vs `stream.pushbullet.com`). Deriving it from `baseUrl`
 * makes a local stub work with one option instead of two, so the known API host
 * is mapped explicitly by hostname - swapping only the scheme builds
 * `wss://api.pushbullet.com/websocket/<token>`, which is the wrong host, and a
 * string-replace of `api.` would rewrite any host that happens to contain it.
 * Every other host (the loopback double included) keeps its own name.
 */
function deriveStreamBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.hostname === DEFAULT_BASE_HOST) return DEFAULT_STREAM_BASE_URL;
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}`;
}

export function createPushbulletClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  streamBaseUrl = null,
  fetchImpl = globalThis.fetch,
  // DESIGN 4.11: a 429 is backed off *once*. A longer ladder would be more
  // forgiving for 5xx, but the responder's hourly cap is the level that must not
  // be exceeded, and the outbox claim already makes a lost retry safe.
  maxRetries = 1,
  timeoutMs = 30_000,
  backoffBaseMs = 500,
  backoffMaxMs = 8_000,
  sleep = defaultSleep,
  jitter = Math.random,
  logger = null,
} = {}) {
  if (!token) {
    throw new Error('createPushbulletClient needs a token (env/secret store only, never the config file)');
  }
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');

  const root = String(baseUrl).replace(/\/+$/, '');
  const streamRoot = String(streamBaseUrl ?? deriveStreamBaseUrl(root)).replace(/\/+$/, '');
  const calls = [];

  async function request(method, path, { query = null, body = null } = {}) {
    const url = new URL(`${root}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value != null && value !== '') url.searchParams.set(key, String(value));
    }

    const headers = { 'access-token': token };
    if (body != null) headers['content-type'] = 'application/json';

    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetchImpl(url.toString(), {
          method,
          headers,
          body: body == null ? undefined : JSON.stringify(body),
          // A fresh signal per attempt, otherwise attempt 2 inherits what is left
          // of attempt 1's timeout budget.
          signal: AbortSignal.timeout(timeoutMs),
        });
        const raw = await response.text();

        if (!response.ok) {
          throw new PushbulletError(`pushbullet ${method} ${path} failed with HTTP ${response.status}`, {
            status: response.status,
            retryable: RETRYABLE_STATUS.has(response.status),
            body: redactPushbullet(raw).slice(0, 500),
          });
        }

        let parsed = null;
        if (raw !== '') {
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new PushbulletError('pushbullet returned a non-JSON body', {
              status: response.status,
              retryable: false,
              body: redactPushbullet(raw).slice(0, 500),
            });
          }
        }
        calls.push({ method, path, status: response.status, attempt });
        return parsed;
      } catch (err) {
        lastError =
          err instanceof PushbulletError
            ? err
            : new PushbulletError(redactPushbullet(String(err?.message ?? err)), { retryable: true });

        if (!lastError.retryable || attempt === maxRetries) break;
        const backoff = Math.min(backoffBaseMs * 2 ** attempt, backoffMaxMs) * (0.5 + jitter() * 0.5);
        logger?.warn?.(
          `pushbullet ${method} ${path}: ${lastError.message}; ` +
            `retry ${attempt + 1}/${maxRetries} in ${Math.round(backoff)}ms`
        );
        await sleep(backoff);
      }
    }

    calls.push({ method, path, error: lastError });
    throw lastError;
  }

  return {
    baseUrl: root,
    streamUrl: `${streamRoot}/websocket/${encodeURIComponent(token)}`,

    /** Request log for tests and debugging; never contains the token. */
    get calls() {
      return calls;
    },

    request,

    /** GET /v2/pushes - the poll fallback and the history bootstrap both use this. */
    async getPushes({ modifiedAfter = null, limit = 100, active = null } = {}) {
      const body = await request('GET', '/v2/pushes', {
        query: { modified_after: modifiedAfter, limit, active },
      });
      return Array.isArray(body?.pushes) ? body.pushes : [];
    },

    /** POST /v2/pushes - generic because the responder owns the payload shape. */
    async createPush(push) {
      if (!push || typeof push !== 'object' || !push.type) {
        throw new Error('createPush needs a push object with a type');
      }
      return request('POST', '/v2/pushes', { body: push });
    },

    /**
     * A note push is the only reply the API offers for a non-SMS push (DESIGN Q6).
     * `deviceIden` targets one device; omitted, Pushbullet delivers to every device
     * on the account, which is the safer default when the source is another user.
     */
    async createNote({ title, body, deviceIden = null } = {}) {
      return request('POST', '/v2/pushes', {
        body: {
          type: 'note',
          title,
          body,
          ...(deviceIden ? { device_iden: deviceIden } : {}),
        },
      });
    },
  };
}
