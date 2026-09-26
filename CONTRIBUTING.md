# Contributing to PaperTok

Thanks for helping improve PaperTok. The project is evolving quickly, so focused changes with
clear verification are easiest to review.

## Local Setup

```bash
git clone https://github.com/mugar123/papertok.git
cd papertok
npm ci
cp .env.example .env.local
npm run dev
```

Firebase values are required for authenticated flows. Protected scientific-provider, AI, and
email credentials belong in Cloudflare Worker secrets and must never be added to `.env.local`
as `VITE_*` values.

## Before Opening a Pull Request

```bash
npm run check
```

Also verify the affected workflow manually when the change involves navigation, animations,
loading states, authentication, or responsive layout.

## Pull Request Scope

- Keep unrelated refactors out of bug fixes.
- Add or update tests for ranking, provider mapping, deduplication, localization, and Worker
  contracts.
- Document new routes, providers, environment variables, and persistence.
- Write user-facing copy in English.
- Explain any API quota, caching, privacy, or fallback implications.

For large features or recommendation changes, open an issue first so the behavior and success
criteria can be discussed.

## Diagnostics

Manual API probes live in `scripts/diagnostics/`. They are intentionally excluded from lint
and automated tests because many hit live services and may consume provider quota.

## Security

Do not commit API keys, Firebase service credentials, email-provider tokens, private user
data, or captured authenticated responses. If a secret is exposed, revoke it before removing
it from Git history.

