# 011 — Move the graph's travelling dot with `translate`, not `left`/`top`

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 5 (Performance)
- **Estimated scope**: 2 source files (`RelatedPapersSheet.jsx`, `PaperCard.css`), ~10 lines

## Problem

When a reader walks to another paper in the citation map, a dot travels from
the clicked node to the centre. It moves by transitioning `left` and `top`,
which re-runs layout every frame, while the map is also laying out new nodes.

```jsx
// src/components/Feed/RelatedPapersSheet.jsx:~705 — current
<span
  className="graph-travel"
  aria-hidden="true"
  style={{
    left: `${hasTravelled ? layout.centerX : travel.x}px`,
    top: `${hasTravelled ? layout.centerY : travel.y}px`,
    background: hasTravelled ? 'var(--accent-primary)' : travel.accent,
    transform: `scale(${hasTravelled ? 1.45 : 1.28})`,
  }}
/>
```

```css
/* src/components/Feed/PaperCard.css:2035-2047 — current */
.graph-travel {
  position: absolute;
  z-index: 8;
  width: 11px;
  height: 11px;
  margin: -5.5px 0 0 -5.5px;
  border-radius: var(--radius-full);
  transition:
    left 0.32s var(--ease-out-expo) 60ms,
    top 0.32s var(--ease-out-expo) 60ms,
    transform 0.32s var(--ease-out-expo) 60ms,
    background 0.32s ease 60ms;
}
```

Reduced motion already sets `transition: none` on `.graph-travel`
(`PaperCard.css:3140-3150`).

## Target

- Position with the individual `translate` property; keep `transform` for the
  scale. They compose (translate is applied before transform's scale), and
  keeping them separate means the scale does not have to be re-stringified
  with the position.
- `left: 0; top: 0` fixed in CSS.
- Same 0.32s, same `var(--ease-out-expo)`, same 60ms delay, same colour fade.

```jsx
style={{
  translate: `${hasTravelled ? layout.centerX : travel.x}px ${hasTravelled ? layout.centerY : travel.y}px`,
  background: hasTravelled ? 'var(--accent-primary)' : travel.accent,
  transform: `scale(${hasTravelled ? 1.45 : 1.28})`,
}}
```

```css
.graph-travel {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 8;
  width: 11px;
  height: 11px;
  margin: -5.5px 0 0 -5.5px;
  border-radius: var(--radius-full);
  transition:
    translate 0.32s var(--ease-out-expo) 60ms,
    transform 0.32s var(--ease-out-expo) 60ms,
    background 0.32s ease 60ms;
}
```

The 320ms is over the 300ms budget, but it is a spatial hand-off across the
whole map and is run once per walk, not per hover. Keep it.

## Repo conventions

`src/components/ui/tabs.jsx:44` already animates the individual `translate`
property (`transition-[translate,width]`). Same approach.

## Steps

1. Edit the JSX `style` as above.
2. Edit `.graph-travel` as above.
3. Leave the reduced-motion block untouched.

## Boundaries

- Do not change the dot's size, margin, z-index or colours.
- Do not change how `travel` or `hasTravelled` are computed.

## Verification

```bash
npm test
npx eslint src/components/Feed/RelatedPapersSheet.jsx
npx vite build
```

`src/components/Feed/graphStyles.test.js` or `graphCentreSettle.test.js` may
match `left 0.32s`. Update them to `translate 0.32s`; keep what they assert.

Feel check, desktop, a paper with connections:

1. Open Connections, click a node to walk to it. The dot must leave **from the
   node** you clicked (not from the map's top-left corner) and land at the
   centre, growing and turning to the accent colour.
2. Walk three times in a row. Each start is at the right place.
3. DevTools → Performance during a walk: no "Layout" per frame for the dot.
4. Reduced motion: the dot jumps straight to the centre.
