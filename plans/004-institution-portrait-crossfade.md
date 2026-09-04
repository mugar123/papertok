# 004 — Make the institution's portrait cross-fade without dimming

- **Status**: DONE (2026-09-04) — see README.md for what changed from this plan
- **Commit**: 040473d
- **Severity**: LOW
- **Category**: 7 (Cohesion — a crossfade that double-exposes)
- **Estimated scope**: 1 file, ~6 lines

## Problem

When an institution's photograph finishes loading, it cross-fades over the
tinted placeholder tile. The two layers share one 72×72 box but run on
**different durations**, so their opacities do not add up to 1 and the slot
visibly dims in the middle of the swap.

Measured on the production build over CDP, sampling both layers' computed
opacity and scale on the same animation frame
(`#/explorer/institution/I136199984`):

```
slot.crossfadeMs             284
slot.crossfadeFrames          16
slot.framesWithBothVisible     2
slot.worstDoubleExposure   { tile: 0.549, photo: 0.363, sum: 0.912 }
slot.framesWithNeitherFull     4
slot.tileReachedZeroAt      4369ms
slot.photoReachedOneAt      4435ms
slot.tail                     66      <- tile gone, photo still not opaque
```

`sum: 0.912` is the finding. In a correct cross-fade the two opacities always
total 1 and the box never changes brightness; here they total 0.91 at the
crossing point, so the card's background shows through both layers for two
frames and the slot reads as a flicker. Then a 66ms tail where the tile is gone
and the photo is still at 0.99.

The cause is two independent transitions on one handover:

```jsx
// src/components/Explorer/EntityExplorer.jsx:1385-1404 — current
<div className="ehc-visual-slot">
  <motion.div
    className="ehc-icon"
    initial={false}
    animate={{ opacity: hasLoadedWikiImage ? 0 : 1, scale: hasLoadedWikiImage ? 0.96 : 1 }}
    transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
    aria-hidden={hasLoadedWikiImage}
  >
    {renderIcon()}
  </motion.div>
  <AnimatePresence>
    {visibleWikiInfo?.thumbnail && (
      <motion.div
        key={visibleWikiInfo.thumbnail}
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: hasLoadedWikiImage ? 1 : 0, scale: hasLoadedWikiImage ? 1 : 0.96 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        className="ehc-wiki-image"
      >
```

**0.32s** on the tile against **0.42s** on the photo. Both ride the same expo-out
`[0.16, 1, 0.3, 1]`, which is heavily front-loaded, so both layers fall/rise fast
and cross early — and because the clocks differ, `1 − e_tile(t) ≠ e_photo(t)` at
every instant.

### What is already right

This is a well-built component and most of it should not be touched:

- The two layers are stacked absolutely in one box
  (`EntityExplorer.css:151-157`, `.ehc-visual-slot > .ehc-icon, > .ehc-wiki-image`
  at `position: absolute; inset: 0`), which is what makes a true cross-fade
  possible at all.
- The swap is gated on `onLoad` (`EntityExplorer.jsx:1408`) via
  `hasLoadedWikiImage` (`:336-338`), so it never fades to a half-decoded image.
- Both layers are branched on `prefersReducedMotion`.
- `aria-hidden` follows the visual state.
- The scales are `0.96 → 1` and `1 → 0.96`, comfortably inside the catalog's
  `0.9–0.97` range — nothing appears from nothing.

### Context, not in scope

The photograph landed **4.1 seconds** after page load in the measured run, so the
tinted tile sits alone for four seconds first. That is Wikipedia's thumbnail
latency, not the animation, and this plan does not address it.

## Target

One handover, one clock, complementary opacities.

```jsx
/* target — src/components/Explorer/EntityExplorer.jsx */
/* the tile */
transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}

/* the photo */
transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
```

That is the entire change: **0.32 and 0.42 both become 0.28**.

Why this works. Framer interpolates a value as `from + (to − from) · e(t)`, so
with one shared duration and one shared easing the tile's opacity is `1 − e(t)`
and the photo's is `e(t)`. Their sum is exactly **1** at every instant, for any
easing curve — the box never changes brightness, and the tail disappears because
both reach their targets on the same frame.

Why 280ms rather than keeping 320 or 420: the measured cross-fade already
occupies 284ms of wall clock, so 280ms changes nothing the reader is waiting for
while bringing the pair inside the catalog's 300ms UI ceiling. The curve stays
the house arrival curve, unchanged.

Note that the *scales* still differ in shape (the tile shrinks away while the
photo grows in), which is correct and wanted — that is what makes the swap read
as one thing replacing another in depth rather than a flat dissolve.

