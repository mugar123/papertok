import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Full-line comments only: a `//` inside a string would otherwise cut the line.
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const read = async (path) => stripComments(await readFile(new URL(path, import.meta.url), 'utf8'));

/**
 * SOURCE tests for the route transition (spec:
 * docs/superpowers/specs/2026-09-06-transicion-tarjeta-entidad-design.md).
 *
 * Measured before this, signed in, chunk warm: `mode="wait"` made the two
 * pages strictly sequential — two frames with no page painted between the
 * feed going and the entity arriving, an exit on an ease-in put there to
 * hide that gap, ~500ms from tap to a still page. The pages coexist now: the
 * deeper one on top, the other held opaque underneath.
 */
test('the two pages of one navigation coexist, and App tells them about it once', async () => {
  const app = await read('../../App.jsx');
  assert.match(app, /<AnimatePresence mode="sync" initial=\{false\} custom=\{pageTransitionCustom\}>/);
  assert.doesNotMatch(app, /mode="wait"/, 'no page waits for another to finish leaving');
  assert.match(app, /const pageTransitionCustom = usePageTransitionCustom\(\)/);
  assert.match(app, /<PageTransitionCustomProvider value=\{pageTransitionCustom\}>/);
  // Exactly one caller, or the direction memory goes backwards.
  assert.equal((app.match(/usePageTransitionCustom\(\)/g) || []).length, 1);
});

test('a page is a plain element the stylesheet moves, not a motion component', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /^import \{ usePresence, usePresenceData \} from 'framer-motion';$/m, 'framer is the bookkeeper, nothing more');
  assert.match(jsx, /^import '\.\/PageTransition\.css';$/m);
  assert.match(jsx, /^import \{ EXIT_SAFETY_MS, isArrivalMotion, pageMotionFor \} from '\.\/pageMotion\.js';$/m);
  for (const gone of [/\bmotion\./, /useReducedMotion/, /variants/, /\bx:/, /ease/, /TRAVEL_PX/, /duration/]) {
    assert.doesNotMatch(jsx, gone, `${gone} left with the old transition`);
  }
  assert.match(jsx, /<div\s+ref=\{rootRef\}\s+className="page-transition"\s+data-nav-direction=\{present \? direction : arrivedWith\}\s+data-leave-direction=\{present \? undefined : direction\}\s+data-page-motion=\{motion\}\s+inert=\{!present \|\| undefined\}\s+onAnimationEnd=\{handleAnimationEnd\}\s*>/);
  assert.match(jsx, /const motion = present && settled \? 'rest' : pageMotionFor\(\{ direction, lateral, present \}\);/);
});

test('the leaving page reads the navigation that ejects it, and never computes one', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /const \[present, safeToRemove\] = usePresence\(\);/);
  assert.match(jsx, /const presenceCustom = usePresenceData\(\);/);
  assert.match(jsx, /const providerCustom = usePageTransitionCustomValue\(\);/);
  assert.match(jsx, /const \{ direction, lateral \} = presenceCustom \?\? providerCustom;/);
  assert.doesNotMatch(jsx, /usePageTransitionCustom\(\)/, 'the component never computes the direction itself');
  // A component file that also exports a function breaks Fast Refresh.
  assert.doesNotMatch(jsx, /export function/, 'PageTransition.jsx exports only its component');
});

test('a move between navbar tabs takes its direction from the bar, not from history', async () => {
  const hook = await read('../../hooks/usePageTransitionCustom.js');
  assert.match(hook, /import \{ lateralTabDirection \} from '\.\.\/utils\/tabDirection\.js';/);
  // The lateral answer wins; history is the fallback, not the other way round.
  assert.match(hook, /const lateral = lateralTabDirection\(useLocation\(\)\.pathname\);/);
  assert.match(hook, /return \{ direction: lateral \?\? historyDirection, lateral: lateral !== null \};/);
});

