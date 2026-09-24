# Public Discovery

PaperTok is a Vite build served from the root of `https://papertok.app/`. The single-page
application is `index.html`, and `vercel.json` rewrites every page path to it; the landing page
that used to sit at `/` was retired on 2026-09-19. This document records the URL and metadata
contract for public discovery surfaces without changing the existing authenticated routes.

## URL Contract

`src/utils/publicNavigation.js` keeps route construction separate from absolute sharing:

- `getPublicEntityPath(type, id)` returns a React Router path such as
  `/public/entity/author/A123`.
- `getPublicPaperPath(paper)` returns `/public/paper/<key>` for a DOI or arXiv paper.
- `getSharedListPath(listId)` returns `/public/list/<id>`.
- The corresponding `*Url` helpers add the origin and the Vite base, producing real paths such as
  `https://papertok.app/public/paper/<key>`. The router reads the path since 2026-09-18. An old
  `#/…` link still reaches the same page — `index.html`'s head script forwards it and
  `src/utils/legacyHashRoute.js` translates it — but nothing new is minted in that shape.

There is no sign-in page. Signed-out visitors land on the guest feed; the only door is the
`AuthPrompt` dialog, which opens in place from any gated action, and also on arrival when a guest
is bounced off a protected route (or follows an old `/login` link): `ProtectedRoute` sends them
to `/` with `authRequired` and the route they asked for in the location state, and App takes
them there once the session exists. Signed-out visitors can browse a bounded multi-provider
sample feed and open public paper or entity pages. Actions that create personal state (likes, follows, saved papers, lists, or AI
preferences) keep their visible controls but open the sign-in prompt instead of writing shared
guest data.

The moment the guest page is up, a sheet opens once (`GuestInterestsPrompt`): two lines on what
PaperTok is, then which areas the visitor is into. The answer — area keys, kept on the device in
`papertok_guestInterests` — rebuilds the guest feed through `buildGuestFeedPlan`
(`src/utils/guestFeedPlan.js`): every source is asked for those areas instead of the fixed
sample, with the same per-source caps the signed-in feed keeps (six arXiv categories, five
OpenAlex labels, three PubMed labels, spread round-robin across the chosen areas so each one
is represented). The first ask has to be answered — no close button, no Escape, no scrim
dismissal — because the feed behind it is built from the answer; the header chip reopens it
as an editable sheet (with Cancel) and names the answer once there is one. If the guest signs up, the onboarding
skips the interests steps altogether and opens on the profile step, with those areas and all
their categories pre-selected (Back reaches the receipt and the pickers for anyone who wants to
narrow them); `completeOnboarding` writes them to the profile and clears the device copy.

Custom lists can be published as deliberately reduced Firestore documents. They contain at
most 50 sanitized papers and never include private notes, tags, preferences, or interaction
state. The public document carries no owner field; attribution is a separate, per-list and
reversible choice that puts a card on the owner's public profile (F12). The public copy is
not a snapshot: editing a published list rebuilds it in the background, with no manual step
(P25). Removing a shared list deletes its public document before the private list can be
removed.

Path identifiers are encoded as individual URL segments. Paper keys are base64url-encoded
payloads with an explicit `doi:`, `arxiv:`, `openalex:` or `pmid:` prefix. They are
reversible URL-safe encodings, not secrets or access controls. DOI values are normalized to
lowercase; arXiv versions are preserved; OpenAlex work ids are uppercased (`W…`); PubMed ids
are the bare number and are only recognized behind a `pmid:` prefix or a PubMed URL. The
precedence is DOI, then arXiv, then the provider id the feed keyed the paper by. The last two
exist because a paper liked or saved from an OpenAlex or PubMed card is remembered under
`openalex:W…` or `pmid:…`; the public paper page resolves both through OpenAlex's
`GET /works/{id}`.

The Vite base comes from `import.meta.env.BASE_URL`, and in this repository it is `/`:
`vite.config.js` sets `BASE_PATH = '/'` because the site is served from the domain root, not
from the `/papertok/` project path. A runtime origin is used in the browser;
`DEFAULT_PUBLIC_ORIGIN` (`https://papertok.app`) is the deterministic fallback outside a
browser.

## Metadata

`index.html` is the application shell and holds the honest, generic metadata for the application
itself:

- its canonical URL and its Open Graph/Twitter URLs are `https://papertok.app/feed`;
- the preview is `public/og/papertok-share-0.2.png`, a 2400x1260 PNG that
  `DEFAULT_SHARE_IMAGE_PATH` points at; it shows a paper in the feed and contains no user
  profile photo;
- its JSON-LD describes PaperTok as a `WebSite`, without inventing a public paper, author, or
  list;
- English is the initial document language (`<html lang="en">`), with Spanish represented as an
  alternate locale.

`src/hooks/usePublicPageMetadata.js` is for public page consumers. It reads the active language
from `LanguageContext` and updates the title, description, canonical URL, Open Graph, Twitter,
robots, and JSON-LD tags at runtime. Localized values can be passed as `{ es, en }` objects.
The hook restores the previous head state when its page unmounts. The paper page builds its
values with `publicPaperMetadata` (`src/utils/shareSeed.js`): title and summary as plain text,
and `noindex` only while there is no paper on screen.

