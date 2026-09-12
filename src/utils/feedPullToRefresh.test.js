import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  PULL_REFRESH_THRESHOLD_PX,
  PULL_FLING_MIN_PX,
  PULL_BAND_MIN_PX,
  pullBandDepth,
  PULL_BLOCKING_SCROLLERS,
  pullStartFrom,
  pullTakesOver,
  pullProgress,
  PULL_MAX_TRAVEL_PX,
  pullTravelPx,
  pullOutcome,
} from './feedPullToRefresh.js';

const plain = { closest: () => null };
const insideAbstract = { closest: (sel) => (sel === PULL_BLOCKING_SCROLLERS ? {} : null) };
// The scroller sits under the navbar, so its own top is the band's origin,
// and it is as tall as the phone minus the bar.
const TOP = 52;
const H = 792;
const BAND = pullBandDepth(H);

test('on the first card the whole card is the gesture: there is nothing above to scroll to', () => {
  assert.equal(pullStartFrom({ target: plain, scrollTop: 0, clientY: 700, containerTop: TOP }), 700);
  assert.equal(pullStartFrom({ target: plain, scrollTop: 0, clientY: TOP + 4, containerTop: TOP }), TOP + 4);
});

test('on any other card only the band under the navbar arms a pull', () => {
  const at = (y) => pullStartFrom({ target: plain, scrollTop: 812, clientY: y, containerTop: TOP, containerHeight: H });
  assert.equal(at(TOP + 10), TOP + 10, 'inside the band');
  assert.equal(at(TOP + BAND), TOP + BAND, 'the band includes its own edge');
  assert.equal(at(TOP + BAND + 1), null, 'one pixel past it is the feed\'s gesture');
  assert.equal(at(600), null, 'the middle of the card still goes to the previous paper');
});

test('the band is a third of the feed, and never less than the floor', () => {
  assert.equal(pullBandDepth(792), 264, 'a phone: the upper third, not a sliver under the bar');
  assert.equal(pullBandDepth(300), PULL_BAND_MIN_PX, 'a short screen keeps a reachable floor');
  assert.equal(pullBandDepth(0), PULL_BAND_MIN_PX);
  assert.ok(pullBandDepth(792) < 792 / 2, 'and never past halfway: the lower half is the previous paper');
});

test('a drag that begins inside the open abstract is refused, wherever the feed is', () => {
  assert.equal(pullStartFrom({ target: insideAbstract, scrollTop: 0, clientY: 200, containerTop: TOP }), null);
  assert.equal(pullStartFrom({ target: insideAbstract, scrollTop: 812, clientY: TOP + 4, containerTop: TOP, containerHeight: H }), null);
});

test('the first move decides: down is the pull, up is the feed, sideways is neither', () => {
  const move = (dy, dx = 0) => pullTakesOver({ startY: 300, startX: 180, currentY: 300 + dy, currentX: 180 + dx });
  assert.equal(move(6), true, 'a few pixels down is enough to decide, before the browser scrolls');
  assert.equal(move(-6), false, 'up is the swipe to the next paper');
  assert.equal(move(0), false);
  assert.equal(move(10, 40), false, 'more sideways than vertical is not a pull');
  assert.equal(move(40, 10), true);
});

test('progress grows with the distance and is clamped to 1', () => {
  assert.equal(pullProgress({ startY: 100, currentY: 100 }), 0);
  assert.equal(pullProgress({ startY: 100, currentY: 60 }), 0, 'upwards is not a pull');
  assert.equal(pullProgress({ startY: 100, currentY: 100 + PULL_REFRESH_THRESHOLD_PX / 2 }), 0.5);
  assert.equal(pullProgress({ startY: 100, currentY: 100 + PULL_REFRESH_THRESHOLD_PX * 3 }), 1);
  assert.equal(pullProgress({ startY: null, currentY: 400 }), 0);
});

