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

/**
 * SOURCE tests for WHETHER a card is born with the clippings it already has.
 *
 * Measured 2026-09-11 (production build, real session, Research -> For you):
 * the page reached rest at 237ms and the four `.pc-figure` elements did not
 * exist until 290ms. No request went out — they were in `figureCache` with
 * their bytes in the browser — but the only door into that cache was
 * `getPaperFigures`, an async call behind a 240ms settle timer. So the
 * clippings landed on a card that had already stopped moving, and with the
 * entrance re-armed per mount (above) the reader watched them arrive late.
 *
 * The fix is a synchronous cache read at first render. Two things are pinned
 * here: that the initial state comes from `peekPaperFigures`, and that the
 * reset for a NEW paper in the same card — the overlay surfaces reuse one
 * instance — happens during render, not in an effect. An effect would leave
 * one frame where the previous paper's clippings are painted against this one.
 */
test('the card is born with whatever the figure cache already holds', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  assert.match(
    src,
    /import \{[^}]*\bpeekPaperFigures\b[^}]*\} from '\.\.\/\.\.\/services\/paperFigureService\.js'/,
    'the synchronous cache read is imported',
  );
  assert.match(
    src,
    /const \[figures, setFigures\] = useState\(\(\) => peekPaperFigures\(paper\)\?\.slice\(0, 4\) \?\? \[\]\)/,
    'the first render already has them; `useState([])` would arrive empty',
  );
});

test('a new paper in the same card resets the clippings during render, not in an effect', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  const start = src.indexOf('const [figuresPaperKey, setFiguresPaperKey]');
  assert.notEqual(start, -1, 'the reset keeps the key it last reset for');
  // Bounded at the `if` block's own closing brace: a wider window swallows the
  // next effect in the file and the assertion below stops meaning anything.
  const block = src.slice(start, src.indexOf('\n  }', start) + 4);
  assert.match(block, /if \(figuresPaperKey !== paperViewKey\) \{/);
  assert.match(block, /setFiguresPaperKey\(paperViewKey\)/);
  assert.match(block, /setFigures\(peekPaperFigures\(paper\)\?\.slice\(0, 4\) \?\? \[\]\)/);
  assert.doesNotMatch(
    block,
    /useEffect/,
    'an effect runs after the paint that already showed the previous paper\'s clippings',
  );
});

test('a card that already has its clippings does not go asking for them again', async () => {
  const src = strip(await read('./PaperCard.jsx'));
  const start = src.indexOf('getPaperFigures(paper)');
  assert.notEqual(start, -1);
  const effect = src.slice(src.lastIndexOf('useEffect', start), start);
  assert.match(
    effect,
    /if \(!isCardSettled \|\| figures\.length > 0\) return/,
    'the settle timer is only for a card that arrived without them',
  );
});
