# PaperTok report API

This Cloudflare Worker protects the OpenAlex API key and caches aggregate trend queries.

```bash
npx wrangler secret put OPENALEX_API_KEY
npx wrangler deploy
```

After deployment, set the GitHub Actions repository variable `VITE_REPORT_API_URL` to:

```text
https://papertok-report-api.<account>.workers.dev/report/trends
```

The frontend keeps a direct, keyless OpenAlex fallback until that variable is configured.
