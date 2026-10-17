# PaperTok Worker API

This Cloudflare Worker protects provider keys and serves scientific queries, AI, account, institution, notification and share routes.

## Source structure

Wrangler loads `worker/index.js`. It delegates HTTP requests to `handleRequest(request, env)` in `router.js`, runs the email schedule, and exports the three Durable Object classes.

- `router.js` owns dispatch order, the Origin checks for the feature and health routes (`/health` and `/notifications/unsubscribe` have none), Firebase identity for `PROTECTED_PROVIDER_PATHS`, institution access and `/ai/quota`, a GET-only check for every route after the AI POST routes, and error responses. Most feature handlers check their own methods.
- Provider handlers refuse a disallowed Origin themselves. A request without an Origin passes, except on `/pdf`, which requires one. The `/sources/*` handlers check through `sourceRequestContext` in `provider-runtime.js`. `/share/*` has no Origin check because it serves crawlers.
- `http.js` owns JSON responses, allowed Origins and CORS headers.
- `provider-runtime.js` owns canonical cache keys, provider quota reservations and refunds, the shared OpenAlex budget, the Semantic Scholar beat, the default upstream deadlines and `fetchWithDeadline`.
- `arxiv-api.js` and `share-route.js` keep the arXiv beat through `upstream-pace.js`, and `share-route.js` reserves its own `share:` ceilings in the request-quota ledger. arXiv, share, the PDF proxy, the citation graph and paper figures set their own deadlines; the PDF proxy and paper figures fetch with their own timers instead of `fetchWithDeadline`.
- `openalex-api.js`, `citation-graph.js`, `open-access.js`, `arxiv-api.js`, `pdf-proxy.js`, `semantic-scholar.js`, `scopus-api.js`, `physics-api.js` and `share-route.js` own their provider handlers. Small source handlers are in `source-api.js`; health responses are in `health-api.js`.
- Existing feature modules own AI, accounts, institutions, notifications, lists and ledgers.

Provider modules use the shared runtime and HTTP helpers. `http.js` imports nothing; `provider-runtime.js` imports `http.js`, the request-quota ledger and `upstream-pace.js`. Neither imports the router or a provider module. OpenAlex relay, graph and share requests reserve against the same budget in `provider-runtime.js`.

## Local testing

From the repository root, install dependencies with `npm ci`. Run the Worker with `npx wrangler dev --local --port 8787`. Local provider credentials belong in the untracked root `.dev.vars` file; never put them in `VITE_*` variables. Local mode emulates KV and Durable Objects, but provider requests still reach live services and can consume quota. `--local` also turns off remote bindings, so the Workers AI binding cannot reach Cloudflare: the PDF-to-text conversion for NaN rewrites fails, and NaN is handed the PDF itself (about 45 s to the first token). To test the conversion, run `npx wrangler login` and then `npx wrangler dev --port 8787` without `--local`. Wrangler then runs the AI binding on the Cloudflare account and warns that this may incur usage charges.

For the frontend, copy `.env.example` to `.env.local` and run `npm run dev -- --port 5173` in another terminal. The example points both API variables to `http://localhost:8787`. Firebase web configuration is already in `src/services/firebase.js`; signing in uses the configured Firebase project.

To use the app with made-up accounts instead of real Google or GitHub sign-in, run `npm run dev:emulators` instead of `npm run dev` (`PORT=5174 npm run dev:emulators` picks another port). It starts the Firebase Auth and Firestore emulators, which need firebase-tools on `PATH` and Java 21 or later (see [`tests/README.md`](../tests/README.md)), and runs Vite in `emulators` mode against them. The app then signs in as `tester@example.com` whenever a page loads with nobody signed in. A new account starts at onboarding. Add `?as=<name>` to any URL, for example `http://localhost:5173/feed?as=alice`, to switch to `<name>@example.com`; the same name always reopens the same account. Guest screens show only between logging out and the next page load, so test them with `npm run dev`. Accounts and Firestore documents stay on this machine and are saved to the untracked `.firebase-emulators/` directory when you stop the command with Ctrl+C. The Worker still checks tokens against the real Firebase project, so routes that require a signed-in user answer 401 for emulator accounts: plain-words rewrites, passage explanations, related papers, the citation graph, the CORE, physics and Scopus sources, institution access, public lists, notifications and account deletion.

