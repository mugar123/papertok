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
