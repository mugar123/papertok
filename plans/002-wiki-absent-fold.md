# 002 — Stop the fold yanking the page up when no explanation arrives

- **Status**: DONE (2026-09-04) — see README.md for what changed from this plan
- **Commit**: 040473d
- **Severity**: HIGH
- **Category**: 2 (Easing & duration) + 7 (Cohesion)
- **Estimated scope**: 2 files (1 source, 1 test), ~12 lines

## Problem

When the Wikipedia lookup misses, the reserved block folds away — and the whole
list below it is yanked up in the first three frames, then crawls the rest of
the distance.

Measured on the production build over CDP, sampling `.explorer-content`'s top
edge every animation frame. Four runs, two entity shapes, same signature:

| Run | Entity | Fold ran | Travel | Biggest single frame |
| --- | --- | --- | --- | --- |
| 1 | topic, no article | 4634 → 5001ms (367ms) | 162px | **31.9px** |
| 2 | institution, homepage but no extract | 5166 → ~5500ms | ~120px | **31.5px** |
| 3 | institution, same | 6567 → ~6900ms | ~120px | **31.5px** |
| 4 | institution, same | 784 → ~1120ms | ~120px | **31.5px** |

The distribution, from run 1 (each row is one frame, `move` is that frame's
travel in px):

```
t=4634  move  -9.4      first three frames carry 69.7px
t=4651  move -28.4      of the 162px total — 43%
t=4668  move -31.9   <- biggest single-frame move
t=4684  move -23.2
t=4701  move -16.5
 …
t=4967  move  -0.1      the last 100ms carries 1.5px
t=5001  move  -0.1
```

Two causes, both in one object:

```jsx
// src/components/Explorer/EntityExplorer.jsx:1858-1867 — current
exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: -HERO_STACK_GAP_PX, y: -6 }}
transition={prefersReducedMotion
  ? { duration: 0 }
  : {
    opacity: { duration: 0.3 },
    height: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
    marginTop: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
    y: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
    layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
  }}
```

1. **The exit rides the arrival curve.** `[0.16, 1, 0.3, 1]` is an expo-out: it
   is designed to cover most of its distance immediately and settle. On an
   *arrival* that is exactly right. On a *collapse* it means everything below the
   block leaps 32px in one frame and then inches the last 20px over 300ms. The
   repo's own rule is that things leave on a different curve — the rationale is
   written at `src/components/Layout/PageTransition.jsx:40` and
   `src/components/Comments/CommentsSheet.jsx:185` — and this exit never got it.

2. **Opacity finishes 120ms before the space does.** `opacity` runs 300ms while
   `height` and `marginTop` run 420ms, so for the final 120ms the block is
   already invisible and the list is still sliding up underneath nothing. The
   movement outlives the thing that was moving, which is what detaches it from
   its cause.

The fold itself is structurally correct and must be preserved: the wrapper
reaches a true zero height, and the last frames measure 0.1px with no jump at
unmount (run 1's final samples: `top` 300.2 → 300.1 → 300.0, then the element
is gone with `move: 0`). The 42px unmount jump that
`explorerLoading.test.js:112-117` records was genuinely fixed. **Only the curve
and the timing are wrong.**

### Context, not in scope

The reader waits a long time before the fold even starts: 5.1s, 6.5s and 0.78s
across the runs above. Wikipedia's `action=query&generator=search` endpoint —
built at `src/services/wikiService.js:75-89` — returns an intermittent 503
(`upstream connect error … reset reason: overflow`), verified directly; the same
query succeeds on retry. So "no explanation" is often a transient upstream
failure rather than a genuine absence. **That is a loading/retry question, not a
motion one, and this plan does not address it.** It is recorded in
`plans/README.md` as a separate concern.

## Target

The space closes on a curve that holds, moves, and settles — and everything
finishes together.

```jsx
/* target — src/components/Explorer/EntityExplorer.jsx:1858-1867 */
exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, marginTop: -HERO_STACK_GAP_PX, y: -6 }}
transition={prefersReducedMotion
  ? { duration: 0 }
  : {
    opacity: { duration: 0.3 },
    height: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
    marginTop: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
    y: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
    layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
    exit: {
      opacity: { duration: 0.2, ease: [0.4, 0, 1, 1] },
      height: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
      marginTop: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
      y: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
    },
  }}
```

