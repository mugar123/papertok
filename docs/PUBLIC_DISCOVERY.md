# Public Discovery

PaperTok is a Vite build served from the root of `https://papertok.app/`: the landing page at
`/` (`index.html`) and the single-page application at `/feed`, which `vercel.json` rewrites to
`app.html`. This document records the URL and metadata contract for public discovery surfaces
without changing the existing authenticated routes.

## URL Contract

`src/utils/publicNavigation.js` keeps route construction separate from absolute sharing:

- `getPublicEntityPath(type, id)` returns a React Router path such as
  `/public/entity/author/A123`.
- `getPublicPaperPath(paper)` returns `/public/paper/<key>` for a DOI or arXiv paper.
- `getSharedListPath(listId)` returns `/public/list/<id>`.
- The corresponding `*Url` helpers add the Vite base and the `#` required by `HashRouter`,
producing URLs such as `https://papertok.app/#/public/paper/<key>`. That URL lands on the
landing page, not on the app: `/` is now `index.html`, whose head script forwards any `#/…`
hash to `/feed` with the same hash attached, so a shared link still opens the route it names.

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

`app.html` is the application shell and holds the honest, generic metadata for the application
itself. `index.html` is the landing page and holds its own, separate metadata — a change meant
for the app belongs in `app.html`:

- the shell's canonical URL and its Open Graph/Twitter URLs are `https://papertok.app/feed`,
  the fragment-free URL `vercel.json` rewrites to `app.html`; the landing keeps
  `https://papertok.app/` as its own canonical and OG URL;
- the preview is `public/og/papertok-share-0.2.png`, a 2400x1260 PNG that both pages declare and
  that `DEFAULT_SHARE_IMAGE_PATH` points at; it shows a paper in the feed and contains no user
  profile photo;
- JSON-LD in `app.html` describes PaperTok as a `WebSite`, without inventing a public paper,
  author, or list;
- English is the initial document language (`<html lang="en">`), with Spanish represented as an
  alternate locale.

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