## Repo conventions to follow

- **Curves are literal arrays in JSX.** `[0.16, 1, 0.3, 1]` is the house arrival
  curve, hand-typed 85 times across the repo. Keep it; do not introduce a token.
- **Every Framer transition is branched on `prefersReducedMotion`.** Both already
  are — preserve the exact ternary shape.
- **Exemplar for a paired handover on one clock**:
  `src/components/Feed/PaperCard.css:1074-1113`, the read button's eye→tick
  morph, where two stacked glyphs hand over inside a single deliberate timing —
  and `PaperCard.css:1046-1060`, the comment arguing for it.
- Feature CSS stays beside its component; this change needs no CSS at all.

## Steps

1. In `src/components/Explorer/EntityExplorer.jsx`, on the `motion.div.ehc-icon`
   (currently line **1389**), change `duration: 0.32` to `duration: 0.28`. Leave
   the easing array, the `prefersReducedMotion` ternary, `initial={false}`,
   `animate` and `aria-hidden` exactly as they are.

2. On the `motion.div.ehc-wiki-image` inside the `AnimatePresence` (currently
   line **1402**), change `duration: 0.42` to `duration: 0.28`. Leave the easing,
   the ternary, the `key`, `initial`, `animate`, `exit` and `className` as they are.

3. Add a short comment above the `.ehc-visual-slot` div (currently line 1385)
   recording why the two clocks must match:

   ```jsx
   {/* The tile and the photograph share one box and one clock. Measured with
       0.32s on the tile against 0.42s on the photo: their opacities summed to
       0.912 at the crossing point, so the card showed through both for two
       frames and the slot flickered, then sat 66ms with the tile gone and the
       photo not yet opaque. On one duration the sum is exactly 1 at every
       instant — 1 − e(t) and e(t) — whatever the curve. The scales still
       differ on purpose: one shrinks away as the other grows in. */}
   ```

4. Run the checks in Verification.

## Boundaries

- Do **NOT** change the easing on either layer. The house arrival curve is
  correct here and matching *durations* is what fixes the dip; matching curves
  is already true.
- Do **NOT** change the `scale` values (`0.96`, `0.97`, `1`). They are inside the
  catalog's range and the asymmetry between the two layers is deliberate.
- Do **NOT** replace Framer's `scale` shorthand with a full transform string.
  The catalog flags the shorthand as main-thread-bound, and that is true — but
  measured here it is a 72×72 box animating once per page load, 16 frames total,
  with no dropped frames. The rule earns its keep on busy surfaces like the feed,
  not on this one. Leave it.
- Do **NOT** touch `.ehc-visual-slot`, `.ehc-icon` or `.ehc-wiki-image` in
  `EntityExplorer.css:143-186`. The absolute stacking is what makes the
  cross-fade possible.
- Do **NOT** change `hasLoadedWikiImage` (`EntityExplorer.jsx:336-338`), the
  `onLoad`/`onError` handlers, or the `key`.
- Do **NOT** add a dependency.
- If lines 1385-1404 do not match the excerpt above (drift since `040473d`),
  **STOP and report**.

## Verification

- **Mechanical**:
  - `npm run lint` — clean.
  - `node --test src/components/Explorer/explorerLoading.test.js` — passes
    unchanged. No test currently pins these two durations
    (`grep -rn "0\.32\|0\.42" src/components/Explorer/*.test.js` confirms), so
    nothing needs editing.
  - `npm run build` — clean.

- **Feel check**:
  ```bash
  npm run build && npx vite preview --port 5173 --strictPort
  ```
  Open `http://localhost:5173/#/explorer/institution/I136199984` and watch the
  72px slot at the top-left of the hero. The photograph should replace the tinted
  tile without the box ever going dull in between.
  - In DevTools → Animations at 10% playback, step through the swap. At every
    frame the slot should look fully "filled" — some blend of tile and photo, but
    never see-through to the card behind.
  - In DevTools → Rendering, enable "Emulate CSS prefers-reduced-motion: reduce"
    and confirm the photo appears instantly with no fade.
  - Institutions without a thumbnail must be unaffected: the tile simply stays.
    Check one — e.g. a small institution whose Wikipedia lookup misses.

- **Done when**: sampling both layers' computed opacity on the same frame through
  the swap, `tileOpacity + photoOpacity` stays within `1.00 ± 0.02` on every
  frame (it currently reaches `0.912`), and both layers reach their final values
  on the same frame (`tail: 0`, currently `66ms`).
