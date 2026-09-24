# Fixing the twelve audited issues — design

**Source:** `docs/AUDITORIA-12-FALLOS-2026-09-23.md`. That report holds the evidence,
the file:line references and the measurements. This document fixes *what we build*
for each issue. The four product decisions below were taken by Nicolás on 2026-09-23.
Everything else follows the "Qué haría" direction of each section of the report.

**Base:** `main` at `a63f919`. Work happens in `.claude/worktrees/auditoria-12-fallos`
(branch `worktree-auditoria-12-fallos`), because another session is editing the main
checkout.

## Product decisions (taken)

| # | Question | Decision |
|---|---|---|
| D1 | What does a guest see in the Explorer's search field? | **A button styled as the field.** For example «Buscar en este tema · necesita cuenta» / «Search this topic · needs an account». It opens the account dialog with the reason. The filter button opens the same dialog. |
| D2 | What does «Conexiones» do without an account? | **The account dialog, with the reason.** Same pattern as the card's other gated actions. Zero requests. |
| D3 | What loads behind the mandatory welcome sheet? | **Nothing.** The loading veil stays behind the sheet until the guest answers. After the answer, only the chosen plan loads. |
| D4 | How far do sharing and indexing go? | **Every shareable surface: papers, lists, profiles and entities.** Crawlers are routed by Vercel to the Worker. The Worker returns the app shell with a real per-page `<head>`. Paper pages also embed the paper, so a rendering crawler can paint it without calling the API. People keep getting the static app. |

## Shared contracts

- **Account-prompt reasons.** Every place that opens the sign-in dialog passes a
  reason. The reason is a string, one of `paper_rewrite`, `related`, `explorer_search`
  or `default`. Anything else, including a click event handed over by an `onClick`,
  means `default`. `AuthPrompt` renders a bilingual headline and lede per reason, and
  the `default` copy is today's.
- **Paper reference for author links.** When a card author has no OpenAlex id, the
  link carries the paper the author was clicked from, so the author can be found on
  that exact work. The reference is `doi:<doi>`, `pmid:<pmid>` or `arxiv:<id>`.
  - The existing `?arxivId=` query parameter keeps working for old links.
  - New links use `?paper=<ref>`.
  - An author with an ORCID and no OpenAlex id links to `/explorer/author/<ORCID>`,
    which the route already accepts.
- **Topic chip labels.** `buildPaperTopicTags(paper, language)` returns chips whose
  `label` is already in the UI language whenever the chip resolves to the local
  taxonomy. Provider free text keeps its original text, flagged `lang: 'en'`.
- **Degraded source payloads.** A Worker source route that could not reach its
  upstream may answer with a degraded payload: `200`, an empty list, and
  `_papertok.degraded = '<CODE>'`, cached for `DEGRADED_CACHE_SECONDS` (120 s). This is
  the same payload-dependent TTL pattern as PubMed's `_papertok.efetch`. The client
  treats a degraded payload as a **source failure** (it is logged and no papers come
  from it), never as an honest empty result.

## Work packages, in execution order

### P1 — Wikipedia by identity (issue 3)

For OpenAlex entities (`institution`, `concept`, `topic`, `source`), the Wikipedia box
is resolved **by identity**, never by free-text search:

- **Wikidata id by type.**
  - `concept`, `institution`, `source`, `field` and `subfield` take `ids.wikidata`. It
    comes as a URL or a bare `Q…`; normalize it to `Q\d+`.
  - `topic` has only `ids.wikipedia`, an enwiki URL. Take the title from the URL and
    ask Wikidata `wbgetentities&sites=enwiki&titles=<title>`.
- **Sitelinks.** Call `wbgetentities&ids=<QID>&props=sitelinks&sitefilter=eswiki|enwiki&origin=*`.
  Pick the sitelink in the UI language. If it is missing, use the enwiki page and
  return `language: 'en'`, so the box renders it with `lang="en"`.
- **The page.** Fetch it by **exact title**:
  `action=query&titles=…&prop=extracts|pageimages|info|pageprops&exintro&explaintext&redirects`.
  Accept it only if `pageprops.wikibase_item` equals the QID.
- **No identity, no box.** An entity with neither id gets no box. It falls back to
  its local or OpenAlex description, as the "Wikipedia missed" path does today.
- **Free-text query topics** (`_queryTopic`) keep today's search with
  `strictTitleMatch`.
- **The photo** only ever comes from the verified page.
- **Budget.** The existing 5 s abort and the one-settle hero behaviour must hold.
  Results are cached per `QID + language`.

