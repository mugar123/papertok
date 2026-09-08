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

## Measuring a page that only exists for a signed-in reader (2026-09-07)

Three of these probes can drive a page behind the session, and there are two
ways in. They are not interchangeable, and picking the wrong one costs a whole
audit.

**A demo build** (`IS_DEMO = true` in `src/services/firebase.js`, never
committed, put back to `false` before committing anything) seeds a fake session
from `localStorage`. It is cheap and it is the only way to open the search
palette. But it short-circuits Firestore and auth: the demo user resolves in a
`setTimeout(0)` (`AuthContext.jsx:60-75`), so nothing that depends on the session
ARRIVING ever happens. Measured 2026-09-07: a demo build hides both of the
defects the entity page's arrival actually has — the subtree remount when
`onAuthStateChanged` flips the key at `App.jsx:508`, and the navbar band’s
unanimated 56px appearing mid-settle — and its feed only ever hands out the fast
id-keyed author route, never the slow name-keyed one. Use it for skeletons and
for the palette; never to judge what a signed-in arrival does.

**A real profile** is `PROFILE_DIR=<dir>`, a Chrome `--user-data-dir` the user
has signed in to themselves. The probe reuses it as-is and NEVER deletes it:
each of the three guards its cleanup with `OWN_PROFILE = !process.env.PROFILE_DIR`
and terminates Chrome with SIGTERM rather than SIGKILL, because a kill only
reaches the parent and the renderers go on writing into that profile.

```bash
# The user opens this VISIBLE window and signs in. Never ask them for
# credentials and never write any into a script, a log or a URL.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 --user-data-dir="$HOME/.papertok-probe-profile" \
  --no-first-run --no-default-browser-check http://localhost:5174

# Then CLOSE it — Chrome locks a --user-data-dir while an instance is alive —
# and measure against it:
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5006398227' 9000
```

A signed-out feed links its authors to `/public/entity/…` rather than
`/explorer/…`, which doubles as a check that the session was inherited. And
`.pc-author-link[href*="?name="]` picks the fast id-keyed route while
`[href*="arxivId="]` picks the slow name-keyed one.

Measure the production build, not `vite dev` — see the note under `open` below.

## `author-door-census.mjs` — which door the feed hands out (2026-09-07)

A card links an author by OpenAlex id when it has one and by name plus
`?arxivId=` when it does not, and the second door costs three round trips before
the hero paints (`src/utils/explorerPaths.js`). This counts which one the real
feed actually gives, over a production build and a signed-in profile:

```bash
PROFILE_DIR="$HOME/.papertok-probe-profile" ORIGIN=http://localhost:5174 \
  node scripts/diagnostics/author-door-census.mjs 20000
SCROLL=8 PORT=9232 PROFILE_DIR=… ORIGIN=… node scripts/diagnostics/author-door-census.mjs 15000
```

It counts `.pc-author-link` by href AND reads the feed snapshot the app leaves in
`localStorage`, which holds the whole page rather than only the mounted cards —
so each paper's source, its OpenAlex enrichment and whether its authors carry an
id are read together. `openAlexKeys` prints what the enrichment blob really
brought back, which is how one tells "the id is here and is not propagated" from
"the id was never asked for". `SCROLL=<n>` pages the feed down first: the first
screenful is the freshest arXiv, not a sample of the feed. `OUT=<path>` dumps the
raw census. Measured 2026-09-07 (`docs/AUDITORIA-PUERTAS-AUTOR-2026-09-07.md`):
57% slow on the first page, 92% after eight. A demo build answers 0% — its feed
only ever hands out the fast door.

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

## `explorer-hero-frames.mjs` — the hero's arrivals, frame by frame (2026-09-05)

The `open` probe above samples the hero's box. This one samples what is INSIDE
it as well — the experience panel and its inner, the Wikipedia fold with its
computed transform, the settle's own `from`/`to`/`currentTime` — because the
two mechanisms of the 2026-09-05 audit (`docs/AUDITORIA-ANIMACIONES-EXPLORER-2026-09-05.md`)
were invisible from the box: a panel squeezed to 0px by flex under a settle,
and a settle re-animating from a height the box had already left.

```bash
node scripts/diagnostics/explorer-hero-frames.mjs route '#/explorer/author/A5068353058' 7000
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.pc-topic-link' late 7000
node scripts/diagnostics/explorer-hero-frames.mjs fromsearch author q=moher late 6000   # needs an IS_DEMO build
node scripts/diagnostics/explorer-hero-frames.mjs shotwhen '#/explorer/author/A5068353058' "(()=>{const p=document.querySelector('#ehc-experience-panel');return !!p&&p.getBoundingClientRect().height<110;})()" squeeze.png
node scripts/diagnostics/explorer-hero-frames.mjs fromfeed '.ee-author-card:not(.ex-skel-row)' demo late 'from=#/explorer/institution/I136199984' 'pre=.ee-tabs .ee-tab:nth-child(2)' 8000
```

`from=<hash>` starts the click somewhere other than the feed and `pre=<css>`
clicks something first, which together reach the third door into an author page:
an author card inside an institution's Authors tab, whose cards do not exist
until the tab is opened. `demo` seeds the demo session for the modes that do not
seed it themselves, and `PROFILE_DIR` (above) is the alternative for a real one.

`fromsearch` seeds a demo session in `localStorage` before the first script and
types with `Input.insertText` (cmdk ignores the native value setter). Build with
`IS_DEMO = true` in `src/services/firebase.js` for it, and put it back to `false`
before committing anything.

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

