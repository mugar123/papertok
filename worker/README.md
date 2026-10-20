# PaperTok Worker API

This Cloudflare Worker protects provider keys and serves scientific queries, AI, account, institution, notification and share routes.

## Source structure

Wrangler loads `worker/index.ts`. It delegates HTTP requests to `handleRequest(request, env)` in `router.ts`, logs one line for every 429 and 5xx answer (see [Logs](#logs)), runs the email schedule, and exports the three Durable Object classes.

- `router.ts` owns dispatch order, the Origin checks for the feature and health routes (`/health` and `/notifications/unsubscribe` have none), Firebase identity for `PROTECTED_PROVIDER_PATHS`, institution access and `/ai/quota`, a GET-only check for every route after the AI POST routes, and error responses. Most feature handlers check their own methods.
- Provider handlers refuse a disallowed Origin themselves. A request without an Origin passes, except on `/pdf`, which requires one. The `/sources/*` handlers check through `sourceRequestContext` in `provider-runtime.ts`. `/share/*` has no Origin check because it serves crawlers.
- `http.ts` owns JSON responses, allowed Origins and CORS headers.
- `provider-runtime.ts` owns canonical cache keys, provider quota reservations and refunds, the shared OpenAlex budget, the Semantic Scholar beat, the default upstream deadlines and `fetchWithDeadline`.
- `arxiv-api.ts` and `share-route.ts` keep the arXiv beat through `upstream-pace.ts`, and `share-route.ts` reserves its own `share:` ceilings in the request-quota ledger. arXiv, share, the PDF proxy, the citation graph and paper figures set their own deadlines; the PDF proxy and paper figures fetch with their own timers instead of `fetchWithDeadline`.
- `openalex-api.ts`, `citation-graph.ts`, `open-access.ts`, `arxiv-api.ts`, `pdf-proxy.ts`, `semantic-scholar.ts`, `scopus-api.ts`, `physics-api.ts` and `share-route.ts` own their provider handlers. Small source handlers are in `source-api.ts`; health responses are in `health-api.ts`.
- Existing feature modules own AI, accounts, institutions, notifications, lists and ledgers.

Provider modules use the shared runtime and HTTP helpers. `http.ts` imports nothing; `provider-runtime.ts` imports `http.ts`, the request-quota ledger and `upstream-pace.ts`. Neither imports the router or a provider module. OpenAlex relay, graph and share requests reserve against the same budget in `provider-runtime.ts`.

## Local testing

From the repository root, install dependencies with `npm ci`. Run the Worker with `npx wrangler dev --local --port 8787`. Local provider credentials belong in the untracked root `.dev.vars` file; never put them in `VITE_*` variables. Local mode emulates KV and Durable Objects, but provider requests still reach live services and can consume quota. `--local` also turns off remote bindings, so the Workers AI binding cannot reach Cloudflare: the PDF-to-text conversion for NaN rewrites fails, and NaN is handed the PDF itself (about 45 s to the first token). To test the conversion, run `npx wrangler login` and then `npx wrangler dev --port 8787` without `--local`. Wrangler then runs the AI binding on the Cloudflare account and warns that this may incur usage charges.

For the frontend, copy `.env.example` to `.env.local` and run `npm run dev -- --port 5173` in another terminal. The example points both API variables to `http://localhost:8787`. Firebase web configuration is already in `src/services/firebase.ts`; signing in uses the configured Firebase project.

To use the app with made-up accounts instead of real Google or GitHub sign-in, run `npm run dev:emulators` instead of `npm run dev` (`PORT=5174 npm run dev:emulators` picks another port). It starts the Firebase Auth and Firestore emulators, which need firebase-tools on `PATH` and Java 21 or later (see [`tests/README.md`](../tests/README.md)), and runs Vite in `emulators` mode against them. The app then signs in as `tester@example.com` whenever a page loads with nobody signed in. A new account starts at onboarding. Add `?as=<name>` to any URL, for example `http://localhost:5173/feed?as=alice`, to switch to `<name>@example.com`; the same name always reopens the same account. Guest screens show only between logging out and the next page load, so test them with `npm run dev`. Accounts and Firestore documents stay on this machine and are saved to the untracked `.firebase-emulators/` directory when you stop the command with Ctrl+C. The Worker still checks tokens against the real Firebase project, so routes that require a signed-in user answer 401 for emulator accounts: plain-words rewrites, passage explanations, related papers, personal recommendations, the citation graph, the CORE, physics and Scopus sources, institution access, public lists, notifications and account deletion.

Run the entry-point and routing tests without credentials or live provider calls:

```bash
node --test worker/index.test.ts worker/router.test.ts
```

Before opening a PR, run `npm run check`. It includes the secret scan, lint, Node tests, frontend build and Worker dry-run. The build needs the API variables from `.env.local`. A dry-run packages the Worker without deploying it.

## Deployment

```bash
npx wrangler secret put OPENALEX_API_KEY # required since Feb 2026; without it OpenAlex runs on the $0.10/day anonymous budget
npx wrangler secret put SEMANTIC_SCHOLAR_API_KEY # required in practice, not optional -- see below; set 2026-09-02
npx wrangler secret put OPENCITATIONS_ACCESS_TOKEN # optional, recommended for production traffic
npx wrangler secret put UNPAYWALL_EMAIL # the contact Unpaywall is asked with, by /oa and, for SFX libraries, /access (app@papertok.io when unset)
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
npm run worker:deploy -- --tag "$(git rev-parse --short HEAD)" # GET /health then names this commit
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
still accepted by `src/services/workerApiClient.ts`, so a bundle built before the variable
was flipped keeps working.

Available routes are `/share/paper/:key`, `/share/list/:shareId`, `/share/entity/:type/:id`, `/account/delete`, `/institution/link`, `/institution/unlink`, `/institution/services`, `/access`, `/related`, `/recommendations`, `/citation-graph`, `/oa`, `/arxiv`, `/pdf`, `/sources/biorxiv`, `/sources/europepmc`, `/sources/pubmed`, `/sources/s2`, `/sources/core`, `/sources/osti`, `/sources/nasa`, `/sources/physics`, `/sources/scopus`, `/sources/openreview`, `/sources/huggingface`, `/enrich/icite`, `/resources/huggingface`, `/ai/rewrite`, `/ai/annotate`, `/ai/quota`, `/notifications/preferences`, `/notifications/test`, `/notifications/unsubscribe`, `/openalex/*`, `/health/email`, `/health/ai`, `/health/scopus`, `/health/openalex`, and `/health`. The citation graph combines OpenCitations relationships with OpenAlex metadata and caches the result for seven days. `/oa` asks Unpaywall first; when Unpaywall has not indexed a DOI yet (a 404, which is every paper a day old), it reads the Crossref licence instead and answers in Unpaywall's shape with `source: 'crossref'` — only a Creative Commons licence on the version of record (`vor` or `unspecified`) whose `start` has passed counts, so a publisher's text-mining licence or a licence on the accepted manuscript alone does not. A DOI neither can answer for comes back as `source: 'unresolved'` and is cached for six hours; an upstream outage is a 502 and is not cached. The specialist-source routes validate, cache and proxy biology, engineering, physics and AI searches so the browser never depends on public CORS proxies. OpenReview and Hugging Face are keyless discovery sources. NIH iCite enriches up to 200 validated PubMed identifiers per cached batch, while Hugging Face paper details expose associated models and datasets. `/sources/physics` uses NASA ADS when `NASA_ADS_API_TOKEN` is configured and falls back to the public INSPIRE API otherwise. `CORE_API_KEY` is optional; anonymous CORE access remains a best-effort fallback. `/pdf?url=` relays a paper's PDF to the touch-screen viewer, which draws the pages itself with pdf.js because framed PDFs do not work on phones: only the hosts the AI routes already read (arXiv, Europe PMC, PMC) are accepted, redirects are checked against the same list, the body must be a PDF of at most 8 MB, the request must carry an allowed `Origin`, a hit is served from the edge cache for a day, and misses share a per-minute ceiling (`PDF_GLOBAL_MINUTE_LIMIT`, 120 by default) that closes when the ledger is missing.

`POST /account/delete` deletes the signed-in Firebase account. It is authenticated with a Firebase ID token (no identity cache), uses the Firestore service account, and is safe to retry: each request does one bounded stage (delete the comments and content reports from before comments were removed, drop public lists, follows, clear `createdBy` on paper stubs, profile and handle, the private user tree, newsletter KV, then Auth last). Replies other accounts wrote under a deleted comment stay. Every request also needs a recent sign-in: when the verified token's `auth_time` is missing or more than 240 s old, the route answers 401 `AUTH_RECENT_LOGIN_REQUIRED` before it deletes anything. Identity Toolkit refuses to delete the Auth account for a sign-in that is not recent (`CREDENTIAL_TOO_OLD_LOGIN_AGAIN`), and Auth is the last stage, so without this check that refusal arrived after the data was gone. Firebase does not document its window; it is commonly reported as five minutes. The settings dialog signs the user in again with a popup just before the first request. A deletion that runs past the window stops with the same 401 while `users/{uid}`, the newsletter and Auth are still there, and the next request after a new sign-in continues it. This is a **new** route: deploy the Worker before the frontend.

`POST /institution/link` and `POST /institution/unlink` record the university of the signed-in account on `users/{uid}.institution` (domain, ROR id, display name, acronym, IdP entityID, `verifiedAt`) with the Firestore service account. The proof is checked through Identity Toolkit with no identity cache: the session's own verified address, or, when the account lives on a personal address, a second Google account's ID token sent as `institutionToken` in the JSON body (16 KB cap) and verified the same way. The address's exact domain is resolved against ROR in one question, and the stored domain is the address's own. A domain ROR lists is found with `query.advanced=domains:<domain>`, matched on the record's `domains`; a website on another domain is no evidence against a record. A subdomain is not linked through its parent, because a parent proves no membership: alumni.cmu.edu is alumni mail, mgh.harvard.edu a hospital, and ROR lists the public suffix nhs.uk as two organisations. So an address links only when ROR lists its domain or when the domain is in `CHECKED_MAIL_DOMAINS` (`worker/institution-link.ts`), the student and staff mail domains checked by hand, each with the university page that documents it and the date it was read. An entry names either the university's ROR id, which ROR is asked for by id (`GET /v2/organizations/<id>`: alumnos.uc3m.es is stored as UC3M with ROR's name and acronym, and `/access` finds UC3M's library by that id; such an entry wins over a record ROR lists the domain under, so purdue.edu, which ROR lists only under the Clifford B. Kinley Trust, links to Purdue University West Lafayette), or a domain to ask ROR about instead: neu.edu and husky.neu.edu, the legacy domains of Northeastern in Boston, are asked about as northeastern.edu, because ROR lists neu.edu under Northeastern in Shenyang, and the record must list northeastern.edu. The checked entries also disambiguate Ghent, Sydney, Manitoba, Nevada–Reno and Rochester from research-unit records returned first for the same domain, pin lmu.de to LMU (ROR also lists it under the Walther-Straub-Institut), and cover student mail at ETH Zurich, Edinburgh, Leiden, Sydney, Manitoba, Rochester, TUM (mytum.de) and LMU (campus.lmu.de). `/access` does not read this list. The SeamlessAccess federation metadata is asked for the identity provider's entityID under the address's domain, then under the domain ROR lists for the university (uc3m.es for alumnos.uc3m.es); the entityID stays `null` when the metadata has no entry or is down (husky.neu.edu: Northeastern's provider is listed under neu.edu only). Every registry question of one link shares a 10 s budget (`LINK_LOOKUP_BUDGET_MS`), under the browser's 15 s wait with room for the token checks and the write: a budget that runs out during the ROR question is a 502 `INSTITUTION_LOOKUP_UNAVAILABLE`, never a 404, and no further question is started past it; the federation question is skipped when the budget is gone and the link completes with `entityId: null`. A resolved institution is cached at the edge for seven days (third cache generation since 2026-10-19: the first could hold the Shenyang record for neu.edu, the second an institution reached through a parent domain). The key of a hand-checked domain also names the ROR id or domain its entry asks about, so adding, changing or removing an entry takes effect for that domain at once, while a change to how every domain is resolved still needs a new generation. A domain without a ROR record is a 404 and is not cached; a ROR outage is a 502. The Firestore rules keep the field frozen for the client (`frozenUserFieldsUntouched`), so only these routes ever write or clear it. Both need an allowed `Origin` and use no new secrets. These are **new** routes: deploy the Worker before the frontend.

`GET /access?doi=<doi>&domain=<domain>` says whether a reader's library gives access to a paper: `{ status: 'entitled' | 'not-entitled' | 'unknown', collection, url }`. `not-entitled` means the library is not the reader's way in: it lists no full text for the paper, or, for an SFX library, the paper is open to anyone (below). It requires a Firebase ID token (the 60 s identity cache applies) and, when an `Origin` is sent, an allowed one. The DOI follows the `/oa` rule and the domain the institution-link rule; a malformed one is a 400 (`INVALID_DOI`, `INVALID_DOMAIN`). The optional `entityId` (an HTTP(S) SAML entityID such as Manitoba’s `http://CAF.AD.UMANITOBA.CA/adfs/services/trust`, or a URN assigned name such as `urn:mace:incommon:usc.edu`, up to 300 characters) and `rorId` (`https://ror.org/…`) name the institution to GetFTR and are a 400 `INVALID_INSTITUTION_ID` when malformed. When the `GETFTR_API_KEY` secret is set and either id was sent, GetFTR's Entitlement API (`POST /v2.1/entitlements` at `GETFTR_API_URL`, `https://entitlements.prod.getft.io` by default) is asked first: `yes` is `entitled` with its version-of-record link and `collection: 'GetFTR'`, `no` is `not-entitled`, and `maybe`, an unsupported publisher or a GetFTR failure fall through. The library's Alma link resolver comes next, for the institutions in `INSTITUTION_RESOLVERS` (`worker/institution-resolvers.ts`, found by ROR id first and by a domain ROR lists for it second, never by a hand-checked mail domain, since one university answers to several domains; the table is generated by `scripts/diagnostics/alma-resolver-census.mjs`, which finds each library's institution code on its own pages and the Alma region by probing, and keeps only codes that answered): Crossref gives the journal's ISSNs (electronic first, at most two) and year, plus the article's volume, issue and first page, which go to the resolver with the DOI (`rft_id`) so that its link lands on the article rather than the journal's home page (Alma's APS parser reads the DOI, ScienceDirect's the volume and page), and the resolver's `svc_dat=CTO` answer is `entitled` when it lists a full-text service, preferring a subscription over a free one, whose `resolution_url` passes through the university's sign-in. A service Alma itself filtered out (`Filtered`, with a `Filter reason`) does not count, link or not: filtered for the date, it is a collection whose coverage ends before the article (Pau, Nature 2020, until 2012) and the answer is a refusal; filtered for any other reason (an IP range, a user group) it is a service the Worker cannot judge, and the answer is `unknown` rather than `not-entitled`. A library that sends readers straight to one service answers with `available_services` = `single_service` and no `full_text_indicator` at all (Harvard, Helsinki, Amsterdam, 2026-10-19); its services still carry Alma's filter marks, so such an answer is read from what it lists unfiltered: a live service is access, only filtered services is a refusal. A DOI Crossref does not know, a work without an ISSN, or a GetFTR failure with no resolver behind it is `unknown`. A domain with neither provider is a 404 `INSTITUTION_NOT_SUPPORTED`; a Crossref or resolver failure is a 502 `ACCESS_LOOKUP_UNAVAILABLE`, and so is a resolver answer the Worker cannot read: one without a context object, or one whose markup does not hold together, as when it was cut off or lost a tag or a quote (a single-service answer cut off before its services would otherwise read as a refusal, and a `Filtered` key that never closes would count a service Alma filtered out as access). Instead of validating the answer as XML, which took about 1 ms per answer in local Node measurements, the Worker checks its tags in one pass: every `<` starts a tag, a CDATA section or, at the very start, an XML declaration, every element closes inside the one it opened in, the root (`uresolver_content`) closes at the end, a key holds no element and no service opens inside another. The Worker matches tags only as Alma writes them, not in every spelling XML allows: element names without a namespace prefix, each attribute after a single space and in double quotes, with no space around `=` and no `<`, `>` or `&` in its value, no space before a tag's `>` or `/>`, a key with a value opened as `<key id="…">` and a link as `<resolution_url>`; and it reads a service up to the next `</context_service>`, so a service closed in its own opening tag (`<context_service .../>`) is refused too. An answer written otherwise is unreadable: read anyway, a `Filtered` key would count as absent, a full-text service written `service_type='getFullTxt'` would be skipped or lose its link, or a service would be read with the next one's keys. Every saved answer writes its tags this way. CDATA sections are read as literal text before extracting keys, services and links, so a `Filtered` value in CDATA still excludes its service and markup inside a public note cannot become a key or service. Text outside CDATA is not checked, so a complete answer that is not well-formed XML only because of an unescaped `&` is still read. Outside CDATA, only `&lt;`, `&gt;`, `&quot;`, `&#39;` and `&amp;` are decoded; any other reference stays as written, so a `Filtered` value written `&#116;rue` would not exclude its service. The 42 saved answers use only `&lt;` and `&amp;` outside CDATA. One 8 s deadline covers the whole lookup (GetFTR, Crossref and the resolver together), and the browser waits 10 s so a slow answer is still cached by both sides. The answer is the institution's, not the reader's, so it is cached at the edge by the normalized DOI, the library's institution code and the host it is asked on (or the domain when the institution has no resolver; a regional host can answer for a code without the library's data, so a row moved to the library's own host is asked again) and the ids, plus what the resolver was asked about (`citation=article`, so answers from before the article locators were sent are not served on) and how its answer is read (`reading=balanced-tags-cdata`, so answers that counted a filtered service as access, read a cut-off answer as a refusal, or read past a key left open or a tag written another way, are not served on either), for seven days, `unknown` for six hours, and errors not at all. This is a **new** route: deploy the Worker before the frontend.

Three rows of `INSTITUTION_RESOLVERS` carry `product: 'sfx'`: TUM, LMU and FAU, whose libraries run SFX instances on the Bavarian library network's server (`sfx.bib-bvb.de/sfx_tum`, `/sfx_ubm`, `/sfx_uben`; a pilot, the census's other SFX libraries are not read). For them the resolver step asks the instance an OpenURL 1.0 with the same ISSN, year, DOI, volume, issue and first page, `svc.fulltext=yes` (only full-text services: without it the instances also look up print holdings and loan options and answered in 5 to 10 s instead of 0.4 to 1.8 s on 2026-10-20) and `sfx.response_type=multi_obj_detailed_xml`. Only `getFullTxt` services of the journal asked about count: SFX resolves an ISSN to a journal of its knowledge base, sometimes another one (1234-5678 came back as a different journal), so the context object must carry the ISSN asked about; holdings, loans, document delivery and the other service types never count. SFX has no free flag, so a collection whose knowledge-base name says free, freely, open access, DOAJ or PubMed Central is open access rather than the library's and does not make the answer `entitled`; an answer that lists only such collections is `not-entitled`, like an answer without full text. A name without those words proves no subscription either: TUM listed MDPI's own platform for an Entropy article and SpringerLink for a Scientific Reports one, both open (2026-10-20). So an article whose version of record Crossref says is openly licensed, by the same rule `/oa` reads (`openLicenseFromCrossref`), is `not-entitled` without asking the instance: it is open access, not the library's. A missing licence proves nothing either way: Crossref has none for most closed articles (40 of the catalogue's 66 closed probe DOIs) and none for Entropy 19(2):87, an open MDPI article TUM's SFX also lists (2026-10-20). So when the instance lists a service it does not name free, the Worker asks Unpaywall, the `/oa` route's source, about the DOI: an article whose published version Unpaywall has behind the publisher's paywall (`closed`, or `green` with only a repository copy) is `entitled`; one open at the publisher (`gold`, `hybrid` or `bronze`) is `not-entitled`; a DOI Unpaywall has not indexed, or a record without one of those statuses, is `unknown`; an Unpaywall failure is a 502. Unpaywall is asked once per lookup, inside its deadline, and only when the answer depends on it. A closed article keeps its subscription beside any free collections. An answer about another journal or without a knowledge-base record, a related journal's service, full text of selected articles only, a licensed service linked only over plain http, or `sfx.has_full_text` without a listed service is `unknown`; an incomplete answer (its root, an object or a service left open), an HTML page or an SFX failure is a 502. SFX does not authenticate the reader, and its target URL goes straight to the publisher, usually the article's DOI link. `url` is that link through the remote-access login the library documents, the row's `proxy`, with the target encoded as `qurl`: TUM's eAccess (`https://tum-eaccess.de/login?qurl=`) and LMU's E-Medien login (`https://emedien.ub.uni-muenchen.de/login?qurl=`), both EZproxy, kept such targets whole, their own encoded parameters included, on the way to the university's sign-in (2026-10-20). A link already on the login's host, or on a host the row lists in `signsIn` because its links start the library's sign-in themselves (LMU's Gale links, on `find.gale.com` and `link.gale.com`, reach LMU's Shibboleth), is left as it is; LMU's EBSCO and Nexis Uni links end at the platform's own sign-in without E-Medien, so they go through it. FAU documents eduVPN and Shibboleth per database and no general login, so its links go to the article directly; off campus its readers sign in at the publisher or connect to the VPN. The edge cache key of these rows also carries `product=sfx`, and the login and the self-signing hosts when they have them.

`GET /institution/services?domain=<domain>&offset=0` checks publications and publisher platforms for the linked library. It returns `{ services: [{ id, name, publisher, url, monogram, color, collection, ownPlatform }], partial, unchecked, checkedAt, nextOffset, catalogue }`; `catalogue`, sent with paged requests only, is the fingerprint of the catalogue the page was cut from (the one in the cache key). Authentication, origins, institution identifiers and provider errors follow `/access`, without its DOI parameter. `offset` must be a nonnegative integer within the catalogue; invalid values return 400 `INVALID_SERVICES_OFFSET`. Follow `nextOffset` until it is `null`. Each page contains at most 36 candidates, with at most four resolver probes running concurrently, a 12 s deadline and a 40-request upstream budget. No probe starts more than 6 s after the page's first resolver probe, so the last one still has 6 s to answer when GetFTR was quick, and the page ends at the first candidate no probe started for: `nextOffset` names it, so the next page asks about it instead of the same first titles again. The time GetFTR takes does not shorten the page; what the deadline then cuts is `partial`, and a page where everything asked about failed is a 502. A fast library still gets pages of 36. TUM's SFX ran into the deadline with 36; on 2026-10-20 it answered the whole catalogue in five pages of 13, 22, 19, 18 and 2 titles, 74 probes and 33 s in all, nothing partial or unchecked, 51 platforms listed. Two GetFTR batches plus every resolver fallback fit that budget. Clients omitting `offset` retain the single-request behaviour, without the window: candidates beyond its budget count as `unchecked`. Older Workers omit `nextOffset`; the current client accepts that bounded result.

`SERVICE_CATALOGUE` (`worker/institution-services.ts`) contains 66 publisher platforms and eight news/business publications. Platform probes use a flagship journal's ISSN and year and a paywalled DOI. GetFTR is asked in batches of twenty DOIs when configured; undecided or failed probes fall through to the institution's resolver. The eight new publications have no probe DOI and go directly to the resolver by ISSN and year. Without a resolver they count as `unchecked`, even when GetFTR is available. An accessible sample identifies a source worth trying; it does not establish access to every article or every year. The individual DOI check and feed ordering are unchanged.

Only paid full-text services count, excluding free archives and services Alma filtered out. A service hidden by an IP or group restriction counts as `unchecked`. For an SFX library the same reading as `/access` applies: free collections are left out, and an answer about another journal or one that cannot be judged leaves the platform `unchecked`. Every catalogue journal is a subscription journal whose probe article was closed when it was chosen, so a service SFX does not name free counts as the library's here, without asking Unpaywall; the per-paper answer asks about the article itself. A press title has no probe article. The Guardian, free on the web, came back from TUM only through PressReader and from LMU through Gale, Nexis Uni and PressReader (FAU: no full text, 2026-10-20), but an SFX service for its website that is not named free would be listed. A press title's library link goes through the row's login as on `/access`. The package name matching `packageHint` is preferred; otherwise `ownPlatform: false` and `collection` identify the aggregator, such as ProQuest or EBSCO. Finding a newspaper in an aggregator does not establish a direct website subscription. For the titles without probe DOIs, `url` is the selected library service link so that the row opens that access route; existing platform links keep their publisher destinations. Bundled logos live in `src/assets/publishers/`, including their provenance; the browser fetches none from publishers at runtime.

The additional titles are The Economist (0013-0613), Financial Times (0307-1766), The Wall Street Journal (0099-9660), The New York Times (0362-4331), The New Yorker (0028-792X), The Guardian (0261-3077), Harvard Business Review (0017-8012), and Bloomberg Businessweek (0007-7135). Candidates came from [MIT's news guide](https://libguides.mit.edu/news/home), [its science journalism guide](https://libguides.mit.edu/sciencejournalism) and the [publisher's ABI/INFORM title list](https://tls.search.proquest.com/titlelist/jsp/list/tlsSingle.jsp?productId=10000008); identifiers were checked against publisher/library records. These are sources of candidates, not a universal or university-specific holdings list. Probes use 2025, the last complete calendar year at addition. On 2026-10-19 MIT returned paid services for all eight, and USAL for six (no service for NYT or Businessweek). The Guardian's [public website is free to read](https://patrons.theguardian.com/); only a paid library collection qualifies here. Embargoes, editions and collections can differ, so these observations are not a promise of current article access.

A failed or unreadable probe, a probe the deadline cut short included, sets `partial: true` and is never read as no access; a page where every attempted probe failed returns 502. The client follows pages sequentially, preserves earlier results if a later page fails, and bounds the complete operation to 45 s and ten pages, with 15 s per request. The edge cache includes library identity, resolver host and product, the login and the self-signing hosts of SFX rows, GetFTR identifiers when used, canonical offset, resolver reading version and a fingerprint of every catalogue field, page size, start window and request budget. A list those bounds cut short keeps, in the client, where it stopped and what it found, per account and institution: once its partial answer expires, the next run goes on from there instead of spending its ten pages on the titles already checked, which the edge would serve but which count all the same. While a later reading of the catalogue is under way, a refresh included, the client keeps showing the last list it read to the end, and replaces it only when the new reading finishes. A page carrying another `catalogue` than the list's, or a 400 for the kept offset, starts the list over; an invalid continuation is not kept; a failed page keeps what was found and is asked again. What the client keeps lives in the page's memory, so a reload starts the list over, with the pages already checked served from the edge. Complete results live for seven days, partial results for one hour, errors are not cached. The client applies the same lifetimes to the combined result. Worker and frontend can be deployed separately; deploy the Worker first to enable the expanded scan.


`/sources/pubmed` runs the whole E-utilities chain server-side — esearch, then esummary and efetch
in parallel — and returns the three upstream payloads unchanged, so the browser keeps its own
mappers. Run from the browser that chain was three serial round trips with nothing cacheable in
between, and NCBI counts them against the caller's IP, so readers behind one NAT rate-limited each
other. `NCBI_API_KEY` is optional and raises the upstream allowance from 3 to 10 requests a second;
without it the route still answers. If efetch fails while the summaries succeed the route still
returns 200, marked `_papertok.efetch: "unavailable"`, because the client already falls back to
OpenAlex and Europe PMC for the abstract — and the ten-minute TTL bounds how long that degraded
answer can be served.

`/sources/pubmed` and `/sources/s2` deliberately do **not** require a Firebase identity: the author
pages are public, so demanding a session would make those branches run, fail locally and be
swallowed. They take the same trade `/openalex/*` does — origin gate, edge
cache, and a **global** per-minute ceiling reserved only after a cache miss
(`PUBMED_GLOBAL_MINUTE_LIMIT`, `S2_GLOBAL_MINUTE_LIMIT`). `/related` and `/recommendations` share
the Semantic Scholar ceiling with `/sources/s2` because all three spend the same provider allowance;
the browser's old per-tab limiter counted per caller, so N tabs were N times the limit.

`/recommendations` is the For You feed's personal retrieval. It takes `POST { positive, negative }`:
up to 10 Semantic Scholar ids of papers the reader liked, saved or read at length, and up to 10 they
rejected, each `ARXIV:`, `DOI:`, `PMID:` or a 40-character corpus hash. One malformed id refuses the
request with `400 INVALID_EXAMPLES` before anything is spent. The ids are sorted and deduplicated,
sent to Semantic Scholar's `POST /recommendations/v1/papers`, and the answer is reduced to
`{ papers: [{ arxivId, doi }] }`, in Semantic Scholar's order and without the papers that carry
neither; the browser fetches the papers themselves from arXiv and OpenAlex. When none of the
positive examples is in Semantic Scholar's corpus it answers 400 `No positive paper examples given`
(measured 2026-10-17), which the route returns as an empty list cached for two minutes; any other
refusal is relayed like `/related`'s. The answer is the reader's own: it requires a Firebase ID
token, its edge-cache key carries the verified uid beside the examples, and it leaves the Worker as
`private, no-store`. The browser makes one request each time the interaction profile loads, about
one interest: the category of an example drawn at random, so each interest comes up as often as the
reader gives examples of it.

`/share/*` answers HTML, not JSON: the page a crawler reads for a shared link
(`worker/share-pages.ts`). `vercel.json`
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
(measured 2026-09-03). `S2_GLOBAL_MINUTE_LIMIT` (60, shared by `/sources/s2`, `/related` and
`/recommendations`) is the same average and no say over which second, so under it the three routes
keep a one-a-second beat
(`worker/upstream-pace.ts`): a caller takes the first free second in the shared ledger and sleeps
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
A paper Semantic Scholar has not indexed (its recommendations endpoint answers 404) is not a
failure: `/related` answers 200 `{ recommendedPapers: [], code: 'PAPER_NOT_INDEXED' }` and caches
it for one hour instead of a day, so a newly indexed paper gets its recommendations soon.

`/openalex/*` exists because OpenAlex changed underneath the app. Since February 2026 it requires
an API key and bills each call against a daily budget — $0.10/day anonymous, $1/day on a free key —
so the browser can no longer hold the credential: an OpenAlex key accepts prepaid credit, which
makes a key in the bundle someone else's spending, not just someone else's quota. The route rebuilds
the upstream URL from an entity allowlist and a parameter allowlist, drops any `api_key` the caller
sends, and attaches the Worker's own. It deliberately does **not** require a Firebase identity —
the public entity pages read OpenAlex — so what protects the budget is a pair of global ceilings,
per-minute (`OPENALEX_GLOBAL_MINUTE_LIMIT`) and per-day (`OPENALEX_GLOBAL_DAILY_LIMIT`), reserved
only after an edge-cache miss and for as many calls as the route is about to spend. The origin gate
is not one of them and should not be counted as one: a request with no `Origin` header has nothing
to check, and one is trivially forged, so the ceiling is the frontier. The day matters because the
budget is daily and a per-minute ceiling does not bound it — 3000/min is 4.320.000/day. Every route
that spends the budget reserves against both, in list calls ($0.0001 each): `/openalex/*` for one call, or ten for a search (`search=` or a `.search` filter, billed $0.001, measured 2026-10-20),
and `/citation-graph` for up to seven, so a caller who cannot be identified still cannot outspend the
day. A
refusal is relayed with its own status and `retry-after` rather than flattened into a 502 (a stall past the deadline answers `504 UPSTREAM_TIMEOUT`, which the client does not retry, since OpenAlex received and billed the call), and the
rate-limit headers are named in `access-control-expose-headers` so the browser can actually read
them; otherwise the client's backoff falls back to guessing, and since the budget resets at midnight
UTC that guess can be hours wrong. A 404, a work OpenAlex has not indexed, is an answer rather than a refusal and is cached for an hour. `/health/openalex` reports the remaining daily budget in dollars.
Both ceilings are one call to the day's `RequestQuotaLedger` object, which checks the current minute as its subject in the same transaction, so a miss costs one Durable Object request rather than two.

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

Rewrite prompt v3 allocates the word budget across the whole document, including
discussion and conclusion. University requests up to 24,000 output tokens; its
previous 16,000-token ceiling cut JWST off before those final sections. The prompt
version is part of the cache key, so older rewrites are regenerated on the next open.

The reader considers a rewrite complete only after a `done` event whose `sectionCount`
matches the received sections, with no error and no `truncated` flag. EOF alone is not
completion. Interrupted or truncated text remains readable with an incomplete notice
and a retry action, and is not stored in the browser's completed-rewrite cache.
The retry sends `retryIncomplete: true` in the POST body. This bypasses a shared
cache entry only when that entry is marked `truncated`; complete entries remain
reusable. A retry reserves a new quota use and replaces the entry when it produces
a cacheable result. A failed retry leaves the previous partial copy available to
normal opens. Missing, false or non-boolean retry values use the ordinary cache path.

`/ai/rewrite` forwards each POST to a new `PaperRewriteSession` Durable Object through
the `PAPER_REWRITE_SESSION` binding. The existing handler verifies identity, validates
input, checks the shared cache and reserves quota inside that object. PDF conversion
and provider stream parsing run there too; the edge Worker only checks method/origin
and relays the response stream. This uses the Durable Object CPU allowance instead
of the Workers Free 10 ms allowance. The object persists no state; the SQLite class
registration keeps it available on the Free plan. Generation still consumes the
account's daily Durable Object request and duration allowances.

Deploy the `v4` migration in `wrangler.toml` before serving this route. A missing
binding returns `AI_NOT_CONFIGURED`; an unavailable session returns `AI_UNAVAILABLE`.
There is no edge-execution fallback. Existing cache, quota, refund, heartbeat and
client-disconnect behavior remains owned by `handlePaperRewrite`.

The Worker limits AI usage per user and globally per UTC day with atomic reservations in the
`RequestQuotaLedger` Durable Object. A reservation is consumed before contacting the provider,
so concurrent tabs cannot exceed the configured limit and failed provider calls fail safely.
Nothing uses the `KimiBudgetLedger` Durable Object; its class is still exported only so that a
later, separate change can delete it with a `deleted_classes` migration.

Routes backed by PaperTok provider credentials (`/related`, `/recommendations`,
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

Email digests require the `NOTIFICATION_STORE` KV binding and a configured email provider. Production uses Brevo through `BREVO_API_KEY` and an active `BREVO_FROM_EMAIL`; Resend remains an optional fallback. The Worker verifies the Firebase ID token before storing a subscription, requires the account to have proven the address (`emailVerified`, or a Google or GitHub identity carrying the same address) so nobody can subscribe a stranger's inbox, derives the recipient address from Firebase rather than trusting client input, and sends every digest and unsubscribe page in English (`<html lang="en">`): PaperTok is English-only, so the stored `language` is always `en`, a legacy `language: 'es'` record simply receives English, and the unsubscribe page ignores a legacy `lang` query parameter and `Accept-Language`. Enabled legacy records without follows are marked invalid once and are never sent. A `PUT /notifications/preferences` without `sync` is the reader's own choice: `enabled: false` deletes the subscription and `enabled: true` creates or updates it. The app's background refresh of follows and previews sends `sync: true`, because its tab may have loaded before the reader unsubscribed or changed the digest elsewhere. A sync never creates or re-enables a subscription: it keeps the stored `enabled`, `maxPapers`, `frequency` and `language`, updates only the follows, previews and the verified address and name, and answers with the stored preferences (`enabled: false` when there is no subscription). When those fields are unchanged, a sync writes nothing unless the enabled subscription's unsubscribe token has no `notification:unsubscribe:` index, which happens when a save stored the subscription but lost that write; it then writes only that index, so the unsubscribe link in its digests works.

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

Cron windows run every 20 minutes from 07:00 through 13:40 UTC, every day, so `/health/email` keeps seeing a fresh run; only Monday's windows send. From Thursday to Sunday nothing can be due or reconciled, so those windows record the run without listing or reading any subscription. The digest is weekly for everyone since 2026-10: a subscription is due once on a Monday, whatever `frequency` it stored (a record saved as `daily` before the choice was retired is weekly too), preferences always report and store `weekly`, and Tuesday's and Wednesday's windows reconcile the previous day's ledger. Later windows recover provider uncertainty or retry source failures after 40 minutes and authoritative empty selections after four hours. A digest whose latest attempt this week failed with `EMAIL_DIGEST_SOURCES_UNAVAILABLE`, and that has not been sent this week, may also start a new digest on Tuesday (only Tuesday, with the same 40-minute spacing): that failure happens before any delivery is reserved, so nothing can have been sent. That is the only failure after which the Tuesday rule starts a new digest. A send whose outcome was uncertain is still recovered by the existing reservation recovery described below, which replays or reconciles the reserved delivery instead of starting a new one; Wednesday's windows reconcile Tuesday reservations without starting new digests or querying scientific sources. Any other failure, and a failure from an earlier week, starts no new digest before the next Monday. The final 13:40 window is recovery-only and never starts a new delivery. Each run has a 12-minute processing budget, keeps three minutes in reserve before starting another three-subscription page, and persists its KV cursor so deferred users resume on the next window instead of starving behind the same users. The digest selects only high-quality, unsent papers from a rolling 10-day publication window; `lastSentAt` controls scheduling but is not a content cutoff. Sent-paper identity history is bounded at 400 keys, enough to cover the window at the maximum configured volume. A scheduled digest with spare capacity may add at most one high-signal exploration paper, but never substitutes exploration when every followed source needed for the selection is unavailable. Test emails remain followed-only.

The email is set as *The PaperTok Weekly*, a small front page in the app's design language (white sheet, serif headlines, mono metadata, hairline rules, the yellow PT mark): a dateline, the nameplate, the highest-scoring paper as the lead story with an excerpt of its abstract, the other followed papers as two columns of briefs (stacked on phones), and the exploration pick boxed apart. The subject is the lead headline and how many papers follow it. Each paper carries its field (`area`, one of the twelve `CATEGORIES` keys) and, when its source has one, its abstract: arXiv supplies the primary category and the summary, OpenAlex the work's `primary_topic` and its rebuilt abstract (`usableOpenAlexAbstract`, so an editorial's body is never shown), and the app's preview items carry the card's own `areaKeyForPaper` answer, which the Worker accepts only when it is a known key. A paper of no known field is set in ink with no field name, and one without an abstract leads with no excerpt. The field inks are the light theme's `--gradient-*` values, copied into the Worker and held to `src/styles/variables.css` by a test; the area lookup itself is imported from `src/utils/areaAccent.ts`, which reads the dependency-free `src/data/categoryTaxonomy.ts` so the Worker bundle carries no React.

Native arXiv topic follows are queried directly in one grouped request, with OpenAlex fallback when arXiv is unavailable. OpenAlex, OpenAIRE, and arXiv requests have bounded timeouts and one bounded retry for rate limits, server failures, or network timeouts. Source attempts, successes, failures, retries, and stable failure codes are recorded without recipient data. An authoritative successful empty response remains an empty outcome; if every usable selection is empty while a required followed source remains unavailable, the run is marked transiently failed instead.

Within one schedule run, identical OpenAlex requests (the date-only exploration query, a followed author, topic, institution or search, a project's DOI lookup) are sent once and their parsed response is shared by every reader who asks. Each reader's relevance filter, follow attribution and sent-paper exclusion still run on that response separately, so no digest changes. The shared requests live only for the run, a failed one is dropped so a later reader retries it with its own bounded retry, and at most 200 answers are kept, past which a request goes upstream unshared. Test emails do not share. Per-source reports therefore separate the questions asked (`attempted`, `succeeded`, `failed`) from the HTTP calls made (`requestAttempts`, `retried`). OpenAIRE and arXiv requests are not shared.

`EMAIL_DAILY_SEND_LIMIT` is enforced by the `EmailDeliveryLedger` Durable Object, using one atomic object per UTC day for scheduled and test sends. The object stores each reservation in its own bounded value plus a small counter, so a full production day remains below Durable Object value limits. Each send reserves quota before provider contact and then commits or releases it. Scheduled reservations and provider idempotency UUIDs are deterministic per subscription generation and UTC day, preventing concurrent cron windows from sending twice while isolating a later resubscription. If a provider response is lost or is not definitively rejected, the exact bounded email draft is retained for one retry between 5 and 25 minutes later; an expired uncertain reservation is conservatively committed rather than risk a duplicate. Committed reservations discard the draft, keep bounded delivery metadata, and every daily object deletes itself after three days. The following day can reconcile a successful provider delivery after a KV write failure without querying scientific sources or sending again, but only while the delivery state has not caught up with the ledger: a reservation whose delivery is already recorded in `lastSentAt` is skipped, so yesterday's committed send cannot swallow today's digest. Provider logs contain only status and stable error codes. The KV emulation of the ledger is serialized only inside one isolate, so it is limited to tests and local runs and requires the explicit `EMAIL_DELIVERY_LEDGER_FALLBACK = "kv"` variable; a deployment with a configured provider and no Durable Object binding aborts the cron with `EMAIL_DELIVERY_LEDGER_MISSING` and reports it in `/health/email` instead of degrading silently.

Subscription preferences and delivery state use separate, generation-scoped KV records with 120-day rolling retention, so a scheduled write cannot overwrite a concurrent preference change, recreate a deleted subscription, or contaminate a later resubscription. Schedule summaries remain at `notification:schedule:last-run` and are also written to 14-day `notification:schedule:history:*` keys; each subscription stores separate PII-free digest and test outcomes. `/health/email` returns an unhealthy HTTP status when the provider is unavailable, the latest schedule is stale, or the delivery ledger is not the Durable Object, and exposes only aggregate freshness, processed/deferred/uncertain counts, and stable failure codes, never recipient data. Because the Brevo probe shares the provider rate limit with real delivery, the answer is served from the edge cache for five minutes, like the Scopus and OpenAlex probes.

`GET /health` needs no `Origin` and reports configuration, not whether providers answer: `ok`, booleans such as `aiConfigured` and `semanticScholarKeyConfigured` (described above), and `version: { id, tag }` from the `[version_metadata]` binding (`CF_VERSION_METADATA`). `id` is the Cloudflare version id and `tag` is what the deploy passed to `--tag`, or `null` when it passed none. `version` is `null` where the binding does not exist, as in the Node tests.

### Logs

Workers Logs stores the Worker's `console.*` lines. The per-request invocation logs are off
(`invocation_logs = false` in `wrangler.toml`), because each one would store the request's URL
with its search text or unsubscribe token. The stored lines are the route handlers' error details,
the AI rewrite and annotation outcomes, the email schedule summary, and one `{ route, status }`
line from `worker/index.ts` for every 429 or 5xx answer, including an uncaught throw (logged as
500). Its `route` is the fixed part of the path, such as `/openalex/works`, `/share` or
`/notifications/unsubscribe`, never an id, a query string or an address. On the Workers Free plan
Cloudflare keeps the lines for 3 days and stores up to 200,000 a day. Its Workers Logs page does
not say what Free does with lines past that number, so a sparse day in the dashboard does not prove
there were few failures. Those limits are from that page in October 2026; from 1 December 2026
Workers Logs moves to Cloudflare Observability pricing. Read the lines in the Cloudflare dashboard
under Workers & Pages → `papertok-report-api` → Observability, or live with `npx wrangler tail`.
Nothing alerts on them. Keep the `[observability]` block in `wrangler.toml`: without it, every
`wrangler deploy` switches Workers Logs off, whatever the dashboard says.
