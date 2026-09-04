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

The file starts its own server with `Deno.serve`, because Deno Deploy runs the
entry point the way `deno run` does. A bare `export default { fetch }` only
listens under `deno serve`, and a project deployed that way starts and answers
nothing — the default export is kept for `deno serve`, but it is not what runs in
production.

Two ways in, at [dash.deno.com](https://dash.deno.com):

- **Playground** — *New Playground*, paste `scopus-proxy.js`, set the variables,
  save. Nothing needs to be pushed, so this is the quickest way to prove the
  egress actually reaches Elsevier before wiring anything to it.
- **Linked to the repository** — new project from GitHub with
  `proxy/scopus-proxy.js` as the entry point, which redeploys on every push. The
  right home once the playground has proved the route.

Either way, set these on the project:

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
npx wrangler secret put SCOPUS_PROXY_URL     # https://<project>.deno.net (playgrounds serve from .deno.net)
npx wrangler secret put SCOPUS_PROXY_SECRET  # the same value
npx wrangler secret delete ELSEVIER_API_KEY  # it does nothing in Cloudflare
npm run worker:deploy
```

To run it locally: `deno run --allow-net --allow-env proxy/scopus-proxy.js`.

## Verify

The egress answers its own health route without a secret, and says nothing about
the key beyond whether one is present:

```bash
curl -s https://<project>.deno.net/health
```

Then confirm the whole chain — browser to Worker to egress to Scopus — through the
Worker's probe, which reports the view Elsevier granted and whether that view
carried an abstract:

```bash
curl -s -H "origin: https://papertok.app" https://api.papertok.app/health/scopus
```

`available: true` is necessary but not sufficient, and the browser flow is
deliberately off. Measured against OpenAlex, Scopus returned 75 papers across
three fields and OpenAlex already held all 75 (STATE.md, «Scopus: estudio
cerrado», 2026-08-22), so it adds nothing as a discovery source; and without an
institutional token the probe reports `hasAbstract: false`, so its records reach
the card with no summary and no AI explanation. The egress and the probe stay in
place to report the day either of those changes.

Turning the flow on is therefore a product decision, and it is recorded in
`src/utils/deployFlags.js` rather than in a repository variable: `vite build`
refuses a bundle whose `VITE_SCOPUS_ENABLED` disagrees with what is declared
there. Change the declaration first, in the commit that records why — setting
the variable alone only makes the build fail.