Run the entry-point and routing tests without credentials or live provider calls:

```bash
node --test worker/index.test.js worker/router.test.js
```

Before opening a PR, run `npm run check`. It includes the secret scan, lint, Node tests, frontend build and Worker dry-run. The build needs the API variables from `.env.local`. A dry-run packages the Worker without deploying it.

## Deployment

```bash
npx wrangler secret put OPENALEX_API_KEY # required since Feb 2026; without it OpenAlex runs on the $0.10/day anonymous budget
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY # required in practice, not optional -- see below; set 2026-09-02
npx wrangler secret put OPENCITATIONS_ACCESS_TOKEN # optional, recommended for production traffic
npx wrangler secret put UNPAYWALL_EMAIL
npx wrangler secret put NAN_API_KEY # sk-... personal key from nan.builders; the primary AI provider since 2026-10-06
npx wrangler secret put GEMINI_API_KEY # only used while AI_PROVIDER = "gemini"
npx wrangler secret put CORE_API_KEY # optional, raises CORE rate limits
npx wrangler secret put NCBI_API_KEY # optional, raises PubMed E-utilities from 3 to 10 req/s
npx wrangler secret put NASA_ADS_API_TOKEN # optional; INSPIRE is used until configured
npx wrangler secret put SCOPUS_PROXY_URL # https://<project>.deno.dev -- see proxy/README.md
npx wrangler secret put SCOPUS_PROXY_SECRET # shared with the egress; the Elsevier key itself never lives here
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_FROM_EMAIL
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put RESEND_FROM_EMAIL # optional after verifying a custom domain
npx wrangler secret put GETFTR_API_KEY # optional; /access asks GetFTR first once set (GETFTR_API_URL overrides the endpoint)
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

Available routes are `/share/paper/:key`, `/share/list/:shareId`, `/share/entity/:type/:id`, `/account/delete`, `/institution/link`, `/institution/unlink`, `/institution/services`, `/access`, `/related`, `/citation-graph`, `/oa`, `/arxiv`, `/pdf`, `/sources/biorxiv`, `/sources/europepmc`, `/sources/pubmed`, `/sources/s2`, `/sources/core`, `/sources/osti`, `/sources/nasa`, `/sources/physics`, `/sources/scopus`, `/sources/openreview`, `/sources/huggingface`, `/enrich/icite`, `/resources/huggingface`, `/ai/rewrite`, `/ai/annotate`, `/ai/quota`, `/notifications/preferences`, `/notifications/test`, `/notifications/unsubscribe`, `/openalex/*`, `/health/email`, `/health/ai`, `/health/scopus`, `/health/openalex`, and `/health`. The citation graph combines OpenCitations relationships with OpenAlex metadata and caches the result for seven days. `/oa` asks Unpaywall first; when Unpaywall has not indexed a DOI yet (a 404, which is every paper a day old), it reads the Crossref licence instead and answers in Unpaywall's shape with `source: 'crossref'` — only a Creative Commons licence on the version of record (`vor` or `unspecified`) whose `start` has passed counts, so a publisher's text-mining licence or a licence on the accepted manuscript alone does not. A DOI neither can answer for comes back as `source: 'unresolved'` and is cached for six hours; an upstream outage is a 502 and is not cached. The specialist-source routes validate, cache and proxy biology, engineering, physics and AI searches so the browser never depends on public CORS proxies. OpenReview and Hugging Face are keyless discovery sources. NIH iCite enriches up to 200 validated PubMed identifiers per cached batch, while Hugging Face paper details expose associated models and datasets. `/sources/physics` uses NASA ADS when `NASA_ADS_API_TOKEN` is configured and falls back to the public INSPIRE API otherwise. `CORE_API_KEY` is optional; anonymous CORE access remains a best-effort fallback. `/pdf?url=` relays a paper's PDF to the touch-screen viewer, which draws the pages itself with pdf.js because framed PDFs do not work on phones: only the hosts the AI routes already read (arXiv, Europe PMC, PMC) are accepted, redirects are checked against the same list, the body must be a PDF of at most 8 MB, the request must carry an allowed `Origin`, a hit is served from the edge cache for a day, and misses share a per-minute ceiling (`PDF_GLOBAL_MINUTE_LIMIT`, 120 by default) that closes when the ledger is missing.

`POST /account/delete` deletes the signed-in Firebase account. It is authenticated with a Firebase ID token (no identity cache), uses the Firestore service account, and is safe to retry: each request does one bounded stage (delete the comments and content reports from before comments were removed, drop public lists, follows, clear `createdBy` on paper stubs, profile and handle, the private user tree, newsletter KV, then Auth last). Replies other accounts wrote under a deleted comment stay. This is a **new** route: deploy the Worker before the frontend.

`POST /institution/link` and `POST /institution/unlink` record the university of the signed-in account on `users/{uid}.institution` (domain, ROR id, display name, acronym, IdP entityID, `verifiedAt`) with the Firestore service account. The proof is checked through Identity Toolkit with no identity cache: the session's own verified address, or, when the account lives on a personal address, a second Google account's ID token sent as `institutionToken` in the JSON body (16 KB cap) and verified the same way. The address's domain is resolved against ROR (`query.advanced=domains:<domain>`, matched on the record's `domains`) and against the SeamlessAccess federation metadata for the identity provider's entityID, which stays `null` when the metadata has no entry or is down. A resolved institution is cached at the edge for seven days; a domain without a ROR record is a 404 and is not cached; a ROR outage is a 502. The Firestore rules keep the field frozen for the client (`frozenUserFieldsUntouched`), so only these routes ever write or clear it. Both need an allowed `Origin` and use no new secrets. These are **new** routes: deploy the Worker before the frontend.

`GET /access?doi=<doi>&domain=<domain>` says whether a reader's library gives access to a paper: `{ status: 'entitled' | 'not-entitled' | 'unknown', collection, url }`. It requires a Firebase ID token (the 60 s identity cache applies) and, when an `Origin` is sent, an allowed one. The DOI follows the `/oa` rule and the domain the institution-link rule; a malformed one is a 400 (`INVALID_DOI`, `INVALID_DOMAIN`). The optional `entityId` (an https SAML entityID) and `rorId` (`https://ror.org/…`) name the institution to GetFTR and are a 400 `INVALID_INSTITUTION_ID` when malformed. When the `GETFTR_API_KEY` secret is set and either id was sent, GetFTR's Entitlement API (`POST /v2.1/entitlements` at `GETFTR_API_URL`, `https://entitlements.prod.getft.io` by default) is asked first: `yes` is `entitled` with its version-of-record link and `collection: 'GetFTR'`, `no` is `not-entitled`, and `maybe`, an unsupported publisher or a GetFTR failure fall through. The library's Alma link resolver comes next, for the domains listed in `INSTITUTION_RESOLVERS` (`worker/institution-access.js`, today `usal.es`): Crossref gives the journal's ISSNs (electronic first, at most two) and year, plus the article's volume, issue and first page, which go to the resolver with the DOI (`rft_id`) so that its link lands on the article rather than the journal's home page (Alma's APS parser reads the DOI, ScienceDirect's the volume and page), and the resolver's `svc_dat=CTO` answer is `entitled` when it lists a full-text service, preferring a subscription over a free one, whose `resolution_url` passes through the university's sign-in. A DOI Crossref does not know, a work without an ISSN, an unreadable resolver answer, or a GetFTR failure with no resolver behind it is `unknown`. A domain with neither provider is a 404 `INSTITUTION_NOT_SUPPORTED`; a Crossref or resolver failure is a 502 `ACCESS_LOOKUP_UNAVAILABLE`. One 8 s deadline covers the whole lookup (GetFTR, Crossref and the resolver together), and the browser waits 10 s so a slow answer is still cached by both sides. The answer is the institution's, not the reader's, so it is cached at the edge by the normalized DOI, domain and ids, plus what the resolver was asked about (`citation=article`, so answers from before the article locators were sent are not served on), for seven days, `unknown` for six hours, and errors not at all. This is a **new** route: deploy the Worker before the frontend.

`GET /institution/services?domain=<domain>` lists the publisher platforms the reader's library subscribes to: `{ services: [{ id, name, publisher, url, monogram, color, collection, ownPlatform }], partial, unchecked, checkedAt }`. It takes the same token, `Origin` rule, `domain`, optional `entityId` and `rorId`, and 400, 404 `INSTITUTION_NOT_SUPPORTED` and 502 `ACCESS_LOOKUP_UNAVAILABLE` codes as `/access`, without the DOI. `SERVICE_CATALOGUE` (`worker/institution-services.js`) has 66 platforms, chosen from what 19 university resolvers reported on 2026-10-14. Each entry has a flagship journal's ISSN and year and one DOI from that journal that Unpaywall reports as closed, because GetFTR says yes to open content for any institution; publishers whose articles all open after an embargo (PNAS, ASM, Cold Spring Harbor, Rockefeller University Press, the Society for Neuroscience) are left out for that reason; Mary Ann Liebert now publishes through Sage. Every platform needs a bundled logo (SVG or PNG) in `src/assets/publishers/` (`publisherLogos.test.js` fails otherwise). A probe asks the `/access` providers in the same order: GetFTR with the DOI when it can be asked, then the library's resolver with the ISSN and year directly, without Crossref. A platform is listed when the probe is entitled. A resolver answer counts only through a subscription service, not a free archive. The publisher's own package (its name carries the entry's `packageHint`) is preferred over an aggregator's, `collection` is the chosen package's name, and `ownPlatform` is false when only an aggregator such as ProQuest has the journal. With GetFTR, `collection` is `null` and `ownPlatform` is true. A GetFTR `no` leaves the platform out; a `maybe`, an unsupported publisher, a per-DOI error or a `yes` without a link, with no resolver to ask next, leaves it out too but counts it in `unchecked`, so the client does not report it as missing. `monogram` and `color` are catalogue data for the client's tile; publisher logos and favicons are trademarks and are never fetched. One lookup sends at most `SUBREQUEST_BUDGET` (40) requests upstream, because a Worker invocation on the free plan may make 50 subrequests and the route spends a few more around the lookup; the 66-platform catalogue overran that on 2026-10-14 and every list came back 502. With a key, GetFTR is asked in batches of twenty DOIs (`askGetFtrBatch`), so the whole catalogue costs four requests and the resolver only gets what GetFTR left undecided; without a key, the resolver is asked one journal per request, in catalogue order, and the platforms past the budget are counted in `unchecked` rather than listed as missing. At most four probes run at once under one 12 s deadline for the whole list. A probe that fails, times out or gets an unreadable answer leaves its platform out and sets `partial: true`; the route answers 502 only when every probe failed. The list is cached at the edge by the domain, a fingerprint of the catalogue and the budget (`servicesCacheParams`, so a changed catalogue is never served from an older list) and, with a GetFTR key, the ids: seven days when complete, one hour when partial, errors not at all. This is a **new** route: deploy the Worker before the frontend.

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

`/share/*` answers HTML, not JSON: the page a crawler reads for a shared link
(`worker/share-pages.js`). `vercel.json`
rewrites crawler user agents from `/public/{paper,list,user,entity}/…` here (profiles are gone, so
`/share/user/…` answers the not-found page), so the routes are
public, GET and HEAD only, and need no `Origin`: they sit ahead of every Origin gate. Each answers
the deployed shell (`https://papertok.app/index.html`, kept five minutes) with the page's own
head, a static copy inside `#root` and, for a paper, the paper as a JSON seed; a page whose source
is final about it is a 404 with `noindex`, a DOI or PMID OpenAlex has not indexed yet and a
provider failure get the generic head. The record behind a paper or an entity is kept 24 hours, a
list's five minutes (its owner can take it back), a missing page one hour and a
failure two minutes, and the page is composed per request, always in English (`Accept-Language` is
not consulted, so there is no `Vary: Accept-Language`). What a miss
may spend is bounded before any provider is asked — 60 a minute and 1000 a day in all (`share:`
ledger periods), 120 arXiv calls an hour with the unit given back when no seat comes — and each
OpenAlex call is then also reserved on the shared OpenAlex budget, like any `/openalex/*` call.
Identical requests in one isolate share one lookup; a refused admission is not cached, and a
failure never replaces a record another request found. Lists are read from Firestore
anonymously, so the rules decide as they do for a visitor. These are **new** routes: deploy the
Worker before the frontend, and check them with a crawler user agent.

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
that spends the budget reserves against both, `/openalex/*` for one call
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

The AI routes require a valid PaperTok Firebase ID token and keep provider credentials exclusively in the Worker.

Since 2026-10-06 every AI route (`/ai/rewrite`, `/ai/annotate`) answers through NaN Builders, an OpenAI-compatible EU cluster (`AI_PROVIDER = "nan"`, `NAN_API_KEY`, `NAN_MODEL = "deepseek-v4-flash"`); `AI_PROVIDER = "gemini"` switches all of them back to the Gemini models below. Every NaN call turns reasoning off through `chat_template_kwargs`: with it on, a rewrite spent its whole 16,384-token budget thinking and wrote nothing, and `reasoning_effort` is ignored on this model. `deepseek-v4-flash` takes `json_object` but not `json_schema`, so field contracts travel in the prompt. A rewrite hands NaN the paper as text: the Workers AI binding (`[ai] binding = "AI"`, used only for `toMarkdown`) converts the PDF in 1.5–3 s, and the first section arrives a few seconds later (a 15-page paper: first section at about 6 s, complete in about 33 s, measured 2026-10-06). When the conversion fails, NaN is handed the PDF itself, which works but costs about 45 s before the first token. NaN refuses with 402 when the model's monthly token allowance is spent (reported as `AI_QUOTA_EXHAUSTED`, resetting on the first of the month) and 429 at its 60 requests per minute or 7 concurrent requests per model (`AI_BUSY`). `/health/ai` probes only the provider `AI_PROVIDER` names; for NaN it checks that the configured `NAN_MODEL` is served and reports `paperText` for the binding.

With `AI_PROVIDER = "gemini"`, `/ai/rewrite` streams from `AI_REWRITE_MODEL` (or `AI_MODEL` when that is unset) and retries the call that opens the stream once on `AI_FALLBACK_MODEL` when Gemini answers `AI_BUSY`, `AI_UNAVAILABLE` or `AI_QUOTA_EXHAUSTED`. The response parser preserves LaTeX commands even when a provider returns raw JSON backslashes.

The Worker limits AI usage per user and globally per UTC day with atomic reservations in the
`RequestQuotaLedger` Durable Object. A reservation is consumed before contacting the provider,
so concurrent tabs cannot exceed the configured limit and failed provider calls fail safely.
Nothing uses the `KimiBudgetLedger` Durable Object; its class is still exported only so that a
later, separate change can delete it with a `deleted_classes` migration.

Routes backed by PaperTok provider credentials (`/related`,
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

Email digests require the `NOTIFICATION_STORE` KV binding and a configured email provider. Production uses Brevo through `BREVO_API_KEY` and an active `BREVO_FROM_EMAIL`; Resend remains an optional fallback. The Worker verifies the Firebase ID token before storing a subscription, requires the account to have proven the address (`emailVerified`, or a Google or GitHub identity carrying the same address) so nobody can subscribe a stranger's inbox, derives the recipient address from Firebase rather than trusting client input, and sends every digest and unsubscribe page in English (`<html lang="en">`): PaperTok is English-only, so the stored `language` is always `en`, a legacy `language: 'es'` record simply receives English, and the unsubscribe page ignores a legacy `lang` query parameter and `Accept-Language`. Enabled legacy records without follows are marked invalid and are never sent.

Both providers send `List-Unsubscribe` and RFC 8058 `List-Unsubscribe-Post` headers. Opening an unsubscribe link with `GET` only shows a confirmation page. The subscription is
deleted by the subsequent `POST` (including RFC 8058 one-click requests), preventing link
scanners and email previews from silently disabling notifications. Every answer on that route is
a page set on the digest's paper (the PT mark and nameplate over the double rule, a serif
headline, one ink action), errors included, and every one carries the same `no-store`,
`no-referrer` and script-free CSP headers, since the token is in the URL. A link that was
already used, replaced by a newer email or cut short answers `400` with a page that sends the
reader to Settings; a missing `NOTIFICATION_STORE` binding answers `503`. The CSP admits no web
fonts, so the page draws the digest's three voices from their local fallback stacks. Preference
request bodies are capped at 96 KiB.

Cron windows run every 20 minutes from 07:00 through 13:40 UTC, every day, so `/health/email` keeps seeing a fresh run; only Monday's windows send. The digest is weekly for everyone since 2026-10: a subscription is due once on a Monday, whatever `frequency` it stored (a record saved as `daily` before the choice was retired is weekly too), preferences always report and store `weekly`, and Tuesday's and Wednesday's windows reconcile the previous day's ledger. Later windows recover provider uncertainty or retry source failures after 40 minutes and authoritative empty selections after four hours. A digest whose latest attempt this week failed with `EMAIL_DIGEST_SOURCES_UNAVAILABLE`, and that has not been sent this week, may also start a new digest on Tuesday (only Tuesday, with the same 40-minute spacing): that failure happens before any delivery is reserved, so nothing can have been sent. That is the only failure after which the Tuesday rule starts a new digest. A send whose outcome was uncertain is still recovered by the existing reservation recovery described below, which replays or reconciles the reserved delivery instead of starting a new one; Wednesday's windows reconcile Tuesday reservations without starting new digests or querying scientific sources. Any other failure, and a failure from an earlier week, starts no new digest before the next Monday. The final 13:40 window is recovery-only and never starts a new delivery. Each run has a 12-minute processing budget, keeps three minutes in reserve before starting another three-subscription page, and persists its KV cursor so deferred users resume on the next window instead of starving behind the same users. The digest selects only high-quality, unsent papers from a rolling 10-day publication window; `lastSentAt` controls scheduling but is not a content cutoff. Sent-paper identity history is bounded at 400 keys, enough to cover the window at the maximum configured volume. A scheduled digest with spare capacity may add at most one high-signal exploration paper, but never substitutes exploration when every followed source needed for the selection is unavailable. Test emails remain followed-only.

The email is set as *The PaperTok Weekly*, a small front page in the app's design language (white sheet, serif headlines, mono metadata, hairline rules, the yellow PT mark): a dateline, the nameplate, the highest-scoring paper as the lead story with an excerpt of its abstract, the other followed papers as two columns of briefs (stacked on phones), and the exploration pick boxed apart. The subject is the lead headline and how many papers follow it. Each paper carries its field (`area`, one of the twelve `CATEGORIES` keys) and, when its source has one, its abstract: arXiv supplies the primary category and the summary, OpenAlex the work's `primary_topic` and its rebuilt abstract (`usableOpenAlexAbstract`, so an editorial's body is never shown), and the app's preview items carry the card's own `areaKeyForPaper` answer, which the Worker accepts only when it is a known key. A paper of no known field is set in ink with no field name, and one without an abstract leads with no excerpt. The field inks are the light theme's `--gradient-*` values, copied into the Worker and held to `src/styles/variables.css` by a test; the area lookup itself is imported from `src/utils/areaAccent.js`, which reads the dependency-free `src/data/categoryTaxonomy.js` so the Worker bundle carries no React.

Native arXiv topic follows are queried directly in one grouped request, with OpenAlex fallback when arXiv is unavailable. OpenAlex, OpenAIRE, and arXiv requests have bounded timeouts and one bounded retry for rate limits, server failures, or network timeouts. Source attempts, successes, failures, retries, and stable failure codes are recorded without recipient data. An authoritative successful empty response remains an empty outcome; if every usable selection is empty while a required followed source remains unavailable, the run is marked transiently failed instead.

Within one schedule run, identical OpenAlex requests (the date-only exploration query, a followed author, topic, institution or search, a project's DOI lookup) are sent once and their parsed response is shared by every reader who asks. Each reader's relevance filter, follow attribution and sent-paper exclusion still run on that response separately, so no digest changes. The shared requests live only for the run, a failed one is dropped so a later reader retries it with its own bounded retry, and at most 200 answers are kept, past which a request goes upstream unshared. Test emails do not share. Per-source reports therefore separate the questions asked (`attempted`, `succeeded`, `failed`) from the HTTP calls made (`requestAttempts`, `retried`). OpenAIRE and arXiv requests are not shared.

`EMAIL_DAILY_SEND_LIMIT` is enforced by the `EmailDeliveryLedger` Durable Object, using one atomic object per UTC day for scheduled and test sends. The object stores each reservation in its own bounded value plus a small counter, so a full production day remains below Durable Object value limits. Each send reserves quota before provider contact and then commits or releases it. Scheduled reservations and provider idempotency UUIDs are deterministic per subscription generation and UTC day, preventing concurrent cron windows from sending twice while isolating a later resubscription. If a provider response is lost or is not definitively rejected, the exact bounded email draft is retained for one retry between 5 and 25 minutes later; an expired uncertain reservation is conservatively committed rather than risk a duplicate. Committed reservations discard the draft, keep bounded delivery metadata, and every daily object deletes itself after three days. The following day can reconcile a successful provider delivery after a KV write failure without querying scientific sources or sending again, but only while the delivery state has not caught up with the ledger: a reservation whose delivery is already recorded in `lastSentAt` is skipped, so yesterday's committed send cannot swallow today's digest. Provider logs contain only status and stable error codes. The KV emulation of the ledger is serialized only inside one isolate, so it is limited to tests and local runs and requires the explicit `EMAIL_DELIVERY_LEDGER_FALLBACK = "kv"` variable; a deployment with a configured provider and no Durable Object binding aborts the cron with `EMAIL_DELIVERY_LEDGER_MISSING` and reports it in `/health/email` instead of degrading silently.

Subscription preferences and delivery state use separate, generation-scoped KV records with 120-day rolling retention, so a scheduled write cannot overwrite a concurrent preference change, recreate a deleted subscription, or contaminate a later resubscription. Schedule summaries remain at `notification:schedule:last-run` and are also written to 14-day `notification:schedule:history:*` keys; each subscription stores separate PII-free digest and test outcomes. `/health/email` returns an unhealthy HTTP status when the provider is unavailable, the latest schedule is stale, or the delivery ledger is not the Durable Object, and exposes only aggregate freshness, processed/deferred/uncertain counts, and stable failure codes, never recipient data. Because the Brevo probe shares the provider rate limit with real delivery, the answer is served from the edge cache for five minutes, like the Scopus and OpenAlex probes.
