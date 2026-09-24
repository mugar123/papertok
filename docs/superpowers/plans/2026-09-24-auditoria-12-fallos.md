# Twelve audited issues — implementation plan

> **For agentic workers:** executed natively (superpowers:executing-plans) by the session
> that wrote it, one commit per task, then one whole-branch review. Steps are TDD: failing
> test first, then the fix, then a mutation check (revert the fix, watch the test fail).

**Goal:** fix the twelve issues of `docs/AUDITORIA-12-FALLOS-2026-09-23.md` as designed in
`docs/superpowers/specs/2026-09-24-auditoria-12-fallos-design.md`, in the audit's order.

**Architecture:** each package stays in the layer that owns it. That means pure helpers in
`src/utils/`, adapters and services in `src/services/`, React wiring in the components, and
Worker routes in `worker/report-api.js`. Vercel routing lives in `vercel.json`. Every
behaviour lands in a pure, Node-testable function first, and the component only wires it.

**Tech stack:** React 19 + react-router (BrowserRouter), Vite, Firebase, a Cloudflare Worker,
Vercel, and `node --test`. CI runs Node 22.

**Spec:** `docs/superpowers/specs/2026-09-24-auditoria-12-fallos-design.md`. The evidence
is in `docs/AUDITORIA-12-FALLOS-2026-09-23.md`.

**Deviation from the writing-plans format, recorded on purpose:** the six parallel planners
died on a session usage limit (2026-09-24). This plan is written by the executor itself, so
it lists behaviour and test cases per task rather than the full code. The code is written
under TDD against these cases.

## Global Constraints

- User-facing copy in ES and EN. Code comments, docs and commit messages in English. Commits
  end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests are colocated `*.test.js`. Source tests strip comments, bound their slice, and use
  one contiguous regex (helpers in `src/context/feedFirstPaint.test.js`).
- Missing metadata stays missing (invariant 3). Provider failure degrades gracefully
  (invariant 5).
- WCAG 2.2 AA for every UI change: native controls, visible focus, live regions for status,
  and `lang="en"` on English content in the Spanish UI.
- `npm run check` passes, and the suite also passes on Node 22.
- Nothing is pushed or deployed without asking Nicolás. The Worker is deployed by him.

## Review Focus

- An `onClick={requestAuthentication}` passes a click event as the "reason" → it must fall
  back to `default` (Task 6).
- The guest page must never lose a card already on screen when a late area arrives
  (Task 5).
- A Wikipedia sitelink whose page redirects to another QID must be rejected (Task 1).
- The stricter author matcher must not drop matches that PaperBuilder's id graft made
  correctly before, such as a reordered arXiv/OpenAlex name (Task 11).
- The narrowed Vercel rewrite must not 404 any route that `App.jsx` declares (Task 19).

---

### Task 1: Wikipedia by identity (P1, issue 3)

**Files:** `src/services/wikiService.js`, `src/services/wikiService.test.js`,
`src/components/Explorer/EntityExplorer.jsx` (the Wikipedia effect), plus a source test.

**Behaviour:** as in design P1:
- Extract a Wikidata QID from `ids.wikidata`: a URL or a bare id, normalized.
- For a topic, take the enwiki title from `ids.wikipedia` and look it up in Wikidata with
  `sites=enwiki&titles=`.
- Read the sitelink in the UI language, falling back to enwiki with `language: 'en'`.
- Fetch the exact title and accept it only when its `wikibase_item` equals the QID.
- No identity means no box. Free-text query topics keep the strict search.

**Tests:**
- QID parsing: URL, `/entity/` URL, bare id, garbage.
- A concept with `eswiki` → the Spanish page.
- A concept with only `enwiki` → the English page with `language: 'en'`.
- A topic via its enwiki title.
- A redirect to a different QID → `null`.
- No ids → `null` and no fetch.
- The source test proves that id-bearing entities no longer reach `searchWikipedia`.

### Task 2: Europe PMC markup (P2, issue 6)

**Files:** `src/utils/europePmcRecord.js` (+ test).

