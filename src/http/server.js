/**
 * HTTP ingress: `POST /v1/solve`, one puzzle in the body, the answer in the body.
 *
 * This is an *ingress* in the sense of `src/solver/core.js`: it turns a request into
 * a file the unchanged core can solve, then egresses the result as JSON. It shares
 * `validateImageBuffer` with the Pushbullet fetcher rather than re-implementing the
 * size/magic/decode gate, so there is one place where "is this an image?" is decided.
 *
 * Security is the point of this module, not an afterthought:
 *
 *  - it binds loopback by default and warns loudly otherwise;
 *  - every request needs a constant-time-checked bearer token (there is no anonymous
 *    mode); the token is resolved through `src/secrets.js` like every other secret;
 *  - the body is capped while streaming, then passed through the shared decode gate;
 *  - requests are rate limited, and a model-escalated solve is labelled in the
 *    response so the caller can see that it cost provider credits;
 *  - the response never contains the image, a secret or an upstream error body.
 *
 * The unsolved case is a `422` with `answer: null`. The one invariant holds: an answer
 * that did not pass validation is never returned, and nothing is ever guessed.
 */
import { createServer as createHttpServerImpl } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import {
  DEFAULT_MIN_HEIGHT,
  DEFAULT_MAX_HEIGHT,
  DEFAULT_MAX_PIXELS,
  DEFAULT_MAX_WIDTH,
  ImageFetchError,
  downloadImage,
  validateImageBuffer,
  saveImage,
} from '../pushbullet/files.js';
import { redactRecord } from '../redact.js';
import { DEFAULT_HTTP_BIND, DEFAULT_HTTP_PORT, DEFAULT_RATE_LIMIT_PER_MIN, DEFAULT_TIMEOUT_MS, SOLVE_PATH } from './defaults.js';

export { DEFAULT_HTTP_BIND, DEFAULT_HTTP_PORT, DEFAULT_RATE_LIMIT_PER_MIN, DEFAULT_TIMEOUT_MS, SOLVE_PATH };

const LOOPBACK_HOSTS = new Set(['::1', 'localhost']);

/** Minimum HTTP bearer token length (#47). Long enough that guessing is hopeless. */
export const MIN_HTTP_TOKEN_LENGTH = 16;

// Values that are common enough to be guessed before the first request. Case-insensitive.
const WEAK_TOKENS = new Set([
  'changeme',
  'password',
  'secret',
  'token',
  'admin',
  'test',
  'letmein',
  'default',
  'http-auth-token',
  'bearer',
]);

/**
 * Describe why an HTTP bearer token is unfit to guard the solver, or `null` if it is fine.
 * Kept as a plain function so `createApp` and `createHttpServer` report the same reason.
 */
export function httpTokenProblem(token) {
  const value = typeof token === 'string' ? token : '';
  if (value.trim() === '') return 'the token is empty';
  if (WEAK_TOKENS.has(value.toLowerCase())) return 'the token is a well-known weak value';
  if (value.length < MIN_HTTP_TOKEN_LENGTH) {
    return `the token is ${value.length} character(s); at least ${MIN_HTTP_TOKEN_LENGTH} are required (try \`openssl rand -hex 24\`)`;
  }
  if (new Set(value).size < 4) return 'the token has too little variation to resist guessing';
  return null;
}

/** Throw with an actionable message when the token is too weak (#47). */
export function assertHttpToken(token) {
  const problem = httpTokenProblem(token);
  if (problem) throw new Error(`the HTTP bearer token is not usable: ${problem}`);
  return true;
}

