# PaperTok Scopus egress

`scopus-proxy.js` exists for one reason, and it is worth writing down because the
symptom is misleading.

`api.elsevier.com` resolves to `api.elsevier.com.cdn.cloudflare.net` — Elsevier's
API is served by Cloudflare. So is the PaperTok report API. A Worker subrequest to
a hostname Cloudflare already fronts never leaves Cloudflare's network, and
Elsevier answers it with `500 GENERAL_SYSTEM_ERROR`. That was measured three ways:
with a valid key, with an invented key, and **with no key at all** — all three got
the same 500, while the identical request from a laptop and from an unrelated
datacenter got a normal answer. No API key, institutional token or header changes
it. The request has to originate outside Cloudflare, and this is where it does.

The Elsevier key lives here and **nowhere else** — not in `wrangler secret`, and
never in a `VITE_*` variable. Elsevier echoes back any `Origin` it is sent, so the
"Website URL" registered against a key restricts nothing: a key shipped in the
browser bundle is a key anyone can take and spend.

## What it is not

Not a general proxy. It serves one route, demands a bearer only the Worker holds,
and rebuilds the upstream URL from a bounded set of parameters — it never accepts
a caller-supplied URL, host or path. `query` is capped at 500 characters, `count`
is clamped to 25, `start` to 5000, and `view` must be `COMPLETE` or `STANDARD` or
it is dropped. Only an allowlist of upstream headers is relayed back.

## Deploy

Create a project at [dash.deno.com](https://dash.deno.com) with `proxy/scopus-proxy.js`
as the entry point, then set these environment variables on it:

| Variable | Purpose |
| --- | --- |
| `ELSEVIER_API_KEY` | Scopus key from [dev.elsevier.com](https://dev.elsevier.com/apikey/manage) |
| `ELSEVIER_INST_TOKEN` | Optional. Institutional token; required for the `COMPLETE` view on some accounts. Request one through [Elsevier Data Support](https://service.elsevier.com/app/contact/supporthub/dataasaservice/) — the `integrationsupport@elsevier.com` inbox is no longer monitored |
| `PROXY_SHARED_SECRET` | At least 32 characters. Must match the Worker's `SCOPUS_PROXY_SECRET`. The route refuses to serve at all below that length |

Generate the shared secret:

```bash
openssl rand -hex 32
```

Then point the Worker at it:

```bash
npx wrangler secret put SCOPUS_PROXY_URL     # https://<project>.deno.dev
npx wrangler secret put SCOPUS_PROXY_SECRET  # the same value
npx wrangler secret delete ELSEVIER_API_KEY  # it does nothing in Cloudflare
```

## Verify

The egress answers its own health route without a secret, and says nothing about
the key beyond whether one is present:

```bash
curl -s https://<project>.deno.dev/health
```

Then confirm the whole chain — browser to Worker to egress to Scopus — through the
Worker's probe, which reports the view Elsevier granted and whether that view
carried an abstract:

```bash
curl -s -H "origin: https://mugar123.github.io" https://papertok-report-api.papertok-mugar123.workers.dev/health/scopus
```

Only once that returns `available: true` should the browser flow be switched on
with `gh variable set VITE_SCOPUS_ENABLED --body true`.
