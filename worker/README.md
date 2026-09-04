# PaperTok report API

This Cloudflare Worker protects provider keys and caches trend, related-paper and open-access queries.

```bash
npx wrangler secret put OPENALEX_API_KEY # required since Feb 2026; without it OpenAlex runs on the $0.10/day anonymous budget
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY # required in practice, not optional -- see below; set 2026-09-02
npx wrangler secret put OPENCITATIONS_ACCESS_TOKEN # optional, recommended for production traffic
npx wrangler secret put UNPAYWALL_EMAIL
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MODAL_PROXY_TOKEN_ID
npx wrangler secret put MODAL_PROXY_TOKEN_SECRET
npx wrangler secret put MODAL_KIMI_BASE_URL
npx wrangler secret put NVIDIA_API_KEY # nvapi-... key from build.nvidia.com; serves the DeepSeek fallback
npx wrangler secret put CORE_API_KEY # optional, raises CORE rate limits
npx wrangler secret put NCBI_API_KEY # optional, raises PubMed E-utilities from 3 to 10 req/s
npx wrangler secret put NASA_ADS_API_TOKEN # optional; INSPIRE is used until configured
npx wrangler secret put SCOPUS_PROXY_URL # https://<project>.deno.dev -- see proxy/README.md
npx wrangler secret put SCOPUS_PROXY_SECRET # shared with the egress; the Elsevier key itself never lives here
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

After deployment, set the GitHub Actions repository variable `VITE_PAPER_API_BASE_URL` to
the Worker's Custom Domain:

```text
https://api.papertok.app
```

The native `https://papertok-report-api.<account>.workers.dev` route still answers and is
still accepted by `src/services/workerApiClient.js`, so a bundle built before the variable
was flipped keeps working.

Available routes are `/locale`, `/thread-anchor`, `/thread-anchor/invalidate`, `/account/delete`, `/report/trends`, `/related`, `/citation-graph`, `/oa`, `/arxiv`, `/sources/biorxiv`, `/sources/europepmc`, `/sources/pubmed`, `/sources/s2`, `/sources/core`, `/sources/osti`, `/sources/nasa`, `/sources/physics`, `/sources/scopus`, `/sources/openreview`, `/sources/huggingface`, `/enrich/icite`, `/resources/huggingface`, `/ai/explain`, `/notifications/preferences`, `/notifications/test`, `/notifications/unsubscribe`, `/openalex/*`, `/health/email`, `/health/ai`, `/health/scopus`, `/health/openalex`, and `/health`. `/locale` returns only Cloudflare's country code for the automatic Spanish/English interface choice and is never cached. The citation graph combines OpenCitations relationships with OpenAlex metadata and caches the result for seven days. The specialist-source routes validate, cache and proxy biology, engineering, physics and AI searches so the browser never depends on public CORS proxies. OpenReview and Hugging Face are keyless discovery sources. NIH iCite enriches up to 200 validated PubMed identifiers per cached batch, while Hugging Face paper details expose associated models and datasets. `/sources/physics` uses NASA ADS when `NASA_ADS_API_TOKEN` is configured and falls back to the public INSPIRE API otherwise. `CORE_API_KEY` is optional; anonymous CORE access remains a best-effort fallback.

`/thread-anchor` is the comments-sheet open path. The browser used to resolve a paper stub in Firestore and then query comments — a sequential chain on the Firestore WebChannel, which is what made an empty thread sit on a skeleton for seconds (and why closing and reopening was instant: the channel was warm). The Worker resolves the stub over Firestore REST, caches the correspondence in KV (`thread:v1:{paperKey}`, currently on `NOTIFICATION_STORE`), and returns the first page of comments with it. Guests can read it (comments are public); `POST /thread-anchor/invalidate` requires a Firebase identity and is called after a create, edit or delete so the next open rebuilds. KV is the cache (HTTP `Cache-Control: private, no-store`) so a delete is not raced by a CDN max-age. A 60-second TTL on live threads and a 2-minute TTL on empty stubs are the safety net for a missed invalidation. This is a **new** route: deploy the Worker before the frontend.

`POST /account/delete` deletes the signed-in Firebase account. It is authenticated with a Firebase ID token (no identity cache), uses the Firestore service account, and is safe to retry: each request does one bounded stage (dissociate comments, drop public lists, follows, profile and handle, the private user tree, newsletter KV, then Auth last). Comments stay in their threads with `dissociated: true` rather than being removed. This is a **new** route: deploy the Worker before the frontend.

