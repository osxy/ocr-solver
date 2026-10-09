/**
 * Minimal OpenAI-compatible chat client built on the built-in `fetch`.
 *
 * Deliberately not the vendor SDK: the only thing this app needs is one POST with
 * retries, and keeping it here means (a) no dependency, (b) any OpenAI-compatible
 * endpoint works by changing `baseUrl`, and (c) tests can swap `fetchImpl` for a
 * fake without touching the reasoning logic.
 */

import { redact } from '../redact.js';

export { redact };

export class ModelError extends Error {
  constructor(message, { status = null, retryable = false, body = null, permanent = false } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    // A permanent failure is a configuration error (bad key, unknown model, bad
    // cost tier). It fails immediately and trips the tier's circuit breaker on the
    // first occurrence rather than waiting for the transient failure budget.
    this.permanent = permanent;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The one endpoint join. The chat client and the first-run/settings **Test
 * connection** probe both call this, so a trailing slash in `llm_base_url`
 * (`https://openrouter.ai/api/v1/`, a very common spelling) cannot make the probe
 * 404 while the real service works (#88). This is the same collapse the three
 * redactors and the two corpus paths got: one implementation, every caller.
 */
export function chatEndpoint(baseUrl) {
  return `${String(baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`;
}

/**
 * OpenRouter slugs that route dynamically, and the plugin id each one listens to.
 *
 * The mapping matters: OpenRouter documents that each slug reads settings ONLY under
 * its own plugin id, and that settings sent under the other slug's id are "accepted
 * but silently ignored". So a hardcoded `auto-router` on `openrouter/auto-beta` would
 * look like it worked while having no effect at all. Encoding the mapping in one
 * place is what stops that becoming a silent behaviour change.
 */
export const AUTO_ROUTER_SLUGS = {
  'openrouter/auto': 'auto-router',
  'openrouter/auto-beta': 'auto-beta-router',
};

export const COST_TIERS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * OpenRouter's model fallback chain (`models`) accepts at most this many entries;
 * longer lists are rejected with a 400.
 */
export const MAX_MODEL_CHAIN = 3;

/**
 * Normalise a model specifier into an ordered fallback chain.
 * Accepts a bare slug, a comma-separated list, or an array.
 *
 * An ordered chain is the right way to pin a model without pinning it to a version
 * that will eventually be retired: the first entry is the deliberate choice, and the
 * rest only run if it errors, is rate-limited or is down.
 */
export function normalizeModelChain(model) {
  const chain = (Array.isArray(model) ? model : String(model ?? '').split(','))
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (chain.length > MAX_MODEL_CHAIN) {
    throw new Error(
      `a model chain may hold at most ${MAX_MODEL_CHAIN} models, got ${chain.length}: ${chain.join(', ')}`
    );
  }
  return chain;
}

/**
 * Build the OpenRouter auto-router plugin block for a model slug, or null when the
 * model is not an auto slug (in which case no plugin should be sent).
 */
export function autoRouterPlugin(model, { costTier, allowedModels, excludedModels } = {}) {
  const id = AUTO_ROUTER_SLUGS[model];
  if (!id) return null;
  const plugin = { id };
  if (costTier) {
    if (!COST_TIERS.includes(costTier)) {
      throw new ModelError(`unknown cost tier ${JSON.stringify(costTier)}; expected one of ${COST_TIERS.join(', ')}`, {
        retryable: false,
        permanent: true,
      });
    }
    plugin.cost_tier = costTier;
  }
  if (allowedModels?.length) plugin.allowed_models = [...allowedModels];
  if (excludedModels?.length) plugin.excluded_models = [...excludedModels];
  return plugin;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `redact` now lives in `../redact.js` so the log sink, the state store and this
 * client share one implementation. Re-exported here because this module's public
 * surface (and its tests) have always exposed it.
 */

/**
 * Create a chat client.
 * `fetchImpl` is injectable so the whole reasoning path can be tested offline.
 */
export function createChatClient({
  baseUrl = 'https://api.openai.com/v1',
  apiKey = process.env.LLM_API_KEY ?? '',
  timeoutMs = 30_000,
  maxRetries = 2,
  fetchImpl = globalThis.fetch,
  extraHeaders = {},
  // { costTier, allowedModels, excludedModels } - applied only to auto-router slugs.
  autoRouter = null,
  // Ask OpenRouter to report how the request was routed ("X-OpenRouter-Metadata").
  requestMetadata = /openrouter\.ai/.test(baseUrl),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const endpoint = chatEndpoint(baseUrl);
  const calls = [];

  /** Assemble the request body, injecting the correct auto-router plugin when relevant. */
  function buildBody({ model, messages, temperature, maxTokens, jsonMode, extraBody }) {
    const body = { model, messages, temperature, max_tokens: maxTokens, ...(extraBody ?? {}) };

    // OpenRouter expresses a fallback chain as `models`, in priority order. Sending
    // `model` and `models` together is ambiguous (the docs warn the two spellings
    // cannot be combined), so a chain replaces the single model outright.
    const chain = Array.isArray(body.models) ? body.models.filter(Boolean) : [];
    if (chain.length) delete body.model;
    else delete body.models;

    if (jsonMode) body.response_format = { type: 'json_object' };

    // The auto-router plugin keys off the primary model, whether it arrived as the
    // single model or as the head of a chain.
    const primary = chain.length ? chain[0] : model;
    const plugin = autoRouterPlugin(primary, autoRouter ?? {});
    if (plugin) body.plugins = [...(body.plugins ?? []), plugin];
    return body;
  }

  async function once({ model, messages, temperature = 0, maxTokens = 300, jsonMode = true, signal, extraBody = null }) {
    const body = buildBody({ model, messages, temperature, maxTokens, jsonMode, extraBody });

    const started = Date.now();
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(requestMetadata ? { 'x-openrouter-metadata': 'enabled' } : {}),
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new ModelError(`model request failed with HTTP ${response.status}`, {
        status: response.status,
        retryable: RETRYABLE_STATUS.has(response.status),
        body: redact(raw).slice(0, 500),
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ModelError('model returned a non-JSON HTTP body', { body: redact(raw).slice(0, 500) });
    }

    const text = parsed?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') {
      throw new ModelError('model response contained no message content', { body: redact(raw).slice(0, 500) });
    }

    // `model` and `provider` report what the router actually chose, which is the only
    // way to know what answered when using an auto slug.
    return {
      text,
      model: parsed.model ?? model,
      provider: parsed.provider ?? null,
      routing: parsed.openrouter_metadata ?? null,
      finishReason: parsed?.choices?.[0]?.finish_reason ?? null,
      usage: parsed.usage ?? null,
      ms: Date.now() - started,
    };
  }

  return {
    endpoint,
    get calls() {
      return calls;
    },

    /** Build the request body without sending it. Exposed for tests. */
    buildBody,

    /**
     * Send one chat request, retrying transient failures with exponential backoff
     * and jitter. Non-retryable errors (bad key, unknown model) fail immediately.
     *
     * If the endpoint rejects `response_format` (many OpenAI-compatible servers do
     * not implement it), the request is retried once without it rather than failing.
     */
    async chat(options) {
      // Validate the chain up front. Inside the retry loop a plain Error would be
      // treated as transient and retried, turning a config mistake into a puzzling
      // three-attempt failure.
      if (Array.isArray(options.extraBody?.models)) normalizeModelChain(options.extraBody.models);

      let lastError = null;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const result = await once(options);
          calls.push({ ...options, result, attempt });
          return result;
        } catch (err) {
          lastError = err;
          const rejectedJsonMode =
            err instanceof ModelError && err.status === 400 && options.jsonMode !== false;
          if (rejectedJsonMode) {
            return this.chat({ ...options, jsonMode: false });
          }
          const retryable = err instanceof ModelError ? err.retryable : true;
          if (!retryable || attempt === maxRetries) break;
          const backoff = Math.min(1000 * 2 ** attempt, 8000) * (0.5 + Math.random() * 0.5);
          await sleep(backoff);
        }
      }
      calls.push({ ...options, error: lastError });
      throw lastError;
    },
  };
}

/** Build the user message for a vision request: text plus one inline image. */
export function visionMessage(promptText, imageBuffer, mimeType = 'image/png') {
  return {
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      {
        type: 'image_url',
        image_url: { url: `data:${mimeType};base64,${imageBuffer.toString('base64')}`, detail: 'high' },
      },
    ],
  };
}

/**
 * Pull a JSON object out of a model reply.
 * Handles bare JSON, ```json fences, and a JSON object embedded in prose.
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();

  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) candidates.push(fenced[1].trim());
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // try the next candidate
    }
  }
  return null;
}
