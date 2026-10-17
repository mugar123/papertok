# 012 — One JS module for the motion curves this PR types by hand

- **Status**: TODO
- **Commit**: 20c4fcb0
- **Severity**: LOW
- **Category**: 7 (Cohesion & tokens)
- **Estimated scope**: 1 new file, 5-7 edited source files, mechanical
- **Depends on**: 007 and 010 (they edit the same lines; run this after them)

## Problem

CSS has tokens (`--ease-out`, `--ease-out-expo`, …). JS does not: the same
three curves are retyped as array literals across the PR, and two files define
a local `EASE_OUT` that is actually the **expo** curve, the opposite of what
CSS calls `--ease-out`.

Literals in files this PR touches (grep at 20c4fcb0):

```
src/components/Feed/PaperCard.jsx:857   ease: [0.16, 1, 0.3, 1]
src/components/Feed/PaperCard.jsx:861   ease: [0.23, 1, 0.32, 1]
src/components/Feed/PaperCard.jsx:884   ease: [0.23, 1, 0.32, 1]
src/components/Feed/PaperCard.jsx:1667  ease: [0.23, 1, 0.32, 1]
src/components/Feed/PaperCard.jsx:1790  ease: [0.16, 1, 0.3, 1]
src/components/Feed/PaperCard.jsx:2040  ease: [0.16, 1, 0.3, 1]
src/components/Feed/FeedContainer.jsx:160,164  [0.16, 1, 0.3, 1]
src/components/Feed/FeedContainer.jsx:168      [0.23, 1, 0.32, 1]
src/components/Lists/ListsPage.jsx:1328        [0.16, 1, 0.3, 1]
src/components/Explorer/EntityExplorer.jsx:1852,1887,1899  [0.16, 1, 0.3, 1]
src/components/Reader/PaperReader.jsx:300      const EASE_OUT = [0.16, 1, 0.3, 1];   (misnamed: this is expo)
src/components/Reader/PaperReader.jsx:1588,1607  [0.23, 1, 0.32, 1]
src/components/Reader/AnnotationRail.jsx:240,306  [0.23, 1, 0.32, 1]
src/components/Reader/AnnotationRail.jsx:241,307,326  [0.16, 1, 0.3, 1]
```

Existing named constants that already hold these values:

```js
// src/utils/scrollTween.js:17
export const CARD_EASE = Object.freeze([0.16, 1, 0.3, 1]);
// src/utils/viewMorph.js:10
export const VIEW_EASE = [0.77, 0, 0.175, 1];
```

And the CSS tokens they must mirror (`src/styles/variables.css`):

```
--ease-out:      cubic-bezier(0.23, 1, 0.32, 1)
--ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1)
```

## Target

New file `src/utils/motionCurves.js`:

```js
// The CSS easing tokens (styles/variables.css), for framer-motion. Keep the
// two in step.
export const EASE_OUT = Object.freeze([0.23, 1, 0.32, 1]);       // --ease-out
export const EASE_OUT_EXPO = Object.freeze([0.16, 1, 0.3, 1]);   // --ease-out-expo
export const EASE_IN_OUT = Object.freeze([0.77, 0, 0.175, 1]);   // on-screen movement
```

Then:

- `scrollTween.js`: `export const CARD_EASE = EASE_OUT_EXPO;` (keep the export
  name; it has consumers).
- `viewMorph.js`: `export const VIEW_EASE = EASE_IN_OUT;` (same reason).
- Replace every literal in the list above with the matching import.
- `PaperReader.jsx`: delete the local `const EASE_OUT = [0.16, 1, 0.3, 1];` and
  import `EASE_OUT_EXPO`; rename its 3 uses (lines 363, 374, 1608). Do **not**
  import `EASE_OUT` under the old local name: the values differ.

## Repo conventions

Small single-purpose modules in `src/utils/` with a colocated test
(`viewMorph.js` + `viewMorph.test.js`). Add `src/utils/motionCurves.test.js`
asserting each constant equals the cubic-bezier numbers parsed from
`src/styles/variables.css` for `--ease-out` and `--ease-out-expo` (read the
file with `node:fs`, as `paperCardStatusChips.test.js` does). That test is the
point of the module: it fails if CSS and JS drift.

## Steps

1. Create `motionCurves.js` and its test.
2. Point `CARD_EASE` and `VIEW_EASE` at it.
3. Replace the listed literals, file by file. Re-grep after each file.
4. Fix `PaperReader.jsx`'s misnamed local as described.

## Boundaries

- Only the files listed. Literals elsewhere (`ReaderBar.jsx`, `ExportCard.jsx`,
  `NudgePanel.jsx`, `GuestWelcome*.jsx`, `PublicPaperPage.jsx`) are outside
  this PR; leave them, and list them in the PR as a follow-up.
- No duration or curve value changes. A visual diff must be zero.

## Verification

```bash
npm test
npx eslint src/utils/motionCurves.js src/utils/scrollTween.js src/utils/viewMorph.js src/components/Feed src/components/Reader src/components/Lists/ListsPage.jsx src/components/Explorer/EntityExplorer.jsx
npx vite build
grep -rnE "\[0\.23, ?1, ?0\.32, ?1\]|\[0\.16, ?1, ?0\.3, ?1\]|\[0\.77, ?0, ?0\.175, ?1\]" src/components/Feed src/components/Reader/PaperReader.jsx src/components/Reader/AnnotationRail.jsx src/components/Lists/ListsPage.jsx src/components/Explorer/EntityExplorer.jsx
```

The last command must print nothing. Feel check: none needed beyond a quick
pass through the feed, the reader and the card's Connections toggle, since no
value changes.
