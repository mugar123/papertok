# 009 — Shorten the Explorer's read-more fold from 380ms to 280ms

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 2 (Easing & duration)
- **Estimated scope**: 1 source file (`EntityExplorer.css`), 2 lines

## Problem

Two "read more" paragraphs in the Explorer unfold with a `max-height`
transition of **380ms**. The expanded height is measured in JS
(`EntityExplorer.jsx:2264` and `:2426` set `--…-expanded-height`), so the
transition runs over the real distance, not a guessed ceiling. That makes
`max-height` an acceptable accordion technique here. The only problem is the
duration: it is a user-initiated toggle, over the 300ms budget.

```css
/* src/components/Explorer/EntityExplorer.css:839-843 — current */
.ehc-wiki p {
  margin: 0 0 8px 0;
  max-height: 4.8em;
  overflow: hidden;
  transition: max-height 0.38s var(--ease-out-expo);
```

```css
/* src/components/Explorer/EntityExplorer.css:2179 — current (inside .project-summary-box p) */
  transition: max-height 0.38s var(--ease-out-expo);
```

## Target

`transition: max-height 0.28s var(--ease-out-expo);` on both rules. Keep the
curve: an unfold is an element entering its space, and `--ease-out-expo`
(`cubic-bezier(0.16, 1, 0.3, 1)`) is the repo's token for it.

## Repo conventions

Durations in this file are literal seconds next to a `var(--ease-*)` token.
Stay in that form.

## Steps

1. Line 843: `0.38s` → `0.28s`.
2. Line 2179: `0.38s` → `0.28s`.

## Boundaries

- Do not convert to `grid-template-rows`, `interpolate-size` or a transform.
  Out of scope.
- Do not touch the `layout` transition of `.ehc-wiki-fold` (plan 002 tuned it
  to 480ms deliberately for the fold, a different element).
- Do not touch the JSX height measurement.

## Verification

```bash
npm test
npx vite build
```

`src/components/Explorer/explorerMotion.test.js` may pin `0.38s`. If it does,
update the expected value to `0.28s`; do not loosen the assertion.

Feel check: open an institution in the Explorer (e.g.
`#/explorer/institution/I136199984`), expand and collapse the description.
It should open crisply with no visible step at the end. Repeat on a project
summary. With reduced motion emulated, check the existing reduced-motion rule
still applies.