`/sources/pubmed` runs the whole E-utilities chain server-side — esearch, then esummary and efetch
in parallel — and returns the three upstream payloads unchanged, so the browser keeps its own
mappers. Run from the browser that chain was three serial round trips with nothing cacheable in
between, and NCBI counts them against the caller's IP, so readers behind one NAT rate-limited each
other. `NCBI_API_KEY` is optional and raises the upstream allowance from 3 to 10 requests a second;
without it the route still answers. If efetch fails while the summaries succeed the route still
returns 200, marked `_papertok.efetch: "unavailable"`, because the client already falls back to
OpenAlex and Europe PMC for the abstract — and the ten-minute TTL bounds how long that degraded
answer can be served.

`/sources/pubmed` and `/sources/s2` deliberately do **not** require a Firebase identity: the guest
feed reads PubMed and the author pages are public, so demanding a session would make those branches
run, fail locally and be swallowed. They take the same trade `/openalex/*` does — origin gate, edge
cache, and a **global** per-minute ceiling reserved only after a cache miss
(`PUBMED_GLOBAL_MINUTE_LIMIT`, `S2_GLOBAL_MINUTE_LIMIT`). `/related` shares the Semantic Scholar
ceiling with `/sources/s2` because both spend the same provider allowance; the browser's old
per-tab limiter counted per caller, so N tabs were N times the limit.

`/thread-anchor` takes the same trade for the comments sheet: origin gate (`Origin` required — the
API host has no same-origin page), KV as the cache, and a **global** per-minute ceiling on Firestore
REST misses only (`THREAD_ANCHOR_GLOBAL_MINUTE_LIMIT`, default 120). A hit costs KV and nothing else.

`SEMANTIC_SCHOLAR_API_KEY` is listed above as if it were optional. It is not, in practice.
Measured on 2026-08-24, Semantic Scholar's anonymous pool refused **10 of 10** requests from a
residential address and **9 of 10** from the Worker: without a key, `/sources/s2` and `/related`
are both effectively unavailable, and were before either route existed. The secret was set on
**2026-09-02** and the difference was measured the next day — 5 of 6 through the Worker against
0 of 6 anonymous in the same minutes — so `/health` now reports `semanticScholarKeyConfigured`
alongside `pubmedKeyConfigured`. They are not the same kind of flag: NCBI's absence costs speed,
this one costs the source. A refusal is relayed as a 429 with the provider's own `retry-after`, not
flattened into a 502, so a client can tell a rate limit from an outage; every `/sources/*` route
does this now, not only Scopus.

The key's introductory rate limit is **1 RPS**, and Semantic Scholar applies it per second: of
five requests in one second, one is answered and four refused at once, with no `retry-after`
(measured 2026-09-03). `S2_GLOBAL_MINUTE_LIMIT` (60, shared by `/sources/s2` and `/related`) is
the same average and no say over which second, so under it both routes keep a one-a-second beat
(`worker/upstream-pace.js`): a caller takes the first free second in the shared ledger and sleeps
for it — at most 2.5 s of sleep, which does not count the handful of ledger round trips around it —
and is refused here with `retry-after: 3` rather than upstream when none is free within that budget.
Any gate that refuses — the minute ceiling, the identity quota, the beat, the OpenAlex
budget — gives back every unit an earlier gate had already taken for this request:
`reserveGates` accumulates what each gate takes, and `cacheResponse` refunds all of it on a
refusal. A ledger that cannot be reached between two gates refunds the same units from inside
`reserveGates` itself, which then re-throws so the router still answers with a 502. What is
never refunded is a failed fetch: a timeout is a send the provider received and did not
answer, and the ledger counts sends, not answers.
Derived from the beat's own 2.5 s wait budget rather than written beside it, so the two cannot drift
apart; the router's separate fallback of 2 s for a refusal Semantic Scholar itself sends speaks for
the provider's one-second window and stays as it is.
A refusal Semantic Scholar does send is relayed with the same short wait from both routes;
`/related` used to flatten every failure into a bare 502. Raising the ceiling does not help at
1 RPS — asking Semantic Scholar for a higher limit is what does.