/** A deliberately-tagged error carrying the HTTP status the caller should see. */
export class HttpError extends Error {
  constructor(status, code, reason = null, headers = {}) {
    super(reason ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.headers = headers;
  }
}

/** The solve did not finish inside `http.timeout_ms`. */
export class SolveTimeoutError extends Error {
  constructor(ms) {
    super(`solve exceeded the ${ms}ms budget`);
    this.name = 'SolveTimeoutError';
    this.status = 504;
    this.code = 'solve_timeout';
  }
}

/** Map the fetcher's reason tags onto honest status codes. */
export function imageErrorStatus(err) {
  switch (err?.reason) {
    case 'size':
    case 'width':
    case 'pixels':
      return 413;
    case 'http':
      return 502;
    case 'no-url':
      return 400;
    // magic | decode | height - the bytes are not an image we can use
    default:
      return 415;
  }
}

/**
 * True when `host` is loopback and the bind does not need a warning.
 *
 * Validates the *whole* host, not a prefix: `127.evil.example` merely starts with
 * `127.` and is a network hostname, so treating it as loopback would suppress the
 * exposure warning this function exists to trigger (#47). Only an address in
 * `127.0.0.0/8`, `::1` (or its IPv4-mapped form) or exactly `localhost` qualifies.
 */
export function isLoopbackHost(host) {
  if (!host) return false;
  let value = String(host).trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (LOOPBACK_HOSTS.has(value)) return true;
  const kind = isIP(value);
  if (kind === 4) return Number(value.split('.')[0]) === 127;
  if (kind === 6) {
    // `::ffff:127.0.0.1` is the same address as `127.0.0.1`; other IPv6 is not loopback.
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(value);
    return mapped ? Number(mapped[1].split('.')[0]) === 127 : false;
  }
  return false;
}

/** Constant-time bearer check. Length is compared first because timingSafeEqual requires it. */
export function tokenMatches(expected, header) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(header ?? ''));
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length) return false;
  return timingSafeEqual(provided, wanted);
}

/** Read the request body, refusing to buffer past the cap. */
function readBodyCapped(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      // After a cap breach keep draining (without buffering) so the client finishes
      // sending and the 413 can actually be written. Destroying the socket here would
      // close the connection before the response left the server.
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(err));
    req.on('aborted', () => fail(new HttpError(400, 'request_aborted', 'request aborted before the body was read')));
  });
}

/** Parse the first file part of a multipart body using the platform's own parser. */
async function firstFormFile(contentType, body) {
  let form;
  try {
    const request = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    form = await request.formData();
  } catch {
    throw new HttpError(400, 'bad_multipart', 'multipart body could not be parsed');
  }
  for (const [, value] of form.entries()) {
    if (value && typeof value === 'object' && typeof value.arrayBuffer === 'function') {
      return { buffer: Buffer.from(await value.arrayBuffer()), filename: value.name ?? null };
    }
  }
  return null;
}

/** `data:image/png;base64,...` and bare base64 are both accepted. */
export function decodeBase64Image(text) {
  const value = String(text ?? '');
  const stripped = value.replace(/^data:image\/[A-Za-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (stripped === '' || !/^[A-Za-z0-9+/=]+$/.test(stripped)) {
    throw new HttpError(400, 'bad_image_base64', 'image_base64 is not valid base64');
  }
  return Buffer.from(stripped, 'base64');
}

/** Only http(s) URLs; the caller is authenticated, but an image URL still fetches. */
export function assertHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new HttpError(400, 'bad_image_url', 'image_url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'bad_image_url', 'image_url must be http or https');
  }
  return url.toString();
}

/** Parse the request into a description the resolver can act on, without touching bytes yet. */
async function classifyRequest(req, body) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.startsWith('multipart/form-data')) {
    const file = await firstFormFile(contentType, body);
    if (!file) throw new HttpError(400, 'missing_image', 'multipart body had no file part');
    return { kind: 'raw', buffer: file.buffer, deliver: null };
  }
  if (contentType.includes('application/json')) {
    let json;
    try {
      json = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      throw new HttpError(400, 'bad_json', 'request body is not valid JSON');
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new HttpError(400, 'bad_json', 'request body must be a JSON object');
    }
    return {
      kind: 'json',
      json,
      deliver: typeof json.deliver === 'string' ? json.deliver : null,
    };
  }
  if (contentType.startsWith('image/')) return { kind: 'raw', buffer: body, deliver: null };
  throw new HttpError(415, 'unsupported_media_type', 'send image/*, multipart/form-data or application/json');
}