## `page-transition-frames.mjs` — a route transition, frame by frame (2026-09-06)

The before/after of `docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md`:
the feed's card giving way to an entity page, the way back, a tab to the next.
Every compositor frame of the second around ONE navigation as a JPEG plus a
contact sheet, and a `requestAnimationFrame` sampler installed in the page the
same tick the navigation fires, which notes per frame whether `.navbar` exists
and each route page's `data-page-motion`, opacity, transform and position.

```bash
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' author-desktop demo
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' author-mobile demo mobile
node scripts/diagnostics/page-transition-frames.mjs '.pc-topic-link' topic-desktop demo
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' back-desktop demo back
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' back-scrolled-desktop demo back scroll=600
node scripts/diagnostics/page-transition-frames.mjs '.pc-author-link' back-mobile demo mobile back
node scripts/diagnostics/page-transition-frames.mjs 'a[href="#/research"]' tab-desktop demo
```

The summary line reads `sampler: 71 frames; bar in 71/71; void 0 (-); overlap 14;
exposed 0 (-); settled at 236 ms; held cards ≥ 1.00`: frames the page produced
with the bar mounted, frames with no page at ≥ 0.5 opacity (the old
`mode="wait"` handover had two), frames with two route pages on screen, frames
with a held page still beside a page already at rest (`exposed`: the held page
is `position: fixed` and paints OVER the page that has just settled — eight of
them per tab switch before 2026-09-06's fix, the For you card at 60% over
Research), the first frame after which one page stands alone at rest, and the
lowest opacity seen on a held page's first card title (`held cards ≥ 1.00`
means the held feed never dipped — anything lower means a card replayed its
arrival under the entity page).
`back` clicks the selector first, waits `backat=<ms>` (2200 by default, when the
page it opened has settled) and records `history.back()` — a smaller `backat`
records the way back taken WHILE the page arriving is still moving, which is the
interruption case;
`scroll=<px>` with it scrolls the page it opened first, so the leaving page's
lift by its own scroll (`top` in the samples) is on record. `demo` needs
`IS_DEMO = true` flipped locally (never committed) and a server on a
Worker-allowed origin (5173/5174/5175; `ORIGIN=http://localhost:5175` to pick
another). `OUT=<dir>` keeps the frames, samples and sheets out of the tree;
`PORT=<n>` picks another CDP debugging port (default 9231, for parallel runs);
`CHROME=<path>` names another Chromium binary (default Google Chrome).

## `project-badge-frames.mjs` — the funding badge opening its space (2026-09-06)

```bash
node scripts/diagnostics/project-badge-frames.mjs after
node scripts/diagnostics/project-badge-frames.mjs mobile-run mobile
node scripts/diagnostics/project-badge-frames.mjs late delay=2000
```

Loads the guest feed on `localhost:5173` in a headless Chrome and answers the
first card's OpenAIRE lookup itself (`Fetch.fulfillRequest`) with a fake funded
project, so the badge always arrives and the run is deterministic. A
`requestAnimationFrame` sampler installed before the app's first script notes,
per frame, the slot's height, the badge's opacity and transform, and the
title's top — and prints the biggest single-frame move of the title, which is
what "the title drops" looks like in numbers. On 2026-09-06 the 200 ms expo-out
opening measured 10, 9.6 and 7.9 px in its first three frames; the 320 ms
`--ease-out-quad` opening that replaced it stays under 3.5 px per frame in
steady state. `delay=MS` holds the OpenAIRE answer so the badge can be made to
land while the title is still arriving or long after it.

## `firestore-stall-probe.mjs` — a listen stream that died under a live client (2026-09-06)

Behind "the feed / the lists / followers sometimes take forever and I have to
reload". The SDK routes every `getDoc`/`getDocs` over one WebChannel stream and
keeps it open for as long as anything listens (always, here: `following`). A
stream that dies silently — sleep, a network change, a proxy dropping the
connection — is not an error the SDK sees: reads issued against it had not
settled after 96 s, network back or not. `disableNetwork` + `enableNetwork`
rebuilds it in 6 ms, and `patientRead` now asks for that at `DEFAULT_STALL_MS`
(see `src/utils/streamRecovery.js`).

The probe reproduces the dead stream faithfully: it visits a public profile
(two SDK reads, no session needed), notes the stream's `SID`, then holds at the
network — never answers — every request carrying that `SID`, and navigates
in-app to a second profile. The network is fine; only that stream is dead. It
samples what the page shows, when it paints, and lists the Firestore requests,
so a rebuilt stream shows up as a new handshake with a new `SID`.

```bash
ORIGIN=https://papertok.app PORT=9225 node scripts/diagnostics/firestore-stall-probe.mjs hold=30   # the deployed build
ORIGIN=http://localhost:5173 PORT=9224 node scripts/diagnostics/firestore-stall-probe.mjs hold=30  # a dev server
```

Measured 2026-09-06: production, second profile **not painted after 30 s**, no
new stream. With the fix, painted at **4.1 s**: the held request at 3 s, the new
handshake at 3.8 s, the profile from the server right after. `HANDLE` and
`HANDLE2` pick the two profiles (default `mugar`, `nick_mugar`). The comments
sheet is not a usable surface for this as a guest: the thread anchor is
resolved at the Worker and a paper without comments never touches Firestore.