test('the leaving page hands itself back when its own animation ends, or when the clock runs out', async () => {
  const jsx = await read('./PageTransition.jsx');
  const handler = jsx.match(/const handleAnimationEnd = useCallback\(\(event\) => \{([\s\S]*?)\n {2}\}, \[present, safeToRemove\]\);/);
  assert.ok(handler, 'one animationend handler, keyed on presence');
  assert.match(handler[1], /if \(event\.target !== rootRef\.current\) return;/, 'the cards\' and the hero\'s animationend bubble here too');
  assert.match(handler[1], /if \(present\) setSettled\(true\);/);
  assert.match(handler[1], /else if \(safeToRemove\) safeToRemove\(\);/);
  const clock = jsx.match(/useEffect\(\(\) => \{\s*if \(present\) return undefined;([\s\S]*?)\}, \[present\]\);/);
  assert.ok(clock, 'the safety clock is keyed on presence alone');
  assert.match(clock[1], /const timer = window\.setTimeout\(\(\) => \{\s*if \(root\) root\.style\.visibility = 'hidden';\s*if \(safeToRemoveRef\.current\) safeToRemoveRef\.current\(\);\s*\}, EXIT_SAFETY_MS\);/, 'a page nobody removes is at least hidden');
  assert.match(clock[1], /return \(\) => window\.clearTimeout\(timer\);/);
  assert.match(jsx, /const safeToRemoveRef = useRef\(safeToRemove\);/);
  assert.match(jsx, /if \(present\) root\.style\.visibility = '';/, 'a page present again is visible again');
});

test('the leaving page is lifted by the scroll it had, tracked only while present', async () => {
  const jsx = await read('./PageTransition.jsx');
  const tracker = jsx.match(/useLayoutEffect\(\(\) => \{\s*if \(!present\) return undefined;([\s\S]*?)\}, \[present\]\);/);
  assert.ok(tracker, 'the scroll listener lives and dies with presence, in the layout phase');
  assert.match(tracker[1], /window\.addEventListener\('scroll', record, \{ passive: true \}\);/);
  assert.match(tracker[1], /return \(\) => window\.removeEventListener\('scroll', record\);/);
  assert.match(jsx, /root\.style\.top = present \? '' : `\$\{-scrollYRef\.current\}px`;/);
});

test('a new page starts at the top, instantly, and only when it is a step somewhere', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /const arrivalDirection = useRef\(direction\);/);
  assert.match(jsx, /useLayoutEffect\(\(\) => \{\s*if \(arrivalDirection\.current !== 0\) window\.scrollTo\(\{ top: 0, behavior: 'instant' \}\);\s*\}, \[\]\);/);
});

test('a cold chunk suspends inside the page arriving', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /^import RouteFallback from '\.\/RouteFallback\.jsx';$/m);
  assert.match(jsx, /<Suspense fallback=\{<RouteFallback \/>\}>\{children\}<\/Suspense>/);
  const app = await read('../../App.jsx');
  // The outer boundary stays as the net for anything that suspends outside a page.
  assert.ok((app.match(/<Suspense fallback=\{<RouteFallback \/>\}>/g) || []).length >= 1);
});

test('a page re-entered while leaving arrives again instead of snapping to rest', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /const \[wasPresent, setWasPresent\] = useState\(present\);\s*if \(present !== wasPresent\) \{\s*setWasPresent\(present\);\s*if \(present\) \{\s*setSettled\(false\);\s*setArrivedWith\(direction\);\s*\}\s*\}/);
  assert.match(jsx, /const \[arrivedWith, setArrivedWith\] = useState\(direction\);/);
  // Before the reset: the motion formula still keys on `settled`.
  assert.match(jsx, /const motion = present && settled \? 'rest' : pageMotionFor\(\{ direction, lateral, present \}\);/);
});

test('the leaving page keeps the direction it arrived with, so the held feed\'s cards stay at rest', async () => {
  const jsx = await read('./PageTransition.jsx');
  assert.match(jsx, /data-nav-direction=\{present \? direction : arrivedWith\}/);
  assert.doesNotMatch(jsx, /data-nav-direction=\{direction\}/);
  const css = await read('../Feed/PaperCard.css');
  // The rule this protects: cards at rest under a page reached by the back arrow.
  assert.match(css, /\[data-nav-direction="-1"\] \.pc-title,/);
});
