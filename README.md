# PaperTok

A scrollable, personalized feed of scientific papers.

[Open PaperTok](https://papertok.app/feed) · [Latest release](https://github.com/mugar123/papertok/releases/latest) · [Report a bug](https://github.com/mugar123/papertok/issues)

PaperTok helps you find research when you don't know what to search for. Pick your fields,
scroll, and the feed learns from what you read, like, save and follow.

> PaperTok is under active development. It is not affiliated with arXiv, OpenAlex, PubMed
> or any other data provider.

## Features

- **Personalized feed** from arXiv, OpenAlex, PubMed, OpenReview, Hugging Face and more.
- **Follow** authors, topics, institutions and projects.
- **Search** papers, authors, topics, institutions and projects with `/`.
- **Read in plain words**: AI rewrites at three levels, with highlights and notes.
- **Export to LaTeX**: take the rewrite and your notes as a `.tex` file.
- **Citation map**: see what a paper cites and what cites it.
- **Clear labels** for preprints, working papers and open access.
- **Library** of colored lists you can share.
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

Sign-in needs Firebase values in `.env.local`. Provider and AI features run through the
Cloudflare Worker; see [`worker/README.md`](worker/README.md).

Run `npm run check` before opening a pull request.

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