/**
 * El recorrido que siguen los papers. Resistido, no crudo: el tirón devuelve
 * casi todo el movimiento al principio y cada vez menos después. Y es a
 * propósito que NO comparte el clamp de `pullProgress`: la píldora deja de
 * crecer en el umbral, pero el feed tiene que seguir contestando al pulgar
 * justo cuando el lector está decidiendo si soltar.
 */
test('the feed follows the finger with resistance, and never runs out of it', () => {
  assert.equal(pullTravelPx({ startY: 100, currentY: 100 }), 0, 'quieto no viaja');
  assert.equal(pullTravelPx({ startY: 100, currentY: 40 }), 0, 'hacia arriba tampoco');
  assert.equal(pullTravelPx({ startY: undefined, currentY: 300 }), 0);
  const at = (dy) => pullTravelPx({ startY: 0, currentY: dy });
  // Resistencia: siempre menos que el dedo, y proporcionalmente menos cuanto
  // más se tira. Un tirón lineal no es un tirón.
  for (const dy of [10, 50, 110, 240, 600]) assert.ok(at(dy) < dy, `${dy}px de dedo mueven menos de ${dy}px`);
  assert.ok(at(10) / 10 > at(110) / 110, 'los primeros píxeles siguen al pulgar mucho más de cerca que los últimos');
  assert.ok(at(110) / 110 > at(600) / 600);
  // Monótono y acotado: nunca retrocede, nunca llega al techo.
  let last = 0;
  for (let dy = 1; dy <= 900; dy += 7) { const v = at(dy); assert.ok(v > last, `monótono en ${dy}`); assert.ok(v < PULL_MAX_TRAVEL_PX); last = v; }
  // En el umbral el feed ha abierto un hueco donde cabe la píldora.
  assert.ok(Math.abs(at(PULL_REFRESH_THRESHOLD_PX) - 59) < 1.5, `~59px en el umbral (${at(PULL_REFRESH_THRESHOLD_PX).toFixed(1)})`);
  // Y pasado el umbral SIGUE contestando, que es lo que `pullProgress` no hace.
  assert.equal(pullProgress({ startY: 0, currentY: 200 }), pullProgress({ startY: 0, currentY: 400 }), 'el progreso sí se satura');
  assert.ok(at(400) - at(200) > 8, 'el recorrido no: el feed sigue vivo bajo el pulgar');
});

test('a slow drag refreshes only past the threshold', () => {
  const slow = (dy) => pullOutcome({ startY: 100, endY: 100 + dy, elapsedMs: 2000 });
  assert.equal(slow(PULL_REFRESH_THRESHOLD_PX - 1), 'none');
  assert.equal(slow(PULL_REFRESH_THRESHOLD_PX + 1), 'refresh');
});

test('a fast fling refreshes before the threshold, but never a tremor', () => {
  const fast = (dy, ms) => pullOutcome({ startY: 100, endY: 100 + dy, elapsedMs: ms });
  assert.equal(fast(60, 30), 'refresh', '60px in 30ms is 2px/ms: a fling');
  assert.equal(fast(PULL_FLING_MIN_PX - 5, 10), 'none', 'too short to be a decision');
  assert.equal(fast(60, 200), 'none', '60px in 200ms is a slow drag short of the threshold');
});

/**
 * The blocking list must keep describing what really scrolls inside a card:
 * an `overflow-y: auto` added to PaperCard.css without an entry here would
 * silently reopen the abstract's bug for the new scroller.
 */
test('SOURCE: every in-card vertical scroller is on the blocking list', async () => {
  const css = (await readFile(new URL('../components/Feed/PaperCard.css', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/overflow(?:-y)?\s*:\s*(?:hidden\s+)?(?:auto|scroll)\b/.test(m[2])) selectors.push(m[1].trim());
  }
  const blocked = PULL_BLOCKING_SCROLLERS.split(',').map((s) => s.trim());
  const uncovered = selectors.filter((sel) => !blocked.some((b) => sel.includes(b.replace(/^\./, ''))));
  assert.deepEqual(uncovered.filter((s) => /^\.pc-abstract/.test(s)), [], 'an abstract scroller escaped the list');
});