`/openalex/*` exists because OpenAlex changed underneath the app. Since February 2026 it requires
an API key and bills each call against a daily budget — $0.10/day anonymous, $1/day on a free key —
so the browser can no longer hold the credential: an OpenAlex key accepts prepaid credit, which
makes a key in the bundle someone else's spending, not just someone else's quota. The route rebuilds
the upstream URL from an entity allowlist and a parameter allowlist, drops any `api_key` the caller
sends, and attaches the Worker's own. It deliberately does **not** require a Firebase identity —
the guest feed reads OpenAlex — so what protects the budget is a pair of global ceilings,
per-minute (`OPENALEX_GLOBAL_MINUTE_LIMIT`) and per-day (`OPENALEX_GLOBAL_DAILY_LIMIT`), reserved
only after an edge-cache miss and for as many calls as the route is about to spend. The origin gate
is not one of them and should not be counted as one: a request with no `Origin` header has nothing
to check, and one is trivially forged, so the ceiling is the frontier. The day matters because the
budget is daily and a per-minute ceiling does not bound it — 300/min is 432.000/day. Every route
that spends the budget reserves against both, `/openalex/*` for one call, `/report/trends` for two
and `/citation-graph` for up to nine, so a caller who cannot be identified still cannot outspend the
day. A
refusal is relayed with its own status and `retry-after` rather than flattened into a 502, and the
rate-limit headers are named in `access-control-expose-headers` so the browser can actually read
them; otherwise the client's backoff falls back to guessing, and since the budget resets at midnight
UTC that guess can be hours wrong. `/health/openalex` reports the remaining daily budget in dollars.
Minute first, day second, and the minute is given back when the day refuses.

`/sources/scopus` does not call Elsevier. `api.elsevier.com` is served by Cloudflare and so is this
Worker, so a subrequest never leaves Cloudflare's network and Elsevier answers it with
`500 GENERAL_SYSTEM_ERROR` — reproduced with a valid key, an invented key, and no key at all, while
the same request from other networks answers normally. Scopus is therefore reached through the Deno
Deploy egress in `proxy/README.md`, which is the only place the Elsevier key lives.

`/health/scopus` measures that whole chain. It runs one minimal search and reports whether the
egress is configured, whether an institutional token is in play, the upstream status, Elsevier's own
error code, the view that answered, whether that view carried an abstract, and the remaining
provider quota — never a key or a token. It tries `COMPLETE`, then `STANDARD`, then the endpoint
default, and records what each one answered, so a failure names which view was refused and why. The
probe costs one upstream call, so it is served from the edge cache for ten minutes: hammering the
route cannot drain the weekly Scopus allowance. One cached entry serves every allowed origin; the
CORS header is put back for whoever is asking, so a monitor without an `Origin` and a browser with
one no longer cost two provider calls for one answer. Only `COMPLETE` returns `dc:description`, so an
account limited to `STANDARD` produces papers without abstracts.

The AI route requires a valid PaperTok Firebase ID token and keeps provider credentials exclusively in the Worker. Gemini 3.5 Flash remains the primary provider. PDF acquisition and Gemini model attempts use bounded latency budgets; a slow open PDF degrades to the available abstract, and malformed structured output can retry once with Gemini Flash Lite without exceeding the browser deadline. The response parser preserves LaTeX commands even when a provider returns raw JSON backslashes. When Gemini explicitly reports that its daily provider quota is exhausted, `AI_FALLBACK_PROVIDER = "nvidia-deepseek,modal-kimi"` walks the fallback chain in cost order for abstract-based explanations: first DeepSeek V4 Flash on NVIDIA's free OpenAI-compatible API (`NVIDIA_API_KEY`, an `nvapi-...` key), then — only when NVIDIA could not answer — Modal's OpenAI-compatible Kimi K3 Shared API. Modal authentication requires the complete proxy-token pair (`wk-...` ID plus `ws-...` secret) and the Shared API base URL shown in the Modal dashboard.

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

Every route that requires a token also screens it locally before asking Identity Toolkit: three
base64url segments, an unexpired `exp`, and an `aud` matching `FIREBASE_PROJECT_ID` when that
variable is set. Nothing is verified here — the signature check stays with `accounts:lookup` — but
a string that could not have been issued by Firebase no longer costs an upstream call. The screen
runs after the identity cache, which only ever holds verified identities.

The publishing routes (`/lists/publish`, `/lists/update`, `/lists/unpublish`, `/lists/attribute`)
follow the same rule: each request is validated in full before a unit of the daily publishing
allowance (`PUBLIC_LIST_USER_DAILY_LIMIT`, `PUBLIC_LIST_GLOBAL_DAILY_LIMIT`) is reserved, so a
malformed body cannot consume one. Failures that did reach Firestore still consume theirs, which is
deliberate: they spend a read of the free-tier allowance, and the daily cap is what bounds it.
`/lists/publish` and the merge half of `/lists/update` pin their writes to the document version they
read, and retry once from a fresh read when they lose, so two tabs publishing or syncing at the same
moment can neither orphan a public document nor drop a paper from one. `/lists/unpublish` takes the
private list id from the share record, never from the request body.