**Behaviour:**
- Strip known tags only: block tags become separators, inline tags keep their text.
- A heading becomes `Heading: `.
- A literal `<` stays as text.
- Entities are decoded after the tags are stripped.

**Tests:** the PMID 42629277 fixture keeps `P < .001) compared with PNI and GPS.` and reads
`GPS. Conclusions: Pretransplant`, plus `x<y`, `&lt;` decoding, `<sup>2</sup>` and nested
`<i>`.

### Task 3: PubMed abstract sections (P2, issue 6)

**Files:** `src/services/adapters/PubmedAdapter.js` (+ `src/services/PubmedAdapter.test.js`).

**Behaviour:**
- Read only `Abstract > AbstractText`.
- A `Label` becomes a `LABEL: ` prefix.
- Sections are joined with a space.

**Tests:** a structured abstract with labels, an `OtherAbstract` that is ignored (Serbian
fixture), an unlabelled single section, and an empty abstract.

### Task 4: OpenAlex abstract gate (P2, issue 6)

**Files:** `src/utils/openAlexAbstract.js` (+ test), `src/services/openAlexService.js` (the
enrichment mapper and `formatOpenAlexWorkAsPaper`), `src/services/adapters/OpenAlexAdapter.js`
if it builds abstracts too.

**Behaviour:** `usableOpenAlexAbstract(work)` returns `''` when the type is `editorial`,
`letter`, `erratum` or `paratext`, or when the text is longer than 6000 or shorter than 40
characters. Every mapper goes through it.

**Tests:** the W7211952859 fixture (editorial) gives `''`, a normal article keeps its
abstract, and both length bounds are exercised.

### Task 5: Guest page composition (P3, issue 1)

**Files:** `src/utils/guestFeedComposition.js` (+ test, new) and `src/hooks/useGuestFeed.js`.

**Behaviour:**
- `areaOfPaper`.
- `composeGuestPage(candidates, plan, pageSize)`: bucket by area, interleave by source and
  subcategory, deal round-robin across areas, cap each area at `ceil(pageSize/areas)` and
  release unused capacity; other areas only as a last resort.
- `extendGuestPage(shown, candidates, plan, pageSize)`: keeps `shown`, fills the remaining
  slots.
- `guestPageReady(papers, plan)`: every chosen area has at least `min(2, quota)` papers.
- The hook uses all three. The default plan behaves as before.

**Tests:**
- The five arrival scenarios of the audit give both areas every time.
- Late arrivals extend without reordering.
- An empty area releases its quota.
- Unknown areas are only used as filler.
- The default plan is unchanged.

### Task 6: Account prompts with a reason, and Conexiones (P4, issues 2 and 9)

**Files:** `src/components/Public/authPromptCopy.js` (+ test, new),
`src/components/Public/AuthPrompt.jsx`, `src/App.jsx`,
`src/components/Public/GuestFeedPage.jsx`, `src/components/Feed/PaperCard.jsx` (the related
button), `src/components/Feed/RelatedPapersSheet.jsx` (the auth copy and a live region),
plus a source test.

**Behaviour:** as in design P4. `normalizeAuthReason(value)` accepts the known strings only.
The related button in `publicMode` calls `requireAuthentication('related')`. The sheet maps
`WorkerApiAuthError` to sign-in copy, and its error state is `role="status"`.

**Tests:**
- Reason normalization: strings, an event object, `undefined`.
- The copy exists in both languages for every reason.
- Source tests cover the App plumbing, the GuestFeedPage forwarding, the PaperCard related
  gate, and the sheet's error mapping.

### Task 7: «Leer en simple» cue and welcome copy (P4, issue 9)

**Files:** `PaperCard.jsx` (the rewrite button in `publicMode`: a lock icon plus an
`aria-describedby` hint), `GuestInterestsPrompt.jsx` (the lede in ES and EN as given in the
design), and the tests that pin those strings.

**Tests:** a source test for the hint's wiring, only in `publicMode`, with the accessible
name unchanged. A lede test asserts that «cada uno» and «each one» are gone.

### Task 8: Explorer guest search as a button (P4, issue 10)