## Crawlers and shared links

A crawler reads the HTML a URL answers; no preview bot runs the application. Until 2026-09-24
every public page answered the same static `index.html`: WhatsApp, Twitterbot,
facebookexternalhit and Googlebot all received «PaperTok», with og:url and canonical at `/feed`
and an empty `#root` (audit of 2026-09-23, issue 5).

**Routing.** `vercel.json` rewrites `/public/{paper,list,user,entity}/…` to the Worker's
`https://api.papertok.app/share/…` when the `user-agent` names a crawler: search engines
(Googlebot, bingbot, Applebot, DuckDuckBot, YandexBot…) and link-preview bots (WhatsApp,
facebookexternalhit, Twitterbot, LinkedInBot, Slackbot, Discordbot, TelegramBot, Bluesky,
Mastodon…). The rule sits before the SPA catch-all, and `src/utils/shareCrawlerRouting.test.js`
holds the pattern against measured crawler and browser user agents. People are not rewritten. A
browser matched by mistake still gets the application: the Worker answers the same shell.

**What the Worker answers** (`worker/share-pages.js`). The deployed shell, fetched from
`https://papertok.app/index.html`, with the page's own head and body:

- title, description, canonical, `og:*`, `twitter:*` and JSON-LD (`ScholarlyArticle`,
  `CollectionPage`, `ProfilePage`, or a `WebPage` about the entity), in the reader's language
  (`Accept-Language`: Spanish when asked for, English otherwise; `Vary: Accept-Language`);
- a static copy of the page inside `#root` (title as h1, authors, abstract and links for a paper;
  the papers of a list, each linked to its own page), which the application replaces when it
  mounts;
- for a paper, the paper itself as JSON in `<script id="papertok-share-seed">`, keyed by the paper
  key it was written for.

Everything from a provider or a user is HTML-escaped; LaTeX in titles and abstracts becomes plain
text (`src/utils/plainScientificText.js`). A page that does not exist answers `404` with
`noindex`. A provider failure answers `200` with PaperTok's generic head at the page's own
address: a preview bot shows nothing for an error status, and an outage is not a reason to drop a
page from an index. An author known only by a name (no OpenAlex id or ORCID), a PaperTok topic and
a search turned into a topic get a head with their name and `noindex`, and cost no lookup: a name
is not an identity, and the same name can be several people.

**Where the data comes from, and what it may spend.** Papers from OpenAlex under the Worker's key
and its shared daily budget; a preprint OpenAlex has not indexed yet (most of what the feed shows
is days old) from arXiv, on the same one-call-every-three-seconds beat as `/arxiv`. Projects from
OpenAIRE. Lists and profiles from their public Firestore documents, read anonymously, so the rules
decide exactly as they do for a visitor and a private profile is a 404. Because the route is
public and carries no `Origin`, a random key misses every cache, so misses have their own
ceilings: 30 a minute and 1000 a day in all, and 30 arXiv calls an hour.

**Caches.** The shell is kept five minutes: it names the hashed assets of the current deployment,
and a stale one points at files Vercel no longer serves. A page's record is kept 24 hours, a
missing page one hour, a failure two minutes. The page is composed per request from the two, so
one record serves both languages and a deploy reaches every shared page within minutes.

**Googlebot.** Googlebot renders JavaScript, but `https://api.papertok.app/robots.txt` is
`Disallow: /`, so the application's own requests fail for it. The paper page therefore paints the
seed (`src/utils/shareSeed.js`, read only for the key in the URL) from its first render, marks
nothing `noindex` while it does, and keeps the seed on screen when its own load fails.

**Sharing.** The card and Research share the PaperTok page, with the plain-text title as the
share `text`: most share targets print `text` and the link and ignore `title`.

**Deploying.** The Worker first — the routes are new — checked with crawler user agents, for
example `curl -A 'facebookexternalhit/1.1' https://api.papertok.app/share/paper/<key>`; then the
frontend, whose `vercel.json` starts sending crawlers there. Cloudflare's bot protection on the
zone must let a crawler user agent arriving from Vercel's addresses through.

**Known limits.**

- A link of the old `/#/public/…` shape can never have its own preview: the fragment never
  reaches a server.
- A PaperTok topic page previews with its id (`quant-ph`), and is not indexed: the taxonomy labels
  live in `src/data/categories.js`, next to React icons the Worker should not bundle.

## Sitemap and robots

`public/sitemap.xml` lists canonical pages only: `/feed` and `/privacy.html`. `/` is not canonical
(the shell names `/feed`), and pages that need an account send a crawler back to `/feed`. There is
no sitemap of papers: the only public collection that names papers, `publicLists`, is readable by
id and deliberately not listable (`allow list: if false`, a directory the product never offers).
Public lists and profiles link their papers from their own share pages instead.

`public/robots.txt` points crawlers to the sitemap and disallows the pages that need an account
(`/lists`, `/research`, `/following`, `/search`, `/profile`, `/settings`, `/admin`, `/onboarding`,
`/login`, `/report`); `src/utils/staticDiscoveryFiles.test.js` holds both files against the routes
`App.jsx` guards.
