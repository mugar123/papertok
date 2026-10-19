# PaperTok

**A personalized way to discover scientific research.**

[Open PaperTok](https://papertok.app/feed) · [Latest release: 0.2](https://github.com/mugar123/papertok/releases/tag/v0.2.0)

PaperTok is an open-source web app for discovering research papers through a scrollable, personalized feed.

I started building it as a physics student because I kept running into the same problem: there is an enormous amount of interesting research available online, but discovering papers outside of a very specific search can still be surprisingly difficult.

PaperTok tries to make that process feel more natural.

Instead of knowing exactly what to search for, you can browse papers, interact with the ones that interest you, follow scientific topics and researchers, and gradually get recommendations that better match what you care about.

> PaperTok is currently under active development. It is a personal open-source project and not affiliated with arXiv, OpenAlex, PubMed, or any other data provider.

The interface is in English.

## What PaperTok does

PaperTok brings scientific literature from multiple sources into a common discovery experience.

The main feed is personalized using signals such as:

- scientific fields and categories you are interested in
- papers you interact with
- learned affinities with research topics
- authors, topics, institutions and projects you follow
- publication recency
- citation information
- semantic concepts
- exploration outside your usual interests
- content diversity

The goal is not simply to rank the most popular papers, but to help each person discover research that is relevant to them while still leaving room for unexpected and interesting results.

## A tour of PaperTok

The current look comes from an editorial redesign — serif headlines, ruled sections, one accent of yellow — whose visual direction was set by Samuel's initial UI redesign. Version 0.2 carries it through the whole app. These are the highlights.

**Dark mode.** The theme opens as a circle from the toggle itself, follows your system until you choose, and is decided before the first paint — no white flash.

**A reader that works with you.** "Read in plain words" rewrites any paper at three levels (Beginner, University, Researcher). Select a passage and a menu appears over it: highlight it, write a note on it, or have the AI explain it — the AI option states its price before you spend it, and a failed request is refunded. Everything lands in an annotations rail, your notes with a yellow rule, the AI's with an ink one, saved per paper and account.

**Export to LaTeX.** Take the rewrite with you as a `.tex` that compiles with pdfLaTeX as-is — choose which of your highlights and notes travel with it. The title, authors, link to the original and the notice that an AI wrote the text always ship with the file.

**A citation map on every paper.** Papers with an identifier get a *Paper connections* view: the paper on a timeline rule, what it cites above, what cites it below, citations on a logarithmic axis. Walk the graph node by node with a breadcrumb trail back. Works with unknown data are counted honestly instead of being invented into a position.

**Search papers and entities.** Press `/` anywhere to search papers, authors, institutions, topics and projects. Results open paper pages or explorer profiles.

The feed palette uses one OpenAlex request per existing search branch: title search for papers, work bylines for author suggestions, and the existing free autocomplete endpoint for topics. Paper and author queries include bounded spelling variants and an unfinished final word in the same request; it does not issue a second autocomplete request or build a local index. Titles already loaded in the feed contribute candidates to the settled paper answer. Exact names rank ahead of prefixes and one-edit matches; unrelated candidates are discarded. Topic spelling recovery reuses the existing taxonomy before its single autocomplete request; unknown topic misspellings remain limited by provider matching. Author suggestions retain canonical author IDs from bylines; author-level work and citation totals remain unknown until profile loading. Candidate limits and provider coverage still apply, so very short or ambiguous fragments cannot guarantee a particular result.

The palette publishes each view once: All waits for every category to settle; a type tab waits only for its category. Rows and counts stay fixed as background requests finish. Type tabs are available before typing and remain selected when the query changes. Switching tabs uses the same in-flight responses, without starting another search. Empty categories remain selectable; unavailable categories are identified separately from zero results. Searches retain bounded deadlines and section-specific errors. Projects use the OpenAIRE Graph projects endpoint with bounded acronym/title recovery within a five-second budget. This recovery does not query OpenAlex.

**A personal library, in color.** Lists carry one of eight colors generated under three constraints (shared lightness, capped chroma, minimum contrast), visible from the library to the lists you share.

**Honest labels.** Every card answers whether a paper passed peer review ("Preprint" / "Verified") and whether you can actually read it ("Open access" / "Open version" / "Subscription") — and shows nothing rather than guessing when the record doesn't say.

**Installable.** Add PaperTok to your home screen and it opens standalone, with its own icon and a theme-tinted system bar. (No offline mode yet — it still needs the network.)

## Data sources

PaperTok uses open scientific infrastructure wherever possible.

Core sources include:

- **arXiv** — preprints across physics, mathematics, computer science and other fields
- **OpenAlex** — publication metadata, citations, concepts, institutions and open-access information
- **PubMed** — biomedical and life-science literature
- **OpenReview** — current conference and journal submissions in machine learning and computer science
- **NIH iCite** — citation and translation metrics for PubMed-indexed papers
- **Hugging Face Hub** — AI papers and their linked models, datasets, code and project pages

Economics and quantitative finance use arXiv in both the personalized and guest feeds. Their category searches also include OpenAlex preprints, so working papers can appear even when they have no arXiv copy. Paper status follows the provider metadata. OpenAlex discovery includes articles, conference papers and scientific reviews in every field.

Both feeds recover missing OpenAlex abstracts from linked arXiv records. The signed-in feed waits for this only on its first screen, at most 1.2 seconds, together with citation enrichment; its later pages, refreshes and follow changes are shown at once. The guest feed waits at most 1.2 seconds before the first batch of every load, including a pull-to-refresh, and only when one of those cards lacks an abstract that can still arrive. During a guest refresh the previous cards stay on screen while that batch waits, and papers added after it are shown at once. A card without an abstract that OpenAlex enrichment, Europe PMC or recovery can still supply says "Loading abstract" until the text arrives or those requests settle, at most seven seconds, and then shows the text or "No abstract". Late responses can update citations and access metadata, but cannot change a displayed abstract or a settled missing-abstract state. Older snapshots are refreshed; snapshots store the text the cards show. A snapshot can be saved before those requests answer, so a restored card that a source can still supply says "Loading abstract" while it is asked again. Answers that change a restored card update the snapshot without extending its fifteen-minute lifetime. Recovery uses the supplied arXiv identifier and preserves existing abstracts, publication metadata and access status. If arXiv cannot supply the text, the card keeps its missing-abstract state.

For missing abstracts of physics papers with a DOI but no arXiv identifier, both feeds query INSPIRE's public API directly, without credentials. INSPIRE indexes high-energy physics and neighbouring fields, so papers from other fields are not sent. Recovery requires an exact DOI match and copies only the abstract, with INSPIRE provenance. It starts when a page is prepared, uses one request at a time per tab, and allows at most two batches of twenty DOIs within six seconds, including queue time and response bodies. The tab caches up to 500 results for seven days, or six hours for confirmed absence. Failures pause new requests for at least one minute and honor longer `Retry-After` values. Truncated or conflicting results do not supply text. No generated summary substitutes for a missing abstract.

Both feeds check the document types of displayed OpenAlex papers by DOI against Crossref. Types this browser already knows exclude confirmed books and bibliographic book reviews before display. A paper Crossref confirms later is removed only if the reader has not reached it; the visible card and the one after it stay. Scientific reviews, book chapters and research without abstracts remain eligible. Identifier-specific corrections cover the reviews of Lang's and Semple–Roth's *Introduction to Algebraic Geometry* ([JSTOR 1965](https://www.jstor.org/stable/i314912), [JSTOR 1951](https://www.jstor.org/stable/i314811)), Todd's [*Methods of Algebraic Geometry*](https://www.nature.com/articles/162006a0), and OpenAlex `W1503277431`, Oda's [*Convex Bodies and Algebraic Geometry*](https://link.springer.com/book/9783642725494). Crossref's generic journal-article type cannot identify those reviews, and the Oda record has no DOI. These corrections do not match titles or infer publication type from a missing abstract. This policy applies to feed admission, not search results or saved library records.

Crossref classification uses its public API directly, with no credentials: one request at a time per tab, starts at least 200 ms apart, twenty DOIs per request, and a six-second deadline covering each page's requests, counted from when its lookup starts rather than while it waits behind another page's. The browser keeps up to 500 DOI results in `localStorage` for seven days, or six hours when Crossref has no matching record, so a reopened app does not ask again. DOIs containing the API filter delimiter (a comma) or longer than 240 characters are left unverified. Timeouts, invalid responses and provider failures are not cached as classifications; unverified candidates retain their existing type. A missed deadline pauses new lookups for five minutes. A 429 or 503 pauses them for `Retry-After`, or one minute when the browser cannot read that header. Feed snapshots created before this policy are refreshed. A snapshot keeps the cards as they were shown, including one that Crossref had not classified yet or that the reader had reached. On restore, types this browser knows by then exclude books before display, and the other OpenAlex cards are checked again like a new page.

The project also contains integrations and enrichment tools for additional scientific services and domain-specific sources.

PaperTok does not host research papers itself. Links to papers, PDFs and metadata are obtained from their respective providers.

## Recommendation system

The ranking is intentionally built inside the project rather than delegated to a black-box recommendation API. Semantic Scholar's recommender supplies some of the candidates, but it does not decide their order.

Each candidate paper can receive signals based on:

**Explicit preferences**  
Fields and categories selected by the user. Their weight fades as the user's own interactions accumulate.

**Learned affinity**  
Interactions gradually modify the user's affinity with scientific categories, concepts and authors. Reading time counts relative to the user's usual pace, not in raw seconds.

**Session**  
What the user engaged with or skipped in the last few cards counts for more, briefly.

**Personal recommendations**  
Semantic Scholar suggests papers similar to the ones the user liked, saved or read at length, one interest at a time. They are ranked like every other candidate.

**Following**  
Papers can be boosted when they relate to followed authors, topics, institutions or projects.

**Recency**  
New research receives a bounded recency signal.

**Scientific impact**  
Citation information can contribute to ranking without allowing highly cited papers to dominate everything else.

**Semantic relevance**  
Scientific concepts associated with papers can be compared with learned user interests.

**Exploration**  
Some results intentionally come from outside the strongest known preferences to avoid creating an overly narrow feed. Nearby categories that held the user's attention before are explored more often, and unexplored ones still get a chance.

**Diversity**  
The ranking tries to avoid long sequences containing only one type of publication or source.

The recommendation system is still experimental, and one of the main reasons this project is open source is to make its behavior inspectable and easier to improve.

## Architecture

PaperTok is primarily built with:

- **React**
- **Vite**
- **Firebase**
- **React Router**
- **Framer Motion**
- **KaTeX**

The frontend is deployed through **Vercel** (Git-connected: a push to `main` is a production
deploy, any other branch or PR gets a preview URL). DNS for `papertok.app` is managed in
Cloudflare.

Usage analytics use two services, both without cookies and behind one opt-out. **Vercel Web
Analytics** counts visits, pages and countries. **PostHog**'s EU cloud receives product
events (searches, follows, saves, rewrites and so on) in cookieless mode, through the
`/ingest` rewrite in `vercel.json`, and only from the production site. What is sent, and
what never is, lives in `src/services/analyticsService.ts`.

A **Cloudflare Worker** is used for server-side functionality such as caching scientific queries, protecting provider credentials and proxying APIs that should not be called directly from the browser. It also serves the AI features — plain-words rewriting and passage explanations — behind a server-enforced daily allowance that reserves usage before the model runs and refunds it on failure.

This keeps the main application lightweight while allowing integrations that require server-side secrets.

The command palette stores up to five successful typed queries locally per signed-in
user under `papertok_recentSearches_<uid>`. Queries are saved when a result opens or the
palette closes, can be removed in the palette, and are never sent as analytics. Guests
have no recent-search history; switching accounts clears the in-memory list.

## Running PaperTok locally

Use Node 22.18 or later (CI uses Node 22; local checks also cover Node 24).
Application code uses strict TypeScript; Vite and Wrangler produce the builds.

Clone the repository:

```bash
git clone https://github.com/mugar123/papertok.git
cd papertok
```

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Then open the local URL shown by Vite.

You can also create a production build with:

```bash
npm run build
```

and run the test suite with:

```bash
npm test
```

`npm run check` runs the secret scan, lint, type checks, application tests,
production build and Worker dry-run. Run `npm run test:rules` separately with
Java 21 or later and firebase-tools; see [CONTRIBUTING.md](CONTRIBUTING.md).

Some integrations require additional environment variables or API credentials. The frontend can still be developed independently, while server-side integrations are handled through the Worker.

See [`worker/README.md`](worker/README.md) for information about the server-side configuration.

## Repository structure

```text
papertok/
├── src/                    React app, scientific services and recommendation logic
├── worker/                 Cloudflare Worker, AI and notifications
├── public/                 Static assets
├── scripts/diagnostics/    Manual provider and proxy probes
└── vercel.json             Vercel build, SPA fallback, auth and analytics proxies, cache headers
```

## Documentation

- [Worker configuration](worker/README.md)
- [Contributing](CONTRIBUTING.md)
- [Agent guidance](AGENTS.md)

## Why I built it

I'm an undergraduate physics student, and PaperTok started as a project to solve a problem I had myself.

When learning about a field, I often don't know the title of the paper I want to read, the author who wrote it, or even the exact keywords I should search for. Traditional search is excellent once you know what you are looking for, but I wanted to experiment with another part of the process: **discovery**.

What happens if scientific literature is something you can explore?

PaperTok is my attempt to find out.

It has also become a way for me to learn software development, recommendation systems, scientific APIs and open-source development while building something connected to the field I study.

## Project status

PaperTok is a work in progress.

Things may change quickly, APIs may occasionally fail, and parts of the architecture are still being redesigned as the project grows.

Current areas of development include:

- improving recommendation quality
- expanding and improving scientific data sources
- better deduplication across providers
- offline support for the installed app (a service worker)
- a three-state theme control (light / system / dark)
- performance and reliability
- documentation and testing
- making the project easier for other people to contribute to

## Contributing

Contributions, suggestions and bug reports are welcome.

If you find something that could be improved, feel free to open an issue or submit a pull request.

Since PaperTok is still evolving quickly, opening an issue before working on a large change is recommended so we can discuss the approach first.

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, verification and security guidance.

## Donors

PaperTok is a personal open-source project, and some people have chosen to support it with their own money. Thank you.

[ConvenIA-RLT-bot](https://github.com/ConvenIA-RLT-bot), [XMihura](https://github.com/XMihura), [felipebasurto](https://github.com/felipebasurto) and [helmcode](https://github.com/helmcode).

[Support PaperTok on GitHub Sponsors](https://github.com/sponsors/mugar123).

## Acknowledgements

PaperTok relies on the work of open scientific infrastructure projects and research databases that make scholarly metadata accessible to developers and researchers.

In particular, the project would not be possible without services such as arXiv, OpenAlex and PubMed.

The visual direction of the current interface grew out of the initial UI redesign by **Samuel** — the 0.2 release carries his design through the whole app.

## License

PaperTok is available under the [MIT License](LICENSE).

---

Built by [Nicolás Muñoz](https://github.com/mugar123) while studying physics and learning how better tools for scientific discovery could work.
