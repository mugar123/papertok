# 013 — Give the map's edges the repo's ease-out instead of the built-in one

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 2 (Easing) and 7 (Cohesion)
- **Estimated scope**: 1 source file (`PaperCard.css`), 2 lines

## Problem

The citation map's edges and its "now" line fade in with the browser's
built-in `ease-out`, which is weak. Every other entrance in the map uses the
repo's tokens.

```css
/* src/components/Feed/PaperCard.css:1737 — current (.graph-edge) */
  animation: graphEdgeIn 0.22s ease-out backwards;
```

```css
/* src/components/Feed/PaperCard.css:1780 — current (.graph-now) */
  animation: graphEdgeIn 0.22s ease-out 0.12s backwards;
```

```css
/* src/components/Feed/PaperCard.css:2699-2702 — the keyframes, unchanged */
@keyframes graphEdgeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

## Target

```css
  animation: graphEdgeIn 0.22s var(--ease-out) backwards;
  animation: graphEdgeIn 0.22s var(--ease-out) 0.12s backwards;
```

`--ease-out` is `cubic-bezier(0.23, 1, 0.32, 1)`, defined in
`src/styles/variables.css`.

## Steps

1. Line 1737: `ease-out` → `var(--ease-out)`.
2. Line 1780: same.

## Boundaries

- Do not change durations, delays, the `--edge-delay` stagger or the keyframes.
- Do not touch the `.graph-map.is-returning` rule that disables these on a
  switch back.

## Verification

```bash
npm test
npx vite build
```

If `graphStyles.test.js` matches `graphEdgeIn 0.22s ease-out`, update the
pattern to the token.

Feel check: open Connections on a paper with several links. Edges should arrive
a touch quicker off the mark and settle softly. Switch to the list and back:
no edge animation on return (unchanged).
