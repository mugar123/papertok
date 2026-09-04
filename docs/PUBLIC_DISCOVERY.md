# Public Discovery

PaperTok is deployed as a Vite single-page application on the GitHub Pages project
site `https://papertok.app/`. This document records the URL and metadata
contract for public discovery surfaces without changing the existing authenticated routes.

## URL Contract

`src/utils/publicNavigation.js` keeps route construction separate from absolute sharing:

- `getPublicEntityPath(type, id)` returns a React Router path such as
  `/public/entity/author/A123`.
- `getPublicPaperPath(paper)` returns `/public/paper/<key>` for a DOI or arXiv paper.
- `getSharedListPath(listId)` returns `/public/list/<id>`.
- The corresponding `*Url` helpers add the Vite base and the `#` required by `HashRouter`,
producing URLs such as `https://papertok.app/#/public/paper/<key>`.

Signed-out visitors can browse a bounded multi-provider sample feed and open public paper or
entity pages. Actions that create personal state (likes, follows, saved papers, lists, or AI
preferences) keep their visible controls but open the sign-in prompt instead of writing shared
guest data.

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

The Vite base comes from `import.meta.env.BASE_URL`, so the same helpers work at `/` during
local development and at `/papertok/` on the project site. A runtime origin is used in the
browser; the production GitHub Pages origin is the deterministic fallback outside a browser.

## Metadata

`index.html` contains honest, generic root metadata for the application itself:

- canonical URL and Open Graph/Twitter URLs point to the fragment-free project root;
- the preview is a 1200x630 PNG derived from `docs/assets/papertok-feed.png` and contains no
  user profile photo;
- JSON-LD describes PaperTok as a `WebSite`, without inventing a public paper, author, or list;
- Spanish is the initial document language, with English represented as an alternate locale.

`src/hooks/usePublicPageMetadata.js` is for public page consumers. It reads the active language
from `LanguageContext` and updates the title, description, canonical URL, Open Graph, Twitter,
robots, and JSON-LD tags at runtime. Localized values can be passed as `{ es, en }` objects.
The hook restores the previous head state when its page unmounts.

## GitHub Pages Limitations

Hash fragments are never sent to the server. GitHub Pages therefore receives only
`/papertok/`, not `/papertok/#/public/paper/...`. This has three consequences:

1. A hash URL is navigable in a browser and works with `HashRouter`, but it cannot be a
   distinct server-side URL for crawling or HTTP redirects.
2. Social crawlers commonly inspect the initial HTML without running the application. They
   will see the generic root title, description, and preview image rather than metadata loaded
   later by the runtime hook. Per-entity, per-paper, and per-list previews require server-side
   rendering, a crawler-aware redirect, or a host that supports non-hash routes.
3. Sitemap entries cannot contain fragments. `public/sitemap.xml` intentionally lists only the
   public project root; it does not pretend that hash routes are independently crawlable.

`public/robots.txt` points crawlers to that root-only sitemap. The shared URL helpers still
produce absolute links with the project-site base so browser sharing remains correct on both
GitHub Pages and local deployments.
