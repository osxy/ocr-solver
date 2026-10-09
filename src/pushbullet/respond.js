/**
 * The responder: turn a validated answer into exactly one Pushbullet note push.
 *
 * This is where the project's one invariant gets its teeth. A wrong answer (or a
 * repeated one) on a rate-limited form is worse than silence, so nothing is sent
 * unless the answer exists, passed validation, and - by default - was corroborated
 * (`require_confidence`). When no tier agreed, the puzzle is reported unresolved
 * and Pushbullet stays silent.
 *
 * Idempotency: the `outbox` row is inserted *before* the network call and is never
 * removed. If the process dies between claim and send, the answer is lost; if it
 * dies between send and the `sent_at` update, it is not sent again. That is the
 * deliberate trade - a missing note is recoverable, a duplicate is not.
 *
 * Strategies are pluggable because the delivery question is not settled: a note push
 * is what the API supports today, an SMS thread would be a true reply if the puzzle
 * ever arrives over mirrored SMS, and `clipboard+notify` is the fully local fallback.
 */
import { createHash } from 'node:crypto';
import { redactPushbullet } from './client.js';

export const DEFAULT_TITLE = 'Antwoord';
export const DEFAULT_MIN_INTERVAL_MS = 3_000;
export const DEFAULT_MAX_PER_HOUR = 20;

export function answerHash(answer) {
  return createHash('sha256').update(String(answer)).digest('hex').slice(0, 32);
}

/** Canonical formatting: the validator already lowercased words and kept digits as digits. */
export function formatAnswer(answer, { prefix = '', bold = false } = {}) {
  const text = String(answer);
  return `${prefix}${bold ? `**${text}**` : text}`;
}

/**
 * Strategy contract: `deliver(ctx)` performs the delivery and returns
 * `{ ok: boolean, response?: any, reason?: string }`, or throws on failure.
 * `ctx` = { client, store, push, result, answer, body, title, deviceIden }.
 */
export const STRATEGIES = {
  'note-push': {
    name: 'note-push',
    async deliver({ client, push, title, body, deviceIden }) {
      const response = await client.createNote({
        title,
        body,
        deviceIden: deviceIden ?? push?.source_device_iden ?? push?.device_iden ?? null,
      });
      return { ok: true, response };
    },
  },
  'sms-thread': {
    name: 'sms-thread',
    // Pushbullet only threads SMS; a file push has no thread id to reply to, so this
    // is a placeholder until the phone-side flow (v2 issue #10) exists.
    async deliver() {
      return { ok: false, reason: 'not-implemented' };
    },
  },
  'clipboard+notify': {
    name: 'clipboard+notify',
    // Deliberately local: no Pushbullet call at all. Needs the tray/notify work of M3.
    async deliver() {
      return { ok: false, reason: 'not-implemented' };
    },
  },
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createResponder({
  client,
  store = null,
  title = DEFAULT_TITLE,
  prefix = '',
  bold = false,
  requireConfidence = true,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxPerHour = DEFAULT_MAX_PER_HOUR,
  strategy = 'note-push',
  strategies = {},
  now = () => Date.now() / 1000,
  sleep = defaultSleep,
  logger = null,
} = {}) {
  if (!client?.createNote) throw new Error('createResponder needs a pushbullet client');
  const allStrategies = { ...STRATEGIES, ...strategies };
  const chosen = allStrategies[strategy];
  if (!chosen) {
    throw new Error(`unknown reply strategy ${JSON.stringify(strategy)}; have ${Object.keys(allStrategies).join(', ')}`);
  }

  async function respond(push, result, { answer = undefined } = {}) {
    const reply = answer !== undefined ? answer : result?.answer ?? null;
    const subject = push?.iden ?? 'unknown';

    const finish = (outcome) => {
      // Recording must never break solving, and `record` swallows its own errors.
      store?.record({
        subject,
        stage: 'respond',
        variant: chosen.name,
        payload: { answer: reply == null ? null : String(reply), ...outcome },
        ok: outcome.sent === true,
      });
      return outcome;
    };

    if (reply == null || String(reply).trim() === '') {
      return finish({ sent: false, reason: 'unresolved' });
    }
    if (requireConfidence && result?.confident !== true) {
      // The answer passed the class validator but no tier corroborated it. This is
      // the case the design singles out: `confident: false` must have a consequence.
      return finish({ sent: false, reason: 'unconfirmed' });
    }
    if (!push?.iden) {
      return finish({ sent: false, reason: 'no-push-iden' });
    }

    const hash = answerHash(reply);
    if (store?.getOutbox(push.iden, hash)) {
      return finish({ sent: false, reason: 'duplicate' });
    }

    // Rate limits are checked before the claim so a refused send can still happen
    // later; a claimed-but-refused note would be lost forever.
    if (store && store.countSentSince(now() - 3_600) >= maxPerHour) {
      return finish({ sent: false, reason: 'rate-limited' });
    }
    if (store && minIntervalMs > 0) {
      const last = store.lastSentAt();
      if (last != null) {
        const waitMs = Math.round(minIntervalMs - (now() - last) * 1000);
        if (waitMs > 0) await sleep(waitMs);
      }
    }

    // Idempotency, insert-before-send. Nothing below may run twice for one
    // (push, answer) pair, even across a process restart.
    const claimed = store ? store.claimOutbox(push.iden, hash) : true;
    if (!claimed) {
      return finish({ sent: false, reason: 'duplicate' });
    }

    const body = formatAnswer(reply, { prefix, bold });
    const context = {
      client,
      store,
      push,
      result,
      answer: String(reply),
      body,
      title,
      deviceIden: push.source_device_iden ?? push.target_device_iden ?? push.device_iden ?? null,
    };

    try {
      const outcome = await chosen.deliver(context);
      if (outcome?.ok === false) {
        store?.noteOutboxError(push.iden, hash, outcome.reason ?? 'strategy refused');
        return finish({ sent: false, reason: outcome.reason ?? 'refused', strategy: chosen.name });
      }
      store?.markOutboxSent(push.iden, hash, { response: outcome?.response ?? null });
      logger?.info?.(`answered push ${push.iden} with ${chosen.name}: ${body}`);
      return finish({ sent: true, reason: 'sent', strategy: chosen.name, answer: body, response: outcome?.response ?? null });
    } catch (err) {
      const message = redactPushbullet(String(err?.message ?? err));
      store?.noteOutboxError(push.iden, hash, message);
      logger?.warn?.(`could not answer push ${push.iden} via ${chosen.name}: ${message}`);
      return finish({ sent: false, reason: 'error', error: message, strategy: chosen.name });
    }
  }

  return {
    respond,
    strategy: chosen.name,
    title,
    requireConfidence,
    minIntervalMs,
    maxPerHour,
  };
}
