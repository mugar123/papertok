import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');

/** Comments are prose, not code: a decoy comment must never satisfy a test. */
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE tests for the two surfaces a card opens over the feed for a related
 * paper: the connections sheet (a Base UI Drawer) and the paper it hands
 * over to (a full-screen Base UI Dialog). Both used to time their own exit
 * with a class, an `animationend` listener and a fallback timer; the
 * primitive holds the node until the exit has played now, and the parent
 * hears of the close from `onOpenChangeComplete(false)` and nowhere else.
 */
test('the connections sheet is a modal Base UI Drawer on phones and a Dialog elsewhere, owns its open state and reports the close once', async () => {
  const jsx = stripComments(await read('./RelatedPapersSheet.tsx'));
  assert.match(jsx, /import \{ Drawer, DrawerClose, DrawerContent, DrawerTitle \} from '\.\.\/ui\/drawer\.tsx';/);
  assert.match(jsx, /import \{ Dialog, DialogClose, DialogContent, DialogTitle \} from '\.\.\/ui\/dialog\.tsx';/);
  assert.match(jsx, /const Root = inline \? InlineRoot : isPhone \? Drawer : Dialog;/);
  assert.match(jsx, /const Content = inline \? 'section' : isPhone \? DrawerContent : DialogContent;/);
  assert.match(jsx, /const Close = isPhone \? DrawerClose : DialogClose;/);
  assert.doesNotMatch(jsx, /useDialogFocus|is-closing|setIsClosing|transitionTimerRef|onAnimationEnd|setTimeout\(\s*finish/);
  assert.doesNotMatch(jsx, /modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the sheet must stay modal');

  // PaperCard unmounts the sheet on `onClose`, so the sheet owns `open` --
  // but it is never open on its first render. Base UI seeds `mounted` from
  // `open`, so a drawer that mounts open never reaches `'starting'` and never
  // gets `data-starting-style`, which is where the whole arrival is written
  // (ui/drawer.css). Measured 2026-09-07 at 1280x900: mounted open, the popup
  // stood at its final transform with opacity 1 in the first frame it
  // existed and `getAnimations()` was empty -- the sheet did not arrive, it
  // appeared. `usePopupOpenOnMount` is the one frame that fixes it.
  assert.match(jsx, /import \{ usePopupOpenOnMount \} from '\.\.\/\.\.\/hooks\/usePopupOpenOnMount\.ts';/);
  assert.match(jsx, /const \{ open, setOpen \} = usePopupOpenOnMount\(\);/);
  assert.doesNotMatch(
    jsx,
    /const \[open, setOpen\] = useState(?:<[^;\n]+>)?\(true\);/,
    'a sheet that mounts open never arrives',
  );
  assert.match(jsx, /<Root\s+open=\{open\}\s+onOpenChange=\{\(nextOpen(?:: boolean)?\) => \{ if \(!nextOpen\) requestClose\(\); \}\}\s+onOpenChangeComplete=\{handleOpenChangeComplete\}/);
  assert.match(jsx, /<Content\s[\s\S]*?className=\{`related-sheet related-sheet--graph related-sheet--\$\{sheetStatus\} [\s\S]*?overlayClassName: 'related-overlay',\s*'aria-modal': 'true',/);

  // Every way out takes `open` down and waits: a dismissal and a chosen
  // paper are told apart when the exit has finished, not before.
  const close = jsx.match(/const requestClose = useCallback(?:<[^;\n]+>)?\(\(\) => \{([\s\S]*?)\}, \[setOpen\]\);/);
  assert.ok(close, 'requestClose is gone');
  assert.match(close[1], /setOpen\(false\);/);
  const pick = jsx.match(/const requestPaper = useCallback\(\(relatedPaper: Partial<Paper>, paperKey: string\) => \{([\s\S]*?)\}, \[setOpen, inline, finishSelection\]\);/);
  assert.ok(pick, 'requestPaper is gone');
  assert.match(pick[1], /pendingSelectionRef\.current = \{ paper: relatedPaper as Paper, key: paperKey \};/);
  assert.match(pick[1], /setOpen\(false\);\s*if \(inline\) finishSelection\(\);/);
  assert.match(
    jsx,
    /const handleOpenChangeComplete = useCallback(?:<[^;\n]+>)?\(\(nextOpen(?:: boolean)?\) => \{\s*if \(nextOpen(?:: boolean)?\) return;\s*if \(pendingSelectionRef\.current\) finishSelection\(\);\s*else finishClose\(\);\s*\}, \[finishClose, finishSelection\]\);/,
  );
  const parentTold = jsx.match(/onCloseRef\.current\(\)/g) ?? [];
  assert.equal(parentTold.length, 1, 'onClose reaches the parent from finishClose and nowhere else');
  // The X is the primitive's Close and the first thing focused, as it always was.
  assert.match(jsx, /<Close\s+ref=\{closeButtonRef\}/);
  assert.match(jsx, /initialFocus: closeButtonRef,/);
});

test('wider than a phone the rail\'s Connections tile swaps the abstract for the panel; a phone keeps the sheet', async () => {
  const card = stripComments(await read('./PaperCard.tsx'));
  assert.match(card, /const relatedInline = showRelated && !isPhone;/);
  // The rail's Connections tile is the panel's state, at every width.
  assert.match(card, /className="pc-side-btn pc-side-btn--connections"\s+pressed=\{showRelated\}\s+onPressedChange=\{toggleRelated\}/);
  // The swap grows the card downward: pinned on the press, held while open.
  assert.match(card, /const toggleRelated = \(next: boolean\) => \{\s*if \(!isPhone && !publicMode\) \{\s*pinSheet\(\);[\s\S]*?if \(next\) openRelated\(\);\s*else setShowRelated\(false\);\s*\};/);
  assert.match(card, /const sheetGrown = expanded \|\| authorsExpanded \|\| slotAway;/);
  assert.doesNotMatch(card, /id: 'related'/, 'Related papers left the More menu for the rail');
  // Two quick presses on the map are not a double tap on the card.
  assert.match(card, /event\.target\.closest\('\.related-sheet'\)\) return;/);
  // The two faces slide past each other: the map from the right, the
  // abstract back from the left, the leaving one lifted out of the flow.
  assert.match(card, /<AnimatePresence mode="popLayout" initial=\{false\} custom=\{slotAway \? 1 : -1\}>\s*\{relatedInline \? \(\s*<motion\.div\s+key="connections"[\s\S]*?custom=\{1\}[\s\S]*?<Suspense fallback=\{null\}>\s*<RelatedPapersSheet\s+inline\s/);
  assert.match(card, /<motion\.div\s+key="abstract"\s+className="pc-slot-face"\s+variants=\{slotSlide\}\s+custom=\{-1\}/);
  assert.match(card, /\{showRelated && !relatedInline && \(\s*<Suspense fallback=\{null\}>\s*<RelatedPapersSheet\s/);

  const jsx = stripComments(await read('./RelatedPapersSheet.tsx'));
  // Part of the page, not a popup: nothing modal for FeedContainer to find.
  assert.match(jsx, /\{\.\.\.\(inline \? \{ 'aria-label': 'Paper connections' \} : \{\s*render: <section \/>/);
  // The tile is its way back: the panel names the graph, with no X.
  assert.match(jsx, /\{inline \? \(\s*<div>\s*<GitBranch size=\{18\} \/>\s*<h3>\{'Citation graph'\}<\/h3>/);
  assert.match(jsx, /\{!inline && \(\s*<Close/);
});

test('the sheet\'s map/list switch is one Toggle, drawn by the sheet\'s own rules', async () => {
  const jsx = stripComments(await read('./RelatedPapersSheet.tsx'));
  assert.doesNotMatch(jsx, /<Tabs|TabsTrigger|value="similar"/, 'Similar lives in its own slot face now');
  const header = jsx.slice(jsx.indexOf('<header className="related-header">'), jsx.indexOf('</header>'));
  assert.doesNotMatch(header, /aria-pressed|is-active/, 'the toggle writes its own pressed state');
  // One button whose pressed state is the list, so the view is always one
  // of the two and the name never flips.
  assert.match(jsx, /<Toggle\s+size="icon"\s+className="graph-view-button"\s+pressed=\{view === 'list'\}\s+onPressedChange=\{\(next\) => \{[\s\S]*?setView\(next \? 'list' : 'map'\);\s*\}\}\s+aria-label=\{'List view'\}/);
  // Back on a map already drawn, it stands instead of arriving again; a new
  // centre (a walk forward or back) arrives as before.
  assert.match(jsx, /if \(!next\) setIsMapReturning\(true\);/);
  assert.equal((jsx.match(/setIsMapReturning\(false\);/g) || []).length, 3, 'appendToTrail, goBackTo and requestCentre clear it');
  // A list reached by a switch stands; only the panel's own arrival fades one in.
  assert.equal((jsx.match(/setHasSwitched\(true\);/g) || []).length, 2, 'the view switch and the off-map link mark it');
  assert.equal((jsx.match(/className=\{`related-list \$\{hasSwitched \? 'is-switched' : ''\}`\}/g) || []).length, 1, 'the list reads it');
  const returning = await read('./PaperCard.css');
  assert.match(returning, /\.related-list\.is-switched \{\s*animation: none;/);
  assert.match(returning, /\.graph-map\.is-returning :is\(\.graph-node, \.graph-edge, \.graph-mark, \.graph-chip, \.graph-now\) \{\s*animation: none;/);
  assert.doesNotMatch(jsx, /ToggleGroup/);

  const css = await read('./PaperCard.css');
  assert.match(css, /\.related-header \.graph-view-button\[data-pressed\] \{/, 'the pressed view is styled on the primitive\'s attribute');
  assert.doesNotMatch(css, /\.related-mode-tabs|\.graph-view-button\.is-active/);
});

test('the sheet\'s box carries the drawer\'s bleed, and a chosen paper settles the sheet in place instead of sliding it away', async () => {
  const css = await read('./PaperCard.css');
  const sheet = css.match(/\n\.related-sheet \{([^}]*)\}/);
  assert.ok(sheet, 'PaperCard.css lost .related-sheet');
  // The drawer pulls the sheet `--bleed` below the viewport so an overshoot
  // never shows the page; a height written without it shows that much less.
  assert.match(sheet[1], /height: calc\(min\(68dvh, 610px\) \+ var\(--bleed\)\);/);
  assert.match(sheet[1], /padding-bottom: calc\(var\(--inset-bottom\) \+ var\(--bleed\)\);/);
  assert.match(sheet[1], /transition: transform 400ms cubic-bezier\(0\.32, 0\.72, 0, 1\), height 0\.28s/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /is-closing|relatedSheetIn|relatedSheetOut|relatedBackdropIn|relatedSheetToCard/);
  const select = css.match(/\.related-sheet\.is-selecting-paper\[data-ending-style\]\s*\{([^}]*)\}/);
  assert.ok(select, 'the hand-off pose is gone');
  assert.match(select[1], /opacity: 0;/);
  assert.match(select[1], /transform: translateY\(10px\) scale\(0\.99\);/);
  assert.match(select[1], /transition: transform 0\.21s cubic-bezier\(0\.4, 0, 1, 1\), opacity 0\.21s/);
  const reduced = (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [])
    .find((rule) => /\.related-sheet\.is-selecting-paper\[data-ending-style\]/.test(rule));
  assert.ok(reduced, 'the reduced-motion block does not cover the hand-off pose');
});

test('the related paper opens as a full-screen modal Dialog whose exit plays before the paper is let go of', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  assert.match(jsx, /import \{ Dialog, DialogClose, DialogContent \} from '\.\.\/ui\/dialog\.tsx';/);
  assert.doesNotMatch(jsx, /useDialogFocus|relatedCardTransitionTimerRef|handleRelatedCardAnimationEnd|RELATED_CARD_CLOSE_MS|is-closing/);
  assert.match(jsx, /<Dialog\s+open=\{Boolean\(activeRelatedPaper\) && !isClosingRelatedCard\}\s+onOpenChange=\{\(nextOpen(?:: boolean)?\) => \{ if \(!nextOpen\) closeRelatedCard\(\); \}\}\s+onOpenChangeComplete=\{\(nextOpen(?:: boolean)?\) => \{ if \(!nextOpen\) finishRelatedCardClose\(\); \}\}/);
  assert.doesNotMatch(jsx, /<Dialog\s[\s\S]*?modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the card must stay modal');
  // The primitive centres a dialog; this one is the whole viewport.
  assert.match(jsx, /className="related-card-overlay inset-0 max-w-none translate-x-0 translate-y-0 rounded-none"/);
  assert.match(jsx, /closeLabel=(?:"Back to previous paper"|\{'Back to previous paper'\})/);
  assert.match(jsx, /<DialogClose\s+className="related-card-back"/);
  // Closing only takes `open` down; the paper goes when the exit has played.
  const close = jsx.match(/const closeRelatedCard = useCallback(?:<[^;\n]+>)?\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(close, 'closeRelatedCard is gone');
  assert.match(close[1], /setIsClosingRelatedCard\(true\);/);
  assert.doesNotMatch(close[1], /setSelectedRelatedPaper|setPendingRelatedPaper|setTimeout/);
  const finish = jsx.match(/const finishRelatedCardClose = useCallback(?:<[^;\n]+>)?\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(finish, 'finishRelatedCardClose is gone');
  assert.match(finish[1], /setPendingRelatedPaper\(null\);\s*setSelectedRelatedPaper\(null\);\s*setIsClosingRelatedCard\(false\);/);

  // The popups are portaled, and React bubbles their clicks up this tree:
  // a double tap inside a sheet must not like the card underneath.
  assert.match(jsx, /const handleDoubleTap = useCallback(?:<[^;\n]+>)?\(\(event: MouseEvent\) => \{\s*if \(event\?\.target instanceof Node && !cardRef\.current\?\.contains\(event\.target\)\) return;/);

  const css = await read('./PaperCard.css');
  assert.match(css, /\.related-card-overlay\[data-open\] \{\s*animation: relatedCardIn 280ms var\(--ease-out\)/);
  assert.match(css, /\.related-card-overlay\[data-closed\] \{\s*animation: relatedCardOut 180ms var\(--ease-out\)[^}]*pointer-events: none;/);
  assert.match(css, /\.related-card-scrim \{\s*background: transparent;/, 'the card is opaque; the scrim draws nothing');
});
