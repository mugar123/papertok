# Manual Diagnostics

This directory contains one-off and historical probes for arXiv, OpenAlex, Elsevier, proxies,
OpenAIRE, Crossref, and related providers.

They are kept for debugging reference but are not part of `npm test` or ESLint. Many call live
services and can consume API quota.

**The public CORS proxies are dead, and the probes that use them can only fail.** Measured on
2026-08-22: `corsproxy.io` answers `Server-side requests are not allowed on your plan`, and
`api.allorigins.win` returns a 520. `test-fetch.js`, `testFetch.js`, `test-allorigins.mjs`,
`test-arxiv.mjs`, `test-rss.js`, `test-rss-seq.js` and `test-long3.js` all probe one of those or
`rss2json`, so a red result from them says nothing about the service they appear to be testing.
They are left in place as the record of what the app used to route through, and why it stopped:
arXiv and OpenAlex now reach the browser through the Worker's own routes instead.

Never put provider credentials in these scripts, URLs, logs, or public CORS proxies. Protected
provider probes must go through the PaperTok Worker and read secrets from Cloudflare bindings.

Run scripts from the repository root:

```bash
node scripts/diagnostics/test-openalex.js
```

When a diagnostic becomes a stable regression check, replace its live request with a fixture
and move the behavior into a colocated `*.test.js` file under `src/` or `worker/`.

## `explorer-loading-probe.mjs` — how an entity page waits (2026-09-03)

Drives a headless Chrome over CDP (no dependencies; Node ≥ 22 for the global
`WebSocket`) against the dev server on `localhost:5173`, with a fresh profile per
run so every load is cold. Three modes:

```bash
node scripts/diagnostics/explorer-loading-probe.mjs timeline '#/explorer/author/A5006398227' 14
node scripts/diagnostics/explorer-loading-probe.mjs tabs '#/explorer/institution/I173304897'
node scripts/diagnostics/explorer-loading-probe.mjs paint '#/explorer/author/A5006398227' new
node scripts/diagnostics/explorer-loading-probe.mjs paint '#/explorer/author/A5006398227' old
```

`timeline` records every change of the page's loading state (skeleton, live
hero, rows, ORCID card, Wikipedia block, impact score, empty state) from a
MutationObserver installed before the app's first script runs. `tabs` opens
Authors, comes back to Papers and checks the rows are still there without a
second request. `paint` holds the profile request so the skeleton stays up,
then traces three seconds of it and counts `Paint`, `RasterTask`, `GPUTask` and
style recalculation; `old` restores the previous `background-position` shimmer
by injecting a stylesheet, for a before/after on the same page. `PORT=9225`
picks another debugging port so runs can go in parallel.

Two more, added the same day:

```bash
node scripts/diagnostics/explorer-loading-probe.mjs wikiexit '#/explorer/topic/query-ec129ead?q=gravitational+lensing+of+quasars&source=free-text'
node scripts/diagnostics/explorer-loading-probe.mjs comments '#/'
```

`wikiexit` opens a topic whose Wikipedia lookup misses and samples the list's
top edge every frame while the reserved block folds away, reporting the biggest
single-frame move — a fold that ends in a jump shows up as one frame carrying
tens of pixels. `comments` opens the first card's thread in the guest feed and
samples the skeleton's and the empty state's computed opacity every frame
through the handover.

```bash
node scripts/diagnostics/explorer-loading-probe.mjs feedload '#/'
```

