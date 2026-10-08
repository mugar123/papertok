# Contributing to PaperTok

Thanks for helping improve PaperTok. The project is evolving quickly, so focused changes with
clear verification are easiest to review.

## Local Setup

You can use Docker instead of installing Node.js and npm on your machine. After cloning,
start Docker and run `docker compose up --build --watch dev`, then open http://localhost:5173.
Docker Compose 2.32 or newer is required. See the
[Docker development guide](docs/DEVELOPMENT.md#docker-development-and-checks) for details.
The frontend uses local Auth and Firestore emulators (`demo-papertok`), so profile and
private-list changes stay local. The Cloudflare Worker is outside this setup's scope.

For a native Node.js setup:

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

With Docker, the equivalent command is `docker compose run --build --rm check`.
It checks the current source snapshot; rerun it after edits. The image installs the locked
dependencies using Node.js 22, matching CI, and runs the existing check script unchanged.
Run `docker compose run --build --rm rules` for the separate Firestore rules suite;
Java and the Firebase CLI are installed inside that image.

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
