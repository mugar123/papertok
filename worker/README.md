# PaperTok report API

This Cloudflare Worker protects provider keys and caches trend, related-paper and open-access queries.

```bash
npx wrangler secret put OPENALEX_API_KEY
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY
npx wrangler secret put OPENCITATIONS_ACCESS_TOKEN # optional, recommended for production traffic
npx wrangler secret put UNPAYWALL_EMAIL
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put CORE_API_KEY # optional, raises CORE rate limits
npx wrangler deploy
```

After deployment, set the GitHub Actions repository variable `VITE_PAPER_API_BASE_URL` to:

```text
https://papertok-report-api.<account>.workers.dev
```

Available routes are `/report/trends`, `/related`, `/citation-graph`, `/oa`, `/arxiv`, `/sources/biorxiv`, `/sources/europepmc`, `/sources/core`, `/sources/osti`, `/sources/nasa`, `/ai/explain`, and `/health`. The citation graph combines OpenCitations relationships with OpenAlex metadata and caches the result for seven days. The specialist-source routes validate, cache and proxy biology and engineering searches so the browser never depends on public CORS proxies. `CORE_API_KEY` is optional; anonymous CORE access remains a best-effort fallback.

The AI route requires a valid PaperTok Firebase ID token and keeps `GEMINI_API_KEY` exclusively in the Worker. It defaults to Gemini 3.5 Flash and can later switch provider through `AI_PROVIDER` without changing the frontend.

The Worker limits AI usage to 5 successful generations per user and 100 globally per UTC day by default. Bind a KV namespace as `AI_USAGE` for persistent distributed counters; without it, the Cloudflare cache provides a best-effort fallback. Keep the Gemini project on its free tier with billing disabled as the hard protection against charges.
