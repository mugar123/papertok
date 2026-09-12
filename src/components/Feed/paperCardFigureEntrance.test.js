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
  assert.match(css, /animation:\s*\n?\s*figureClipIn var\(--fig-in-duration, 420ms\)/);
});

/**
 * SOURCE tests for HOW a clipping arrives, retuned 2026-09-12.
 *
 * Both halves of the old shape fought being seen. `cubic-bezier(0.16, 1, 0.3,
 * 1)` is an expo-out: ~80% of the travel in the first fifth of the run, so a
 * "620ms" entrance had about 100ms of perceptible movement and then crawled.
 * And the stagger was a longer DURATION per slot (620 + 140·index) with the
 * hold pinned at 20% of the run — which puts the four STARTS 28ms apart and
 * the four ENDS 140ms apart, so the clippings began as one clump and each
 * travelled slower than the one before. Duration cannot do both jobs: a
 * stagger the eye can read needs a step of 400ms+, which would leave the last
 * clipping crawling for a second and a half.
 */
test('the clippings stagger by delay and all travel at the same speed', async () => {
  const jsx = strip(await read('./PaperCard.jsx'));
  const scatter = jsx.slice(jsx.indexOf('function figureScatterStyle'), jsx.indexOf('function mergeResearchResources'));
  assert.match(scatter, /'--fig-in-delay': `\$\{index \* FIGURE_ENTRANCE_STAGGER_MS\}ms`/,
    'the stagger is a delay, and it is the thing that varies per slot');
  assert.match(scatter, /'--fig-in-duration': `\$\{FIGURE_ENTRANCE_MS\}ms`/);
  assert.doesNotMatch(scatter, /'--fig-in-duration': [^,]*index/,
    'duration must not carry the stagger again: it made every later clipping slower');
  const stagger = Number(/const FIGURE_ENTRANCE_STAGGER_MS = (\d+);/.exec(jsx)[1]);
  assert.ok(stagger >= 30 && stagger <= 120, `un escalonado que se lee (${stagger}ms)`);
});

test('the entrance spends its run moving, and holds only its first frame', async () => {
  const css = strip(await read('./PaperCard.css'));
  const figure = css.slice(css.indexOf('.pc-figure {'), css.indexOf('}', css.indexOf('.pc-figure {')));
  assert.match(figure, /figureClipIn var\(--fig-in-duration, 420ms\) var\(--ease-out-quad\)\s*\n?\s*var\(--fig-in-delay, 0ms\) backwards/,
    'quad, no expo: el expo-out hace el 80 % del viaje en el primer quinto');
  assert.doesNotMatch(figure, /figureClipIn[^,]*cubic-bezier\(0\.16/, 'y el expo no vuelve por la puerta de atrás');
  assert.doesNotMatch(figure, /forwards|both/,
    'nada de fill hacia adelante: dentro de content-visibility: auto una pose retenida es una figura congelada');
  assert.match(figure, /figureClipDrift[\s\S]{0,140}calc\(var\(--fig-in-delay, 0ms\) \+ var\(--fig-in-duration, 420ms\) \+ 1\.1s\)/,
    'la deriva espera a la entrada ENTERA, retardo incluido, o empieza encima de ella');
  const keyframes = css.slice(css.indexOf('@keyframes figureClipIn'), css.indexOf('}', css.indexOf('@keyframes figureClipIn') + 60));
  assert.doesNotMatch(keyframes, /0%, 20%/,
    'el hueco del 20 % era el escalonado viejo; con retardo de verdad sólo es tiempo muerto dentro de la carrera');
  assert.match(keyframes, /0% \{/);
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

/**
 * A clipping does not arrive twice.
 *
 * Measured 2026-09-12 (production build, real session, back from an author page
 * onto a card with four clippings): the entrance started on the FIRST frame of
 * the return and was still running 450ms after the page had stopped. At the
 * frame the page came to rest the four sat at 0.49, 0.33, 0.10 and 0.00 of
 * their resting 0.62, the last finishing near 750ms — while the card's own
 * `pcArrive` is deliberately at rest on the way back. Half the card treating
 * the return as a return and the other half as a first arrival is what the
 * reader sees as the photographs coming back from nothing.
 *
 * The gate is `useIsPageArriving`, asked at the instant the clippings are handed
 * the entrance — NOT the page's arrival direction, which stays on the root for
 * the whole visit and would silence every card scrolled to afterwards (measured
 * and rejected on 2026-09-11, see 41cd627).
 */
test('SOURCE: a clipping lit while the page is still travelling is resumed, not arrived', async () => {
  const css = await readFile(new URL('./PaperCard.css', import.meta.url), 'utf8');
  const jsx = await readFile(new URL('./PaperCard.jsx', import.meta.url), 'utf8');
  const code = jsx.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

  const resumed = css.match(/\.pc-figure\.is-loaded\.is-resumed \{([^}]*)\}/);
  assert.ok(resumed, 'the resumed pose has a rule of its own');
  assert.doesNotMatch(resumed[1], /figureClipIn/, 'the entrance is what a resumed clipping drops');
  assert.match(resumed[1], /animation: figureClipDrift/, 'and the drift is what it keeps');
  // Re-declared, not layered: `animation` is a shorthand, so naming only the
  // drift here is what takes the entrance away.
  assert.equal((resumed[1].match(/animation:/g) || []).length, 1);

  assert.match(code, /import \{ useIsPageArriving \} from '\.\.\/\.\.\/hooks\/usePageArrival\.js';/);
  assert.match(code, /const isPageArriving = useIsPageArriving\(\);/);
  assert.doesNotMatch(code, /data-nav-direction[^\n]*figure/i, 'the direction outlives the transition; it is the wrong gate');
  // The verdict is taken before the frame is painted, or the entrance flashes
  // for one frame and is then replaced.
  const effect = code.match(/useLayoutEffect\(\(\) => \{\s*if \(!figuresShown\)([\s\S]*?)\s+\}, \[figuresShown, isPageArriving\]\);/);
  assert.ok(effect, 'the verdict is taken in a layout effect keyed on the clippings being shown');
  assert.match(effect[1], /if \(isPageArriving\(\)\) setFiguresResumed\(true\);/);
  assert.match(effect[1], /figuresVerdictRef\.current = true;/, 'and only once per showing');
  assert.match(code, /figuresResumed \? ' is-resumed' : ''/, 'the verdict reaches the element');
});
