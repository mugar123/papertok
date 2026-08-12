# Development Guide

## Requirements

- Node.js 22
- npm
- A Firebase web project for authenticated flows
- A Cloudflare account only when developing or deploying Worker functionality

## Setup

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The GitHub Pages base path is handled by Vite. Use the URL printed by the dev server for local
work.

## Environment Variables

Frontend variables are public in the built JavaScript:

| Variable | Purpose |
| --- | --- |
| `VITE_FIREBASE_*` | Firebase web configuration |
| `VITE_GA_MEASUREMENT_ID` | Public GA4 measurement ID; analytics remains consent-gated |
| `VITE_PAPER_API_BASE_URL` | Cloudflare Worker base URL |
| `VITE_REPORT_API_URL` | Legacy report API alias |
| `VITE_SCOPUS_ENABLED` | Enables Scopus-backed browser flows when the Worker is configured |
| `VITE_UNPAYWALL_EMAIL` | Public contact email required by Unpaywall |

Never put secret provider tokens in a `VITE_*` variable. See `worker/README.md` for Worker
secrets.

Google Analytics uses basic consent mode: the Analytics SDK is not loaded until the user
explicitly opts in. PaperTok records normalized application routes only. Entity identifiers,
searches, paper titles, interests, account identifiers, and recommendation events are excluded.
Consent is stored locally on the device and can be changed from Settings at any time.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite |
| `npm test` | Run frontend and Worker Node tests |
| `npm run lint` | Run ESLint |
| `npm run build` | Create the production bundle |
| `npm run preview` | Serve the production bundle locally |
| `npm run check` | Run lint, tests, and production build |

## Adding a Scientific Provider

1. Decide whether the browser can call the provider safely and reliably.
2. Put secret-bearing or CORS-sensitive access behind the Worker.
3. Add an adapter or service that maps results into the normalized paper shape.
4. Preserve provider provenance and distinguish unknown metadata from zero values.
5. Add deduplication and realistic fixture tests.
6. Add bounded timeouts and a fallback so one provider cannot block the feed.
7. Document rate limits and required configuration.

## Localization

PaperTok supports `es` and `en`.

- Read the active language from `LanguageContext`.
- Store canonical entity IDs, not translated labels, whenever possible.
- Add both languages in the same change.
- Include language in caches for translated or generated content.
- Worker-generated explanations and emails must follow the user's selected language.

## Manual Diagnostics

Historical and provider-specific probes live in `scripts/diagnostics/`. Run them from the
repository root, for example:

```bash
node scripts/diagnostics/test-openalex.js
```

These scripts may hit live APIs, depend on temporary provider behavior, or consume quota.
They are not acceptance tests.
