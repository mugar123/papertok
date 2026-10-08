# Development Guide

## Requirements

Choose Docker Engine with Docker Compose 2.32+ (Docker Desktop or OrbStack also work),
or install the following tools for native development:

- Node.js 22
- npm
- A Firebase web project for authenticated flows (the live one is wired in `src/services/firebase.js`; see below)
- A Cloudflare account only when developing or deploying Worker functionality

## Setup

```bash
npm ci
cp .env.example .env.local
npm run dev
```

The site is served from the domain root, so Vite's `base` is `/`. Use the URL printed by the dev
server for local work.

## Docker development and checks

Run these commands from the repository root. Only Docker and Compose are needed on the
host; Node.js 22 and npm dependencies are installed in the image using `npm ci`.
The Firebase image also contains Java 21 and firebase-tools 15.27.0, matching CI.
The initial build needs network access to download the base image and packages.

```bash
docker compose up --build --watch dev
```

This starts Vite plus local Firebase Authentication and Firestore emulators.
Open http://localhost:5173 and inspect local users/data at http://localhost:4000.
Use Google sign-in and create a fictitious user in the emulator popup; no real Google
account or Firebase credentials are needed. Complete onboarding, then visit your profile
and Manage my lists to create, rename, and delete private lists.

Compose Watch syncs source changes into the container and Vite
reloads the app. Changes to `package.json`, `package-lock.json`, or `Dockerfile` rebuild the
container. Restart the command after changing `compose.yaml`. Docker's build cache reuses
the dependency layer until the package files change. No host `node_modules` is needed or used.

The `.dockerignore` rules also apply to Watch: local environment files, credentials in
`.dev.vars*`, Git metadata, dependencies, and generated output are excluded. The image
initializes an empty Git repository solely so the existing secret scanner can enumerate
the copied source; it contains no host history, remotes, or authentication configuration.

### Checks

In another terminal:

```bash
docker compose run --build --rm check
docker compose run --build --rm rules
```

This runs the same `npm run check` as CI: secret scanning, ESLint, Node tests, production
build, and a Worker deployment dry run. It does not deploy anything. Each run builds the
current source snapshot, keeps output inside its container, and removes that container on
exit. Rerun after editing files; the check container does not watch the working tree.

For an individual gate:

```bash
docker compose run --build --rm check npm test
docker compose run --build --rm check npm run lint
docker compose run --build --rm check npm run build
```

The `rules` service runs `npm run test:rules` with Java and the Firebase CLI inside its
own container and emulator. It uses the separate `papertok-rules-test` project and does
not clear the development emulator. Verify affected browser flows manually as well.

With `dev` running, verify local signup, private-list SDK writes, REST reads, and denial
of anonymous access:

```bash
docker compose exec -T dev node tests/firebaseEmulator.smoke.mjs
```

This test only targets the Docker emulators and removes its own fictitious account and list.

### Configuration and external services

Compose explicitly enables `VITE_USE_FIREBASE_EMULATORS=true` for `dev`. This development-only
switch selects the fixed `demo-papertok` project and connects the Firebase SDK to Auth on
`localhost:9099` and Firestore on `localhost:8080`. Direct Firestore REST reads use that
same emulator. There is no fallback to live Firebase if an emulator is unavailable.
The app refuses to initialize with this flag outside the development server.
Normal native development keeps the existing
Firebase configuration unless you explicitly enable it with the emulators running.

The emulators enforce the repository's Firestore rules. They start empty and hold test
data in memory; restarting Firebase discards users and documents. Sign out and create
another fictitious account if the browser retains a session after a reset. Changes to
`firestore.rules`, `firestore.indexes.json`, or `firebase.docker.json` require restarting
with `docker compose up --build --watch dev` so the emulator gets the new configuration.

