# 005 — The Explorer's skeleton promises things that never arrive

- **Status**: TODO
- **Commit**: e2da8a6
- **Severity**: HIGH (the largest remaining cause of "the page shoves me around")
- **Category**: 8 (missed opportunities) + 1 (purpose)
- **Estimated scope**: 3–4 source files, one item at a time

## Why this exists

A four-way audit of the entity Explorer ran against `040473d`. The motion
findings were implemented in `e2da8a6`. What is left is not motion — it is the
**reservation**: what the skeleton stands in for versus what actually lands.
Every item below makes the page move under the reader for a reason no animation
can hide, and three of the four auditors arrived at them independently.

The single sentence that explains the user's complaint:

> A project page loads as one 420ms fade and then holds perfectly still, while
> several hundred pixels of content it never reserved shove everything down.
> An author page is the opposite: three separate height settles fight one
> unreserved list growth.

## What the skeleton promises versus what arrives

Verified per type. `✓` = reserved and delivered.

| | tabs | identity strip | aside block | 4 stat boxes | visual slot |
| --- | --- | --- | --- | --- | --- |
| **author** | 1 ✓ | topics ✓ | ORCID — **only if `entity.orcid` exists** | 4 ✓, but **1** on an ORCID stub | icon, never a photo ✓ |
| **institution** | 2 ✓ | credentials ✓ | wiki ✓, held open ✓ | 4 ✓ | icon → photo ✓ |
| **topic / concept** | **2 → 1** | none ✓ | **none, but a wiki block lands** | **3, or 0** for a query topic | icon → photo |
| **project** | 1 ✓ | none — live hero adds chips, summary, subjects, participants | none ✓ | **0–5** | icon, never a photo ✓ |
| **source** | 2 ✓ | none ✓ | **none, and not even held open** | **3** | icon → photo |

## The items, in the order they are worth doing

### 1. The paper row reserves no abstract — the list grows 185–310px

`EntityExplorer.jsx:2210-2223` (list skeleton) and `:1331-1341` (page skeleton),
shapes at `EntityExplorer.css:978-985`. The skeleton row paints a kicker, two
title bars and an authors bar; the live row **always** renders `.eli-summary`
(there is a fallback string, so it is never absent), which is
`0.9375rem/1.55` clamped to 2 lines = **46.5px that nothing stands in for**.

Skeleton row ≈ 97px of content; live row ≈ 134–159px. Over five rows the list
grows **185–310px** at the handover, and rows 2–5 each start 40/80/120/160px
above the shape they replace. The comment at `EntityExplorer.css:857-862` —
"a row that has not started yet is already sitting at 0.35 where its skeleton
shape was" — is true for row 1 only.

**Fix**: add a two-line summary shape to the skeleton row, matched to
`.eli-summary`'s own line box the way `.ehc-wiki-skeleton` is matched to the
paragraph's (`EntityExplorer.css:623-628` records that method). Applies to all
five types. `explorerLoading.test.js:145-150` pins the row *count* only, so no
test blocks this.

### 2. The project skeleton reserves nothing below the hero

`explorerSkeletonShape.js:52-54` gives a project `identity: 'none', aside: 'none'`,
yet `EntityExplorer.jsx:1785-1885` renders chips, a summary box, subjects and a
participants grid the moment `getProjectDetails` answers, in one batched
`setEntity`. Single-column, the participants grid alone is **≈382px**.
`useHeightSettle` makes it a smooth push rather than a jump, but the tab strip,
the toolbar and the whole papers skeleton still travel several hundred pixels
off the bottom of the screen.

**Fix**: give `project` an identity/aside shape of its own. The util's docstring
already reasons about exactly this class of drop for authors and institutions;
projects were left out. No test pins it.

### 3. A topic's second tab disappears from under the reader

`explorerSkeletonShape.js:52` calls `hasAuthorsTab(type)` with no entity → 2 tabs
for a topic; `EntityExplorer.jsx:2106` calls `hasAuthorsTab(type, entity)` →
1 tab once `_localTopic` / `_queryTopic` is known. The strip paints two shapes
and then one button, in the frame the hero crossfade begins.