Framer resolves a `transition.exit` sub-object for the exit only, leaving the
`initial`→`animate` arrival untouched. If the installed `framer-motion` version
does not honour a nested `exit` key, use the alternative in step 3 instead.

The values, and why each one:

- **`cubic-bezier(0.77, 0, 0.175, 1)` on `height` / `marginTop` / `y`.** This is
  the ease-in-out from the audit catalog, and it is a **deliberate departure from
  the house exit curve** `[0.4, 0, 1, 1]`. The house rule was reasoned about for
  a *page leaving the screen*, where ending at full velocity is free because the
  thing is gone. Here the thing that moves is the list below, which has to *land*
  — an ease-in ends at maximum speed and would slam it into place. An ease-in-out
  holds the list still while the block starts to go, spreads the travel, and
  brings it to rest. Record this reasoning in a comment (step 2).
- **`cubic-bezier(0.4, 0, 1, 1)` on `opacity`.** The block itself *is* leaving,
  so its own fade takes the house exit curve unchanged.
- **280ms, not 420ms.** The catalog budgets 150–250ms for a dropdown and
  200–500ms for a drawer; a hero block folding away sits between them. 280ms also
  puts the fade (200ms) and the space (280ms) close enough that the movement no
  longer outlives the thing that moved — an 80ms tail instead of 120ms, at the
  end where it reads as settling rather than as an unexplained slide.

Expected result: no single frame carrying more than ~14px, against 31.9px today.

## Repo conventions to follow

- **Curves are literal arrays in JSX**, hand-typed. `cubic-bezier(0.16, 1, 0.3, 1)`
  appears 85 times this way. Do not introduce an easing token.
- **Departures from a convention get a comment saying why.** This codebase argues
  for its motion in place — see the fifteen-line rationale at
  `src/components/Feed/PaperCard.css:1046-1060` defending an overshoot curve, or
  the header of `src/components/Layout/ThemeToggle.css`. A silent departure is
  the thing to avoid, not the departure.
- **Exemplar for an exit that is not the arrival reversed**:
  `src/components/Layout/PageTransition.jsx:29-44` — the `EASE_LEAVING` constant
  and the comment above it, which is the same argument this plan is making one
  level down.
- Motion values that a test asserts are updated in the test in the same change.

## Steps

1. Open `src/components/Explorer/EntityExplorer.jsx`. The object to edit is the
   `transition` prop of `<motion.div layout className="ehc-wiki-fold">`, at lines
   **1859-1867**. Leave `initial`, `animate` and `exit` untouched.

2. Add the `exit` sub-object exactly as in Target, and put this comment directly
   above it:

   ```jsx
   // Leaving is not arriving reversed, and it is not the house exit either.
   // Measured before this: the fold ran the arrival's expo-out, so the list
   // below leapt 31.9px in one frame and then crawled the last 20px over
   // 300ms. The house exit curve ([0.4, 0, 1, 1], PageTransition.jsx) would
   // back-load it instead and end at full speed — right for a page that is
   // gone by then, wrong for a list that has to land. An ease-in-out holds
   // the list still, spreads the travel and brings it to rest; the block's
   // own fade keeps the house exit curve, because the block really is leaving.
   ```

3. **If the installed `framer-motion` ignores `transition.exit`** (verify with the
   feel check below — the biggest single-frame move will still be ~32px), replace
   the whole `transition` prop with a ternary on Framer's `isPresent`, or simplest,
   hoist two constants above the component and select between them:

   ```jsx
   const WIKI_FOLD_IN = {
     opacity: { duration: 0.3 },
     height: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
     marginTop: { duration: 0.42, ease: [0.16, 1, 0.3, 1] },
     y: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
     layout: { duration: 0.38, ease: [0.16, 1, 0.3, 1] },
   };
   const WIKI_FOLD_OUT = {
     opacity: { duration: 0.2, ease: [0.4, 0, 1, 1] },
     height: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
     marginTop: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
     y: { duration: 0.28, ease: [0.77, 0, 0.175, 1] },
   };
   ```
   and pass `transition={prefersReducedMotion ? { duration: 0 } : WIKI_FOLD_IN}`
   with `exit={{ …existingExitObject, transition: WIKI_FOLD_OUT }}`. Framer reads a
   `transition` inside a variant object in every version that ships this API.
   **If you take this branch, the test edit in step 4 changes shape too** — the
   assertion at `explorerLoading.test.js:125` matches the `exit` prop literally
   and would now see the added `transition` key. Update the regex to match what
   you actually wrote.

