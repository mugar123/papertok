# 014 — Keep the tab indicator's width transition, and say why in the code

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 5 (Performance), accepted
- **Estimated scope**: 1 source file (`ui/tabs.jsx`), 1 comment

## Problem

The line-tab indicator animates `width`, a layout property:

```jsx
// src/components/ui/tabs.jsx:41-46 — current
<TabsPrimitive.Indicator
  data-slot="tabs-indicator"
  className={cn(
    'absolute bottom-[-1px] left-0 h-[3px] w-(--active-tab-width) translate-x-(--active-tab-left) bg-brand',
    'motion-safe:transition-[translate,width] motion-safe:duration-200 motion-safe:ease-[var(--ease-out-expo)]',
  )}
/>
```

The usual fix is a fixed 1px-wide bar scaled with `scaleX`. That needs the
width as a unitless ratio, but Base UI only provides `--active-tab-width` in
`px`, and CSS cannot divide a length by a length to get a number
(`calc(var(--active-tab-width) / 1px)` is invalid in the browsers this app
supports). Doing it in JS means re-measuring tabs Base UI already measures.
The element is 3px tall and absolutely positioned, so its relayout is tiny.

The audit's call: **accept**, and record the reason so the next audit does
not re-raise it.

## Target

A comment directly above the `className` (match the file's comment style):

```jsx
{/* Width, not scaleX: Base UI gives the tab's width in px only, and CSS
    cannot turn a length into the ratio scaleX needs. The bar is 3px tall
    and out of flow, so its relayout is negligible. */}
```

## Boundaries

- No class, duration or curve change.

## Verification

```bash
npx eslint src/components/ui/tabs.jsx
npm test
```
