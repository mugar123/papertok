# 007 — Shorten the abstract ⇄ map morph to 240ms on an on-screen curve

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: MEDIUM
- **Category**: 2 (Easing & duration)
- **Estimated scope**: 2 source files (`PaperCard.jsx`, `PaperCard.css`), ~8 lines

## Problem

On desktop, the card's Connections toggle swaps the abstract for the citation
map inside `.pc-slot`. Two things move together: the arriving face slides in
(framer) and the slot's height eases from the old face to the new one (CSS).
Both run **420ms**, borrowed from the card-scroll timing, on an ease-out-expo
curve. This is a toggle the reader flips several times per paper: 420ms is
over the 300ms UI budget, and the height change is movement **on screen**, not
an entrance, so it wants an ease-in-out.

```js
// src/components/Feed/PaperCard.jsx:869-886 — current
const slotSlide = {
  enter: (direction) => ({
    opacity: 0,
    transform: `translateX(${prefersReducedMotion ? 0 : direction * 40}px)`,
  }),
  center: {
    opacity: 1,
    transform: 'translateX(0px)',
    transition: { duration: prefersReducedMotion ? 0.12 : CARD_DURATION_MS / 1000, ease: CARD_EASE },
  },
  exit: (direction) => (direction < 0
    ? { opacity: 0, transition: { duration: 0 } }
    : {
      opacity: 0,
      transform: `translateX(${prefersReducedMotion ? 0 : -40}px)`,
      transition: { duration: prefersReducedMotion ? 0.08 : 0.2, ease: [0.23, 1, 0.32, 1] },
    }),
};
```

```js
// src/components/Feed/PaperCard.jsx:800-804 — current
const land = setTimeout(() => {
  slot.classList.remove('pc-slot--morphing');
  slot.style.height = '';
  track.style.height = '';
}, CARD_DURATION_MS + 60);
```

```css
/* src/components/Feed/PaperCard.css:1563-1566 — current */
.pc-slot--morphing {
  overflow: hidden;
  transition: height 420ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

`CARD_DURATION_MS = 420` and `CARD_EASE = [0.16, 1, 0.3, 1]` live in
`src/utils/scrollTween.js` and are **also used by the card scroll tween**.

## Target

| What | Now | Target |
| --- | --- | --- |
| Slide-in duration (`center`) | 420ms | **240ms** |
| Slide-in curve | `[0.16, 1, 0.3, 1]` | **`[0.77, 0, 0.175, 1]`** |
| Height transition | `420ms cubic-bezier(0.16, 1, 0.3, 1)` | **`240ms cubic-bezier(0.77, 0, 0.175, 1)`** |
| `land` timeout | `CARD_DURATION_MS + 60` | **`SLOT_MORPH_MS + 60`** (300ms) |
| Exit (forward) | 200ms, `[0.23,1,0.32,1]` | unchanged |
| Reduced motion | 0.12s fade, no travel, no height morph | unchanged |

`[0.77, 0, 0.175, 1]` is the repo's existing `VIEW_EASE` (`src/utils/viewMorph.js:10`)
and the catalog's ease-in-out. Height is tolerated here because there is no
transform equivalent for an accordion-style resize.

## Repo conventions

`src/utils/viewMorph.js` already exports `VIEW_EASE = [0.77, 0, 0.175, 1]`;
import it, do not retype it. Keep the duration in one JS constant and mirror
it once in CSS, the way `CARD_DURATION_MS` and the 420ms literal mirror each
other today.

## Steps

1. In `PaperCard.jsx`, add `const SLOT_MORPH_MS = 240;` near the slot code with
   a one-line comment that `.pc-slot--morphing` in `PaperCard.css` mirrors it.
2. In `slotSlide.center.transition`, use
   `duration: prefersReducedMotion ? 0.12 : SLOT_MORPH_MS / 1000, ease: VIEW_EASE`.
   Import `VIEW_EASE` from `../../utils/viewMorph.js`.
3. Change the `land` timeout to `SLOT_MORPH_MS + 60`.
4. In `PaperCard.css:1565`, set
   `transition: height 240ms cubic-bezier(0.77, 0, 0.175, 1);`.
5. Remove the `CARD_DURATION_MS` / `CARD_EASE` imports from `PaperCard.jsx`
   only if nothing else in the file still uses them (grep first).

## Boundaries

- **Do not change `CARD_DURATION_MS` or `CARD_EASE`** in `scrollTween.js`. The
  feed's scroll tween depends on them.
- Do not touch the exit variant, the `popLayout` mode, or the
  `initial={false}` return path. "Going back has no entrance" was a user
  decision.
- Do not touch the layout effect's measuring logic (lines 783-799).

## Verification

```bash
npm test
npx eslint src/components/Feed/PaperCard.jsx
npx vite build
```

A source test may assert `CARD_DURATION_MS + 60` or the 420ms rule. Update its
pattern to the new constant; keep what it asserts (the timeout outlives the
transition by 60ms).

Feel check on desktop, dev server 5174, a paper with connections:

1. Toggle Connections on and off ten times quickly. Height and slide finish
   together; there is no step at the end where the height snaps.
2. In DevTools → Animations, slow to 25%. The map should ease in **and** out of
   its travel (no abrupt start), and the slot's bottom edge should move on the
   same curve.
3. The map's plot must not re-lay its nodes during the morph (that was the bug
   `.pc-slot--morphing > .pc-slot-track { flex-shrink: 0 }` fixed).
4. With reduced motion emulated, the swap is a plain fade, no height animation.