4. Update `src/components/Explorer/explorerLoading.test.js`. Line **126**
   currently asserts the arrival's marginTop timing and still passes unchanged:

   ```js
   assert.match(fold[0], /marginTop: \{ duration: 0\.42, ease: \[0\.16, 1, 0\.3, 1\] \}/);
   ```

   Keep it, and add one assertion beneath it that pins the new exit timing, so a
   future edit cannot silently put the arrival curve back on the collapse:

   ```js
   // The collapse is not the arrival reversed: the list below has to land.
   assert.match(fold[0], /exit: \{[\s\S]*?height: \{ duration: 0\.28, ease: \[0\.77, 0, 0\.175, 1\] \}/);
   assert.doesNotMatch(
     fold[0].slice(fold[0].indexOf('exit: {')),
     /ease: \[0\.16, 1, 0\.3, 1\]/,
     'the collapse must not ride the arrival curve',
   );
   ```
   Adjust both regexes to the shape you actually wrote in step 2 or 3.

5. Run the checks in Verification.

## Boundaries

- Do **NOT** change `initial`, `animate`, or the `exit` *values*
  (`opacity: 0, height: 0, marginTop: -HERO_STACK_GAP_PX, y: -6`). Those are
  asserted literally at `explorerLoading.test.js:123-125` and they are correct —
  the negative `marginTop` is what carries the 16px stack gap out with the block,
  and removing it re-introduces the 42px unmount jump the test was written for.
- Do **NOT** change `HERO_STACK_GAP_PX` (`EntityExplorer.jsx:57`) or
  `.ehc-wiki-fold { overflow: hidden }` (`EntityExplorer.css:599-601`). Both are
  load-bearing and both are asserted.
- Do **NOT** touch the skeleton/prose swap inside the block — that is plan **001**,
  and it edits lines 1873-1900 of the same file. The two plans do not overlap, but
  only if this one stays inside the `transition` prop.
- Do **NOT** attempt to fix the Wikipedia 503 / retry behaviour. Out of scope.
- Do **NOT** add a dependency.
- If lines 1858-1867 do not match the excerpt above (drift since `040473d`),
  **STOP and report**.

## Verification

- **Mechanical**:
  - `npm run lint` — no new findings.
  - `node --test src/components/Explorer/explorerLoading.test.js` — all pass,
    including the assertion you added.
  - `npm run build` — clean.

- **Feel check** — the measurement is reproducible, and this is the one that
  decides whether the change worked. Build and serve:
  ```bash
  npm run build && npx vite preview --port 5173 --strictPort
  ```
  Then run the repo's own probe against a topic whose lookup misses:
  ```bash
  node scripts/diagnostics/explorer-loading-probe.mjs wikiexit '#/explorer/topic/query-ec129ead?q=gravitational+lensing+of+quasars&source=free-text'
  ```
  Read `biggestSingleFrameMove.move` in its JSON output.
  - **Before this change it is −31.9px.** After it, expect **no worse than −16px**,
    and ideally ~−12px.
  - The `moves` array should show the travel spread across the run rather than
    concentrated in the first three frames.
  - The final samples must still converge to 0.1px per frame with no jump on the
    frame the block unmounts (`wiki: null`). If a jump reappears, you have changed
    something in the Boundaries list.
- By eye, at 10% playback speed in DevTools → Animations: the list below should
  stay still for a beat, close the gap, and stop — not start by jumping.
- In DevTools → Rendering, enable "Emulate CSS prefers-reduced-motion: reduce"
  and confirm the block still disappears instantly with no movement.

- **Done when**: `biggestSingleFrameMove.move` is ≤ 16px in absolute value on the
  `wikiexit` probe, the fold still ends without a jump, and
  `explorerLoading.test.js` passes with the added assertion.
