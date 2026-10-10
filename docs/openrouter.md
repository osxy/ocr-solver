# Using OpenRouter

[OpenRouter](https://openrouter.ai) is an OpenAI-compatible endpoint in front of many
providers, and it is what the auto-router work was built and tested against. For the
running service it takes the model settings and the auto-router policy below, plus a key,
in `config.toml` or the settings UI.

**Model names are provider-prefixed.** OpenRouter addresses a model as `vendor/model` —
`openai/gpt-4o-mini`, `anthropic/claude-sonnet-5.5` — and every ID in its catalogue has
the slash. A bare `gpt-4o-mini` is therefore not a model it has, so the request comes
back **404**. That reads like a broken key or a broken app; it is an addressing mistake.

**The base URL is the API host, not the dashboard:**

```toml
[solver]
llm_base_url = "https://openrouter.ai/api/v1"   # not the openrouter.ai dashboard
llm_text_model = "openrouter/auto"
llm_vision_model = "~google/gemini-flash-latest"
# Auto-router policy. These apply only to auto-routed slugs (openrouter/auto,
# openrouter/auto-beta); a pinned model ignores them. Omitting cost_tier sends no
# band, which OpenRouter routes at its cheapest.
cost_tier = "medium"              # low | medium | high | xhigh | max
allowed_models = ["openai/*", "google/gemini-*"]   # wildcard patterns
# excluded_models = ["*/claude-*"]
```

`config set` writes the same values — `node src/cli.js config set solver.llm_base_url
https://openrouter.ai/api/v1`, and so on. The model settings and the auto-router policy
are all **restart-bound**, and the settings UI marks them `[restart]`.

**The key goes in the credential store, never `config.toml`** (which rejects secret-shaped
keys at load by design). The settings UI (tray **Settings**, or `config edit --gui`) has a
**Model API key** row, and `node src/cli.js config set llm.api_key sk-or-...` writes the
same store. The UI also exposes the model settings and the auto-router policy, validating
each before it writes.

A headless or unattended service reads `LLM_API_KEY` from the environment instead, and it
must be a **persistent** variable — `setx LLM_API_KEY "sk-or-..."` on Windows, or System
Properties → Environment Variables — because the logon task does not see a session
`$env:LLM_API_KEY = "…"`.

The settings UI's **Test connection** button probes the configured
`solver.llm_base_url` and `solver.llm_text_model`, so with the base URL and text model
above it talks to OpenRouter rather than to OpenAI. A failed probe names the host and
model it used, so it cannot be mistaken for "your key is bad".

**The auto-router policy applies to the service.** `cost_tier`, `allowed_models` and
`excluded_models` are `[solver]` config keys, edited like any other setting, and the
running service passes them to the client it builds. `allowed_models` in particular is a
policy control: it bounds which providers OpenRouter may route to, so a user can keep
their traffic inside an allowlist or a cost band. A pinned (non-auto) model still ignores
all three — the plugin is only sent for `openrouter/auto` and `openrouter/auto-beta`.

**Route the text tier; choose the vision tier.** Reading an OCR transcript and emitting
JSON is easy work, so `openrouter/auto` is a good fit for the text tier and is cheap. The
**vision tier runs only when OCR failed**, so it is the single place where the model choice
matters most — pick one deliberately. Left to the router it also routes as if you had
asked for OpenRouter's lowest cost band (the provider's default when no band is sent), the
opposite of what a last-resort image reader needs. The `~` prefix is a rolling alias:
`~google/gemini-flash-latest` follows the newest model in its family, so the choice of
family does not go stale the way a dated version does.

**Fallback chains.** Any model setting accepts a comma-separated list of at most **3**,
tried in order:

```toml
llm_vision_model = "~google/gemini-flash-latest,~anthropic/claude-sonnet-latest"
```

The first is the deliberate pick; the rest run only on error, rate limit or downtime. A
chain is sent as OpenRouter's `models` array and the single `model` field is omitted,
because the two spellings cannot be combined.

**How to tell it works.** The offline lexicon answers the common classes with **no model
call at all**, so a misconfigured provider usually shows up as an occasional unresolved
puzzle rather than everything failing. When a model is needed, its HTTP status is in the
log and in the attempt row: `401` is the key, `402` is credits (OpenRouter: "insufficient
credits"), and `404` is the model name — a bare name, or an `allowed_models` restriction
that matched nothing. A reply truncated at the token budget (`finish_reason: "length"`) is
retried once with three times the budget, so a single truncation is not a misconfiguration.

**The environment template is for the CLI and live testing.**
[`config/llm.env.example`](../config/llm.env.example) is the copy-paste block for `npm run
test:live`, `scripts/live-eval.js` and `node src/cli.js ... --auto`. The running service
takes its base URL, models and auto-router policy from `config.toml` and reads only
`LLM_API_KEY` from the environment. The template's `LLM_COST_TIER` (`low`, `medium`,
`high`, `xhigh`, `max`; `low` is the cheapest) and `LLM_ALLOWED_MODELS` /
`LLM_EXCLUDED_MODELS` (wildcard patterns such as `openai/*`) are the CLI/live-test
equivalents of `solver.cost_tier`, `solver.allowed_models` and `solver.excluded_models`.
All of them apply to routed slugs — `openrouter/auto`, `openrouter/auto-beta` — and a
pinned model ignores them. The precedence everywhere is a flag, then the environment,
then the config file. The reasoning behind the text/vision split is in
[DESIGN.md](../DESIGN.md) §4.7.

**Quote `~` values in an env file.** The shell performs tilde expansion on an assignment,
so an unquoted `~root/x` silently becomes `/root/x`; `~google/…` survives only because no
local user is named `google`. `config/llm.env.example` quotes these for that reason; quote
them in your own `~/.config/puzzlesolver/env` too. TOML's own quoting makes this a
non-issue in `config.toml`.
