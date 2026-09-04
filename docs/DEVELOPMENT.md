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

The site is served from the domain root, so Vite's `base` is `/`. Use the URL printed by the dev
server for local work.

## Environment Variables

Frontend variables are public in the built JavaScript:

| Variable | Purpose |
| --- | --- |
| `VITE_FIREBASE_*` | Firebase web configuration |
| `VITE_PAPER_API_BASE_URL` | Cloudflare Worker base URL |
| `VITE_REPORT_API_URL` | Legacy report API alias |
| `VITE_SCOPUS_ENABLED` | Enables Scopus-backed browser flows. Declared `false` in `src/utils/deployFlags.js`, which is where the decision is made and reviewed; `vite build` fails when this variable disagrees with that declaration, so change the declaration first. Check `/health/scopus` on the Worker before ever declaring it on: with the flag on and the key refused, the feed queues calls that only ever fail. Scopus reaches Elsevier through the Deno Deploy egress in `proxy/README.md`, never from the Worker |
| `VITE_UNPAYWALL_EMAIL` | Public contact email required by Unpaywall |

Never put secret provider tokens in a `VITE_*` variable. See `worker/README.md` for Worker
secrets. OpenAlex is reached through the Worker's `/openalex/*` route for exactly this reason: since
February 2026 it requires a key and bills against a daily budget, and its keys take prepaid credit.
Without `VITE_PAPER_API_BASE_URL` the browser still calls OpenAlex directly, on the anonymous
$0.10/day allowance.

## Analytics

Measurement is **Vercel Web Analytics**, and it stays consent-gated: `AnalyticsProvider` renders
`<Analytics />` only while consent is granted, so the script is not on the page at all until the
reader opts in. It sets no cookies of its own.

PaperTok records normalized application routes and a strict allowlist of coarse funnel events
(acquisition channel, guest demo, search result count, follow/save/share, AI explanation status,
onboarding, newsletter subscription, activation, and day-seven return). Entity identifiers, search
text, paper titles, interests, account identifiers, URLs, and other free-form values are excluded.
Consent is stored in local browser storage with a first-party cookie fallback, so either explicit
choice survives reloads. It can be changed from Settings.

Two details are load-bearing and easy to undo by accident:

- The app uses `HashRouter`, so every route lives in the fragment and `location.pathname` is `/`
  for all of them. Passing `route` to `<Analytics />` disables the script's own pathname-based
  tracking and makes the component emit each view instead. Remove it and the whole site collapses
  into a single `/` row.
- `route`, `path` and the `beforeSend` rewrite all carry the *normalized* path, never the real one.
  The published privacy policy promises that reading a paper is reported as `/public/paper/:id`
  and never says which; `sanitizeAnalyticsEventUrl` is what keeps that true, because the script
  builds its payload's `url` from `location.href` on its own.

**Custom events need a paid plan.** On Hobby, Vercel accepts page views and discards custom
events, so the funnel above is wired but silent. Pro allows 2 properties per event; four of these
events carry 3 or 4 (`paper_export`, `paper_open`, `paper_annotation`, `share`), so keeping every
field needs the Web Analytics Plus add-on. The instrumentation is left in place either way: moving
to Pro turns it on with no code change.

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