/** Resolve the parsed request to a validated image (bytes + ext) and the requested egress. */
async function resolveImage(parsed, { inboxDir, maxBodyBytes, fetchImpl, imageLimits }) {
  const saveValidated = (validated) => {
    const iden = `http-${createHash('sha256').update(validated.buffer).digest('hex').slice(0, 32)}`;
    const path = saveImage(validated.buffer, { inboxDir, iden, ext: validated.ext });
    return { ...validated, path, iden };
  };

  if (parsed.kind === 'json') {
    if (typeof parsed.json.image_base64 === 'string') {
      const bytes = decodeBase64Image(parsed.json.image_base64);
      return saveValidated(await validateImageBuffer(bytes, { maxBytes: maxBodyBytes, ...imageLimits }));
    }
    if (typeof parsed.json.image_url === 'string') {
      const url = assertHttpUrl(parsed.json.image_url);
      const image = await downloadImage(url, { fetchImpl, maxBytes: maxBodyBytes, ...imageLimits });
      return saveValidated(image);
    }
    throw new HttpError(400, 'missing_image', 'provide image_base64 or image_url');
  }
  return saveValidated(await validateImageBuffer(parsed.buffer, { maxBytes: maxBodyBytes, ...imageLimits }));
}

/**
 * Serialise one pipeline result. `answer` is null when unresolved - never a guess.
 *
 * `requireConfidence` mirrors the Pushbullet responder's policy (#42): an answer
 * that passed the class validator but was never corroborated is withheld from the
 * body entirely (not merely flagged), so the HTTP and Pushbullet egresses cannot
 * disagree about whether it may be sent. The unpicked candidate is deliberately not
 * echoed under an adjacent field - a caller that could read it would be one line
 * away from using it.
 */
export function formatSolveResponse(
  result,
  { image, deliver = null, delivered = null, modelNames = {}, unresolvedReply = null, requireConfidence = false } = {}
) {
  const candidate = result?.answer != null;
  const withheld = candidate && requireConfidence && result?.confident !== true;
  const answered = candidate && !withheld;
  const method = result?.method ?? null;
  const tier = method?.startsWith('model:') ? method.slice('model:'.length) : answered ? 'tier0' : 'none';
  const escalated = Boolean(result?.model);
  // The models actually consulted, not merely the winning tier: a tier0 answer that
  // needed a model opinion was still billed.
  const consulted = result?.model
    ? [result.model.text ? modelNames.text : null, result.model.vision ? modelNames.vision : null].filter(Boolean)
    : [];
  const body = {
    status: answered ? 'solved' : 'unresolved',
    answer: answered ? result.answer : null,
    method,
    confident: result?.confident === true,
    puzzleClass: result?.puzzleClass ?? null,
    transcript: result?.transcript ?? null,
    // The caller pays for a routed call; say so rather than hiding it behind `method`.
    cost: { escalated, tier, model: consulted },
    opinions: result?.opinions?.map((o) => ({ source: o.source, answer: o.answer })) ?? [],
  };
  if (withheld) {
    // The candidate exists but policy withheld it. No acknowledgement: the
    // Pushbullet responder stays silent for this case too (DESIGN 4.11), and the
    // reason tag is enough for a programmatic caller to tell it from "no answer".
    body.reason = 'unconfirmed';
  } else if (!answered) {
    body.reason = result?.disputed ? 'tiers disagreed; no answer was sent' : 'no tier produced a valid answer';
    // The structured response is the contract for a programmatic caller; the human
    // acknowledgement is offered as an additional field, never as prose replacing it.
    if (unresolvedReply && String(unresolvedReply.text ?? '').trim() !== '') {
      body.unresolvedReply = { title: unresolvedReply.title ?? null, text: String(unresolvedReply.text) };
    }
  }
  if (image) {
    body.image = { bytes: image.bytes, width: image.width, height: image.height };
  }
  if (deliver) {
    body.delivery = { requested: deliver, ...(delivered ?? { sent: false, reason: 'not-attempted' }) };
  }
  return body;
}

/** Fixed-window per-client limiter. In-memory: one process, low volume (DESIGN 3). */
export function createRateLimiter({ limit, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return {
    take(key) {
      // `rate_limit_per_min = 0` means disabled, not "allow one then refuse".
      if (!(limit > 0)) return { allowed: true, remaining: null, retryAfterSec: 0 };
      const at = now();
      const entry = hits.get(key);
      if (!entry || at - entry.start >= windowMs) {
        hits.set(key, { start: at, count: 1 });
        return { allowed: true, remaining: Math.max(0, limit - 1), retryAfterSec: 0 };
      }
      if (entry.count >= limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((entry.start + windowMs - at) / 1000)),
        };
      }
      entry.count += 1;
      return { allowed: true, remaining: Math.max(0, limit - entry.count), retryAfterSec: 0 };
    },
    size: () => hits.size,
  };
}