No environment file or cloud credentials are required. The Worker URL stays at
`http://localhost:8787`, where this setup does **not** start a backend. AI, email, public-list
publishing, account deletion through the Worker, and Worker-backed providers are outside
this environment's scope. Do not point it at the production Worker: emulator identities
are not production identities. Some public research providers are still called directly,
so this is not a fully offline application. Private lists and profile editing use local
Firebase. See [the Worker guide](../worker/README.md) for backend development separately.

All published ports bind to `127.0.0.1`: Vite 5173, emulator UI 4000, Auth 9099, and Firestore
8080. The browser reaches `localhost`; Compose services reach Firebase as `firebase`.
The emulator container's internal hub is not published to the host. Local environment
files are excluded from builds and Watch; Node, Java, and dependencies stay inside Docker.

If port 5173 is busy, use `PAPERTOK_PORT=5174 docker compose up --build --watch dev` and
open http://localhost:5174. If source changes do not appear, confirm Watch is running and
that the file is not excluded by `.dockerignore`.

### Stop and clean up

Press Ctrl+C in the development terminal, then:

```bash
docker compose down --remove-orphans
```

There are no bind mounts or persistent dependency volumes. This removes the project's
containers and network, including all local test users and documents; source files remain
on the host. To remove the project's
locally built images as well, use `docker compose down --rmi local --remove-orphans`.
Docker may retain build cache for later builds.

## Environment Variables

Frontend variables are public in the built JavaScript:

| Variable | Purpose |
| --- | --- |
| `VITE_USE_FIREBASE_EMULATORS` | Set to `true` only for the development server to use local Auth and Firestore with `demo-papertok`; set automatically by Compose |
| `VITE_PAPER_API_BASE_URL` | Cloudflare Worker base URL |
| `VITE_REPORT_API_URL` | Legacy report API alias |
| `VITE_SCOPUS_ENABLED` | Enables Scopus-backed browser flows. Declared `false` in `src/utils/deployFlags.js`, which is where the decision is made and reviewed; `vite build` fails when this variable disagrees with that declaration, so change the declaration first. Check `/health/scopus` on the Worker before ever declaring it on: with the flag on and the key refused, the feed queues calls that only ever fail. Scopus reaches Elsevier through the Deno Deploy egress in `proxy/README.md`, never from the Worker |
| `VITE_UNPAYWALL_EMAIL` | Public contact email required by Unpaywall |

The production Firebase web configuration is not an environment variable: it is a literal in
`src/services/firebase.js`. Those values are public by design (they ship in every bundle), and
`authDomain` is `papertok.app` because Vercel proxies `/__/auth/*` to Firebase's sign-in handler
(`vercel.json`); the domain and the rewrite have to change together, which is why both live in code.

Never put secret provider tokens in a `VITE_*` variable. See `worker/README.md` for Worker
secrets. OpenAlex is reached through the Worker's `/openalex/*` route for exactly this reason: since
February 2026 it requires a key and bills against a daily budget, and its keys take prepaid credit.
Without `VITE_PAPER_API_BASE_URL` the browser still calls OpenAlex directly, on the anonymous
$0.10/day allowance.

## Analytics

Measurement is **Vercel Web Analytics**. It sets no cookies of its own, so nobody is asked before
it runs: it is on by default and the switch in Settings is the way out (the consent banner went on
2026-09-17). `AnalyticsProvider` renders `<Analytics />` only while consent reads as granted, so
turning it off unmounts the script and stops the page views.

PaperTok records normalized application routes and a strict allowlist of coarse funnel events
(acquisition channel, guest demo, search result count, follow/save/share, AI explanation status,
onboarding, newsletter subscription, activation, and day-seven return). Entity identifiers, search
text, paper titles, interests, account identifiers, URLs, and other free-form values are excluded.
An explicit choice is stored in local browser storage with a first-party cookie fallback, so it
survives reloads; an empty store reads as granted, and the default is never written down. It can
be changed from Settings.

Two details are load-bearing and easy to undo by accident:

