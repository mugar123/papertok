# 001 — Cross-fade the Wikipedia explanation over the shapes it replaces

- **Status**: DONE (2026-09-04) — see README.md for what changed from this plan
- **Commit**: 040473d
- **Severity**: MEDIUM
- **Category**: 7 (Cohesion — a crossfade that double-exposes; here, one that does not exist at all)
- **Estimated scope**: 2 files, ~25 lines

## Problem

In the entity hero (institutions, topics/concepts, projects), the Wikipedia
explanation replaces its loading shapes **in a single frame, at full opacity**.
There is no transition of any kind between the two.

Measured on the production build against `#/explorer/institution/I136199984`,
sampling every animation frame (341 frames):

```
prose.framesWithBoth      0      <- no frame carries both the shapes and the text
prose.proseFirstOpacity   1      <- the paragraph's first frame is already opaque
```

Zero frames of overlap, and the text's very first painted frame is at
`opacity: 1`. The block's *height* is animated around the swap by Framer's
`layout` (0.38s), so the reader sees a box easing to a new size with its
contents hard-cutting inside it — the container moves smoothly and the words
teleport.

The swap is a bare ternary with no presence wrapper and no key:

```jsx
// src/components/Explorer/EntityExplorer.jsx:1873-1900 — current
{isWikiRequestPending && !wikiDescription ? (
  <div className="ehc-wiki-skeleton" role="status" aria-label={isEnglish ? 'Loading topic details' : 'Cargando información del tema'}>
    <span />
    <span />
    <span />
    <span className="ehc-wiki-skeleton-toggle" />
    <span className="ehc-wiki-skeleton-links" />
  </div>
) : wikiDescription ? (
  <p
    ref={wikiDescriptionTextRef}
    className={isWikiDescriptionExpanded ? 'expanded' : 'collapsed'}
    style={wikiDescriptionExpandedHeight ? { '--wiki-description-expanded-height': `${wikiDescriptionExpandedHeight}px` } : undefined}
  >
    {wikiDescription}
  </p>
) : null}
```

and the paragraph's stylesheet transitions only `max-height` — nothing that
could carry an arrival:

```css
/* src/components/Explorer/EntityExplorer.css:603-608 — current */
.ehc-wiki p {
  margin: 0 0 8px 0;
  max-height: 4.8em;
  overflow: hidden;
  transition: max-height 0.38s cubic-bezier(0.16, 1, 0.3, 1);
}
```

Why it matters: the shapes are a promise about what is coming, and they are
deliberately measured to the paragraph's own line box (the comment at
`EntityExplorer.css:623-628` records three lines at 24px reserving 72px exactly).
Everything is in place for the text to *replace* the shapes in the reader's eye
— and then the handover throws that away with a cut.

## Target

A short cross-fade in which the shapes leave and the text arrives over the same
box. Both layers stay in flow, so the `layout` height animation still works.

Exact values — the shapes leave on the house exit curve, the text arrives on the
house arrival curve, and the text is the slower of the two so it is what the eye
lands on:

```jsx
/* target — src/components/Explorer/EntityExplorer.jsx */
<AnimatePresence mode="wait" initial={false}>
  {isWikiRequestPending && !wikiDescription ? (
    <motion.div
      key="wiki-shapes"
      className="ehc-wiki-skeleton"
      role="status"
      aria-label={isEnglish ? 'Loading topic details' : 'Cargando información del tema'}
      initial={false}
      exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.14, ease: [0.4, 0, 1, 1] }}
    >
      <span />
      <span />
      <span />
      <span className="ehc-wiki-skeleton-toggle" />
      <span className="ehc-wiki-skeleton-links" />
    </motion.div>
  ) : wikiDescription ? (
    <motion.p
      key="wiki-prose"
      ref={wikiDescriptionTextRef}
      className={isWikiDescriptionExpanded ? 'expanded' : 'collapsed'}
      style={wikiDescriptionExpandedHeight ? { '--wiki-description-expanded-height': `${wikiDescriptionExpandedHeight}px` } : undefined}
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
    >
      {wikiDescription}
    </motion.p>
  ) : null}
</AnimatePresence>
```