/**
 * Bounded failed-auth throttle, per client (#47).
 *
 * The request limiter only runs after a token check, so before this a caller could
 * hammer 401s forever. After `limit` failures the client is blocked for a backoff
 * that doubles with each further trip (1s, 2s, 4s … capped), and a success clears
 * the record so a user who finally types the right token is not locked out. In-memory
 * like the rate limiter: one process, low volume.
 */
export const DEFAULT_AUTH_FAILURE_LIMIT = 5;

export function createAuthThrottle({
  limit = DEFAULT_AUTH_FAILURE_LIMIT,
  windowMs = 60_000,
  baseBackoffSec = 1,
  maxBackoffSec = 900,
  now = () => Date.now(),
} = {}) {
  const entries = new Map();
  const blocked = (entry, at) => entry.blockedUntil > at;
  const retryAfter = (entry, at) => Math.max(1, Math.ceil((entry.blockedUntil - at) / 1000));
  return {
    /** Check before the token comparison so a blocked client never reaches the compare. */
    check(key) {
      const at = now();
      const entry = entries.get(key);
      if (!entry || !blocked(entry, at)) return { allowed: true, retryAfterSec: 0 };
      return { allowed: false, retryAfterSec: retryAfter(entry, at) };
    },
    /** Record a failed attempt; the trip itself already returns `allowed: false`. */
    fail(key) {
      const at = now();
      let entry = entries.get(key);
      if (!entry || (entry.blockedUntil <= at && at - entry.windowStart >= windowMs)) {
        entry = { count: 0, windowStart: at, blockedUntil: 0, trips: 0 };
        entries.set(key, entry);
      }
      entry.count += 1;
      if (entry.count < limit) return { allowed: true, retryAfterSec: 0 };
      entry.trips += 1;
      const backoff = Math.min(maxBackoffSec, baseBackoffSec * 2 ** (entry.trips - 1));
      entry.blockedUntil = at + backoff * 1000;
      entry.count = 0;
      entry.windowStart = at;
      return { allowed: false, retryAfterSec: backoff };
    },
    succeed(key) {
      entries.delete(key);
    },
    size: () => entries.size,
  };
}

/**
 * Race a promise against a deadline. The losing solve keeps running and is
 * discarded - cancellation mid-Tesseract is not possible, and this helper does not
 * pretend otherwise. `onTimeout` runs when the deadline wins, which is how HTTP
 * marks a request abandoned so a *queued* task can still be skipped at dequeue.
 */
export function withTimeout(promise, ms, onTimeout = null) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // A bookkeeping hook must not turn a clean 504 into a 500.
      }
      reject(new SolveTimeoutError(ms));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Build the HTTP ingress. It owns no listener of its own; `start()` binds and
 * `stop()` closes, so the app can run it beside the Pushbullet ingress or alone.
 */
