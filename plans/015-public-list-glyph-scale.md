# 015 — Start the public list's share glyph at 0.95, not 0.8

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 3 (Physicality & origin)
- **Estimated scope**: 1 source file (`PublicListPage.css`), 1 value

## Problem

The share button's icon swaps (share → check) and the new icon pops in from
`scale(0.8)`. That is a large jump for a 16px glyph in 160ms: it reads as a
blink rather than a settle. The bar for entrances is `scale(0.9–0.97)` plus
opacity.

```css
/* src/components/Lists/PublicListPage.css:341-347 — current */
@keyframes public-list-glyph-in {
  from { opacity: 0; transform: scale(0.8); }
}

.public-list-share-glyph {
  display: inline-flex;
  animation: public-list-glyph-in 160ms var(--ease-out);
}
```

## Target

`from { opacity: 0; transform: scale(0.95); }`. Duration (160ms) and curve
(`--ease-out`, `cubic-bezier(0.23, 1, 0.32, 1)`) are right for button feedback.

## Steps

1. Line 342: `scale(0.8)` → `scale(0.95)`.

## Boundaries

- Nothing else. Check the file's reduced-motion block still covers
  `.public-list-share-glyph`; if it does not, report it, do not add it here.

## Verification

```bash
npm test
npx vite build
```

Feel check: open a public list page, press Share. The check mark should settle
in place, not pop.