**Files:** `src/components/Explorer/EntityExplorer.jsx`, `EntityExplorer.css` if needed, and
`explorerGuestGate.test.js` plus any test that pins the `readOnly` input.

**Behaviour:** in `publicMode`, a `<button type="button">` shaped like the field, with a
search icon and entity-aware bilingual copy, calls `requestAccount('explorer_search')`. The
filters button uses the same reason. There is no `readOnly` input for guests.

**Tests:** a source test that asserts the guest branch renders a button, not an `Input`, and
passes the reason.

### Task 9: Topic chip labels and `lang` (P5, issue 8)

**Files:** `src/utils/paperTopicTags.js` (+ test) and `PaperCard.jsx`.

**Behaviour:** chips carry their resolved UI-language label, are deduplicated on the
resolved identity, and flag provider text with `lang: 'en'`. `PaperCard` renders
`lang="en"` on those chips and on the abstract.

**Tests:** `Oncology` → «Oncología» in `es`; `Computer science` → «Ciencias de la
Computación»; a concept and a category that resolve to the same topic → one chip; free text
keeps its text and gets `lang: 'en'`.

### Task 10: MeSH check tags and OpenAlex concepts (P5, issue 7)

**Files:** `src/utils/meshCheckTags.js` (+ test, new), `PubmedAdapter.js` (descriptors),
`src/utils/europePmcRecord.js` (`meshDescriptors`), `src/services/openAlexService.js`
(enrichment concepts and `formatOpenAlexWorkAsPaper`).

**Behaviour:** drop check tags and put major topics first. Enrichment concepts need
`score > 0.3` and must not be on the bibliographic-database denylist.

**Tests:** `Humans`, `Female` and `Aged, 80 and over` are dropped; major topics come first;
the MEDLINE concept is dropped; a low-score concept is dropped; the classification callers
still see the other descriptors.

### Task 11: Author name matcher (P6, issue 4)

**Files:** `src/utils/authorNameMatch.js` (+ test).

**Behaviour:** as in design P6: split initials runs, anchor on the surname, and check
initials in order.

**Tests:** the full outcome table from the design, plus the existing positive cases (the
order swap, accents, hyphens, a single initial), and every current caller's fixtures still
pass.

### Task 12: Author identifiers and links (P6, issue 4)

**Files:** `PubmedAdapter.js` (efetch `AuthorList` → full name, affiliation, ORCID),
`src/utils/europePmcRecord.js` (authors), and `src/utils/explorerPaths.js` (+ tests).

**Behaviour:** authors keep `orcid`, `affiliation` and a full display name. The link is the
OpenAlex id, else `/explorer/author/<ORCID>`, else name plus `?paper=<ref>`. Public paths
keep the reference.