export function createHttpServer({
  core,
  token,
  config,
  inboxDir,
  responder = null,
  logger = null,
  fetchImpl = globalThis.fetch,
  createServerImpl = createHttpServerImpl,
  now = () => Date.now(),
  randomId = () => randomUUID(),
} = {}) {
  if (!core?.solve) throw new Error('createHttpServer needs the solve core');
  if (!config?.http) throw new Error('createHttpServer needs config.http');
  if (!token) throw new Error('createHttpServer needs a bearer token; there is no anonymous mode');
  // A one-character token is accepted by `tokenMatches` but is an oracle with a
  // guessable key; refuse it rather than pretend the bind is protected (#47).
  assertHttpToken(token);

  const http = config.http;
  // The gate's limits come from config where they are configurable, and from the
  // shared defaults otherwise. `maxBytes` is the HTTP body cap; the push path keeps
  // its own byte default in `downloadImage`.
  const imageLimits = {
    minHeight: DEFAULT_MIN_HEIGHT,
    maxHeight: DEFAULT_MAX_HEIGHT,
    maxWidth: config.image?.max_width ?? DEFAULT_MAX_WIDTH,
    maxPixels: config.image?.max_pixels ?? DEFAULT_MAX_PIXELS,
  };
  const modelNames = { text: config.solver?.llm_text_model ?? null, vision: config.solver?.llm_vision_model ?? null };
  // The acknowledgement a human would receive for an unresolved puzzle. It is reported
  // even when nothing is delivered, so a caller can relay the same wording.
  const unresolvedReply =
    config.reply?.enabled === true && String(config.reply.unresolved_text ?? '').trim() !== ''
      ? { title: config.reply.unresolved_title ?? null, text: config.reply.unresolved_text }
      : null;
  const limiter = createRateLimiter({ limit: http.rate_limit_per_min, now });
  // Separate from the request limiter: before this, a wrong token never reached the
  // limiter at all, so 401s were unlimited (#47). A correct token clears the record.
  const authThrottle = createAuthThrottle({ now });
  // `reply.require_confidence` is a policy about answers, not a Pushbullet-only
  // setting: an answer that passed validation but was never corroborated is withheld
  // on both egresses (#42). It applies even with `reply.enabled = false`, because that
  // switch stops sending, it does not change what is safe to send.
  const requireConfidence = config.reply?.require_confidence === true;

  // Admission control is the HTTP-specific queue bound (#43). Serialisation is the
  // core's shared lock; this only decides how many HTTP requests may wait on it. A
  // caller that stops reading cannot leave an unbounded backlog spending provider
  // credits after it is gone. Pushbullet and the tray are deliberately exempt - a
  // push is not retried by a buggy loop and must not be dropped.
  const maxQueue = http.max_queue;
  const QUEUE_RETRY_AFTER_SEC = 1;
  let inflight = 0;
  function acquireSlot() {
    if (inflight >= maxQueue) return false;
    inflight += 1;
    return true;
  }
  function releaseSlot() {
    inflight = Math.max(0, inflight - 1);
  }

  function send(res, status, payload, headers = {}) {
    if (res.writableEnded || res.destroyed) return;
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    res.end(body);
  }

  function sendError(res, err, startedAt) {
    if (err instanceof HttpError) {
      return send(res, err.status, { error: err.code, reason: err.reason }, err.headers);
    }
    if (err instanceof ImageFetchError) {
      return send(res, imageErrorStatus(err), { error: 'invalid_image', reason: err.reason });
    }
    if (err instanceof SolveTimeoutError) {
      return send(res, 504, { error: 'solve_timeout', reason: 'the solve exceeded the configured budget; nothing was sent' });
    }
    // Never leak an upstream error body, a stack or a key. Log a redacted line with an
    // id so the caller can quote it without the server disclosing internals.
    const id = randomId();
    logger?.warn?.(
      `http: request ${id} failed after ${now() - startedAt}ms: ${redactRecord(String(err?.message ?? err))}`
    );
    return send(res, 500, { error: 'internal', id });
  }

  function clientKey(req) {
    const remote = req.socket?.remoteAddress ?? 'unknown';
    return String(remote);
  }

  async function handleRequest(req, res) {
    const startedAt = now();
    // `slot` is released either when the core's promise settles (the normal path,
    // including a timeout that already answered the caller) or, if we never handed
    // the request to the core, on the way out of an error. Releasing on response
    // rather than on core settlement would under-count a timed-out queued task.
    let slot = false;
    let handedToCore = false;
    const safeRelease = () => {
      if (!slot) return;
      slot = false;
      releaseSlot();
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== SOLVE_PATH) {
        return send(res, 404, { error: 'not_found' });
      }
      if (req.method !== 'POST') {
        return send(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
      }
      const client = clientKey(req);
      const gate = authThrottle.check(client);
      if (!gate.allowed) {
        return send(
          res,
          429,
          { error: 'too_many_auth_failures', retryAfterSec: gate.retryAfterSec },
          { 'retry-after': String(gate.retryAfterSec) }
        );
      }
      if (!tokenMatches(token, req.headers['authorization'])) {
        const outcome = authThrottle.fail(client);
        if (!outcome.allowed) {
          return send(
            res,
            429,
            { error: 'too_many_auth_failures', retryAfterSec: outcome.retryAfterSec },
            { 'retry-after': String(outcome.retryAfterSec) }
          );
        }
        return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      }
      authThrottle.succeed(client);

      const budget = limiter.take(client);
      if (!budget.allowed) {
        return send(
          res,
          429,
          { error: 'rate_limited', retryAfterSec: budget.retryAfterSec },
          { 'retry-after': String(budget.retryAfterSec) }
        );
      }

      // Checked before the body is read so a full queue is refused without decoding
      // an image. `429` already means the rate limit, so a full queue is its own
      // `503` with a `Retry-After`; the two are not conflated.
      if (!acquireSlot()) {
        return send(
          res,
          503,
          { error: 'queue_full', retryAfterSec: QUEUE_RETRY_AFTER_SEC },
          { 'retry-after': String(QUEUE_RETRY_AFTER_SEC) }
        );
      }
      slot = true;

      const body = await readBodyCapped(req, http.max_body_bytes);
      const parsed = await classifyRequest(req, body);
      const image = await resolveImage(parsed, {
        inboxDir,
        maxBodyBytes: http.max_body_bytes,
        fetchImpl,
        imageLimits,
      });

      const deliver = parsed.deliver ?? (url.searchParams.get('deliver') || null);
      // The budget starts at arrival and includes queue wait. What #43 changes is not
      // the clock but the consequence: a task that has not started when its deadline
      // passes is skipped at dequeue rather than run in full. Once Tesseract is
      // running, cancellation is not possible and this does not pretend otherwise.
      let abandoned = false;
      const markAbandoned = () => {
        abandoned = true;
      };
      // A client that disconnects before the response is written has stopped waiting.
      // `res` also emits `close` after a normal `end`; `writableEnded` tells those apart.
      res.on('close', () => {
        if (!res.writableEnded) markAbandoned();
      });
      const solvePromise = core.solve(image.path, { subject: image.iden, canStart: () => !abandoned });
      solvePromise.then(safeRelease, safeRelease);
      handedToCore = true;
      const result = await withTimeout(solvePromise, http.timeout_ms, markAbandoned);

      let delivered = null;
      if (deliver === 'pushbullet') {
        const syntheticPush = {
          iden: image.iden,
          type: 'file',
          file_name: `http-${image.iden}`,
          modified: now() / 1000,
        };
        if (responder) {
          const outcome = await responder.respond(syntheticPush, result);
          delivered = {
            sent: outcome.sent === true,
            reason: outcome.reason ?? null,
            strategy: outcome.strategy ?? null,
            unresolved: outcome.unresolved === true,
          };
        } else {
          delivered = { sent: false, reason: 'reply-disabled' };
        }
      }

      const withheld = result.answer != null && requireConfidence && result.confident !== true;
      const status = result.answer != null && !withheld ? 200 : 422;
      logger?.info?.(
        `http: ${status} ${withheld ? `withheld-unconfirmed (${result.answer})` : result.answer ?? 'unresolved'} ` +
          `in ${now() - startedAt}ms (${result.method ?? 'no method'}, escalated=${Boolean(result.model)})`
      );
      return send(
        res,
        status,
        formatSolveResponse(result, { image, deliver, delivered, modelNames, unresolvedReply, requireConfidence })
      );
    } catch (err) {
      return sendError(res, err, startedAt);
    } finally {
      if (!handedToCore) safeRelease();
    }
  }

  const server = createServerImpl((req, res) => {
    handleRequest(req, res).catch((err) => {
      // handleRequest has its own catch, so reaching here means `send` itself threw.
      logger?.warn?.(`http: request failed after headers were considered sent: ${redactRecord(String(err?.message ?? err))}`);
      if (!res.writableEnded) {
        try {
          res.destroy();
        } catch {
          // nothing else to do
        }
      }
    });
  });

  // A runtime error after `listening` must not become an unhandled 'error' event and
  // take the process down; startup errors are still surfaced by the `once` below.
  server.on('error', (err) => logger?.warn?.(`http server error: ${redactRecord(String(err?.message ?? err))}`));

  let address = null;

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        address = server.address();
        if (!isLoopbackHost(http.bind)) {
          logger?.warn?.(
            `http.bind=${http.bind} exposes the solver beyond this machine. Anyone who has the ` +
              'bearer token can spend your provider credits. Prefer 127.0.0.1.'
          );
        }
        logger?.info?.(`http ingress listening on http://${http.bind}:${address?.port}${SOLVE_PATH}`);
        resolve(address);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: http.bind, port: http.port });
    });
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  return {
    start,
    stop,
    server,
    get address() {
      return address;
    },
    port: () => address?.port ?? http.port,
    status() {
      return { listening: server.listening, host: http.bind, port: address?.port ?? http.port, clients: limiter.size() };
    },
  };
}

