/**
 * Scripted model client for tests and offline development.
 *
 * This is what makes the whole reasoning path testable without a provider key:
 * the self-consistency vote, the JSON-repair path, the escalation ladder and the
 * validator gate can all be exercised deterministically.
 */
import { ModelError } from './client.js';

/**
 * Mark a scripted reply as cut off by the token budget.
 *
 * Worth being able to script, because a truncated reply is a distinct failure mode: it
 * parses as garbage, which looks identical to a model that simply answered badly, and
 * the correct response is to retry with more room rather than to escalate.
 */
export function truncated(text) {
  return { __truncated: true, text };
}

/**
 * @param {object} options
 * @param {Array|Function} options.responses  Replies in order (last one repeats),
 *   or a function receiving the request and returning a reply. A reply may be a
 *   string (raw assistant text) or an object (serialised to JSON for you).
 * @param {object|null} options.failWith      Throw this instead of replying:
 *   { status, retryable } or an Error.
 * @param {Function}    options.onCall        Observes every request.
 */
export function createFakeClient({ responses = [], failWith = null, onCall = null } = {}) {
  const calls = [];
  let index = 0;

  function nextReply(options) {
    if (typeof responses === 'function') return responses(options);
    if (responses.length === 0) return { answer: 'fallback' };
    return responses[Math.min(index++, responses.length - 1)];
  }

  return {
    isFake: true,
    get calls() {
      return calls;
    },
    reset() {
      index = 0;
      calls.length = 0;
    },
    async chat(options) {
      calls.push(options);
      onCall?.(options);

      if (failWith) {
        if (failWith instanceof Error) throw failWith;
        throw new ModelError(`fake failure (HTTP ${failWith.status ?? 500})`, {
          status: failWith.status ?? 500,
          retryable: failWith.retryable ?? false,
        });
      }

      const reply = nextReply(options);
      if (reply instanceof Error) throw reply;

      const wasTruncated = Boolean(reply && typeof reply === 'object' && reply.__truncated);
      const content = wasTruncated ? reply.text : reply;

      return {
        text: typeof content === 'string' ? content : JSON.stringify(content),
        model: options.model ?? 'fake-model',
        finishReason: wasTruncated ? 'length' : 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        ms: 1,
      };
    },
  };
}

/** Convenience: a client that always answers with the same JSON payload. */
export function constantClient(payload) {
  return createFakeClient({ responses: [payload] });
}