**Tests:** fixture parsing (PMID 42774036's `AuthorList`), and the link builder for each
branch and for public mode.

### Task 13: Author resolution and page behaviour (P6, issue 4)

**Files:** `src/services/openAlexService.js` (`getAuthorProfileExact`),
`src/components/Explorer/EntityExplorer.jsx` (the author route, the supplements, the notice,
Follow, the failsafe), plus tests.

**Behaviour:**
- `getAuthorProfileExact(name, paperRef)` resolves a DOI or PMID through the OpenAlex work's
  authorships, running in parallel with the name search. It never builds
  `10.48550/arxiv.pmid:`.
- The name-only result is `unverified`.
- A verified profile gets no name supplements.
- An unverified profile shows a bilingual notice and no Follow button.
- The failsafe fetches by id type.

**Tests:** resolution with a stubbed OpenAlex client (PMID → Wan-Ning Li; a name-only
fallback marked unverified), and source tests for the Explorer wiring.

### Task 14: Welcome backdrop (P7, issue 11a)

**Files:** `src/hooks/useGuestFeed.js` (`enabled`) and `GuestFeedPage.jsx`.

**Behaviour:** with `interests === null`, nothing loads and the veil shows. The first answer
starts a first load.

**Tests:** a pure decision helper (`shouldLoadGuestFeed`) plus a source test for the wiring.

### Task 15: bioRxiv degraded payload (P7, issue 11b)

**Files:** `worker/report-api.js` (`handleBioRxiv` and the TTL), `worker/report-api.test.js`,
and `src/services/domainSourceService.js` (treat `_papertok.degraded` as a failure).

**Tests:**
- An upstream timeout, an empty body or a 5xx gives 200 with `collection: []`,
  `_papertok.degraded`, and `s-maxage=120`.
- Success keeps its normal TTL.
- The client logs a degraded payload as a failure and returns no papers from it.

### Task 16: OpenAIRE lookup (P7, issue 11c)

**Files:** `src/services/openAireService.js` (+ test).

**Behaviour:** an arXiv-only lookup uses `originalId=oai:arXiv.org:<id>`. A null or failed
answer is cached.

**Tests:** the URL built for an arXiv-only paper and one with a DOI, and a second call made
after a 400 or an empty answer does not fetch again.

### Task 17: Worker share routes (P8, issue 5)

**Files:** `worker/share-pages.js` (new: the head builder and the route handlers),
`worker/share-pages.test.js`, and `worker/report-api.js` (router table, no Origin needed,
GET/HEAD only).

**Behaviour:** as in design P8.

**Tests:**
- A head per kind.
- Escaping.
- Not found → 404 plus `noindex`.
- `Accept-Language` and the cache key.
- The paper seed parses and matches the key.
- HEAD support.
- An upstream failure gives a generic safe head.

### Task 18: Vercel crawler routing, seed, share text, sitemap (P8, issue 5)

**Files:**
- `vercel.json` and a test for it.
- `src/components/Public/PublicPaperPage.jsx`, `src/hooks/usePublicPageMetadata.js`, and a
  seed reader in `src/utils/shareSeed.js` (+ test).
- `PaperCard.jsx` (share text) and `ScientificReport.jsx` (share URL).
- `public/sitemap.xml` and `public/robots.txt`.
- Docs: `docs/PUBLIC_DISCOVERY.md` and `worker/README.md`.

**Tests:**
- The bot regex matches the measured user agents and not browsers.
- The rewrites come before the catch-all.
- The seed is read only when its key matches.
- A seeded page is not marked `noindex` while loading.
- The share `text` is sent.

### Task 19: NotFound and a real 404 (P9, issue 12)

**Files:** `src/components/Layout/NotFoundPage.jsx` (new) and `src/App.jsx` (the `/` and `*`
routes), `vercel.json` (narrowed rewrite), `public/404.html`, and a test comparing the
`App.jsx` routes with `vercel.json`.

**Tests:** every declared route is covered by the rewrite; unknown routes render
`NotFoundPage`, which has a `<main>`, an h1 and `noindex`; `/` still reaches `/feed`.

### Task 20: Headings (P9, issue 12)

**Files:** `GuestFeedPage.jsx` (hidden h1), `PaperCard.jsx` (`titleAs`),
`PublicPaperPage.jsx` (`titleAs="h1"`), `SearchPage.jsx` (`<main>` and h1),
`EntityExplorer.jsx` (the error and not-found h1), and `src/accessibilityStructure.test.js`.

### Task 21: Preprint labels (P9, issue 12)

**Files:** `src/services/arxivService.js` (the comment regex), `openAlexService.js` and
`OpenAlexAdapter.js` (status from the type), and `SemanticScholarAdapter.js` (`Review`),
with tests.

**Tests:** the comment table from the audit (chapter, `accepted at`, `to appear as` → not a
preprint; `submitted to` → preprint); `book-chapter` is never a preprint; a Semantic Scholar
`Review` in a journal is not a preprint.

### Task 22: Delivery

- A STATE.md entry (newest first) and the evidence rows in `docs/ACCESIBILIDAD-EVIDENCIA.md`
  for the UI changes.
- `npm run check` and the Node 22 run.
- Live verification against production data on :5173 as a guest: the composition probe,
  Wikipedia, and the prompts.
- A whole-branch review by a fresh reviewer, then one fix wave.
