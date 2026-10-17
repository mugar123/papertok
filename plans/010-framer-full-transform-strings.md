# 010 — Use full transform strings instead of framer `x`/`y`/`scale` shorthands

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 5 (Performance)
- **Estimated scope**: 3 source files, ~12 lines

## Problem

Framer Motion's `x` / `y` / `scale` / `scaleY` shorthands are composed on the
main thread each frame and are not hardware-accelerated. A `transform` string
is. These three spots animate while the page is busy (the feed fetching, the
reader streaming an AI answer), which is when shorthands drop frames. The rest
of this PR already uses strings (`PaperCard.jsx` `slotSlide`,
`src/utils/viewMorph.js`).

```js
// src/components/Feed/FeedContainer.jsx:162-169 — current
const ATOM_VARIANTS = {
  shown: { opacity: 1, scale: 1, y: 0 },
  gone: { opacity: 0, scale: 0.62, y: -16, transition: { duration: 0.36, ease: [0.16, 1, 0.3, 1] } },
};
const ATOM_COPY_VARIANTS = {
  shown: { opacity: 1, y: 0 },
  gone: { opacity: 0, y: 6, transition: { duration: 0.24, ease: [0.23, 1, 0.32, 1] } },
};
```

```jsx
// src/components/Reader/AnnotationRail.jsx:236-241 — current
initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
animate={{ opacity: 1, y: 0 }}
exit={prefersReducedMotion
  ? { opacity: 0, transition: { duration: 0.12 } }
  : { opacity: 0, x: -8, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
```

```jsx
// src/components/Reader/AnnotationRail.jsx:300-306 — current
initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
animate={{ opacity: 1, y: 0 }}
exit={prefersReducedMotion
  ? { opacity: 0, transition: { duration: 0.12 } }
  : { opacity: 0, y: -4, height: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
```

```jsx
// src/components/Reader/PaperReader.jsx:1586-1588 — current (rd-ghost)
exit={prefersReducedMotion
  ? { opacity: 0, transition: { duration: 0.12 } }
  : { opacity: 0, y: -6, transition: { duration: 0.2, ease: [0.23, 1, 0.32, 1] } }}
```

```jsx
// src/components/Reader/PaperReader.jsx:1604-1607 — current (rd-ghost-body)
initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, scaleY: 0.7, y: -4 }}
animate={{ opacity: 1, scaleY: 1, y: 0 }}
exit={prefersReducedMotion
  ? { opacity: 0, transition: { duration: 0.12 } }
  : { opacity: 0, scaleY: 0.4, y: -8, transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] } }}
```

## Target

Same values, written as transforms. Every state of one element must use the
**same function list in the same order**, so framer interpolates rather than
jumps:

| Where | State | Value |
| --- | --- | --- |
| ATOM_VARIANTS | shown | `transform: 'translateY(0px) scale(1)'` |
| | gone | `transform: 'translateY(-16px) scale(0.62)'` |
| ATOM_COPY_VARIANTS | shown | `transform: 'translateY(0px)'` |
| | gone | `transform: 'translateY(6px)'` |
| rd-note (236) | initial | `transform: 'translate(0px, 10px)'` |
| | animate | `transform: 'translate(0px, 0px)'` |
| | exit | `transform: 'translate(-8px, 0px)'` |
| thinking card (300) | initial / animate / exit | `translateY(8px)` / `translateY(0px)` / `translateY(-4px)` |
| rd-ghost | exit | `transform: 'translateY(-6px)'` (it has no entrance today; do not add one) |
| rd-ghost-body | initial / animate / exit | `translateY(-4px) scaleY(0.7)` / `translateY(0px) scaleY(1)` / `translateY(-8px) scaleY(0.4)` |

Keep the `height`, `marginBottom`, `paddingTop`, `paddingBottom` collapse in the
AnnotationRail exits: it hands the card's room back so the next card does not
jump. Height has no transform equivalent here.

Reduced-motion branches stay opacity-only, unchanged.

## Repo conventions

Exemplar: `src/components/Feed/PaperCard.jsx` `slotSlide` (around line 869)
writes `transform: \`translateX(${…}px)\`` in every state. Match that style.

## Steps

1. Rewrite the variants and props above to the target values.
2. For `rd-ghost-body`, confirm the element's CSS sets `transform-origin` the
   way framer did (framer's `scaleY` uses `transform-origin: 50% 50%` unless
   `originY` is set). If no origin is set anywhere, add nothing.
3. Do not change any duration, ease or delay.

## Boundaries

- No changes to durations or curves (plan 012 covers curve constants).
- No changes to reduced-motion branches.
- Do not remove the height collapse.

## Verification

```bash
npm test
npx eslint src/components/Feed/FeedContainer.jsx src/components/Reader/AnnotationRail.jsx src/components/Reader/PaperReader.jsx
npx vite build
```

`src/components/Feed/feedAtomVeil.test.js` may match the old variant text.
Update its pattern to the transform form and keep the assertion's intent.

Feel check, in DevTools → Animations at 25%:

1. Feed: trigger a refresh so the atom veil shows and leaves. The flask shrinks
   up and fades exactly as before.
2. Reader: add a note and delete it. It slides left, collapses, the card below
   rises with no jump.
3. Reader: ask the AI; the thinking card leaves upward and hands its room to
   the answer.
4. Reader: watch the ghost skeleton grow per section. It must not snap from
   0.7 to 1 or wobble horizontally.
5. Performance panel: no long "Recalculate style" bars attributed to framer
   during these.
