# PaperTok

A scrollable, personalized feed of scientific papers.

[Open PaperTok](https://papertok.app/feed) · [Latest release](https://github.com/mugar123/papertok/releases/latest) · [Report a bug](https://github.com/mugar123/papertok/issues)

PaperTok helps you find research when you don't know what to search for. Pick your fields,
scroll, and the feed learns from what you read, like, save and follow.

> PaperTok is under active development. It is not affiliated with arXiv, OpenAlex, PubMed
> or any other data provider.

## PaperTok 0.3

Version 0.3 adds university library access, recommendations that adapt to your reading
pace, a redesigned search palette, PDF export and a citation map built for phones.
Read the [release notes](https://github.com/mugar123/papertok/releases/tag/v0.3.0).

## Features

- **Personalized discovery** from arXiv, OpenAlex, PubMed, OpenReview, Hugging Face and
  specialist sources. Likes, saves, skips and reading time shape your recommendations.
- **University library access**: verify a university email, including a secondary address
  on a Google or GitHub account. PaperTok checks individual articles and links to your
  library when access is confirmed. Browse sampled journals and platforms by publisher;
  availability depends on your institution, article and subscription year.
- **A feed made for touch and keyboard**: swipe or use the arrow keys, pull to refresh on
  phones, undo Not interested, and hold Save to choose a list.
- **Search** papers, authors, topics, institutions and funded projects with `/`, with
  separate result tabs and links to their paper or explorer pages.
- **Similar papers** from the card's action rail, alongside likes, saves and connections.
- **Read in plain words** at Beginner, University or Researcher level when supported full
  text is available. Highlight passages, write notes and ask for explanations.
- **PDF and LaTeX export**: download the rewrite with selected highlights and annotations,
  paper attribution and an AI disclosure.
- **Citation map**: explore references and citing papers on desktop or phone, re-center on
  another paper, and download references as BibTeX.
- **Follow** authors, topics, institutions and projects. Explorer pages include publications,
  source-backed facts and verified ORCID links when available.
- **The PaperTok Weekly**: opt in to a Monday email with new papers from what you follow.
- **Shared reading lists** with colors and public links.
- **Installable** on your home screen, with light and dark themes.

## Screenshots

Real screenshots of the 0.3 app, captured locally with a disposable Firebase emulator
account. Paper results come from live scholarly sources.

| Paper feed | Search | University email verification |
| --- | --- | --- |
| <img src="docs/assets/release-0.3/feed.jpg" width="260" alt="PaperTok feed showing a research paper with Read, Simple, like, save and connections controls"> | <img src="docs/assets/release-0.3/search.jpg" width="260" alt="PaperTok search with suggestions and tabs for papers, authors, topics, institutions and projects"> | <img src="docs/assets/release-0.3/university.jpg" width="260" alt="Optional university email verification step with a labeled email field and a Skip for now action"> |

## Run locally

Requires Node 22.18 or later.

```bash
git clone https://github.com/mugar123/papertok.git
cd papertok
npm ci
cp .env.example .env.local
npm run dev
```

The example points the frontend at a local Cloudflare Worker. Start it with
`npx wrangler dev --local --port 8787`; provider credentials belong in the ignored
`.dev.vars` file, as described in [`worker/README.md`](worker/README.md#local-testing).
Firebase web configuration is already bundled in `src/services/firebase.ts`.

For signed-in development, use `npm run dev:emulators` with firebase-tools and Java 21
or later. It starts local Auth and Firestore emulators and signs in a disposable account;
Worker routes that require production identity reject its tokens. See the
[local testing guide](worker/README.md#local-testing) for account switching and limits.

Run `npm run check` before opening a pull request.

## Analytics and error monitoring

Reader analytics distinguish `reader_open` (the internal reader becomes visible),
`paper_open` (an attempt to open the original/PDF), and `paper_rewrite` (an attempted
Worker request). `paper_rewrite_result` reports success, incomplete output,
failure or cancellation, with the reading level, cache status, bounded duration
and an allowlisted error code. Cached results do not count as Worker requests.
`auth_prompt_view` records the sign-in dialog's reason; `auth_result` distinguishes
successful, cancelled and failed Google/GitHub attempts without account details.

Sentry receives frontend and Worker errors in separate `papertok-web` and
`papertok-worker` projects. Frontend collection covers the React error boundary,
uncaught JavaScript errors and unhandled promise rejections, on production hosts
and behind the analytics opt-out. Worker collection covers uncaught request,
scheduled-task and Durable Object failures, caught router and rewrite failures,
and otherwise unreported 5xx responses. Expected 4xx responses are excluded.
Backend operational reporting is independent of browser analytics consent.

Reports keep standard error types, code locations, release identifiers and
allowlisted operation/status tags. Messages, request data, account details,
paper content and breadcrumbs are removed; transport IP inference is suppressed.
Tracing, replay, logs and metrics are disabled. `app_error` remains a product
counter in PostHog. Hidden frontend source maps upload during Vite builds and
are deleted from the published assets. Set `SENTRY_AUTH_TOKEN` in the Vercel
Production build environment; never use a `VITE_*` variable for this credential.
The Worker deployment command uploads its maps separately (see `worker/README.md`).

## Contributing

Bug reports, ideas and pull requests are welcome. For large changes, open an issue first.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Supporters

Thanks to [ConvenIA-RLT-bot](https://github.com/ConvenIA-RLT-bot),
[XMihura](https://github.com/XMihura), [felipebasurto](https://github.com/felipebasurto) and
[helmcode](https://github.com/helmcode). [Sponsor PaperTok](https://github.com/sponsors/mugar123).

PaperTok depends on open scholarly infrastructure, especially arXiv, OpenAlex and PubMed.

## License

[MIT](LICENSE). Built by [Nicolás Muñoz](https://github.com/mugar123), with UI design by Samuel.
