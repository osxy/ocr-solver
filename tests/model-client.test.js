import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJson,
  redact,
  createChatClient,
  visionMessage,
  ModelError,
  autoRouterPlugin,
  AUTO_ROUTER_SLUGS,
  OPENROUTER_BASE_URL,
  normalizeModelChain,
  MAX_MODEL_CHAIN,
} from '../src/model/client.js';

/** A fetch stub that records request bodies and returns a canned reply. */
function recordingFetch(bodies, { model = 'routed-model', provider = 'SomeProvider', routing = null } = {}) {
  return async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"answer":"1"}' }, finish_reason: 'stop' }],
        model,
        provider,
        ...(routing ? { openrouter_metadata: routing } : {}),
      }),
      { status: 200 }
    );
  };
}

test('extracts a bare JSON object', () => {
  assert.deepEqual(extractJson('{"answer":"7"}'), { answer: '7' });
});

test('extracts JSON from a markdown fence', () => {
  assert.deepEqual(extractJson('```json\n{"answer":"7"}\n```'), { answer: '7' });
  assert.deepEqual(extractJson('```\n{"answer":"hoofd"}\n```'), { answer: 'hoofd' });
});

test('extracts JSON embedded in prose', () => {
  const reply = 'Sure, here is my answer:\n{"answer":"7","confidence":0.9}\nHope that helps!';
  assert.deepEqual(extractJson(reply), { answer: '7', confidence: 0.9 });
});

test('rejects replies with no JSON object', () => {
  assert.equal(extractJson('I think the answer is seven.'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
  assert.equal(extractJson('[1,2,3]'), null, 'an array is not an answer object');
});

test('redacts API keys out of log lines', () => {
  const key = 'sk-abcdef1234567890abcdef';
  const clean = redact(`request failed: Bearer ${key} (key ${key})`);
  assert.ok(!clean.includes(key), 'the full key must not survive');
  assert.ok(!clean.includes('abcdef1234567890'), 'no key body may survive either');
  assert.ok(clean.includes('sk-abc…'), 'a short prefix is kept to tell keys apart');
});

test('sends the expected request shape', async () => {
  const seen = [];
  const client = createChatClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"1"}' } }], model: 'm' }), {
        status: 200,
      });
    },
  });

  const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.text, '{"answer":"1"}');
  assert.equal(seen[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-key');
  assert.equal(seen[0].body.model, 'm');
  assert.deepEqual(seen[0].body.response_format, { type: 'json_object' });
});

test('retries a rate limit and then succeeds', async () => {
  let attempts = 0;
  const client = createChatClient({
    maxRetries: 2,
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return new Response('slow down', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"2"}' } }] }), { status: 200 });
    },
  });

  const result = await client.chat({ model: 'm', messages: [] });
  assert.equal(result.text, '{"answer":"2"}');
  assert.equal(attempts, 2);
});

