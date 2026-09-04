# 003 — Make the navbar tabs switch sideways instead of descending

- **Status**: DONE (2026-09-04) — see README.md for what changed from this plan
- **Commit**: 040473d
- **Severity**: HIGH
- **Category**: 1 (Purpose & frequency) + 2 (Duration) + 8 (Spatial consistency)
- **Estimated scope**: 3 source files + 2 test files, ~70 lines

## Problem

Switching between "For you" and "Following" is a route change dressed as a
descent into a hierarchy, and it takes over half a second.

Measured on the production build over CDP, sampling every page wrapper under
`#main-content` every animation frame, signed in, both directions:

```
──────── For you  →  Following ────────
  outgoing page fully gone  250ms
  incoming page appears     283ms
  ► DEAD AIR (nothing up)   33ms
  frames with BOTH pages    0
  incoming at full opacity  ~549ms
  data-nav-direction seen   0, 1
  translateX range          -10.28px … 18px

──────── Following  →  For you ────────
  outgoing page fully gone  211ms
  incoming page appears     246ms
  ► DEAD AIR (nothing up)   35ms
  frames with BOTH pages    0
  card title at opacity 1   570ms
  data-nav-direction seen   1          <- note: 1 again, going the other way
  translateX range          -10.19px … 18px
```

### 1. Both directions slide the same way — the bar has no sides

`data-nav-direction` is `1` going to Following **and** `1` coming back. The
incoming page always enters from `+18px` (the right) and the outgoing always
leaves toward `-10.8px` (the left), whichever tab you pressed. Going and
returning are the same animation.

The cause is that direction is derived from the history index, and every tab
press is a push, so the index only ever grows:

```js
// src/utils/routeDirection.js:59-68 — current
export function directionForHistoryIndex(historyIndex, memory = historyDirectionMemory, navigationType = null) {
  if (typeof historyIndex !== 'number') return directionForNavigationType(navigationType);
  if (memory.index === historyIndex) return memory.direction;
  const direction = typeof memory.index === 'number'
    ? Math.sign(historyIndex - memory.index)
    : 0;
  memory.index = historyIndex;
  memory.direction = direction;
  return direction;
}
```

This is correct for the hierarchy it was written for — a card opens an author,
the back arrow returns — and `PageTransition.jsx:45-53` explains exactly why the
sign matters there. It is wrong for the tab bar, because **For you, Research and
Following are siblings**. Neither is inside the other. Sliding one "deeper" than
the next asserts a nesting that does not exist, and returning to a tab you were
just on reads as arriving somewhere new.

The bar itself already knows better: `src/utils/navRule.js` slides the 1px
underline laterally between tabs (`Navbar.css:227-243`, 280ms). The indicator
moves sideways while the page it indicates moves forward.

### 2. Half a second, strictly sequential, for two tabs of one bar

`AnimatePresence mode="wait"` (`src/App.jsx:197`) means the outgoing page must
finish before the incoming one starts — confirmed by **0 frames with both pages**
in both directions. With `ENTER_MS = 0.3` and `EXIT_MS = 0.2`
(`PageTransition.jsx:25-26`) the handover is 200ms + 300ms plus the presence
round-trip, measured end to end at **~530–570ms**, with 33–35ms of blank screen
in the middle.

That is a reasonable budget for descending into an entity. It is a long time to
change tabs. The catalog's own frequency table puts navbar tabs in the 100+/day
band, where the instruction is to reduce rather than decorate.

### 3. What is NOT wrong — do not "fix" these

- **The card arrival is not the problem.** `pcArrive` runs concurrently with the
  page entrance, not after it: the first card's title goes from `0.291` at 246ms
  to `1` at 570ms, i.e. it settles 20ms after the page does. Leave
  `PaperCard.css:241-296` alone.
- **The dead air is already small.** 33–35ms, not the 184ms the comment at
  `PageTransition.jsx:33-40` records — that regression was genuinely fixed by the
  `EASE_LEAVING` change. Shortening the phases (step 4) shrinks it further for
  free; no separate work is needed.
- **No Suspense fallback appears** (`Suspense fallback shown: no`) — the chunk
  prefetch at `App.jsx:155` is doing its job. Do not touch it.

## Target

A tab switch is lateral, and its direction comes from the tabs' order in the bar.

**Bar order** (the order they are rendered in `Navbar.jsx:147-176`):

```
index 0  /            For you
index 1  /research    Research
index 2  /following   Following
```