Email digests require the `NOTIFICATION_STORE` KV binding and a configured email provider. Production uses Brevo through `BREVO_API_KEY` and an active `BREVO_FROM_EMAIL`; Resend remains an optional fallback. The Worker verifies the Firebase ID token before storing a subscription, requires the account to have proven the address (`emailVerified`, or a Google or GitHub identity carrying the same address) so nobody can subscribe a stranger's inbox, derives the recipient address from Firebase rather than trusting client input, and persists the active `es`/`en` interface language so the subject, body, dynamic labels, and unsubscribe page use the same locale. Enabled legacy records without follows are marked invalid and are never sent.

Both providers send `List-Unsubscribe` and RFC 8058 `List-Unsubscribe-Post` headers. Opening an unsubscribe link with `GET` only shows a confirmation page. The subscription is
deleted by the subsequent `POST` (including RFC 8058 one-click requests), preventing link
scanners and email previews from silently disabling notifications. Preference request bodies
are capped at 96 KiB.

Cron windows run every 20 minutes from 07:00 through 13:40 UTC. A successful daily digest is due only once per UTC date, weekly subscriptions are due on Mondays, and later windows recover provider uncertainty or retry source failures after 40 minutes and authoritative empty selections after four hours. The final 13:40 window is recovery-only and never starts a new delivery. Each run has a 12-minute processing budget, keeps three minutes in reserve before starting another three-subscription page, and persists its KV cursor so deferred users resume on the next window instead of starving behind the same users. Both frequencies select only high-quality, unsent papers from a rolling 10-day publication window; `lastSentAt` controls scheduling but is not a content cutoff. Sent-paper identity history is bounded at 400 keys, enough to cover the window at the maximum configured volume. A scheduled digest with spare capacity may add at most one high-signal exploration paper, but never substitutes exploration when every followed source needed for the selection is unavailable. Test emails remain followed-only.

Native arXiv topic follows are queried directly in one grouped request, with OpenAlex fallback when arXiv is unavailable. OpenAlex, OpenAIRE, and arXiv requests have bounded timeouts and one bounded retry for rate limits, server failures, or network timeouts. Source attempts, successes, failures, retries, and stable failure codes are recorded without recipient data. An authoritative successful empty response remains an empty outcome; if every usable selection is empty while a required followed source remains unavailable, the run is marked transiently failed instead.

`EMAIL_DAILY_SEND_LIMIT` is enforced by the `EmailDeliveryLedger` Durable Object, using one atomic object per UTC day for scheduled and test sends. The object stores each reservation in its own bounded value plus a small counter, so a full production day remains below Durable Object value limits. Each send reserves quota before provider contact and then commits or releases it. Scheduled reservations and provider idempotency UUIDs are deterministic per subscription generation and UTC day, preventing concurrent cron windows from sending twice while isolating a later resubscription. If a provider response is lost or is not definitively rejected, the exact bounded email draft is retained for one retry between 5 and 25 minutes later; an expired uncertain reservation is conservatively committed rather than risk a duplicate. Committed reservations discard the draft, keep bounded delivery metadata, and every daily object deletes itself after three days. The following day can reconcile a successful provider delivery after a KV write failure without querying scientific sources or sending again, but only while the delivery state has not caught up with the ledger: a reservation whose delivery is already recorded in `lastSentAt` is skipped, so yesterday's committed send cannot swallow today's digest. Provider logs contain only status and stable error codes. The KV emulation of the ledger is serialized only inside one isolate, so it is limited to tests and local runs and requires the explicit `EMAIL_DELIVERY_LEDGER_FALLBACK = "kv"` variable; a deployment with a configured provider and no Durable Object binding aborts the cron with `EMAIL_DELIVERY_LEDGER_MISSING` and reports it in `/health/email` instead of degrading silently.

Subscription preferences and delivery state use separate, generation-scoped KV records with 120-day rolling retention, so a scheduled write cannot overwrite a concurrent preference change, recreate a deleted subscription, or contaminate a later resubscription. Schedule summaries remain at `notification:schedule:last-run` and are also written to 14-day `notification:schedule:history:*` keys; each subscription stores separate PII-free digest and test outcomes. `/health/email` returns an unhealthy HTTP status when the provider is unavailable, the latest schedule is stale, or the delivery ledger is not the Durable Object, and exposes only aggregate freshness, processed/deferred/uncertain counts, and stable failure codes, never recipient data. Because the Brevo probe shares the provider rate limit with real delivery, the answer is served from the edge cache for five minutes, like the Scopus and OpenAlex probes.