test('does not retry an authentication failure', async () => {
  let attempts = 0;
  const client = createChatClient({
    maxRetries: 3,
    fetchImpl: async () => {
      attempts++;
      return new Response('invalid api key', { status: 401 });
    },
  });

  await assert.rejects(() => client.chat({ model: 'm', messages: [] }), (err) => {
    assert.ok(err instanceof ModelError);
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(attempts, 1, 'a bad key must fail immediately, not burn retries');
});

test('retries without JSON mode when the endpoint rejects response_format', async () => {
  const bodies = [];
  const client = createChatClient({
    maxRetries: 0,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return new Response('unsupported parameter', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"3"}' } }] }), { status: 200 });
    },
  });

  const result = await client.chat({ model: 'm', messages: [] });
  assert.equal(result.text, '{"answer":"3"}');
  assert.equal(bodies.length, 2);
  assert.ok(bodies[0].response_format);
  assert.equal(bodies[1].response_format, undefined, 'second attempt must drop response_format');
});

test('reports a non-JSON HTTP body as a model error', async () => {
  const client = createChatClient({
    maxRetries: 0,
    fetchImpl: async () => new Response('<html>gateway error</html>', { status: 200 }),
  });
  await assert.rejects(() => client.chat({ model: 'm', messages: [] }), /non-JSON HTTP body/);
});

// ------------------------------------------------------------- openrouter auto

test('every auto slug maps to its own plugin id', () => {
  // OpenRouter silently ignores settings sent under the other slug's plugin id, so
  // getting this wrong would look like it worked while doing nothing at all.
  assert.deepEqual(Object.keys(AUTO_ROUTER_SLUGS).sort(), ['openrouter/auto', 'openrouter/auto-beta']);
  assert.equal(autoRouterPlugin('openrouter/auto').id, 'auto-router');
  assert.equal(autoRouterPlugin('openrouter/auto-beta').id, 'auto-beta-router');
});

test('no plugin is built for a non-auto model', () => {
  assert.equal(autoRouterPlugin('gpt-4o-mini'), null);
  assert.equal(autoRouterPlugin('anthropic/claude-sonnet-4'), null);
  assert.equal(autoRouterPlugin(undefined), null);
});

test('carries cost tier and model restrictions into the plugin', () => {
  const plugin = autoRouterPlugin('openrouter/auto', {
    costTier: 'medium',
    allowedModels: ['openai/*', 'anthropic/*'],
    excludedModels: ['openai/gpt-4o'],
  });
  assert.equal(plugin.cost_tier, 'medium');
  assert.deepEqual(plugin.allowed_models, ['openai/*', 'anthropic/*']);
  assert.deepEqual(plugin.excluded_models, ['openai/gpt-4o']);
});

test('omits optional plugin fields when not configured', () => {
  const plugin = autoRouterPlugin('openrouter/auto', {});
  assert.deepEqual(plugin, { id: 'auto-router' });
});

test('rejects an unknown cost tier loudly instead of silently ignoring it', () => {
  assert.throws(() => autoRouterPlugin('openrouter/auto', { costTier: 'cheap' }), /unknown cost tier/);
});

test('injects the plugin into the request body for auto slugs only', async () => {
  const bodies = [];
  const client = createChatClient({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: 'k',
    autoRouter: { costTier: 'low', allowedModels: ['openai/*'] },
    fetchImpl: recordingFetch(bodies),
  });

  await client.chat({ model: 'openrouter/auto', messages: [] });
  await client.chat({ model: 'openrouter/auto-beta', messages: [] });
  await client.chat({ model: 'gpt-4o-mini', messages: [] });

  assert.deepEqual(bodies[0].plugins, [
    { id: 'auto-router', cost_tier: 'low', allowed_models: ['openai/*'] },
  ]);
  assert.deepEqual(bodies[1].plugins, [
    { id: 'auto-beta-router', cost_tier: 'low', allowed_models: ['openai/*'] },
  ]);
  assert.equal(bodies[2].plugins, undefined, 'a pinned model must send no plugin');
});

test('the plugin survives the retry that drops json mode', async () => {
  // The response_format fallback rebuilds the body; losing the router settings there
  // would quietly change routing on exactly the retried requests.
  const bodies = [];
  const client = createChatClient({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: 'k',
    maxRetries: 0,
    autoRouter: { costTier: 'high' },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.response_format) return new Response('unsupported', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"1"}' } }] }), { status: 200 });
    },
  });

  await client.chat({ model: 'openrouter/auto', messages: [] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].response_format, undefined);
  assert.equal(bodies[1].plugins[0].cost_tier, 'high', 'routing settings must persist across the retry');
});

test('captures which model and provider actually answered', async () => {
  const client = createChatClient({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: 'k',
    fetchImpl: recordingFetch([], { model: 'chosen/model', provider: 'ChosenProvider', routing: { pipeline: ['router'] } }),
  });
  const result = await client.chat({ model: 'openrouter/auto', messages: [] });
  assert.equal(result.model, 'chosen/model', 'the resolved model, not the slug');
  assert.equal(result.provider, 'ChosenProvider');
  assert.deepEqual(result.routing, { pipeline: ['router'] });
});

