# PaperTok report API

This Cloudflare Worker protects provider keys and caches trend, related-paper and open-access queries.

```bash
npx wrangler secret put OPENALEX_API_KEY
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY
npx wrangler secret put UNPAYWALL_EMAIL
npx wrangler deploy
```

After deployment, set the GitHub Actions repository variable `VITE_PAPER_API_BASE_URL` to:

```text
https://papertok-report-api.<account>.workers.dev
```

Available routes are `/report/trends`, `/related`, `/oa`, and `/health`. The frontend keeps direct, keyless fallbacks until the base URL is configured. `VITE_REPORT_API_URL` remains supported for backwards compatibility.
