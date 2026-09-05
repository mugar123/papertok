# Animation plans

Written by the `improve-animations` advisor pass on **2026-09-04**, against
commit `040473d`.

Every plan is self-contained: exact file paths, the current code verbatim, the
target values, the repo conventions to imitate, hard boundaries, and a
verification section including how to *feel-check* the result. An executor needs
nothing from the conversation that produced them.

**These plans do not touch source code. Nothing here has been applied.**

## The plans

| # | Title | Severity | Category | Files | Status |
| --- | --- | --- | --- | --- | --- |
| [001](001-wiki-explanation-reveal.md) | Cross-fade the Wikipedia explanation over the shapes it replaces | MEDIUM | Cohesion | 1 source | **DONE** |
| [002](002-wiki-absent-fold.md) | Stop the fold yanking the page up when no explanation arrives | HIGH | Easing & duration | 1 source, 1 test | **DONE** (values differ, see below) |
| [003](003-lateral-feed-switch.md) | Make the navbar tabs switch sideways instead of descending | HIGH | Purpose, duration, spatial consistency | 3 source, 2 test | **DONE** (scope grew, see below) |
| [004](004-institution-portrait-crossfade.md) | Make the institution's portrait cross-fade without dimming | LOW | Cohesion | 1 source | **DONE** |
| [005](005-explorer-what-the-skeleton-promises.md) | The Explorer's skeleton promises things that never arrive | HIGH | Missed opportunities | 3-4 source | **PARTLY DONE** (rows, project summary, query topic) |

## What was actually implemented, 2026-09-04

All four applied on top of `040473d`. `npm run lint` clean, `npm test` 2036
passing, `npm run build` clean. Every number below is a re-measurement against
the production build, not an estimate.

| | Before | After |
| --- | --- | --- |
| Fold's worst single frame (002) | −31.9px | **−15.5px** |
| Portrait cross-fade, worst opacity sum (004) | 0.912 | **1.000** |
| Portrait tail, tile gone before photo opaque (004) | 66ms | **0ms** |
| Prose reveal, frames between 0 and 1 opacity (001) | 0 | **11** |
| Prose first painted frame (001) | opacity 1 | **opacity 0** |
| Tab switch handover, settled (003) | ~550ms | **~390ms** |
| Tab switch direction, there and back (003) | 1 and 1 | **1 and −1** |

### 002 — the plan's values were wrong, and the first attempt made it worse

The plan specified `cubic-bezier(0.77, 0, 0.175, 1)` at 280ms. Measured, that
gave **−39.7px** — worse than the −31.9px it replaced. The curve's *shape* was
right (it holds, moves, settles) but the catalog's ease-in-out has a very steep
middle, and shortening 420ms → 280ms left too few frames to spend the peak over.
A 160px collapse is bounded by arithmetic, not taste: peak per frame is travel ×
curve steepness ÷ frames.

What shipped instead: `cubic-bezier(0.4, 0, 0.2, 1)` (already used 5× in this
repo) at **480ms**, with the fade at 400ms so it lands 80ms before the space
closes — the shortest such tail of any version measured, against 120ms in the
original. 480ms is the top of the catalog's drawer budget, which is the right
bracket for a block this tall: 60ms slower than before for half the jolt.

Note for anyone re-running `explorer-loading-probe.mjs wikiexit`: its headline
`biggestSingleFrameMove` may now report a **positive** value from the first
frames. That is the hero settling as content arrives, not the fold. Compare the
negative run.

### 003 — the scope grew by one file, for a reason the plan could not have known

The plan named `tabDirection.js`, `PageTransition.jsx` and their tests. Two
things forced more:

1. **`PageTransition.jsx` may not export a function.** `react-refresh/only-export-components`
   fails the build's lint. The hook moved to `src/hooks/usePageTransitionCustom.js`.
