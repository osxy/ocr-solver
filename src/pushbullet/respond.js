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
// Unresolved replies are their own message, with their own title, so nobody can read
// one as a solution. Dutch first because the puzzle itself arrives in Dutch and the
// sender is the reader; the English line covers an operator or recipient who cannot
// read Dutch. The whole value is replaceable through `reply.unresolved_text`.
export const DEFAULT_UNRESOLVED_TITLE = 'Puzzel niet opgelost';
export const DEFAULT_UNRESOLVED_TEXT =
  'Deze puzzel kon niet automatisch worden opgelost, dus er is geen antwoord gegeven.\n' +
  'This puzzle could not be solved automatically, so no answer is given.';
// The outbox is keyed on (push_iden, answer_hash). An unresolved reply has no answer,
// so it must never claim a null/empty hash - that is meaningless and can collide with
// another row. This literal marker cannot be produced by answerHash() (32 hex chars),
// is independent of the message text (editing the text does not re-acknowledge an old
// push), and gives exactly one acknowledgement per push across restarts and duplicate
// tickles.
export const UNRESOLVED_MARKER = 'unresolved';
export const DEFAULT_MIN_INTERVAL_MS = 3_000;
export const DEFAULT_MAX_PER_HOUR = 20;
// Acknowledgements get their own, looser budget (#48). They are cheap and expected,
// and the sender of a junk image deserves a reply, but they must never compete with a
// real answer for the same allowance. 60/hour is one a minute on average - looser than
// the 20 answers/hour budget, and still bounded so a junk-image flood cannot turn the
// account into a note-spammer. The 3 s minimum interval still bounds the burst.
export const DEFAULT_UNRESOLVED_MAX_PER_HOUR = 60;

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
  unresolvedTitle = DEFAULT_UNRESOLVED_TITLE,
  unresolvedText = DEFAULT_UNRESOLVED_TEXT,
  requireConfidence = true,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  maxPerHour = DEFAULT_MAX_PER_HOUR,
  unresolvedMaxPerHour = DEFAULT_UNRESOLVED_MAX_PER_HOUR,
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

    const hasAnswer = reply != null && String(reply).trim() !== '';
    // Two distinct no-answer cases, deliberately treated differently:
    //  - unresolved: no tier produced a valid answer, so the sender gets the
    //    configured acknowledgement instead of the old silence;
    //  - unconfirmed: an answer passed the class validator but no tier corroborated
    //    it. That stays silent. `require_confidence` withholds an unconfirmed result
    //    by design, and a "could not solve it" note would misdescribe a candidate the
    //    app actually has (DESIGN 4.11 and 7).
    if (hasAnswer && requireConfidence && result?.confident !== true) {
      return finish({ sent: false, reason: 'unconfirmed' });
    }

    const outgoing = hasAnswer
      ? {
          hash: answerHash(reply),
          title,
          body: formatAnswer(reply, { prefix, bold }),
          answer: String(reply),
          unresolved: false,
        }
      : {
          hash: UNRESOLVED_MARKER,
          title: unresolvedTitle,
          body: String(unresolvedText ?? ''),
          answer: null,
          unresolved: true,
        };

    // `unresolved_text` is non-empty by config validation; a hand-built responder can
    // still pass "", and an empty acknowledgement is worse than silence.
    if (outgoing.unresolved && outgoing.body.trim() === '') {
      return finish({ sent: false, reason: 'unresolved' });
    }
    if (!push?.iden) {
      return finish({ sent: false, reason: 'no-push-iden' });
    }

    const hash = outgoing.hash;
    if (store?.getOutbox(push.iden, hash)) {
      return finish({ sent: false, reason: 'duplicate', unresolved: outgoing.unresolved });
    }

    // Rate limits are checked before the claim so a refused send can still happen
    // later; a claimed-but-refused note would be lost forever.
    //
    // Answers and acknowledgements are counted separately (#48). Counting them
    // together let a burst of junk images exhaust the hourly cap and drop a real
    // answer as `rate-limited` - the app went silent exactly when it had something
    // worth sending. The answer budget excludes the acknowledgement marker; the
    // acknowledgement budget counts only it. The responder's literal lives here, not
    // in the store, which only knows one `answer_hash` to include or exclude.
    if (store) {
      const windowStart = now() - 3_600;
      if (outgoing.unresolved) {
        if (store.countSentSince(windowStart, { onlyHash: UNRESOLVED_MARKER }) >= unresolvedMaxPerHour) {
          return finish({ sent: false, reason: 'rate-limited', unresolved: true });
        }
      } else if (store.countSentSince(windowStart, { excludeHash: UNRESOLVED_MARKER }) >= maxPerHour) {
        return finish({ sent: false, reason: 'rate-limited', unresolved: false });
      }
    }
    if (store && minIntervalMs > 0) {
      const last = store.lastSentAt();
      if (last != null) {
        const waitMs = Math.round(minIntervalMs - (now() - last) * 1000);
        if (waitMs > 0) await sleep(waitMs);
      }
    }

    // Idempotency, insert-before-send. Nothing below may run twice for one
    // (push, answer) pair, even across a process restart. The unresolved case uses
    // UNRESOLVED_MARKER in place of a hash, so it dedupes the same way.
    const claimed = store ? store.claimOutbox(push.iden, hash) : true;
    if (!claimed) {
      return finish({ sent: false, reason: 'duplicate', unresolved: outgoing.unresolved });
    }

    const context = {
      client,
      store,
      push,
      result,
      answer: outgoing.answer,
      body: outgoing.body,
      title: outgoing.title,
      deviceIden: push.source_device_iden ?? push.target_device_iden ?? push.device_iden ?? null,
    };

    try {
      const outcome = await chosen.deliver(context);
      if (outcome?.ok === false) {
        store?.noteOutboxError(push.iden, hash, outcome.reason ?? 'strategy refused');
        return finish({ sent: false, reason: outcome.reason ?? 'refused', strategy: chosen.name, unresolved: outgoing.unresolved });
      }
      store?.markOutboxSent(push.iden, hash, { response: outcome?.response ?? null });
      logger?.info?.(
        `${outgoing.unresolved ? 'acknowledged' : 'answered'} push ${push.iden} with ${chosen.name}: ${outgoing.body}`
      );
      return finish({
        sent: true,
        reason: 'sent',
        strategy: chosen.name,
        answer: outgoing.unresolved ? null : outgoing.body,
        unresolved: outgoing.unresolved,
        response: outcome?.response ?? null,
      });
    } catch (err) {
      const message = redactPushbullet(String(err?.message ?? err));
      store?.noteOutboxError(push.iden, hash, message);
      logger?.warn?.(`could not answer push ${push.iden} via ${chosen.name}: ${message}`);
      return finish({ sent: false, reason: 'error', error: message, strategy: chosen.name, unresolved: outgoing.unresolved });
    }
  }

  return {
    respond,
    strategy: chosen.name,
    title,
    unresolvedTitle,
    unresolvedText,
    requireConfidence,
    minIntervalMs,
    maxPerHour,
    unresolvedMaxPerHour,
  };
}