- The app uses `HashRouter`, so every route lives in the fragment, and the app itself is served
  at `/feed` (`vercel.json` rewrites that path to `app.html`), so `location.pathname` is `/feed`
  for all of them. Passing `route` to `<Analytics />` disables the script's own pathname-based
  tracking and makes the component emit each view instead. Remove it and the whole site collapses
  into a single `/feed` row.
- `route`, `path` and the `beforeSend` rewrite all carry the *normalized* path, never the real one.
  The published privacy policy promises that reading a paper is reported as `/public/paper/:id`
  and never says which; `sanitizeAnalyticsEventUrl` is what keeps that true, because the script
  builds its payload's `url` from `location.href` on its own.

**Custom events need a paid plan.** On Hobby, Vercel accepts page views and discards custom
events, so the funnel above is wired but silent. Pro allows 2 properties per event; four of these
events carry 3 or 4 (`paper_export`, `paper_open`, `paper_annotation`, `share`), so keeping every
field needs the Web Analytics Plus add-on. The instrumentation is left in place either way: moving
to Pro turns it on with no code change.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Vite |
| `npm test` | Run frontend and Worker Node tests |
| `npm run lint` | Run ESLint |
| `npm run build` | Create the production bundle |
| `npm run preview` | Serve the production bundle locally |
| `npm run check` | Scan secrets, run lint and tests, build, and dry-run the Worker deployment |
| `npm run test:rules` | Firestore rules against the emulator (needs a JRE: `PATH="/opt/homebrew/opt/openjdk/bin:$PATH"` on a Homebrew Mac) |

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and on every push to `main`: a `check` job
(`npm ci` + `npm run check`) and a `rules` job (Temurin 21, `firebase-tools@15.27.0`,
`npm run test:rules`). Production is Vercel, which builds from the repository and runs no tests,
so what keeps `main` green is a branch protection rule requiring the `check` and `rules` checks
before merge. There is no second publish workflow: `deploy.yml` published to GitHub Pages and was
removed on 2026-09-18, and what it ran was a strict subset of `npm run check`.
Every action is pinned to a commit SHA; Dependabot proposes the bumps weekly.

## PWA updates

Navigation uses Workbox `NetworkFirst` without a cache timeout: slow successful
requests serve current HTML, and cached HTML is used only when the network fails.
The cached `/feed` shell remains available for offline routes. Hashed JS, CSS and
fonts keep their `CacheFirst` policy.

After service worker registration, the app checks for updates when it becomes
visible, returns from the back/forward cache, or regains connectivity, and every
five minutes while visible and online. Successful checks are throttled to one per
minute; failed checks can retry on the next event. An installation already in
progress is left alone. The existing automatic activation and reload behavior
applies a detected deployment, preserving the feed position through `appReload`.

## Adding a Scientific Provider

1. Decide whether the browser can call the provider safely and reliably.
2. Put secret-bearing or CORS-sensitive access behind the Worker.
3. Add an adapter or service that maps results into the normalized paper shape.
4. Preserve provider provenance and distinguish unknown metadata from zero values.
5. Add deduplication and realistic fixture tests.
6. Add bounded timeouts and a fallback so one provider cannot block the feed.
7. Document rate limits and required configuration.

## Localization

The interface is English only; there is no language setting.

- `LanguageContext` provides the fixed language (`en`) and locale (`en-US`) that services
  pass to the Worker and use for date and number formatting. Read them from there rather
  than writing the literal again.
- Store canonical entity IDs, not display labels, whenever possible.
- Worker-generated explanations, emails and share pages are written in English. A legacy
  `language: 'es'` stored on old records or sent by an old client is accepted and ignored.

## Manual Diagnostics

Historical and provider-specific probes live in `scripts/diagnostics/`. Run them from the
repository root, for example:

```bash
node scripts/diagnostics/test-openalex.js
```

These scripts may hit live APIs, depend on temporary provider behavior, or consume quota.
They are not acceptance tests.