2. **The page on its way out could not be told.** `AnimatePresence` keeps the
   previous element mounted rather than re-rendering it, so the outgoing
   `PageTransition` resolved its exit against the `custom` it mounted with —
   the first tab switch after arriving at the bar kept the 200ms hierarchy exit
   while the incoming page correctly used the lateral one.

   Fixing that by having the component call the hook itself made it worse in a
   way that only a frame-by-frame trace caught: `Routes` carrying its own
   `location` prop gives its subtree a location context of its own, so the
   outgoing page asked about the tab it was **leaving**, got `-1`, and dragged
   the shared module memory backwards — corrupting `data-nav-direction` for
   every later navigation in the session.

   Shipped: `App` computes it **once**, hands it to `AnimatePresence` as
   `custom` (framer's supported route to an exiting child) and to every
   `PageTransition` through a context. `PageTransition` reads, never computes.
   A test pins that there is exactly one caller.

**One consequence worth knowing about, not asked for:** because a leftward tab
move now reports direction `-1`, `PaperCard.css`'s existing
`[data-nav-direction="-1"]` rule applies — so going Following → For you, the
cards no longer replay their arrival. Moving right, they still do. That is a
defensible reading of a bar (later tabs are "further along") and it is what
makes the return feel instant, but it is asymmetric and was not in the plan. It
is one CSS selector to change if you would rather both directions composed.

## Recommended order (used)

**002 → 001 → 004 → 003**, as written below. It held up: 002's probe caught
the bad first attempt immediately, and leaving 003 for last kept the one change
that could regress navigation away from the others.

- **002 first.** It is the only one backed by a repeatable probe already in the
  repo (`explorer-loading-probe.mjs wikiexit`), so it is the cheapest to prove,
  and it is the worst thing measured: a 31.9px single-frame jolt of the whole
  page.
- **001 second**, because it lands in the same block and reads better once the
  collapse is fixed — you will be looking at that hero either way.
- **004 third.** Six lines, one file, no test changes. Do it while the Explorer
  is still in your head.
- **003 last.** It is the largest (a new util, a new test file, and a change to
  the transition every route in the app uses) and it is the only one that can
  regress navigation, so it deserves its own pass rather than being bundled.

## Dependencies and collisions

- **001 and 002 edit the same JSX element's neighbourhood** in
  `src/components/Explorer/EntityExplorer.jsx`:
  - 002 edits the `transition` prop of `<motion.div layout className="ehc-wiki-fold">` (lines 1859-1867).
  - 001 edits the skeleton/prose ternary *inside* it (lines 1873-1900).

  They do not overlap **provided each stays inside its stated boundaries**. If
  you run them in one session, do 002 first and re-read the file before starting
  001, because the line numbers in 001 will have shifted.
- **004 is independent** of both, though it is in the same file (lines 1385-1404).
- **003 shares no file with the others.**
- 002 and 003 each require a test edit; 001 and 004 must leave the test suite
  untouched. If a test fails on 001 or 004, that is the signal you crossed a
  boundary.

## How these were measured

The numbers in 001-004 are not estimates. They come from CDP probes driven
against the **production build** (`npm run build` + `vite preview --port 5173`),
sampling computed styles and bounding boxes every animation frame. React's
development mode adds 90-135ms tasks that make `vite dev` numbers meaningless —
`scripts/diagnostics/README.md` records this.

- 002 used the repo's own `explorer-loading-probe.mjs wikiexit`, four runs across
  two entity shapes.
- 001, 003 and 004 used one-off probes built on the same plumbing. They live in
  the session scratchpad, not in the repo. If the work is picked up later and the
  probes are gone, the plans' verification sections say what to measure and what
  the before-numbers were, which is enough to rebuild them.
- 003's measurement needs a signed-in Chrome profile, because every navbar tab is
  behind `ProtectedRoute`. `explorer-loading-probe.mjs` already supports
  `PROFILE_DIR=<profile>` for exactly this.

## Out of scope, but found while measuring

Neither is a motion problem; both surfaced from the same runs and are recorded
here so they are not lost.

1. **Wikipedia's search endpoint fails intermittently.**
   `src/services/wikiService.js:75-89` builds an
   `action=query&generator=search` request. Verified directly: it returned
   `503 upstream connect error … reset reason: overflow`, and the identical query
   succeeded on retry moments later. Across four probe runs the explanation
   failed to arrive three times. So "no explanation" is frequently a transient
   upstream failure being rendered as a permanent absence — there is no retry.
   Plan 002 makes that failure *look* better; it does not make it rarer.

2. **The reader waits a long time before the block resolves.** 5.1s, 6.5s and
   0.78s to first paint of the fold across runs. The shapes are honest about
   waiting, but five seconds is a long time to promise a paragraph that then
   never comes.

## Audit backlog (not yet planned)

A four-way parallel audit ran against the same commit and returned findings well
beyond the four the user selected. The items below were **re-verified by hand at
their exact lines**; the rest of the audit is not recorded here because it was
not independently confirmed.

| Location | Finding |
| --- | --- |
| `src/components/Feed/PaperCard.css:23` | `.pc { transition: opacity 0.9s ease; }` — 900ms, three times the UI budget, on the most-mounted element in the app. It is vestigial: `pc--visible` is applied at `PaperCard.jsx:1035` but **no rule anywhere defines it**, and nothing else changes `.pc`'s opacity. The fix is deletion. |
| `src/components/Lists/ListsPage.css:1047` and `src/components/Explorer/EntityExplorer.css:1262` | `@keyframes staggerFadeUp` is defined **twice with different values** (`opacity 0 → 1, translateY(8px)` vs `opacity 0.35 → 1, translateY(6px)`). `@keyframes` is a global namespace and both files ship in lazy chunks, so whichever route is visited first wins for both components. Non-deterministic across sessions. |
| `src/components/ui/button-variants.js:5` | The shared `Button` has **zero** `active:` styles across the base string and all variants — only `transition-colors`. The feed's two primary reading CTAs (`PaperCard.jsx:1572`, `:1578`) are this component, so on touch the app's highest-frequency control acknowledges a press with nothing. |
| `src/components/Settings/EditInterestsModal.css` | The only component stylesheet with animations and **no** `prefers-reduced-motion` block at all (0 matches), and its JSX imports no `useReducedMotion` either. It opens with `translateY(20px) scale(0.98)` and closes with a slide-down. |
| `src/styles/variables.css:507, 512, 517, 522, 537, 542, 555` | Seven global `@keyframes` with zero consumers — `slideDown`, `slideInFromBottom`, `slideOutToBottom`, `scaleIn`, `bounce`, `heartBeat`, `ripple`. Verified by grepping every `animation:` / `animation-name:` in CSS and JSX. `ripple` also starts at `scale(0)`. |

One correction worth recording, because two comments and a test assert the
opposite: **the global `button { transition: all }` no longer exists.**
`src/styles/global.css:156-162` declares an explicit six-property list. The
rationale at `src/components/Profile/ProfilePage.css:64` and the comment in
`src/components/Profile/profileStyles.test.js:255-257` are stale, though the
assertion they wrap is still worth keeping.
