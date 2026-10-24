# PaperTok

A scrollable, personalized feed of scientific papers.

[Open PaperTok](https://papertok.app/feed) · [Latest release](https://github.com/mugar123/papertok/releases/latest) · [Report a bug](https://github.com/mugar123/papertok/issues)

PaperTok helps you find research when you don't know what to search for. Pick your fields,
scroll, and the feed learns from what you read, like, save, skip and follow.

> PaperTok is under active development. It is not affiliated with arXiv, OpenAlex, PubMed
> or any other data provider.

## Features

- **Personalized feed** from arXiv, OpenAlex, PubMed, OpenReview, Hugging Face and more.
- **Follow** authors, topics, institutions and projects.
- **Search** papers, authors, topics, institutions and projects with `/`.
- **Similar papers** from the card’s action rail.
- **Read in plain words**: AI rewrites at Beginner, University or Researcher level when
  supported full text is available, with highlights and notes.
- **University library access**: verify a university email to read articles your library
  confirms access to. Coverage depends on your institution, article and subscription year.
- **Citation map**: see what a paper cites and what cites it.
- **Clear labels** for preprints, working papers and open access.
- **Library** of colored lists you can share.
- **The PaperTok Weekly**: an opt-in Monday email with new papers from what you follow.
- **Installable** on your home screen, with dark mode.

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

## Contributing

Bug reports, ideas and pull requests are welcome. For large changes, open an issue first.
See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## Supporters

<!-- donors:start -->
Thanks to [ConvenIA-RLT-bot](https://github.com/ConvenIA-RLT-bot),
[XMihura](https://github.com/XMihura), [felipebasurto](https://github.com/felipebasurto) and
[helmcode](https://github.com/helmcode). [Sponsor PaperTok](https://github.com/sponsors/mugar123).
<!-- donors:end -->

PaperTok depends on open scholarly infrastructure, especially arXiv, OpenAlex and PubMed.

## License

[MIT](LICENSE). Built by [Nicolás Muñoz](https://github.com/mugar123),
[Samuel](https://x.com/disamdev), Pablo Presa and Asier.
