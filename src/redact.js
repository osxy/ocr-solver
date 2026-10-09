/**
 * The one place redaction happens.
 *
 * Both sinks that persist data - the rotating log file and the SQLite store - run
 * their text through this module rather than keeping a private copy of the rules.
 * That is deliberate: a second copy drifts, and the copy that drifts is the one that
 * leaks. It also means the "cannot be bypassed" claim has a single thing to test.
 *
 * Three rules, in order:
 *
 *   1. `redact` hides OpenAI-style keys, including hyphenated provider prefixes
 *      (`sk-...`, `sk-or-v1-...`, `sk-proj-...`). Only a short prefix survives, enough
 *      to tell two keys apart when debugging and useless to a reader.
 *   2. `redactPushbullet` additionally hides Pushbullet tokens (`o.xxx`) and the
 *      `access-token` header form.
 *   3. `stripImageBytes` removes inline image data (a `data:image/...;base64,...` URL
 *      or a serialised Node Buffer). DESIGN 8 allows transcripts to be logged for
 *      debugging but never image bytes; enforcing it at the sink means a future caller
 *      that passes an image through cannot accidentally persist it.
 *
 * `redactRecord` is the composition used by both sinks.
 */

/** OpenAI-style key, hyphenated prefixes included (`sk-or-v1-...`). */
export function redact(text) {
  return String(text ?? '')
    .replace(/(sk-[A-Za-z0-9]{2,3})[A-Za-z0-9_-]+/g, '$1…')
    .replace(/(Bearer\s+[A-Za-z0-9]{3})[A-Za-z0-9_-]+/gi, '$1…');
}

/** Pushbullet tokens look like `o.GFb9...`; an error body is where one leaks. */
export function redactPushbullet(text) {
  return redact(String(text ?? ''))
    .replace(/(o\.[A-Za-z0-9]{3})[A-Za-z0-9]+/g, '$1…')
    .replace(/(access-token\s*[:=]\s*)([A-Za-z0-9]{3})[A-Za-z0-9._-]*/gi, '$1$2…');
}

const DATA_URL_RE = /data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi;
const BUFFER_JSON_RE = /\{"type"\s*:\s*"Buffer"\s*,\s*"data"\s*:\s*\[[0-9,\s]*\]\}/g;

/**
 * Remove inline image bytes from a string. Kept separate from the secret redactors
 * so a caller can apply the content policy without pretending an image is a secret.
 *
 * The Buffer replacement keeps the JSON valid (`"..."`, not a bare token), because
 * the attempts table is parsed back with `JSON.parse` and an invalid blob would be
 * silently returned as a raw string.
 */
export function stripImageBytes(text) {
  return String(text ?? '')
    .replace(DATA_URL_RE, 'data:image/…;base64,[bytes not logged]')
    .replace(BUFFER_JSON_RE, '"[image bytes not logged]"');
}

/** Secrets first, then image bytes. Both sinks call exactly this. */
export function redactRecord(value) {
  return stripImageBytes(redactPushbullet(value));
}
