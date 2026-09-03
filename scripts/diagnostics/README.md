# Manual Diagnostics

This directory contains one-off and historical probes for arXiv, OpenAlex, Elsevier, proxies,
OpenAIRE, Crossref, and related providers.

They are kept for debugging reference but are not part of `npm test` or ESLint. Many call live
services and can consume API quota.

**The public CORS proxies are dead, and the probes that use them can only fail.** Measured on
2026-08-22: `corsproxy.io` answers `Server-side requests are not allowed on your plan`, and
`api.allorigins.win` returns a 520. `test-fetch.js`, `testFetch.js`, `test-allorigins.mjs`,
`test-arxiv.mjs`, `test-rss.js`, `test-rss-seq.js` and `test-long3.js` all probe one of those or
`rss2json`, so a red result from them says nothing about the service they appear to be testing.
They are left in place as the record of what the app used to route through, and why it stopped:
arXiv and OpenAlex now reach the browser through the Worker's own routes instead.

Never put provider credentials in these scripts, URLs, logs, or public CORS proxies. Protected
provider probes must go through the PaperTok Worker and read secrets from Cloudflare bindings.

Run scripts from the repository root:

```bash
node scripts/diagnostics/test-openalex.js
```

When a diagnostic becomes a stable regression check, replace its live request with a fixture
and move the behavior into a colocated `*.test.js` file under `src/` or `worker/`.

## `explorer-loading-probe.mjs` — how an entity page waits (2026-09-03)

Drives a headless Chrome over CDP (no dependencies; Node ≥ 22 for the global
`WebSocket`) against the dev server on `localhost:5173`, with a fresh profile per
run so every load is cold. Three modes:

```bash
node scripts/diagnostics/explorer-loading-probe.mjs timeline '#/explorer/author/A5006398227' 14
node scripts/diagnostics/explorer-loading-probe.mjs tabs '#/explorer/institution/I173304897'
node scripts/diagnostics/explorer-loading-probe.mjs paint '#/explorer/author/A5006398227' new
node scripts/diagnostics/explorer-loading-probe.mjs paint '#/explorer/author/A5006398227' old
```

`timeline` records every change of the page's loading state (skeleton, live
hero, rows, ORCID card, Wikipedia block, impact score, empty state) from a
MutationObserver installed before the app's first script runs. `tabs` opens
Authors, comes back to Papers and checks the rows are still there without a
second request. `paint` holds the profile request so the skeleton stays up,
then traces three seconds of it and counts `Paint`, `RasterTask`, `GPUTask` and
style recalculation; `old` restores the previous `background-position` shimmer
by injecting a stylesheet, for a before/after on the same page. `PORT=9225`
picks another debugging port so runs can go in parallel.

Two more, added the same day:

```bash
node scripts/diagnostics/explorer-loading-probe.mjs wikiexit '#/explorer/topic/query-ec129ead?q=gravitational+lensing+of+quasars&source=free-text'
node scripts/diagnostics/explorer-loading-probe.mjs comments '#/'
```

`wikiexit` opens a topic whose Wikipedia lookup misses and samples the list's
top edge every frame while the reserved block folds away, reporting the biggest
single-frame move — a fold that ends in a jump shows up as one frame carrying
tens of pixels. `comments` opens the first card's thread in the guest feed and
samples the skeleton's and the empty state's computed opacity every frame
through the handover.
