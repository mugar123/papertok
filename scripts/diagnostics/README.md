# Manual diagnostics

These scripts inspect provider coverage, browser rendering and local request
behavior. They are excluded from `npm test` and ESLint. Provider probes can
consume quota; use existing deterministic tests for regression checks.

Run them from the repository root with Node 22.18 or later. Read each script's
header and arguments before running it. Write captures and reports outside the
checkout. Do not record credentials or authenticated responses.

| Script | Purpose |
| --- | --- |
| `search-coverage-check.mjs` | Compares OpenAlex and arXiv search results through the Worker; `--no-before` skips the retired-filter comparison. |
| `alma-resolver-census.mjs` | Discovers and verifies Alma resolvers and generates `worker/institution-resolvers.ts`; its census and seed JSON files are inputs. `--dry` probes without writing. |
| `author-door-census.mjs` | Counts author links and metadata in a loaded feed. |
| `explorer-loading-probe.mjs` | Samples Explorer loading states and browser paint work; modes are listed in the script. |
| `explorer-hero-frames.mjs` | Captures frames and geometry around an Explorer arrival or interaction. |
| `explorer-glitch-frames.mjs` | Records Explorer route or chained navigation frames and layout geometry. |
| `page-transition-frames.mjs` | Records compositor frames and page geometry around a selected navigation. |
| `route-transition-timing.mjs` | Times repeated navigation from a selected topic link. |
| `route-transition-profile.mjs` | Collects a browser performance profile for route transitions. |
| `feed-figure-entrance.mjs` | Captures feed figure geometry and arrival frames. |
| `offline-routes-probe.mjs` | Starts Vite preview from `dist/`, installs the service worker, stops the server, then checks offline app routes and static pages. |
| `firestore-probe-plugin.mjs` | Vite diagnostic plugin for inspecting local Firestore requests. |

Browser probes use Chrome over CDP. `CHROME`, `ORIGIN`, `PORT` and `PROFILE_DIR`
are supported only where the script declares them. Use current path routes such
as `/explorer/author/A5006398227`; older probe headers may still show hash routes
or selectors that need checking against the current interface.

For signed-in checks, use the Firebase emulators described in
[`worker/README.md`](../../worker/README.md#local-testing), with a disposable
browser profile. The retired demo build is no longer supported. Do not change
application defaults or use a production account to make a probe run. These
manual tools require inspection before use and do not establish current behavior
merely by remaining in the repository.

For an offline check, build first and then run:

```bash
npm run build
node scripts/diagnostics/offline-routes-probe.mjs http://localhost:4175
```

The script stops its preview server because browser network emulation alone does
not disconnect the service worker's separate target.
