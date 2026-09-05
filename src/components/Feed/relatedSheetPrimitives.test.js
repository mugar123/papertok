import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Comments are prose, not code: a decoy comment must never satisfy a test. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE tests for the two surfaces a card opens over the feed for a related
 * paper: the connections sheet (a Base UI Drawer) and the paper it hands
 * over to (a full-screen Base UI Dialog). Both used to time their own exit
 * with a class, an `animationend` listener and a fallback timer; the
 * primitive holds the node until the exit has played now, and the parent
 * hears of the close from `onOpenChangeComplete(false)` and nowhere else.
 */
test('the connections sheet is a modal Base UI Drawer that owns its open state and reports the close once', async () => {
  const jsx = stripComments(await read('./RelatedPapersSheet.jsx'));
  assert.match(jsx, /import \{ Drawer, DrawerClose, DrawerContent, DrawerTitle \} from '\.\.\/ui\/drawer\.jsx';/);
  assert.doesNotMatch(jsx, /useDialogFocus|is-closing|setIsClosing|transitionTimerRef|onAnimationEnd|setTimeout\(\s*finish/);
  assert.doesNotMatch(jsx, /modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the sheet must stay modal');

  // PaperCard unmounts the sheet on `onClose`, so the sheet owns `open`.
  assert.match(jsx, /const \[open, setOpen\] = useState\(true\);/);
  assert.match(jsx, /<Drawer\s+open=\{open\}\s+onOpenChange=\{\(nextOpen\) => \{ if \(!nextOpen\) requestClose\(\); \}\}\s+onOpenChangeComplete=\{handleOpenChangeComplete\}/);
  assert.match(jsx, /<DrawerContent\s[\s\S]*?className=\{`related-sheet related-sheet--graph related-sheet--\$\{sheetStatus\} [\s\S]*?overlayClassName="related-overlay"[\s\S]*?aria-modal="true"/);

  // Every way out takes `open` down and waits: a dismissal and a chosen
  // paper are told apart when the exit has finished, not before.
  const close = jsx.match(/const requestClose = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(close, 'requestClose is gone');
  assert.match(close[1], /setOpen\(false\);/);
  const pick = jsx.match(/const requestPaper = useCallback\(\(relatedPaper, paperKey\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(pick, 'requestPaper is gone');
  assert.match(pick[1], /pendingSelectionRef\.current = \{ paper: relatedPaper, key: paperKey \};/);
  assert.match(pick[1], /setOpen\(false\);/);
  assert.match(
    jsx,
    /const handleOpenChangeComplete = useCallback\(\(nextOpen\) => \{\s*if \(nextOpen\) return;\s*if \(pendingSelectionRef\.current\) finishSelection\(\);\s*else finishClose\(\);\s*\}, \[finishClose, finishSelection\]\);/,
  );
  const parentTold = jsx.match(/onCloseRef\.current\(\)/g) ?? [];
  assert.equal(parentTold.length, 1, 'onClose reaches the parent from finishClose and nowhere else');
  // The X is a DrawerClose and the first thing focused, as it always was.
  assert.match(jsx, /<DrawerClose\s+ref=\{closeButtonRef\}/);
  assert.match(jsx, /initialFocus=\{closeButtonRef\}/);
});

test('the sheet\'s mode switch is a Tabs and its map/list switch a ToggleGroup, drawn by the sheet\'s own rules', async () => {
  const jsx = stripComments(await read('./RelatedPapersSheet.jsx'));
  assert.match(jsx, /<Tabs value=\{mode\} onValueChange=\{\(next\) => setMode\(next\)\}>/);
  assert.match(jsx, /<TabsList variant="pill" className="related-mode-tabs" aria-label=/);
  assert.match(jsx, /<TabsTrigger value="graph" disabled=\{!hasGraphIdentifier \|\| Boolean\(selectedPaperKey\)\}>/);
  assert.match(jsx, /<TabsTrigger value="similar" disabled=\{Boolean\(selectedPaperKey\)\}>/);
  assert.doesNotMatch(jsx, /role="tablist"|role="tab"|aria-selected/, 'the primitives write the roles and states');
  const header = jsx.slice(jsx.indexOf('<header className="related-header">'), jsx.indexOf('</header>'));
  assert.doesNotMatch(header, /aria-pressed|is-active/, 'the toggle writes its own pressed state');
  // Base UI's group value is an array; a press on the pressed item reports
  // [] and the view must never go to "neither".
  assert.match(jsx, /<ToggleGroup\s[\s\S]*?value=\{\[view\]\}\s+onValueChange=\{\(\[next\]\) => \{ if \(next\) setView\(next\); \}\}/);
  assert.match(jsx, /<ToggleGroupItem\s+value="map"[\s\S]*?className="graph-view-button"/);
  assert.match(jsx, /<ToggleGroupItem\s+value="list"[\s\S]*?className="graph-view-button"/);

  const css = await read('./PaperCard.css');
  assert.match(css, /\.related-mode-tabs button\[data-active\] \{/, 'the active tab is styled on the primitive\'s attribute');
  assert.match(css, /\.related-header \.graph-view-button\[data-pressed\] \{/, 'the pressed view is styled on the primitive\'s attribute');
  assert.doesNotMatch(css, /\.related-mode-tabs button\.is-active|\.graph-view-button\.is-active/);
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
  const jsx = stripComments(await read('./PaperCard.jsx'));
  assert.match(jsx, /import \{ Dialog, DialogClose, DialogContent \} from '\.\.\/ui\/dialog\.jsx';/);
  assert.doesNotMatch(jsx, /useDialogFocus|relatedCardTransitionTimerRef|handleRelatedCardAnimationEnd|RELATED_CARD_CLOSE_MS|is-closing/);
  assert.match(jsx, /<Dialog\s+open=\{Boolean\(activeRelatedPaper\) && !isClosingRelatedCard\}\s+onOpenChange=\{\(nextOpen\) => \{ if \(!nextOpen\) closeRelatedCard\(\); \}\}\s+onOpenChangeComplete=\{\(nextOpen\) => \{ if \(!nextOpen\) finishRelatedCardClose\(\); \}\}/);
  assert.doesNotMatch(jsx, /<Dialog\s[\s\S]*?modal=\{false\}/, 'FeedContainer probes [aria-modal="true"]; the card must stay modal');
  // The primitive centres a dialog; this one is the whole viewport.
  assert.match(jsx, /className="related-card-overlay inset-0 max-w-none translate-x-0 translate-y-0 rounded-none"/);
  assert.match(jsx, /closeLabel=\{isEnglish \? 'Back to previous paper' : 'Volver al paper anterior'\}/);
  assert.match(jsx, /<DialogClose\s+className="related-card-back"/);
  // Closing only takes `open` down; the paper goes when the exit has played.
  const close = jsx.match(/const closeRelatedCard = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(close, 'closeRelatedCard is gone');
  assert.match(close[1], /setIsClosingRelatedCard\(true\);/);
  assert.doesNotMatch(close[1], /setSelectedRelatedPaper|setPendingRelatedPaper|setTimeout/);
  const finish = jsx.match(/const finishRelatedCardClose = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\);/);
  assert.ok(finish, 'finishRelatedCardClose is gone');
  assert.match(finish[1], /setPendingRelatedPaper\(null\);\s*setSelectedRelatedPaper\(null\);\s*setIsClosingRelatedCard\(false\);/);

  // The popups are portaled, and React bubbles their clicks up this tree:
  // a double tap inside a sheet must not like the card underneath.
  assert.match(jsx, /const handleDoubleTap = useCallback\(\(event\) => \{\s*if \(event\?\.target instanceof Node && !cardRef\.current\?\.contains\(event\.target\)\) return;/);

  const css = await read('./PaperCard.css');
  assert.match(css, /\.related-card-overlay\[data-open\] \{\s*animation: relatedCardIn 0\.32s/);
  assert.match(css, /\.related-card-overlay\[data-closed\] \{\s*animation: relatedCardOut 0\.22s[^}]*pointer-events: none;/);
  assert.match(css, /\.related-card-scrim \{\s*background: transparent;/, 'the card is opaque; the scrim draws nothing');
});
