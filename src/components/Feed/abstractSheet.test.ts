import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path: string|URL) => readFile(new URL(path, import.meta.url), 'utf8');
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for the abstract panel's two doors (2026-09-18).
 *
 * Tapping an abstract that fits whole used to flip `expanded` on, and the
 * toggle reserved beneath it — invisible until then — came up saying "Show
 * less" for a panel that had never been anything but open (reproduced on
 * the guest feed, desktop). A panel that hides nothing has nothing to open.
 */
test('a panel that hides nothing cannot be opened, so the reserved toggle never says "Show less"', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  assert.match(jsx, /const toggleExpanded = \(e: SyntheticEvent, newState: boolean\) => \{\s*e\.stopPropagation\(\);\s*if \(newState && abstractClipped !== true\) return;/);
});

/**
 * On a phone the card's column is bottom-anchored and short, so the unfolded
 * panel scrolls inside a box a few lines tall. A clipped abstract opens a
 * bottom sheet there instead — gated by pointer type, like the reader's
 * selection route, never by width — and the card's own panel stays put.
 */
test('on a touch screen or at phone width a clipped abstract opens the reading sheet instead of unfolding in the card', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  assert.match(jsx, /const coarsePointer = useMemo\(\(\) => \{\s*try \{ return window\.matchMedia\('\(pointer: coarse\)'\)\.matches; \} catch \{ return false; \}\s*\}, \[\]\);/);
  assert.match(jsx, /const readsInSheet = \(coarsePointer \|\| isPhone\) && abstractClipped === true && !expanded;/, 'a touch screen or a phone-width window reads in the sheet');
  assert.match(jsx, /const openAbstract = \(e: SyntheticEvent\) => \{\s*if \(readsInSheet\) \{\s*e\.stopPropagation\(\);\s*setShowAbstractSheet\(true\);\s*return;\s*\}\s*toggleExpanded\(e, !expanded\);\s*\};/);
  assert.match(jsx, /className=\{`pc-abstract \$\{expanded[^`]*`\}\s*onClick=\{openAbstract\}/);
  assert.match(jsx, /className=\{`pc-abstract-toggle\$\{abstractClipped === true \|\| expanded \? '' : ' pc-abstract-toggle--reserved'\}`\}\s*aria-expanded=\{readsInSheet \? undefined : expanded\}\s*aria-haspopup=\{readsInSheet \? 'dialog' : undefined\}\s*aria-controls=\{readsInSheet \? undefined : abstractId\}\s*onClick=\{openAbstract\}/);
  assert.match(jsx, /\{showAbstractSheet && \(\s*<AbstractSheet paper=\{paper\} onClose=\{closeAbstractSheet\} \/>\s*\)\}/);
});

test('the reading sheet is a bottom drawer that arrives, scrolls inside and leaves before it unmounts', async () => {
  const jsx = stripComments(await read('./AbstractSheet.tsx'));
  assert.match(jsx, /const \{ open, requestClose \} = usePopupOpenOnMount\(\);/);
  assert.match(jsx, /onOpenChange=\{\(next\) => \{ if \(!next\) requestClose\(\); \}\}/);
  assert.match(jsx, /onOpenChangeComplete=\{\(next\) => \{ if \(!next\) onClose\(\); \}\}/);
  assert.match(jsx, /<DrawerBody className="abstract-sheet-body" data-base-ui-swipe-ignore>/);
  assert.match(jsx, /<ScientificText>\{paper\.abstract\}<\/ScientificText>/);
  assert.match(jsx, /initialFocus=\{closeRef\}/);
  const css = stripComments(await read('./AbstractSheet.css'));
  assert.match(css, /\.abstract-sheet-body p \{[^}]*font-family: var\(--font-serif\);[^}]*font-size: 1\.0625rem;[^}]*line-height: 1\.72;/);
  assert.match(css, /\.abstract-sheet-body \{[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;/);
});

test('the sheet head is the field in its own colour and the title, closed by a ghost button', async () => {
  const jsx = stripComments(await read('./AbstractSheet.tsx'));
  assert.match(jsx, /style=\{\{ '--area-accent': areaAccentForPaper\(paper\) \}\}/);
  assert.doesNotMatch(jsx, /abstract-sheet-authors/, 'the card already shows its authors');
  assert.match(jsx, /<DrawerClose\s*ref=\{closeRef\}\s*render=\{<Button variant="ghost" size="icon-sm" aria-label=\{'Close'\} \/>\}/);
  const css = stripComments(await read('./AbstractSheet.css'));
  assert.match(css, /\.abstract-sheet-kicker \{[^}]*color: var\(--area-accent, var\(--accent-primary\)\);/);
  assert.match(css, /\.abstract-sheet-heading \{[^}]*gap: var\(--space-2\);/);
});

test('the collapsed abstract fades out on a whole line, never half of one', async () => {
  const jsx = stripComments(await read('./PaperCard.tsx'));
  assert.match(jsx, /const cut = clipped && line > 0 \? shown % line : 0;\s*node\.style\.setProperty\('--pc-abstract-cut', `\$\{cut\}px`\);/);
  const css = stripComments(await read('./PaperCard.css'));
  const words = css.match(/\.pc-abstract > p \{[^}]*\}/)?.[0] || '';
  assert.doesNotMatch(words, /\{[^}]*\{/, 'no rule nested inside the paragraph rule');
  assert.match(words, /line-height: 1\.6;/);
  assert.match(css, /\n\.pc-abstract \{\s*-webkit-mask-image: linear-gradient\(to bottom, black 60%, transparent 100%\);[^}]*mask-size: 100% calc\(100% - var\(--pc-abstract-cut, 0px\)\);[^}]*mask-repeat: no-repeat;/);
  assert.match(css, /\n\.pc-abstract \{[^}]*cursor: pointer;\s*\}/, 'the cursor is a declaration again, not comment text');
});