`feedload` opens the guest feed from cold with every cross-origin source
request held for 3.5 s — the guest feed answers in half a second, under the
1.5 s the atom waits before showing — then releases them and samples the atom
veil (presence, opacity, the atom's transform) against the first card's sheet
and title every frame through the handover.

```bash
node scripts/diagnostics/explorer-loading-probe.mjs consent '#/'
```

`consent` waits for the analytics banner in the guest feed, presses "Allow
analytics" and samples the button's three faces, the check's transform, the
button's width, the banner's opacity and the mark's colour every frame until
the banner has left.

## `open` and `swipe`: an entity opened from a card, and the feed under a finger (2026-09-04)

```bash
export CHROME="$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
node scripts/diagnostics/explorer-loading-probe.mjs open '#/' mobile,late
node scripts/diagnostics/explorer-loading-probe.mjs open '#/' mobile,late,viamodal
node scripts/diagnostics/explorer-loading-probe.mjs open '#/' mobile,late,slow,profile
node scripts/diagnostics/explorer-loading-probe.mjs open '#/' 'mobile,late,sel=.pc-topics button'
node scripts/diagnostics/explorer-loading-probe.mjs swipe '#/' mobile,slow,n=4
```

`open` loads the guest feed, taps an author — the first name link, or `sel=<css>`
for a topic tag or a project badge, or with `viamodal` the phone's path: the
authors row, the sheet, an author in it — and samples every frame of the
handover: both pages under `#main-content` (opacity, transform, direction), the
fallback, the skeleton and the live hero, the hero's box, the first row, the tab
strip, the authors sheet, dropped frames and long tasks; then the hero's blocks
on the first skeleton frame and the first live frame, `history.back()` sampled
the same way, the OpenAlex cache blob's size, and whether the page reloaded
itself. `mobile` is 390×844 at 2× with touch, `slow` a CPU at a quarter speed,
`late` waits out the 2.5 s chunk prefetch so the explorer's chunk is warm,
`hold` keeps the entity's own requests back 2.5 s so the skeleton lasts,
`nosweep` switches the skeleton's sweep off, `wait=<ms>` samples the opening
for longer than the default 3 s (a works page under a throttled CPU arrives
later than that), and `profile` records a CPU profile of each run and sums it
by function and by script — read it against a build made with
`--minify false`, which keeps the names. The sampler itself costs a few
milliseconds a frame under `slow` (it reads computed styles and boxes every
frame), so a run's long tasks carry some of its weight; compare runs against
each other, not against zero. `swipe` scrolls the
feed card by card with a touch gesture and reports, per swipe, the frames,
the settle time, dropped frames and long tasks.

Measure the production build, not `vite dev`: React's development mode adds
tasks of 90–135 ms that the build does not have. Build with
`VITE_PAPER_API_BASE_URL=https://api.papertok.app` (the Worker's allowlist
includes `http://localhost:5173`) and serve it on that port with
`vite preview --port 5173`. `CHROME` names the Chromium to drive when Google
Chrome is not installed; whole-document navigations are logged, and a
`[vite:preloadError]` line means the page reloaded itself mid-run — check
`node_modules` was installed with `npm ci`.

```bash
node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,slow=4,follows=many,at=2500,cycles=2
node scripts/diagnostics/explorer-loading-probe.mjs tap '#/' demo,mobile,mouse
```

`tap` (2026-09-05) presses the tab bar with `Input.dispatchTouchEvent` — the
gesture recogniser, hit-testing and click synthesis run as on a phone, which
`tabswitch`'s `element.click()` skips — For you → Following → For you,
`cycles` times, and logs every touch/pointer/mouse/click event that reaches the
document, `pushState`, and the pages per frame. `follows=many` seeds fourteen
follows so Following has cards and a chain still landing; `at=<ms>` taps For
you that soon after entering Following; `until=<cards>` waits for that many
cards first; `slow=<rate>` throttles the CPU; `mouse` is the desktop control;
`late` waits out the 2.5 s chunk prefetch so the Following chunk is warm.
Exit code 1 when a tap leaves the hash unchanged or the outgoing page has not
started to leave 400 ms after touchend. Needs `IS_DEMO = true` flipped locally
(never committed) and a server on a Worker-allowed origin (5173/5174/5175).

`safari-tabs-probe.mjs` runs the same sequence in desktop Safari through
`safaridriver` (WebKit, mouse clicks): enable Safari → Settings → Advanced →
"Allow remote automation" once, then `ORIGIN=http://localhost:5174 node
scripts/diagnostics/safari-tabs-probe.mjs`. It seeds the demo session through
`localStorage` on a first load and reads the same event log.
