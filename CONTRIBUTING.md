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

This runs the secret scan, ESLint, TypeScript checks, Node tests, Vite build and
Worker dry-run. Run `npm run test:rules` separately with Java and firebase-tools
as described in [`tests/README.md`](tests/README.md).

The check also runs on Windows, in PowerShell or cmd. `.gitattributes` checks text files out
with LF, which some source tests expect. A working tree checked out before that file existed
keeps its CRLF files, and so can one that later checks out an older branch; each worktree has
its own. If `git ls-files --eol` lists any `w/crlf` file, refresh the working tree you are in.
`git reset --hard` discards uncommitted changes, so commit or stash them first:

```bash
git rm -r --cached -q .
git reset --hard
```

Also verify the affected workflow manually when the change involves navigation, animations,
loading states, authentication, or responsive layout.

### TypeScript migration

`npm run typecheck` generates Worker declarations from `wrangler.toml`, then runs
`tsc --noEmit` for each environment. Vite and Wrangler still compile the application.
Generated Worker declarations live in the ignored `worker-configuration.d.ts` file;
regenerate them with `npm run worker:types` after changing Worker bindings.

| Configuration | Files and runtime types |
| --- | --- |
| `tsconfig.json` | Frontend sources; DOM, React and Vite |
| `worker/tsconfig.json` | Worker sources; Wrangler-generated bindings and runtime |
| `worker/tsconfig.test.json` | Worker tests and frontend tests that import Worker modules; Node 22 plus Wrangler runtime types |
| `tsconfig.node.json` | Remaining colocated tests, `tests/`, maintained scripts and root tool configs; Node 22 |
| `proxy/tsconfig.json` | Proxy sources; Deno and Web Worker web APIs |

Each environment uses `strict: true`. During the incremental migration, `allowJs`
and `checkJs: false` let existing JavaScript participate in module resolution without
requiring annotations. TypeScript files are checked immediately. Manual provider
probes in `scripts/diagnostics/` remain outside the automated checks.

Use Node 22.18 or later for native `.ts` test execution. CI selects Node 22;
Node 22.23.3 was verified to run `.ts` tests without a stripping flag. `npm test`
discovers both `.test.js` and `.test.ts` under `src/`, `worker/` and `proxy/`.
Use explicit relative extensions such as `./helper.ts` and `import type` for types.
`erasableSyntaxOnly` rejects enums, value namespaces and parameter properties.
Node does not execute `.tsx`; tests must import modules without JSX or inspect
component source as text. Update source-reading paths and extension filters with
every rename, and verify those assertions with a failing control mutation.

The shared paper contract and its parts live in `src/models/Paper.ts`. Import
`Paper` with `import type`; use `Partial<Paper>` for enrichment metadata instead
of a separate provider or component paper type. `PaperBuilder` references that
contract through JSDoc while its JavaScript implementation awaits phase 3.
Missing metadata stays optional. In particular, a zero citation count with
`citationCountKnown: false` is unknown; only a known zero is a confirmed count.
The legacy adapter can pass through a partial stored record without normalizing
it, so its return type does not promise a complete `Paper` for that input.

The paper model and all Worker modules now use TypeScript. Worker tests use
`.test.ts`; the frontend, proxy and rules tests remain JavaScript until their phases.
`worker/env.ts` derives optional local bindings from generated `Env` and adds the
secrets read by the Worker. It does not replace Wrangler's binding declarations.
Worker production types exclude Node; only the Worker test configuration combines
Node with Cloudflare APIs for the in-process test doubles.
Tailwind's `@source` in `src/styles/global.css` still scans `.js` and `.jsx`;
add `.ts` and `.tsx` and compare production CSS when components are first renamed.

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