Moving right in the bar (For you → Following) should send the outgoing page
left and bring the incoming one in from the right. Moving left should reverse
both. That is `direction = Math.sign(nextTabIndex - previousTabIndex)` — the
same sign convention the existing code already uses, just measured along the bar
instead of along history.

**New module** `src/utils/tabDirection.js`:

```js
/**
 * Which way the navbar's tabs sit relative to each other.
 *
 * The three tabs are siblings: none is inside another, so a switch between them
 * is a step sideways, not a descent. History cannot tell us which way — every
 * tab press is a push, so `directionForHistoryIndex` returns 1 both going to
 * Following and coming back from it, and the page slid the same way whichever
 * tab you pressed. The bar's own order is the only thing that knows, and the
 * underline in `utils/navRule.js` already moves along it.
 */
export const TAB_ORDER = ['/', '/research', '/following'];

/** The last tab we were on, module scope for the same reason `routeDirection`'s
 *  memory is: `App` keys `<Routes>` on the pathname, so every page component is
 *  destroyed and remade on the way through and cannot remember anything. */
const tabMemory = {};

/**
 * `1` moving right along the bar, `-1` moving left, `null` when this is not a
 * tab-to-tab move at all — in which case the caller keeps the history-based
 * direction it already had.
 */
export function lateralTabDirection(pathname, memory = tabMemory) {
  const index = TAB_ORDER.indexOf(pathname);
  if (index === -1) {
    // Left the bar entirely (an entity, settings, the reader). Forget where we
    // were, so coming back to a tab from a deep page is a return, not a slide.
    memory.index = undefined;
    return null;
  }
  const previous = memory.index;
  memory.index = index;
  if (typeof previous !== 'number' || previous === index) return null;
  return Math.sign(index - previous);
}
```

**In `PageTransition.jsx`**, prefer the lateral answer when there is one:

```jsx
/* target — src/components/Layout/PageTransition.jsx */
const historyDirection = directionForHistoryIndex(
  typeof window !== 'undefined' ? window.history.state?.idx : null,
  undefined,
  useNavigationType(),
);
const lateral = lateralTabDirection(useLocation().pathname);
const direction = lateral ?? historyDirection;
```

**Durations**, for a lateral move only. A sibling step is shorter than a descent:

```js
const ENTER_MS = 0.3;       // unchanged, for hierarchy moves
const EXIT_MS = 0.2;        // unchanged, for hierarchy moves
const LATERAL_ENTER_MS = 0.2;
const LATERAL_EXIT_MS = 0.14;
```

Both stay on the curves they already use — `EASE = [0.16, 1, 0.3, 1]` arriving,
`EASE_LEAVING = [0.4, 0, 1, 1]` leaving. Do not change the curves.

Expected result: ~340ms end to end instead of ~530–570ms, the two directions
mirror each other, and pressing back to a tab retraces the step it came by.

## Repo conventions to follow

- **Direction logic lives in a pure, tested util under `src/utils/`, not in the
  component.** `src/utils/routeDirection.js` + `src/utils/routeDirection.test.js`
  is the exemplar to copy exactly — module-scope memory object, an injectable
  `memory` parameter so tests can pass their own, and a long comment explaining
  the measurement that motivated it.
- **`src/AGENTS.md`**: "`utils/` contains deterministic ranking, normalization,
  navigation, and formatting logic" — this is navigation logic, so it belongs
  there.
- **Add deterministic utility tests** (`src/AGENTS.md`, "Testing").
- Curves are literal arrays; no easing tokens.
- Comments argue for the decision with the number that motivated it — see
  `PageTransition.jsx:29-44`.

## Steps

1. Create `src/utils/tabDirection.js` with exactly the module in Target.

2. Create `src/utils/tabDirection.test.js` covering, at minimum:
   - moving right along the bar returns `1` (`/` then `/following` → `1`);
   - moving left returns `-1` (`/following` then `/` → `-1`);
   - the first tab seen returns `null` (nothing to compare against);
   - the same tab twice returns `null`;
   - a path outside `TAB_ORDER` returns `null` **and** clears the memory, so
     `/` → `/explorer/author/A1` → `/following` returns `null` for the last step
     rather than a stale `1`.
   Each test must pass its own `memory` object, as `routeDirection.test.js` does
   for `directionForHistoryIndex`.

3. In `src/components/Layout/PageTransition.jsx`:
   - add `import { useLocation, useNavigationType } from 'react-router-dom'`
     (the file currently imports only `useNavigationType`);
   - add `import { lateralTabDirection } from '../../utils/tabDirection.js'`;
   - replace the `direction` derivation (currently lines 100-104) with the
     three-line target above, keeping the existing comment block that explains
     the history-index reasoning and adding one sentence saying the lateral
     answer wins when the move is tab-to-tab.