### P2 — Abstract integrity (issue 6)

- **Europe PMC `stripMarkup`** (`src/utils/europePmcRecord.js`):
  - Strip **known tags only**: block tags (`h1`–`h6`, `p`, `div`, `br`, `li`, `ul`,
    `ol`) become separators, and inline tags lose the tag but keep their text.
  - A heading becomes `Heading: ` in front of its section.
  - A literal `<` that does not open a known tag is text.
  - Entities are decoded **after** the tags are stripped.
  - Regression fixture: PMID 42629277 must keep `P < .001) compared with PNI and GPS.`
    and read `… GPS. Conclusions: Pretransplant …`.
- **PubMed** (`PubmedAdapter.js` efetch parsing):
  - Read only `Abstract > AbstractText`, never `OtherAbstract`. Fixture: PMID 42775314
    must not carry its Serbian translation.
  - Keep the `Label` attribute as a `LABEL: ` prefix.
  - Join sections with a space.
- **OpenAlex abstract gate.** A reconstructed OpenAlex abstract is **not** used when
  the work `type` is `editorial`, `letter`, `erratum` or `paratext`, or when the
  reconstructed text is over 6000 characters (a full-text leak) or under 40 (junk
  such as «Lettre»). The gate is one shared helper, applied to the enrichment mapper
  and to the Explorer/public paper mapper. The paper keeps no abstract (invariant 3).
  Fixture: W7211952859 (the tester's editorial, PMID 42774036).

### P3 — Guest page composition (issue 1)

- **New pure module `src/utils/guestFeedComposition.js`:**
  - `areaOfPaper(paper)` maps the paper's `primaryCategory`, and then its
    `categories`, to a taxonomy area key through `CATEGORIES`. An unknown value gives
    `null`.
  - `composeGuestPage(candidates, plan, pageSize)`:
    1. Bucket the deduplicated candidates by area, keeping only the plan's chosen
       areas.
    2. Inside each area, interleave by source (`sources.primary`) and then by
       subcategory.
    3. Deal the slots round-robin across areas. Each area is capped at
       `ceil(pageSize / areas)`, and unused capacity is released to the areas that
       still have papers.
    4. Papers from areas the guest did not choose are only a last resort, used when
       the chosen areas together cannot fill the page.
    5. The default plan (no areas) behaves as it does today.
  - `extendGuestPage(shown, candidates, plan, pageSize)` never reorders or removes
    `shown`. It fills the remaining slots with the same quota rules, so an area that
    answered late still gets its share.
- **`useGuestFeed` wiring:**
  - First paint waits until **every chosen area has ≥ min(2, quota) papers**, or
    until the existing 4 s per-source budget runs out.
  - The early page is composed with the caps.
  - The late pool goes through `extendGuestPage`.
- **Acceptance.** With Informática + Medicina, every arrival order of the four
  branches (the five scenarios in the report) yields a page with papers from both
  areas.

### P4 — Account prompts with a reason (issues 2, 9, 10)

- **Plumbing.**
  - `AuthPrompt({ onClose, reason })` reads its copy from
    `src/components/Public/authPromptCopy.js`, bilingual and keyed by reason.
  - `App.requestAuthentication(reason)` stores the reason.
  - `GuestFeedPage.requestAccount(action)` forwards it.
  - Validation happens in one place: an unknown reason, or an event, means `default`.
- **Conexiones (D2).** In `publicMode`, the card's related button calls
  `requireAuthentication('related')` instead of opening the sheet.
  - `RelatedPapersSheet` maps a `WorkerApiAuthError` to explicit sign-in copy instead
    of «ahora». This covers an expired session too.
  - Its error state becomes a polite live region.
- **«Leer en simple» (issue 9).**
  - In `publicMode` the button shows a visible "needs an account" cue (a lock icon)
    and has an `aria-describedby` hint, «Necesita una cuenta gratuita» / «Needs a free
    account». The accessible name stays exactly the visible label, so 2.5.3 still
    passes.
  - The press opens the prompt with reason `paper_rewrite`.
  - The welcome lede stops promising «cada uno»:
    - ES: «Un feed de papers científicos para deslizar, con recomendaciones que
      aprenden de lo que lees. Con una cuenta gratuita, muchos se pueden leer además
      explicados en claro.»
    - EN: «A scrollable feed of scientific papers, with recommendations that learn
      from what you read. With a free account, many of them can also be read in plain
      words.»
- **Explorer search (D1).** In `publicMode` the field is a `<button type="button">`
  with the field's look. It has a search icon and entity-aware copy, for example
  «Buscar en este tema · necesita cuenta» / «Search this topic · needs an account»,
  and opens the prompt with reason `explorer_search`. The filter button uses the same
  reason. The read-only `<input>` for guests is gone, and the tests that pinned it are
  updated.

### P5 — Topic chips (issues 7, 8)

- **Chip labels.**
  - `buildPaperTopicTags` resolves each chip through `resolvePaperTopic(value,
    language)` and uses the resolved label as the chip text.
  - It deduplicates on the resolved identity, so «Oncology» and `med.onco` do not
    both show «Oncología».
  - Provider free-text chips carry `lang: 'en'`, and `PaperCard` renders `lang="en"`
    on them.
  - `PaperCard` also puts `lang="en"` on the abstract, as it already does on the title.
- **MeSH check tags.** A new `src/utils/meshCheckTags.js` holds the NLM check-tag list:
  sex, age groups, `Humans`, `Animals`, pregnancy and the common model organisms. Both
  the PubMed efetch parser and `europePmcRecord` drop check tags, and put major topics
  (`MajorTopicYN="Y"` / `majorTopic_YN: 'Y'`) first.
- **OpenAlex concepts from enrichment.**
  - Keep only `score > 0.3`, the adapter's existing rule.
  - Drop bibliographic-database concepts by normalized name: MEDLINE, PubMed, Embase,
    CINAHL, Scopus, Web of Science, PsycINFO, Google Scholar and Cochrane Library.
  - The same filter applies in the Explorer/public paper mapper.

### P6 — Author identity (issue 4)

- **Matcher** (`src/utils/authorNameMatch.js`):
  - Split all-caps initials runs: in PubMed's «Li WN», `WN` becomes `w` + `n`.
  - Anchor on the surname: it must match exactly.
  - Initials must agree, in order, with the given names' first letters.
  - Required outcomes: «Li WN» vs «Po-Wn Li» → **false**; «Li WN» vs «Wan-Ning Li»
    → **true**; «Chen YC» vs «Y. C. Pan» → **false**. The arXiv ↔ OpenAlex order case
    («Nicolás Cuello» vs «Cuello, N.») stays true.
  - The test that pinned "a subset of the parts is enough" is rewritten on purpose.
- **Keep identifiers.**
  - PubMed efetch `AuthorList` gives the full name (`ForeName LastName`), the first
    `AffiliationInfo/Affiliation`, and `Identifier[@Source="ORCID"]`, merged onto the
    card authors by position.
  - Europe PMC `authorList.author` gives `fullName`, the ORCID in `authorId` and the
    affiliation.
- **Links.** Use the OpenAlex id, else the ORCID (`/explorer/author/<ORCID>`), else
  name plus `?paper=<ref>`. That includes guests: public explorer paths keep the
  reference too.
- **Resolution** (`getAuthorProfileExact(name, paperRef)`):
  - Resolve a DOI or PMID reference through the OpenAlex work (`works/doi:` /
    `works/pmid:`) and take the authorship that matches with the fixed matcher, or the
    same position.
  - Never build `10.48550/arxiv.pmid:…`.
  - The name search is a fallback only, and its result is marked `unverified`.
- **Author page.**
  - A **verified** profile (OpenAlex id, ORCID or paper match) does not append
    name-based supplements (Semantic Scholar keyword, PubMed `[Author]`, Scopus,
    arXiv by name).
  - An **unverified** profile keeps them. It shows a visible, bilingual notice that
    results come from the name and may mix people who share it, and it offers no
    Follow button.
  - The "source paper first" failsafe fetches the paper by its own id type, never
    `id_list=pmid:…`.

### P7 — Performance (issue 11)

- **Welcome backdrop (D3).** `useGuestFeed({ areas, enabled })`. `GuestFeedPage`
  passes `enabled: interests !== null`. When disabled, no source is asked and the
  feed shows its loading veil. The first answer starts a **first** load, not a
  refresh.
- **bioRxiv** (`worker/report-api.js`, `handleBioRxiv`). An upstream failure (timeout,
  non-JSON or empty body, non-2xx) answers a degraded payload,
  `{ collection: [], _papertok: { degraded: '<CODE>' } }`, cached for 120 s.
  `fetchDomainPapers` treats `_papertok.degraded` as a failure: it logs through
  `reportDomainSourceFailures` and returns no papers from that source.
- **OpenAIRE** (`openAireService.js`).
  - An arXiv-only lookup uses `originalId=oai:arXiv.org:<id without version>`. That
    parameter was measured to find the record; `pid` is a 400.
  - A null or failed answer is cached for the session under the same key, so a card
    never asks twice.
- **Deferred, stated in the delivery notes.** bioRxiv's oldest-first window. It
  cannot be validated while api.biorxiv.org answers empty bodies (measured
  2026-09-24).

### P8 — Sharing and indexing (issue 5, D4)

- **Worker HTML routes**, public and GET/HEAD only, needing no `Origin`:
  `/share/paper/:key`, `/share/list/:shareId`, `/share/user/:handle` and
  `/share/entity/:type/:id`. Each one:
  1. Fetches the app shell from `https://papertok.app/index.html` (edge-cached 5 min).
  2. Replaces the `<title>`, description, canonical, `og:*` and `twitter:*` tags, and
     the JSON-LD, with per-page values. Everything is HTML-escaped, and LaTeX in
     titles becomes plain text.
  3. For papers, embeds `<script type="application/json" id="papertok-share-seed">`
     with the paper, and a static fallback (h1 title, authors, abstract) inside
     `#root`.
  - Not found answers `404` with `noindex`.
  - Metadata comes through the Worker's own provider paths and budgets and is cached
    for 24 h. Lists and profiles come from their public Firestore documents.
  - Copy follows `Accept-Language` (es, otherwise en), and the language is part of the
    cache key.
- **Vercel.** Add rewrites before the SPA catch-all, conditioned on a crawler
  `user-agent` regex (preview bots and search engines), from `/public/paper/:key`,
  `/public/list/:shareId`, `/public/user/:handle` and `/public/entity/:type/:id` to
  the Worker's `/share/…`. People are not affected.
- **Client.**
  - `PublicPaperPage` paints the embedded seed when its key matches the URL,
    through the existing `seedPaintsWhole` path.
  - `usePublicPageMetadata` does not mark `noindex` while loading when a seed painted
    the page.
  - The card's `navigator.share` sends `text: <plain title>`.
  - Research shares the PaperTok public URL, with the external URL only as fallback.
- **Static files.** `public/sitemap.xml` keeps canonical URLs only. A papers sitemap
  generated from public lists is built only if the data model makes it cheap; the plan
  decides with the code in front of it and states it.
- **Docs.** Update `docs/PUBLIC_DISCOVERY.md` and the Worker route list.
- **Deploy order** (for the delivery notes): Worker first, checked with crawler
  user agents; then the frontend with the Vercel rewrites.

### P9 — Minor issues (issue 12)

- **Routes.** An explicit `/` → `/feed` route. `*` renders a bilingual `NotFound` page
  with `<main>`, an h1, a link to the feed and `noindex`.
- **Real 404.** The SPA rewrite in `vercel.json` is narrowed to the declared route
  prefixes, and a static bilingual `public/404.html` is served for the rest. A test
  derives the route list from `App.jsx` and checks `vercel.json` against it.
- **Headings.**
  - The guest feed gets a visually hidden h1 inside its own `<main>`, without nesting
    a second `<main>`.
  - `/public/paper` renders the paper title as the h1, through a `PaperCard` heading
    prop.
  - `/search` gets `<main>` and an h1.
  - The Explorer's error and not-found states use an h1.
  - `accessibilityStructure.test.js` covers these routes.
- **Preprint labels.**
  - The arXiv comment rule also accepts `accepted for`, `accepted at` and
    `to appear as`.
  - OpenAlex mappers derive the status from the work `type`: only
    `preprint`/`posted-content` is a preprint, and a `book-chapter` never is.
  - Semantic Scholar's `Review` no longer means preprint.

## Global constraints

- **Language.** User-facing copy is bilingual, ES and EN. Code comments,
  documentation and commit messages are in English. Commits end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Tests.**
  - Colocated `*.test.js`, run with `node --test`.
  - Source-reading tests strip comments, bound their slice and bind pieces in one
    contiguous regex (convention `ce139ce`).
  - Every new test is checked by mutation: revert the fix and watch it fail.
- **Verification.** `npm run check` passes, and the suite also passes on Node 22
  (`npx -y -p node@22 node --test $(find src worker proxy -name '*.test.js')`).
- **Accessibility.** WCAG 2.2 AA on every UI change. Use the existing `Dialog`,
  `Drawer` and `Button` primitives, visible focus, live regions for status, and
  `lang="en"` on English content.
- **Isolation.** No edits outside the worktree except `.claude/launch.json`, and no
  pushes or deploys without asking Nicolás. The Worker is deployed by him.
