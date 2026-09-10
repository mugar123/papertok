import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
/** Comments quote the very code these tests pin, so they are stripped first. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * SOURCE tests for WHEN a feed clipping plays its entrance.
 *
 * `figureClipIn` used to be gated on the image's `load`, and an image loads
 * exactly once. Measured 2026-09-11 (production build, real session, the
 * reader's own path: feed -> institution page -> back):
 *
 *   - cold, first sight of the card: `figureClipIn:running@0` climbing to @650
 *     with opacity 0 -> 0.62. The entrance played.
 *   - coming back from the entity page: the FIRST frame the figures existed
 *     they already carried `is-loaded` and `figureClipIn@0` — the pictures were
 *     in the browser's cache, so `complete` was true the instant the <img>
 *     attached, and the 620ms entrance ran 262ms into a 300ms page transition.
 *   - every later arrival at that card: `figureClipIn` gone from
 *     `getAnimations()` entirely, the figures sitting at the resting pose. Four
 *     of seven clippings reached the screen with their entrance already spent.
 *
 * So the class has to mean "the picture is in hand AND the card is in front of
 * the reader", not "the bytes arrived". Then it goes away when the card leaves
 * and comes back when the card does — and a CSS animation restarts when its
 * element is given it again, which is what re-arms the entrance for free.
 */
test('a clipping is shown as loaded only while its card is in front of the reader', async () => {
  const jsx = strip(await read('./PaperCard.jsx'));
  const className = jsx.match(/className=\{`pc-figure\$\{[^`]*`\}/)?.[0] || '';
  assert.ok(className, 'the figure still builds its className from a template literal');
  // Both halves, or the entrance goes back to being a one-shot on `load`.
  assert.match(className, /loadedFigures\.has\(item\.url\)/, 'the picture must be in hand');
  assert.match(className, /figuresLit/, 'and the card must be in front of the reader');
});

/**
 * The two ends of a card's turn on screen need different thresholds. Armed at
 * the same 15% that starts the fetch, the entrance is still running when the
 * card is centred. Disarmed at 15% as well, the OUTGOING card cut its figures
 * from 0.62 to 0 in one frame with a sliver still on screen — a flicker on
 * every swipe. So it is only put out once the card has left entirely.
 */
test('the clippings are lit at 15% but only put out once the card is gone entirely', async () => {
  const jsx = strip(await read('./PaperCard.jsx'));
  assert.match(jsx, /if \(entry\.isIntersecting && entry\.intersectionRatio >= 0\.15\) setFiguresLit\(true\);/);
  assert.match(jsx, /else if \(!entry\.isIntersecting\) setFiguresLit\(false\);/);
  // A single symmetric flag is exactly what this must not collapse back into.
  assert.doesNotMatch(jsx, /setFiguresLit\(entry\.isIntersecting && entry\.intersectionRatio >= 0\.15\)/);
});

test('the entrance is withheld by the same class the stylesheet gates it on', async () => {
  const css = strip(await read('./PaperCard.css'));
  const withheld = css.match(/\.pc-figure:not\(\.is-loaded\) \{[^}]*\}/)?.[0] || '';
  assert.ok(withheld, 'the withholding rule exists');
  assert.match(withheld, /opacity: 0;/);
  assert.match(withheld, /animation: none;/);
  // And the entrance itself is still the thing being withheld.
  assert.match(css, /animation:\s*\n?\s*figureClipIn var\(--fig-in-duration, 620ms\)/);
});

/**
 * The visibility flag this leans on is the card's OWN observer, not the
 * container's prefetch one: `FeedContainer` watches with
 * `rootMargin: '0px 0px 200% 0px'`, which is true for cards two screens away.
 * Gating the entrance on that would put it back to running off screen.
 */
test('the flag is the card\'s own 15% observer, so it cannot be true off screen', async () => {
  const jsx = strip(await read('./PaperCard.jsx'));
  assert.match(jsx, /setIsCardVisible\(entry\.isIntersecting && entry\.intersectionRatio >= 0\.15\)/);
  assert.doesNotMatch(jsx, /setIsCardVisible[\s\S]{0,200}rootMargin/);
});
