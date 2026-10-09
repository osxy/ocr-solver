/**
 * The one place redaction happens.
 *
 * Both sinks that persist data - the rotating log file and the SQLite store - run
 * their text through this module rather than keeping a private copy of the rules.
 * That is deliberate: a second copy drifts, and the copy that drifts is the one that
 * leaks. It also means the "cannot be bypassed" claim has a single thing to test.
 *
 * Redaction is defence in depth, not a single regex:
 *
 *   1. **Known secrets by value.** The app registers every resolved secret (see
 *      `registerSecrets`) and any exact occurrence is replaced. This is the only
 *      rule that is complete for the credentials this process actually holds, and
 *      it does not depend on guessing a provider's key shape.
 *   2. **Header/key-name rules.** `Authorization`, `x-api-key`, `api_key=`,
 *      `token:` and friends have their *value* hidden whatever it looks like. This
 *      catches a body the app never registered (a third party's key quoted in an
 *      upstream error).
 *   3. **Value-shape rules.** Documented provider prefixes - OpenAI/OpenRouter
 *      `sk-`, Groq `gsk_`, Google `AIza`, GitHub `ghp_`/`github_pat_`, Stripe
 *      `sk_live_`/`pk_live_`, Slack `xox…`, AWS `AKIA` - are hidden even without a
 *      key name. The `sk-` rule carries a word-boundary lookbehind so ordinary
 *      hyphenated words (`task-assignment-failed`, `risk-management`) are not
 *      mangled. A masked value ends in `…` and later rules leave it alone.
 *   4. **Pushbullet rules.** `redactPushbullet` additionally hides `o.` tokens and
 *      `access_token` values, because Pushbullet is the one provider this app holds
 *      a token for outside the generic model path.
 *   5. **Image-byte policy.** `stripImageBytes` removes inline image data; DESIGN 8
 *      allows transcripts but never image bytes.
 *
 * `redactRecord` is the composition used by both sinks.
 *
 * What is still not covered is named in DESIGN 8: a secret that this process never
 * resolved (so it was never registered) and that does not match a header name or a
 * known shape can still pass. That is the honest boundary of the mechanism.
 */

/** Key names whose value is a credential whatever shape the value has. */
const KEY_NAMES = [
  'authorization',
  'x-api-key',
  'api[_-]?key',
  'apikey',
  'auth[_-]?token',
  'client[_-]?secret',
  'password',
  'secret',
  'token',
];

// A key name only counts when it is a whole word (so `access-token` is not read as
// the `token` rule, which would pre-empt the Pushbullet rule) and is followed by a
// `:`/`=` assignment. The value is hidden in a callback so an already-masked value
// (one ending in `…`) is left untouched.
const KEY_NAME_RE = new RegExp(
  `(?<![A-Za-z0-9_-])(${KEY_NAMES.join('|')})(["']?\\s*[:=]\\s*["']?)((?:Bearer\\s+)?[^\\s"',;&]+)`,
  'gi'
);

/** Known provider prefixes, longest first so `github_pat_` wins over `gh`. */
const TOKEN_PREFIXES = [
  'github_pat_',
  'sk_live_',
  'sk_test_',
  'pk_live_',
  'pk_test_',
  'rk_live_',
  'gsk_',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'xoxb-',
  'xoxa-',
  'xoxp-',
  'xoxr-',
  'xoxs-',
  'AIza',
  'AKIA',
  'sk-',
  'o.',
];

/**
 * Hide a token, keeping a short prefix that identifies it without being usable.
 * The leading run of alphanumerics is what survives, capped at three characters,
 * so `sk-or-v1-…` keeps `sk-or…` and not `sk-or-…`.
 */
function maskToken(token) {
  const text = String(token ?? '');
  const prefix = TOKEN_PREFIXES.find((candidate) => text.startsWith(candidate)) ?? '';
  const rest = text.slice(prefix.length);
  if (rest.length <= 3) return `${prefix}…`;
  const run = /^[A-Za-z0-9]{1,3}/.exec(rest)?.[0] ?? '';
  return `${prefix}${run}…`;
}

/** Documented key shapes, hidden even with no key name attached. */
const SHAPE_RE = new RegExp(
  '(?<![A-Za-z0-9])(?:' +
    [
      'sk-[A-Za-z0-9]{2,3}[A-Za-z0-9_-]+', // OpenAI / OpenRouter
      'gsk_[A-Za-z0-9_-]{8,}', // Groq
      'AIza[0-9A-Za-z_-]{10,}', // Google
      '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}', // GitHub
      'github_pat_[A-Za-z0-9_]{20,}', // GitHub fine-grained PAT
      '(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}', // Stripe
      'xox[baprs]-[A-Za-z0-9-]{10,}', // Slack
      'AKIA[0-9A-Z]{16}', // AWS access key id
    ].join('|') +
    ')(?!…)',
  'g'
);

const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._~+/=-]+)/gi;

/** Secrets resolved at runtime, registered by value (longest first). */
let knownSecrets = [];

/**
 * Register the configured secrets so their exact value is redacted from every sink.
 * Values shorter than `MIN_REGISTERED_SECRET` are ignored: replacing a one-character
 * "secret" would corrupt every log line, and no real credential is that short.
 *
 * @param {string|string[]} values
 * @returns {number} how many distinct values were registered
 */
export function registerSecrets(values) {
  const list = (Array.isArray(values) ? values : [values]).filter(
    (value) => typeof value === 'string' && value.length >= 8
  );
  knownSecrets = [...new Set(list)].sort((a, b) => b.length - a.length);
  return knownSecrets.length;
}

/** Forget registered secrets. Tests use this; the app registers once at startup. */
export function clearKnownSecrets() {
  knownSecrets = [];
}

function redactKnownSecrets(text) {
  let out = text;
  for (const secret of knownSecrets) out = out.split(secret).join('[redacted]');
  return out;
}

function maskValue(value) {
  const match = /^(Bearer\s+)([\s\S]*)$/i.exec(value);
  const prefix = match ? match[1] : '';
  const rest = match ? match[2] : value;
  return `${prefix}${maskToken(rest)}`;
}

/**
 * `redact` hides documented key shapes, `Bearer` values and key-name assignments.
 * The known-secret registry is applied first, so a configured key is redacted even
 * when its shape is not in the list.
 */
export function redact(text) {
  let out = redactKnownSecrets(String(text ?? ''));
  out = out.replace(BEARER_RE, (_match, prefix, value) => `${prefix}${maskToken(value)}`);
  out = out.replace(SHAPE_RE, (token) => maskToken(token));
  out = out.replace(KEY_NAME_RE, (match, name, sep, value) => {
    // A value a prior rule already masked ends in `…`; leave it alone so repeated
    // passes are stable and `o.abc…` is not reduced to `o.…`.
    if (value.includes('…') || value.includes('[redacted]')) return match;
    return `${name}${sep}${maskValue(value)}`;
  });
  return out;
}

/**
 * `redactPushbullet` additionally hides Pushbullet tokens (`o.xxx`) and the
 * `access-token`/`access_token` header form, including values with no documented
 * shape.
 */
export function redactPushbullet(text) {
  let out = redact(String(text ?? ''));
  out = out.replace(/(o\.[A-Za-z0-9]{3})[A-Za-z0-9]+/g, '$1…');
  out = out.replace(/(access[_-]?token\s*[:=]\s*["']?)([^\s"',;&]+)/gi, (match, prefix, value) => {
    if (value.includes('…') || value.includes('[redacted]')) return match;
    return `${prefix}${maskToken(value)}`;
  });
  return out;
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
