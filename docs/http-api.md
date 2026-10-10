# Solve over HTTP (no Pushbullet needed)

The HTTP ingress is a second way in: post a puzzle image and get the answer in the
response. It needs no Pushbullet account, which is also what makes the whole solve path
verifiable end to end.

This page is the reference for the endpoint. The one-paragraph summary and the
start-here instructions are in the [README](../README.md#solve-over-http).

## Enable it

Turn it on in `config.toml` and provide a token:

```toml
[http]
enabled = true
bind = "127.0.0.1"      # loopback only; see the warning below before changing this
port = 8765
```

```powershell
$env:HTTP_AUTH_TOKEN = "a-long-random-string"
```

The token must be at least 16 characters and not an obvious weak value. There is **no
anonymous mode**: with `enabled = true` and no token the service refuses to start rather
than listen unprotected. Generate one with `openssl rand -hex 24`.

## Post an image

Start the service (`listen --headless` is the usual unattended form) and post an image.
The simplest form needs only the auth header:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  --data-binary @puzzle.png
```

The content type is **conventional, not required**: the server recognises the image
from its magic bytes, so a missing `Content-Type` (curl's default
`application/x-www-form-urlencoded`), `application/octet-stream`, and `image/png` are all
accepted. Declaring it is still the clearest, so this form works too:

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" \
  -H 'Content-Type: image/png' \
  --data-binary @puzzle.png
```

```json
{
  "status": "solved",
  "answer": "2",
  "method": "tier0:count",
  "confident": true,
  "puzzleClass": "count",
  "transcript": "hoeveel kleuren in lijst wit ...",
  "cost": { "escalated": false, "tier": "tier0", "model": [] }
}
```

Accepted bodies: the raw image bytes (as above, whatever the declared `Content-Type`),
`multipart/form-data` with a file field, or JSON with `image_base64` (a data URL is
fine). A raw body that is not a real image is still refused with `415`
(`"error": "invalid_image"`, `"reason": "magic"`). JSON may also carry `image_url`,
but **fetching a URL is off by default** - see below.

```bash
curl -sS -X POST http://127.0.0.1:8765/v1/solve \
  -H "Authorization: Bearer $HTTP_AUTH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"image_base64":"'"$(base64 -w0 puzzle.png)"'"}'
```

## `image_url` is off by default (issue #57)

Making the server fetch a URL the caller supplies is an SSRF surface: the server can
reach services the caller cannot, including link-local metadata endpoints. Since
uploading the image is the normal path, the default is to refuse it - `403` with
`"error": "image_url_disabled"` and a reason pointing at `image_base64` / multipart /
the raw body. To enable it, name the hosts you trust (default deny):

```toml
[http]
allow_image_url = true
image_url_hosts = ["images.example.com", "cdn.example.com"]
```

When enabled, a URL whose host is not on that list is a `403` with
`"error": "image_url_host_not_allowed"`. Redirects are never followed: a public URL that
`302`s elsewhere is refused with `403` and `"error": "image_url_redirect"`, because the
redirect target is a second, unchecked host. Entries are exact host names (no wildcards
or ports). The residual: an allowlisted *hostname* that resolves to an internal address
is fetched, because `fetch` re-resolves at connect time - keep the list to names you
control.

## Status codes are honest, not approximate

`200` is a **corroborated** validated answer; `422` is a puzzle that could not be solved,
or an answer that passed validation but was not corroborated (the body has `"answer":
null` and a `reason` - nothing is guessed). A `422` for an unresolved puzzle also carries
`unresolvedReply` with the configured human wording when one is set, so a caller can
relay it; the structured fields are never replaced by prose. A `422` for a withheld
uncorroborated answer instead carries `"reason": "unconfirmed"` and **no**
`unresolvedReply`, because the Pushbullet path stays silent for that case too. `401` is a
missing or wrong bearer token; repeated wrong tokens get a `429` with `Retry-After` (a
bounded failure count with backoff, per client); `400`/`413`/`415` is a bad, too large,
or non-image body; `429` is the rate limit; `503` (with `Retry-After`) means too many
requests are already running or waiting on the shared solver; `504` means the solve
passed `timeout_ms`. A model-escalated solve says so in `cost.escalated`, because it
bills your provider credits.

## `reply.require_confidence` holds on HTTP too (issue #42)

An uncorroborated answer is not returned as a solved `200`; it is withheld exactly as the
Pushbullet responder withholds it, so the two egresses cannot disagree about the same
answer. Set `require_confidence = false` to trade accuracy for coverage and get the
answer with `confident: false`.

## It is synchronous

An offline solve is ~1 s and a vision escalation can pass 10 s, so the answer is returned
in the same request and `timeout_ms` (default 30 s) bounds it; there is no job id and no
polling. The budget includes queue wait. If it is exceeded the request gets the `504` and
the abandoned solve is discarded - nothing is delivered later. A solve that has not
*started* when its deadline passes is skipped before touching Tesseract or a provider, so
a request that expired in the queue does not bill you. Once Tesseract is running it
cannot be cancelled, and the app does not pretend otherwise.

## The queue is bounded (issue #43)

At most `max_queue` HTTP requests (default 8) may be running or waiting on the solver at
once; the next is refused with `503` and `Retry-After` instead of being queued. This is a
deliberate behaviour change: a burst larger than the bound is refused where it used to be
queued and billed. The rate limit bounds admission per minute; `max_queue` bounds the
backlog behind the one shared worker.

It coexists with the Pushbullet listener in one process (two ingresses, one solve core).
**An HTTP request replies over HTTP and sends no Pushbullet push by default** - Pushbullet
delivery is opt-in, not the default. To exercise the *note-push* path without a real
Pushbullet push, add `"deliver": "pushbullet"` to a JSON body; only then does the
configured responder run and the response report `delivery`.

> **Binding beyond loopback.** `bind = "0.0.0.0"` exposes a CAPTCHA solver to your
> network. The token is still required, but anyone who has it can spend your provider
> credits. The app logs a warning when the bind is not loopback. Keep it on
> `127.0.0.1` unless you have a specific reason.
