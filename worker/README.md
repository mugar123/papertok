# PaperTok report API

This Cloudflare Worker protects provider keys and caches trend, related-paper and open-access queries.

```bash
npx wrangler secret put OPENALEX_API_KEY
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY
npx wrangler secret put OPENCITATIONS_ACCESS_TOKEN # optional, recommended for production traffic
npx wrangler secret put UNPAYWALL_EMAIL
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MODAL_PROXY_TOKEN_ID
npx wrangler secret put MODAL_PROXY_TOKEN_SECRET
npx wrangler secret put MODAL_KIMI_BASE_URL
npx wrangler secret put CORE_API_KEY # optional, raises CORE rate limits
npx wrangler secret put NASA_ADS_API_TOKEN # optional; INSPIRE is used until configured
npx wrangler secret put ELSEVIER_API_KEY # Scopus search; the browser flow stays dark without it
npx wrangler secret put ELSEVIER_INST_TOKEN # institutional token; required for the COMPLETE view and for non-subscribing networks
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_FROM_EMAIL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL # optional after verifying a custom domain
npm run worker:deploy:dry-run
npm run worker:deploy
```

Brevo is the primary notification provider when `EMAIL_PROVIDER = "brevo"`.
`BREVO_FROM_EMAIL` must match an active sender in the Brevo account. Resend remains
available as a fallback by changing `EMAIL_PROVIDER` to `resend`.

After deployment, set the GitHub Actions repository variable `VITE_PAPER_API_BASE_URL` to:

```text
https://papertok-report-api.<account>.workers.dev
```

Available routes are `/locale`, `/report/trends`, `/related`, `/citation-graph`, `/oa`, `/arxiv`, `/sources/biorxiv`, `/sources/europepmc`, `/sources/core`, `/sources/osti`, `/sources/nasa`, `/sources/physics`, `/sources/scopus`, `/sources/openreview`, `/sources/huggingface`, `/enrich/icite`, `/resources/huggingface`, `/ai/explain`, `/notifications/preferences`, `/notifications/test`, `/notifications/unsubscribe`, `/health/email`, `/health/ai`, `/health/scopus`, and `/health`. `/locale` returns only Cloudflare's country code for the automatic Spanish/English interface choice and is never cached. The citation graph combines OpenCitations relationships with OpenAlex metadata and caches the result for seven days. The specialist-source routes validate, cache and proxy biology, engineering, physics and AI searches so the browser never depends on public CORS proxies. OpenReview and Hugging Face are keyless discovery sources. NIH iCite enriches up to 200 validated PubMed identifiers per cached batch, while Hugging Face paper details expose associated models and datasets. `/sources/physics` uses NASA ADS when `NASA_ADS_API_TOKEN` is configured and falls back to the public INSPIRE API otherwise. `CORE_API_KEY` is optional; anonymous CORE access remains a best-effort fallback.

`/health/scopus` answers the only question that decides whether Scopus can ship: does
`ELSEVIER_API_KEY` authenticate from Cloudflare's network, and which view does it grant? It runs
one minimal search and reports whether the key is configured, whether an institutional token is
present, the upstream status, Elsevier's own error code, the view that answered, whether that view
carried an abstract, and the remaining provider quota — never the key or the token themselves. It
tries `COMPLETE`, then `STANDARD`, then the endpoint default, and records what each one answered,
so a failure names which view was refused and why. The probe costs one upstream call, so it is
served from the edge cache for ten minutes: hammering the route cannot drain the weekly Scopus
allowance. Only `COMPLETE` returns `dc:description`, so an account limited to `STANDARD` produces
papers without abstracts.

The AI route requires a valid PaperTok Firebase ID token and keeps provider credentials exclusively in the Worker. Gemini 3.5 Flash remains the primary provider. PDF acquisition and Gemini model attempts use bounded latency budgets; a slow open PDF degrades to the available abstract, and malformed structured output can retry once with Gemini Flash Lite without exceeding the browser deadline. The response parser preserves LaTeX commands even when a provider returns raw JSON backslashes. When Gemini explicitly reports that its daily provider quota is exhausted, `AI_FALLBACK_PROVIDER = "modal-kimi"` routes abstract-based explanations to Modal's OpenAI-compatible Kimi K3 Shared API. Modal authentication requires the complete proxy-token pair (`wk-...` ID plus `ws-...` secret) and the Shared API base URL shown in the Modal dashboard.