**The route already knows**: query topics carry `?q=` and `source=free-text`, and
`isOpaqueQueryTopicText(id)` is already used at `EntityExplorer.jsx:560`. Pass it
into the shape.

**Careful**: `explorerSkeletonShape.test.js:23-37` pins both sides of the current
mismatch as correct and reasons only about the opposite hazard (the entity
adding a tab). That reasoning needs amending, not just the assertion.

### 4. The ORCID slot has no way to leave

`EntityExplorer.jsx:1306` reserves `<OrcidCardSkeleton />` for every author;
`:2017` renders it only while `isLoadingOrcid`, which is never raised when
`data.orcid` is absent (`:652`). For every author OpenAlex has no ORCID for, a
96px card is reserved and then simply is not in the tree — the shapes vanish in
one commit while only the parent's height settle blurs the loss.

**Fix**: the pattern is already built two hundred lines away —
`.ehc-wiki-fold` with `WIKI_FOLD_OUT` (`EntityExplorer.jsx:1899`), written for
exactly this: "one that never comes folds the block away instead of cutting it".
Wrap the ORCID slot the same way.

### 5. Typing in the search box tears the list down to five shapes

`EntityExplorer.jsx:779-782` sets `isLoadingPapers` on every page-1 query, and
`:2156` gates every mounted row on it. 600ms after the reader stops typing, a
reader who has scrolled to row 20 has the page collapse from ~13,000px to ~600px
underneath them, and the results replay the full stagger. Refining a search is a
tens-of-times action, which is the band where the catalog says reduce, not
amplify.

**Fix**: keep the rows mounted at reduced opacity while the request is in flight.

### 6. Entity → entity keeps the old scroll position

`navigateToEntity` (`EntityExplorer.jsx:325-331`) has no `scrollTo`, and there is
no `ScrollRestoration` anywhere. Opening an entity *from the feed* is safe (the
feed has its own scroller), but tapping a related institution from halfway down
an author's paper list mounts the new skeleton at the old `scrollY`. The route
animates 18px while the content underneath jumps hundreds.

### 7. The tab swap teleports the whole content region

`EntityExplorer.jsx:2151` swaps thousands of pixels of list between two frames
with no treatment, while the 3px underline it belongs to crossfades over 120ms.
Scroll position is retained against a document that just changed height.

## Deliberately NOT doing

Recorded so they are not re-proposed:

- **Animating the author/project visual slot.** `hasLoadedWikiImage` is
  permanently false for those types and `initial={false}` means the element never
  plays a frame. There is no state change to carry motion; an idle float or a
  pulse would answer "it looks nice" on an element seen every visit. The
  complaint is real, the fix is not motion in that box.
- **A presence wrapper around any skeleton→live swap in this hero.** Measured:
  it splits the swap across two React commits and destroys the `layout`
  projection (the block stopped animating its height, the list flashed 40px).
- **`scale(0.97)` on full-bleed rows.** Re-rasters two lines of serif type for a
  tap; the background change shipped in `e2da8a6` instead.
- **A sliding underline for the Explorer tabs.** Two tabs ~60px apart, at most
  one switch per visit; a measured indicator costs a ref, a layout read and a
  resize listener for spatial consistency nobody was missing.
- **Softening the papers-list → skeleton collapse with a height animation.**
  The only honest fix animates `height` on `.explorer-grid` — a large reflow on
  every debounce. Item 5's opacity approach instead.

## Verification

`scripts/diagnostics/explorer-loading-probe.mjs open '#/' mobile,late` already
samples every frame of the handover **and dumps the hero's blocks on the first
skeleton frame and on the first live frame** — that dump is exactly the
promise-versus-arrival diff each item above is about. `sel=<css>` reaches a topic
tag or a project badge; `hold` keeps the skeleton up. Nothing new needs building.

For each item, the number to move is the travel of `.explorer-content`'s top
edge, and the count of frames carrying more than ~10px of it.