test('asks OpenRouter to report routing, but only for OpenRouter', async () => {
  const headers = [];
  const fetchImpl = async (url, init) => {
    headers.push(init.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
  };

  await createChatClient({ baseUrl: OPENROUTER_BASE_URL, apiKey: 'k', fetchImpl }).chat({ model: 'm', messages: [] });
  await createChatClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', fetchImpl }).chat({ model: 'm', messages: [] });

  assert.equal(headers[0]['x-openrouter-metadata'], 'enabled');
  assert.equal(headers[1]['x-openrouter-metadata'], undefined);
});

// ---------------------------------------------------------------- model chains

test('normalises a model specifier into an ordered chain', () => {
  assert.deepEqual(normalizeModelChain('a/one'), ['a/one']);
  assert.deepEqual(normalizeModelChain('a/one,b/two , c/three'), ['a/one', 'b/two', 'c/three']);
  assert.deepEqual(normalizeModelChain(['a/one', 'b/two']), ['a/one', 'b/two']);
  assert.deepEqual(normalizeModelChain(''), []);
  assert.deepEqual(normalizeModelChain(null), []);
});

test('refuses a chain longer than the documented maximum', () => {
  const tooMany = Array.from({ length: MAX_MODEL_CHAIN + 1 }, (_, i) => `m/${i}`);
  assert.throws(() => normalizeModelChain(tooMany), /at most 3 models/);
});

test('a chain replaces the single model rather than being sent alongside it', async () => {
  // Sending both `model` and `models` is ambiguous - the docs warn the two spellings
  // cannot be combined - so the chain must win outright.
  const bodies = [];
  const client = createChatClient({ apiKey: 'k', fetchImpl: recordingFetch(bodies) });

  await client.chat({ model: 'a/one', messages: [] });
  await client.chat({ model: 'a/one', messages: [], extraBody: { models: ['a/one', 'b/two'] } });

  assert.equal(bodies[0].model, 'a/one');
  assert.equal(bodies[0].models, undefined);
  assert.equal(bodies[1].model, undefined, 'model must be dropped when a chain is present');
  assert.deepEqual(bodies[1].models, ['a/one', 'b/two']);
});

test('the auto-router plugin keys off the head of a chain', async () => {
  const bodies = [];
  const client = createChatClient({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: 'k',
    autoRouter: { costTier: 'low' },
    fetchImpl: recordingFetch(bodies),
  });

  await client.chat({ model: 'openrouter/auto', messages: [], extraBody: { models: ['openrouter/auto', 'x/y'] } });
  await client.chat({ model: 'pinned/vision', messages: [], extraBody: { models: ['pinned/vision', 'x/y'] } });

  assert.equal(bodies[0].plugins[0].id, 'auto-router', 'routed head keeps the plugin');
  assert.equal(bodies[1].plugins, undefined, 'a pinned head needs no routing plugin');
});

test('an over-long chain is rejected before any request is sent', async () => {
  const bodies = [];
  const client = createChatClient({ apiKey: 'k', fetchImpl: recordingFetch(bodies) });
  await assert.rejects(
    () => client.chat({ model: 'a', messages: [], extraBody: { models: ['1', '2', '3', '4'] } }),
    /at most 3 models/
  );
  assert.equal(bodies.length, 0, 'a config error must not burn requests');
});

test('builds a vision message carrying the image inline', () => {
  const buffer = Buffer.from('fake-png-bytes');
  const message = visionMessage('read this', buffer);
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].text, 'read this');
  const url = message.content[1].image_url.url;
  assert.ok(url.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(url.split(',')[1], 'base64').toString(), 'fake-png-bytes');
});