import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
/** Comments quote the very code these tests pin, so they are stripped first. */
const strip = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for what the paper takeover shows WHILE it is leaving.
 *
 * Every caller owned `selectedPaper` and rendered `{selectedPaper && <PaperCard/>}`
 * inside the overlay. Closing set it to null, so the card left in the same commit
 * that started the exit, and the popup went on playing `fadeOut` plus
 * `paperOverlaySurfaceOut` — 200ms — over an empty surface. Measured 2026-09-11
 * (production build, real session): the frame 49ms into the close showed the page
 * behind it and nothing else where the card had been.
 *
 * The fix is the same one `PaperReader` and `SelectionMenu` already use: Base UI
 * announces the end of the leave with `onOpenChangeComplete(false)`, and the
 * caller keeps a second piece of state — the paper being SHOWN — that outlives
 * `selectedPaper` until then. It is adjusted during render, not in an effect, so
 * a paper opened while another is still leaving takes over immediately instead of
 * one frame late (see `papertok-popup-identity-during-exit`).
 */

const CALLERS = [
  { name: 'Research', path: '../Report/ScientificReport.jsx' },
  { name: 'the explorer', path: '../Explorer/EntityExplorer.jsx' },
  { name: 'search', path: '../Search/SearchPage.jsx' },
  { name: 'the lists page', path: '../Lists/ListsPage.jsx', selected: 'overlayPaper' },
];

test('the overlay tells its caller when the leave has actually finished', async () => {
  const src = strip(await read('./PaperOverlay.jsx'));
  assert.match(
    src,
    /export default function PaperOverlay\(\{[^}]*\bonExitComplete\b[^}]*\}\)/,
    'the caller needs a way to hear the end of the exit',
  );
  assert.match(
    src,
    /onOpenChangeComplete=\{\(nextOpen\) => \{ if \(!nextOpen\) onExitComplete\?\.\(\); \}\}/,
    'Base UI announces it on Dialog.Root, the way PaperReader already listens',
  );
});

for (const { selected = 'selectedPaper', ...caller } of CALLERS) {
  test(`${caller.name} keeps the card on screen until the overlay has finished leaving`, async () => {
    const src = strip(await read(caller.path));

    const start = src.indexOf('const [shownPaper, setShownPaper]');
    assert.notEqual(start, -1, 'the paper being SHOWN is separate from the one selected');
    // Bounded at the adjustment's own closing brace: a fixed-width window
    // swallows whatever happens to follow and the assertions stop meaning anything.
    const block = src.slice(start, src.indexOf('\n  }', start) + 4);
    assert.match(
      block,
      new RegExp(`if \\(${selected} && ${selected} !== shownPaper\\) \\{?\\s*setShownPaper\\(${selected}\\);?\\s*\\}?`),
      'the shown paper follows the selected one up, and only up',
    );
    assert.doesNotMatch(block, /useEffect/, 'an effect would hand over one frame late');

    assert.match(
      src,
      /onExitComplete=\{\(\) => setShownPaper\(null\)\}/,
      'the card is dropped when the leave ends, not when it starts',
    );
    assert.match(
      src,
      /\{shownPaper && \(\s*<PaperCard\s/,
      'the overlay renders the shown paper, not the selected one',
    );
  });

  test(`${caller.name} hands the card no field of the paper it has stopped showing`, async () => {
    const src = strip(await read(caller.path));
    const open = src.indexOf('<PaperCard');
    assert.notEqual(open, -1);
    const props = src.slice(open, src.indexOf('/>', open));
    assert.doesNotMatch(
      props,
      new RegExp(`\\b${selected}\\b`),
      'a prop still reading selectedPaper would go null mid-exit and blank part of the card',
    );
  });
}