4. In the same file, add the two lateral constants beside `ENTER_MS` / `EXIT_MS`
   and make `routeVariants` select between them. The variants receive `custom`,
   so pass the flag through:
   - change the `custom` prop from `{{ direction }}` to `{{ direction, lateral: lateral !== null }}`;
   - in `enter`, use `duration: lateral ? LATERAL_ENTER_MS : ENTER_MS`;
   - in `exit`, use `duration: lateral ? LATERAL_EXIT_MS : EXIT_MS`.
   Leave `TRAVEL_PX`, `EASE` and `EASE_LEAVING` untouched.

5. Update `src/components/Layout/pageTransition.test.js`. Its two current
   assertions read the `routeVariants` slice and match `x: direction * TRAVEL_PX`
   and `x: direction * -TRAVEL_PX * 0.6`; both must still pass — do not change
   the `x` expressions. Add assertions that:
   - `routeVariants` still contains no `scale:` (the existing guarantee);
   - the lateral durations exist and are shorter than the hierarchy ones.

6. Run the checks in Verification.

## Boundaries

- Do **NOT** change `AnimatePresence mode="wait"` in `src/App.jsx:197`. The
  comment at `App.jsx:31-38` records that the Suspense fallback depends on the
  incoming screen being mounted from the exit-complete callback; removing
  `mode="wait"` changes how every route in the app loads, which is far beyond
  this plan. The 33–35ms of dead air is not worth that risk.
- Do **NOT** change `src/utils/routeDirection.js` or its test. The hierarchy
  behaviour is correct and is what the Explorer's back arrow depends on.
- Do **NOT** touch `PaperCard.css`'s arrival (`:241-296`) or the
  `[data-nav-direction="-1"]` rest rules (`:285-296`). Measured: the card arrival
  already settles with the page. Changing it is a separate decision.
- Do **NOT** change `TRAVEL_PX`, `EASE`, or `EASE_LEAVING`.
- Do **NOT** change `src/utils/navRule.js` or the navbar underline. It is already
  lateral and already correct — it is the exemplar, not the target.
- Do **NOT** add a dependency.
- `TAB_ORDER` must stay in sync with the render order in `Navbar.jsx:147-176`. If
  you find the bar renders a different set or order than `['/', '/research', '/following']`,
  **STOP and report** rather than guessing.

## Verification

- **Mechanical**:
  - `node --test src/utils/tabDirection.test.js` — new tests pass.
  - `node --test src/utils/routeDirection.test.js` — unchanged, still passes.
  - `node --test src/components/Layout/pageTransition.test.js` — passes.
  - `npm run lint` and `npm run build` — clean.

- **Feel check** — this needs a signed-in session, because every navbar tab is
  behind `ProtectedRoute`. Build, serve, sign in, then:
  ```bash
  npm run build && npx vite preview --port 5173 --strictPort
  ```
  - Press For you → Following, then Following → For you. The page must leave and
    arrive on **opposite** sides in the two directions. If both still slide the
    same way, `lateralTabDirection` is returning `null` — check `TAB_ORDER`
    against `location.pathname` (the router normalises a trailing slash; `/` is
    the home path, not the empty string).
  - Open an entity from a card, then press Following in the bar. That is not a
    tab-to-tab move, so it should keep the hierarchy slide, not the lateral one.
  - Press the browser back button after a tab switch and confirm it still
    retraces sensibly.
  - In DevTools → Animations at 10% speed, confirm the outgoing and incoming
    pages travel in mirrored directions and that neither overshoots.
  - In DevTools → Rendering, enable "Emulate CSS prefers-reduced-motion: reduce"
    and confirm the switch is the plain 120ms/80ms cross-fade from
    `reducedMotionVariants` with no travel at all — the lateral change must not
    leak movement into the reduced-motion path.

- **Instrumented re-measure** (optional but decisive). The probe used to produce
  the numbers in this plan is not in the repo; if it has been kept, re-run it
  against a signed-in Chrome profile and compare:
  - `outgoing page fully gone` should drop from ~250ms to ~140ms;
  - `incoming at full opacity` should drop from ~549ms to ~340ms;
  - `data-nav-direction seen` should show **both** `1` and `-1` across a
    there-and-back pair, where it currently shows only `1`.

- **Done when**: the two directions mirror, the tests above pass, the total
  handover measures under ~380ms, and a move from a non-tab route into a tab
  still uses the hierarchy transition.