- Shapes out: **140ms**, `cubic-bezier(0.4, 0, 1, 1)` (the repo's exit curve).
- Text in: **260ms**, `cubic-bezier(0.16, 1, 0.3, 1)` (the repo's arrival curve).
- `mode="wait"` so the shapes finish leaving before the text starts: the two
  never double-expose, and the total is 400ms — the same order as the 420ms
  height fold already wrapping them, so the box and its contents finish together.
- Reduced motion: opacity only, `duration: 0`, i.e. the current hard cut. That is
  correct — opacity is not movement, and a reader who asked for less motion is
  not asking for a slower text swap.

**Do not** animate `transform`, `y`, `height` or `max-height` on either layer.
The block's height is already animated by the `layout` prop on the ancestor
`.ehc-wiki-fold` (`EntityExplorer.jsx:1848`) and by the `max-height` transition
on `.ehc-wiki p`; adding a second height animation on the same box makes the two
fight.

## Repo conventions to follow

- **Curves are written as literal arrays in JSX and literal `cubic-bezier()` in
  CSS.** There is no easing token; the house arrival curve
  `cubic-bezier(0.16, 1, 0.3, 1)` appears 85 times, hand-typed. Match that —
  do **not** introduce a token in this plan (that is plan 005's job, if it is
  ever written).
- **Arrivals ride `[0.16, 1, 0.3, 1]`, exits ride `[0.4, 0, 1, 1]`.** This is a
  documented house rule; the rationale is at
  `src/components/Comments/CommentsSheet.jsx:185` and
  `src/components/Layout/PageTransition.jsx:40`.
- **Every Framer value is branched on `prefersReducedMotion`.** The variable is
  already in scope in this component — it is used at
  `EntityExplorer.jsx:1856-1866` and `:1389`.
- **Exemplar to imitate**: `src/components/Explorer/EntityExplorer.jsx:1385-1412`
  — the hero's visual slot, which cross-fades the tinted tile to the institution's
  photograph with `AnimatePresence`, a `key`, branched transitions and the house
  curve. Same file, same hero, same shape of problem.
- Feature CSS lives next to its component (`src/AGENTS.md`, "Architecture").

## Steps

1. In `src/components/Explorer/EntityExplorer.jsx`, confirm `AnimatePresence` and
   `motion` are already imported at the top of the file. They are — the file uses
   both extensively. Do not add an import.

2. In the same file, replace the ternary currently spanning lines **1873-1900**
   (the block quoted verbatim under "Problem") with the target JSX above.
   Keep every existing attribute: the `role`, the `aria-label` with its bilingual
   ternary, the `ref`, the `className` ternary and the `style` with the
   `--wiki-description-expanded-height` custom property. Only the element types,
   the `key`s, the presence wrapper and the motion props are new.

3. Leave the `{isWikiDescriptionExpandable && (<button className="ehc-wiki-toggle" …>)}`
   block that follows (currently lines 1901-1913) **outside** the new
   `AnimatePresence`, exactly where it is. It is a sibling of the swap, not part
   of it, and moving it inside would make the "Read more" toggle fade on every
   state change.

4. In `src/components/Explorer/EntityExplorer.css`, leave `.ehc-wiki p` (line 603)
   unchanged. Its `transition: max-height` is the expand/collapse, a different
   interaction, and the new `opacity` animation is written inline by Framer.

5. Run the mechanical checks in Verification.

## Boundaries

- Do **NOT** touch the `motion.div.ehc-wiki-fold` at `EntityExplorer.jsx:1845-1868`
  — its `initial` / `animate` / `exit` / `transition` objects are asserted
  literally by `src/components/Explorer/explorerLoading.test.js:118-134`, and the
  exit curve on that element is plan **002**'s subject. Two plans editing the same
  object will collide.
- Do **NOT** change the skeleton's shape, count of `<span>`s, or its CSS. The five
  rows are measured against the paragraph's line box on purpose
  (`EntityExplorer.css:623-628`); changing them re-breaks the reservation.
- Do **NOT** change what `wikiDescription` resolves to (`EntityExplorer.jsx:335`),
  or the `isWikiRequestPending` condition. This plan is motion only.
- Do **NOT** add a dependency, a token, or a shared keyframe.
- Do **NOT** animate `height`, `max-height`, `y` or `transform` on either layer.
- If the code at lines 1873-1900 does not match the excerpt above (drift since
  commit `040473d`), **STOP and report** rather than improvising a match.

## Verification

- **Mechanical**:
  - `npm run lint` — expect no new warnings or errors.
  - `node --test src/components/Explorer/explorerLoading.test.js` — expect all
    tests to pass **unchanged**. This plan must not require editing that file. If
    a test fails, you have touched the fold wrapper; revert that part.
  - `npm run build` — expect a clean build.

- **Feel check** — serve the production build and open an institution with a
  Wikipedia article:
  ```bash
  npm run build && npx vite preview --port 5173 --strictPort
  ```
  then open `http://localhost:5173/#/explorer/institution/I136199984`.
  - The shapes should dissolve and the words should surface over them, in the
    same box, with the box's own height easing at the same time — one movement,
    not a cut inside an animation.
  - In DevTools → Animations, set playback speed to 10%. Confirm the shapes are
    fully gone before the text begins to appear (`mode="wait"`), and that the
    text never appears at full opacity on its first frame.
  - Wikipedia's `generator=search` endpoint returns an intermittent 503; if the
    paragraph does not arrive at all, that is the case plan **002** covers, not a
    failure of this change. Reload until it does.
  - In DevTools → Rendering, tick "Emulate CSS prefers-reduced-motion: reduce"
    and confirm the swap is instant again, with no fade and no movement.

- **Done when**:
  - A frame-by-frame sample shows at least ~8 frames in which the paragraph's
    computed opacity is strictly between 0 and 1 (it is currently 0 such frames).
  - No frame shows the shapes and the paragraph simultaneously above opacity 0.15.
  - `explorerLoading.test.js` passes without modification.
