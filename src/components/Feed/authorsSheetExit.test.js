import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

/** Comments are prose, not code: a decoy comment must never satisfy a test. */
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * SOURCE tests for the authors sheet on a phone, which is the path to every
 * author there: the names take no pointer events under 768px, a tap on the
 * row opens the sheet, and the author is picked from it.
 *
 * The sheet is a Base UI Drawer (ui/drawer.jsx) now. What these protect is
 * what the old framer-motion sheet protected: it lives outside the page the
 * transition transforms, a dismissal springs it back down, and picking an
 * author moves it to its leaving pose in phase with the page.
 */
test('the authors sheet is a Base UI Drawer, which lives on the body, outside the page the transition transforms', async () => {
  const jsx = stripComments(await read('./PaperCard.jsx'));
  const sheet = jsx.match(/<Drawer\s[\s\S]*?overlayClassName="pc-authors-modal-overlay"[\s\S]*?<\/Drawer>/);
  assert.ok(sheet, 'the authors sheet is not a Drawer');
  assert.match(sheet[0], /<DrawerContent\s[\s\S]*?className=\{`pc-authors-modal-sheet /);
  assert.match(sheet[0], /aria-modal="true"/, 'FeedContainer probes [aria-modal="true"] to hold the feed still');
  assert.doesNotMatch(sheet[0], /createPortal|AnimatePresence|motion\./, 'the primitive portals and animates the sheet itself');
  assert.doesNotMatch(jsx, /useDialogFocus/, 'Base UI owns the focus trap, Escape and the restore');
  // The drawer's viewport is fixed to the real viewport, which is why the
  // sheet cannot sit inside a transformed page — the primitive portals it
  // to `document.body`.
  const drawer = await read('../ui/drawer.jsx');
  assert.match(drawer, /<DrawerPortal>[\s\S]*?<DrawerPrimitive\.Viewport/);
  const drawerCss = await read('../ui/drawer.css');
  assert.match(drawerCss, /\.ui-drawer-viewport \{\s*position: fixed;/);
});

test('picking an author moves the sheet to its leaving pose and lets the page take it; dismissing it slides it back down', async () => {
  const jsx = stripComments(await read('./PaperCard.jsx'));
  assert.match(jsx, /const \[authorsSheetLeaving, setAuthorsSheetLeaving\] = useState\(false\);/);
  // Somewhere to go: the sheet closes in its leaving pose, in the same
  // render, so the primitive's `data-ending-style` lands with the class;
  // nowhere: dismissed as if by the scrim, on the drawer's own slide.
  assert.match(jsx, /if \(path\) setAuthorsSheetLeaving\(true\);\s*setShowAuthorsModal\(false\);/);
  assert.match(jsx, /if \(path\) navigate\(path\);/);
  assert.match(jsx, /className=\{`pc-authors-modal-sheet \$\{authorsSheetLeaving \? 'is-leaving' : ''\}`\}/);
  // Once the exit has played the pose is put back, so a sheet reopened on
  // the same card arrives clean.
  assert.match(jsx, /onOpenChangeComplete=\{\(nextOpen\) => \{ if \(!nextOpen\) setAuthorsSheetLeaving\(false\); \}\}/);

  const css = await read('./PaperCard.css');
  const leaving = css.match(/\.pc-authors-modal-sheet\.is-leaving\[data-ending-style\]\s*\{([^}]*)\}/);
  assert.ok(leaving, 'PaperCard.css lost the leaving pose');
  assert.match(leaving[1], /opacity: 0;/);
  assert.match(leaving[1], /transform: translateY\(24px\);/);
  // The page leaves in 0.2 s on the same curve.
  assert.match(leaving[1], /transition: transform 0\.18s cubic-bezier\(0\.4, 0, 1, 1\), opacity 0\.18s cubic-bezier\(0\.4, 0, 1, 1\);/);
  assert.match(leaving[1], /pointer-events: none;/, 'a leaving sheet takes no taps');
  // Without the class the exit is the drawer's: a slide back down the screen.
  assert.match(drawerExit(await read('../ui/drawer.css')), /translateY\(calc\(100% - var\(--bleed\) \+ 2px\)\)/);
});

test('reduced motion drops the leaving pose\'s movement along with the drawer\'s slide', async () => {
  const css = await read('./PaperCard.css');
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [];
  const block = reduced.find((rule) => /\.pc-authors-modal-sheet\.is-leaving\[data-ending-style\]/.test(rule));
  assert.ok(block, 'the reduced-motion block does not cover the leaving pose');
  assert.match(block, /\.pc-authors-modal-sheet\.is-leaving\[data-ending-style\] \{\s*transition: none;\s*transform: none;/);
});

function drawerExit(css) {
  const rule = css.match(/\.ui-drawer-popup\[data-starting-style\],\s*\.ui-drawer-popup\[data-ending-style\]\s*\{([^}]*)\}/);
  return rule ? rule[1] : '';
}