The Worker limits AI usage per user and globally per UTC day with atomic reservations in the
`RequestQuotaLedger` Durable Object. A reservation is consumed before contacting the provider,
so concurrent tabs cannot exceed the configured limit and failed provider calls fail safely.
Kimi is protected separately by the `KimiBudgetLedger` Durable Object: every request reserves
a conservative maximum before contacting Modal, actual usage is reconciled afterwards, and
calls stop at `KIMI_MONTHLY_HARD_CAP_USD`. Production uses a $27 monthly cap, leaving a $3
margin below Modal's $30 monthly free credit.

Routes backed by PaperTok provider credentials (`/report/trends`, `/related`,
`/citation-graph`, `/sources/core`, `/sources/physics`, and `/sources/scopus`) require a valid
Firebase ID token. They also reserve an atomic per-user and global request allowance per UTC
minute through `RequestQuotaLedger`. Cache keys are built only from validated, output-affecting
parameters, so arbitrary query parameters cannot bypass provider caches.
Authentication is checked before route handling, while quota is reserved only after parameter
validation and a cache miss. Invalid queries and cached responses therefore cannot consume the
provider allowance.

Email digests require the `NOTIFICATION_STORE` KV binding and a configured email provider. Production uses Brevo through `BREVO_API_KEY` and an active `BREVO_FROM_EMAIL`; Resend remains an optional fallback. The Worker verifies the Firebase ID token before storing a subscription, derives the recipient address from Firebase rather than trusting client input, and persists the active `es`/`en` interface language so the subject, body, dynamic labels, and unsubscribe page use the same locale. Enabled legacy records without follows are marked invalid and are never sent.

Opening an unsubscribe link with `GET` only shows a confirmation page. The subscription is
deleted by the subsequent `POST` (including RFC 8058 one-click requests), preventing link
scanners and email previews from silently disabling notifications. Preference request bodies
are capped at 96 KiB.

Cron windows run every 20 minutes from 07:00 through 13:40 UTC. A successful daily digest is due only once per UTC date, weekly subscriptions are due on Mondays, and later windows recover provider uncertainty or retry source failures after 40 minutes and authoritative empty selections after four hours. The final 13:40 window is recovery-only and never starts a new delivery. Each run has a 12-minute processing budget, keeps three minutes in reserve before starting another three-subscription page, and persists its KV cursor so deferred users resume on the next window instead of starving behind the same users. Both frequencies select only high-quality, unsent papers from a rolling 10-day publication window; `lastSentAt` controls scheduling but is not a content cutoff. Sent-paper identity history is bounded at 400 keys, enough to cover the window at the maximum configured volume. A scheduled digest with spare capacity may add at most one high-signal exploration paper, but never substitutes exploration when every followed source needed for the selection is unavailable. Test emails remain followed-only.

Native arXiv topic follows are queried directly in one grouped request, with OpenAlex fallback when arXiv is unavailable. OpenAlex, OpenAIRE, and arXiv requests have bounded timeouts and one bounded retry for rate limits, server failures, or network timeouts. Source attempts, successes, failures, retries, and stable failure codes are recorded without recipient data. An authoritative successful empty response remains an empty outcome; if every usable selection is empty while a required followed source remains unavailable, the run is marked transiently failed instead.

`EMAIL_DAILY_SEND_LIMIT` is enforced by the `EmailDeliveryLedger` Durable Object, using one atomic object per UTC day for scheduled and test sends. The object stores each reservation in its own bounded value plus a small counter, so a full production day remains below Durable Object value limits. Each send reserves quota before provider contact and then commits or releases it. Scheduled reservations and provider idempotency UUIDs are deterministic per subscription generation and UTC day, preventing concurrent cron windows from sending twice while isolating a later resubscription. If a provider response is lost or is not definitively rejected, the exact bounded email draft is retained for one retry between 5 and 25 minutes later; an expired uncertain reservation is conservatively committed rather than risk a duplicate. Committed reservations discard the draft, keep bounded delivery metadata, and every daily object deletes itself after three days. The following day can reconcile a successful provider delivery after a KV write failure without querying scientific sources or sending again. Provider logs contain only status and stable error codes. Tests and local environments without the binding use a serialized, short-lived KV fallback.

Subscription preferences and delivery state use separate, generation-scoped KV records with 120-day rolling retention, so a scheduled write cannot overwrite a concurrent preference change, recreate a deleted subscription, or contaminate a later resubscription. Schedule summaries remain at `notification:schedule:last-run` and are also written to 14-day `notification:schedule:history:*` keys; each subscription stores separate PII-free digest and test outcomes. `/health/email` returns an unhealthy HTTP status when either the provider is unavailable or the latest schedule is stale, and exposes only aggregate freshness, processed/deferred/uncertain counts, and stable failure codes, never recipient data.
