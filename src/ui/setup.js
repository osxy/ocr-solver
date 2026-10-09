/**
 * First-run setup: validate, test, then write.
 *
 * The dialog is the UI seam; this module is the logic behind it. Validation, the
 * two connection probes and the credential write all live in the injected
 * `saveSecrets` from `src/secrets.js`, so the same provider interface the rest of
 * the app reads through is the one the setup writes through. There is no second
 * credential file.
 *
 * "Test connection" is per field and never fatal: a provider being down when the
 * user clicks it must not block saving a key. `apply()` validates first and can
 * optionally require a successful test, but it never invents a value.
 *
 * The default probes talk to the real Pushbullet and model endpoints. They are the
 * only network in this file and are only reached in the real dialog; every test
 * injects a fake.
 */

export const SETUP_FIELDS = ['pushbulletToken', 'llmApiKey'];

/** A key/token pasted from a browser or a shell often carries a trailing newline. */
function hasInternalWhitespace(value) {
  return /\s/.test(String(value).trim());
}

export function validateSetupInput({ pushbulletToken = '', llmApiKey = '', requireModelKey = true } = {}) {
  const errors = {};
  if (!String(pushbulletToken).trim()) errors.pushbulletToken = 'the Pushbullet token is required';
  else if (hasInternalWhitespace(pushbulletToken)) errors.pushbulletToken = 'the Pushbullet token contains whitespace';

  if (requireModelKey && !String(llmApiKey).trim()) errors.llmApiKey = 'the model API key is required';
  else if (llmApiKey && hasInternalWhitespace(llmApiKey)) errors.llmApiKey = 'the model API key contains whitespace';

  return { ok: Object.keys(errors).length === 0, errors };
}

/** Real Pushbullet probe: the same endpoint the listener authenticates with. */
export async function defaultTestPushbullet(token, { fetchImpl = globalThis.fetch, baseUrl = 'https://api.pushbullet.com/v2' } = {}) {
  const res = await fetchImpl(`${baseUrl}/users/me`, { headers: { 'Access-Token': String(token) } });
  if (res.status === 401) return { ok: false, detail: 'Pushbullet rejected the token (401)' };
  if (!res.ok) return { ok: false, detail: `Pushbullet returned HTTP ${res.status}` };
  return { ok: true, detail: 'Pushbullet accepted the token' };
}

/** Real model probe: the cheapest possible authenticated completion. */
export async function defaultTestModel(
  key,
  { fetchImpl = globalThis.fetch, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini' } = {}
) {
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(key)}` },
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
  });
  if (res.status === 401 || res.status === 403) return { ok: false, detail: `the model key was rejected (${res.status})` };
  if (!res.ok) {
    const body = await res.text?.().catch?.(() => '') ?? '';
    return { ok: false, detail: `the model endpoint returned HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}` };
  }
  return { ok: true, detail: 'the model key was accepted' };
}

export function createSetup({
  saveSecrets,
  testPushbullet = defaultTestPushbullet,
  testModel = defaultTestModel,
  requireModelKey = true,
  logger = null,
} = {}) {
  if (typeof saveSecrets !== 'function') throw new Error('createSetup needs the saveSecrets provider function');

  async function runProbe(name, fn, value) {
    if (!String(value ?? '').trim()) return { ok: false, detail: `${name} is empty` };
    try {
      const result = await fn(value);
      return { ok: Boolean(result?.ok), detail: String(result?.detail ?? (result?.ok ? 'ok' : 'failed')) };
    } catch (err) {
      // A network failure is a failed test, not a thrown dialog.
      return { ok: false, detail: `${name} test failed: ${err?.message ?? err}` };
    }
  }

  async function testConnection({ pushbulletToken = '', llmApiKey = '' } = {}) {
    const results = {};
    if (String(pushbulletToken).trim()) results.pushbullet = await runProbe('Pushbullet', testPushbullet, pushbulletToken);
    if (String(llmApiKey).trim()) results.llm = await runProbe('model', testModel, llmApiKey);
    const ok = Object.keys(results).length > 0 && Object.values(results).every((r) => r.ok);
    return { ok, results };
  }

  return {
    validate: (input) => validateSetupInput({ ...input, requireModelKey }),
    testConnection,
    /**
     * Validate, optionally require a connection, then persist. Returns what was
     * saved (names only - never the values) or the validation errors.
     */
    apply: async ({ pushbulletToken = '', llmApiKey = '', requireConnection = false } = {}) => {
      const validation = validateSetupInput({ pushbulletToken, llmApiKey, requireModelKey });
      if (!validation.ok) return { saved: false, errors: validation.errors, results: null };

      let results = null;
      if (requireConnection) {
        results = (await testConnection({ pushbulletToken, llmApiKey })).results;
        if (!results.pushbullet?.ok || (requireModelKey && !results.llm?.ok)) {
          return { saved: false, errors: null, results };
        }
      }
      const saved = await saveSecrets({
        entries: {
          pushbullet: String(pushbulletToken).trim(),
          ...(String(llmApiKey).trim() ? { llm: String(llmApiKey).trim() } : {}),
        },
        logger,
      });
      return { saved: true, savedNames: saved.saved, providers: saved.providers, errors: null, results };
    },
  };
}
