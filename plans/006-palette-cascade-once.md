# 006 — Cascade the palette's results once per opening, not on every result set

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: MEDIUM
- **Category**: 1 (Purpose & frequency)
- **Estimated scope**: 1 source file (`SearchCommand.jsx`), ~10 lines; CSS untouched

## Problem

The command palette is opened with a keyboard shortcut and typed into dozens of
times a session. Its rows rise in on a staggered cascade (`.sc-enter`). The
cascade is justified **once**, when the sheet opens. But every row of every
result set gets the class, so each new row that mounts while the user is typing
plays the 260ms rise again, with up to 240ms of stagger delay in front of it.
A user typing "graph neural" watches rows fade in behind their own keystrokes:
motion on a 100+/day keyboard action, which the bar says gets none.

```js
// src/components/Search/SearchCommand.jsx:312-336 — current
let enterIndex = 0;
const renderedSections = orderedSections.map((section) => {
  // ...
  const headingIndex = Math.min(enterIndex, ENTER_STAGGER_CAP);
  enterIndex += 1;
  const rows = Children.map(sectionContent[section](), (child, offset) => cloneElement(child, {
    className: [child.props.className, 'sc-enter'].filter(Boolean).join(' '),
    style: {
      ...child.props.style,
      '--sc-enter-index': Math.min(enterIndex + offset, ENTER_STAGGER_CAP),
    },
  }));
  enterIndex += results[section].length;
  // ...
  heading={<span className="sc-heading sc-enter" style={{ '--sc-enter-index': headingIndex }}>...
```

```css
/* src/components/Search/SearchCommand.css:357-361 — current, keep as is */
.sc-enter {
  opacity: 0;
  animation: scEnterRise 260ms var(--ease-out-expo) forwards;
  animation-delay: calc(var(--sc-enter-index, 0) * 24ms);
}
```

`ENTER_STAGGER_CAP = 10` (line 82). The component is
`SearchCommand({ open, onOpenChange, finalFocus })` and already uses `useState`
and `useLayoutEffect` from React (line 1).

## Target

- The first result set shown after the sheet opens cascades exactly as today.
- Every later result set while the sheet stays open renders **with no
  `sc-enter` class and no `--sc-enter-index`**: rows are simply there.
- Closing the sheet (`open` becomes `false`) re-arms the cascade for the next
  opening.
- Never strip the class from rows **while** they are mid-cascade: that would
  snap them to `opacity: 1` early. Disarm only after the cascade has finished.

Cascade length: last delay `ENTER_STAGGER_CAP * 24ms = 240ms` + `260ms` =
**500ms**. Disarm at 500ms after the first result set renders.

## Repo conventions

React state plus a timer cleared in the effect's cleanup is how this file and
`PaperCard.jsx` already sequence motion (see `PaperCard.jsx:783-805`, the
`land` timeout). Do not add a ref-based "has animated" registry or a new hook
file — one boolean state in this component is the whole change.

## Steps

1. Add `const [cascadeDone, setCascadeDone] = useState(false);` beside the
   other state (around line 111).
2. Add an effect: when `open` is false, `setCascadeDone(false)`. When `open` is
   true and there are rows to show (`totalResults > 0`) and `cascadeDone` is
   false, start `setTimeout(() => setCascadeDone(true), ENTER_STAGGER_CAP * 24 + 260)`
   and clear it in cleanup. Name the 24 and 260 once each as constants next to
   `ENTER_STAGGER_CAP`, with a one-line comment that they mirror
   `SearchCommand.css`'s `.sc-enter` delay step and duration.
3. In the block at lines 312-336, when `cascadeDone` is true, return the child
   unchanged (no `cloneElement`) and render the heading span without `sc-enter`
   and without the `--sc-enter-index` style.
4. Leave `SearchCommand.css` alone, including the reduced-motion rule.

## Boundaries

- Do not touch the sheet's own 150ms open animation (`scSheetIn`). It is
  documented as deliberate.
- Do not change `ENTER_STAGGER_CAP`, the 24ms step or the 260ms duration.
- Do not touch `src/components/ui/command.jsx`.

## Verification

```bash
npm test
npx eslint src/components/Search/SearchCommand.jsx
npx vite build
```

If a source test asserts the `sc-enter` cloneElement shape, update its pattern
to match the guarded form; do not delete the assertion.

Feel check (dev server on 5174):

1. Open the palette (⌘K). Results cascade in, as before.
2. Type slowly, one letter every half second. New rows must appear instantly,
   with no fade or rise.
3. Close with Esc, reopen. The cascade plays again.
4. Open and type within the first 300ms. The opening cascade must finish
   cleanly; no row may snap to full opacity mid-rise.
5. With `prefers-reduced-motion: reduce` emulated, rows are visible at once in
   every case (existing CSS rule).
