import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { depsAreSame, planHeightSettle } from './heightSettlePlan.js';

/**
 * The hero body's settle used to keep its memory only on the commits whose
 * deps changed. Every height change without a dep — the Wikipedia toggle
 * mounting a frame after the paragraph, the reader folding the experience
 * panel — left the memory behind, and the next dep animated the box from a
 * height it had already left: measured on a topic page, the list jumped 27px
 * up and slid back down 1.4s after the paragraph had landed.
 */
test('the first commit only remembers', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: null, depsChanged: true, running: null, current: null, natural: 226 }),
    { action: 'none', remember: 226 },
  );
});

test('a declared change animates from the remembered height to the natural one', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 237.9, depsChanged: true, running: null, current: null, natural: 479.3 }),
    { action: 'animate', from: 237.9, to: 479.3, remember: 479.3 },
  );
});

test('a change too small to see is not animated', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 226, depsChanged: true, running: null, current: null, natural: 226.6 }),
    { action: 'none', remember: 226.6 },
  );
});

test('a commit without a declared change re-syncs the memory instead of animating', () => {
  // The reader folded the panel: the box is at 243 and nothing declared it.
  assert.deepEqual(
    planHeightSettle({ remembered: 216.4, depsChanged: false, running: null, current: null, natural: 243.4 }),
    { action: 'none', remember: 243.4 },
  );
});

test('a settle in flight whose target moved is re-aimed from where the box is', () => {
  // Measured: Wikipedia lands (146 → 216.4), the toggle mounts a frame later
  // and the natural height is 243.4. Without this the box eased to 216.4 and
  // snapped +27px the frame the settle let go.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 17 }, current: 146.3, natural: 243.4 }),
    { action: 'animate', from: 146.3, to: 243.4, remember: 243.4 },
  );
});

test('a settle in flight whose target did not move resumes on its own clock', () => {
  // A row chunk mounted under the list mid-settle: nothing about the hero
  // changed, so the same keyframes carry on from the same instant.
  assert.deepEqual(
    planHeightSettle({ remembered: 146, depsChanged: false, running: { from: 146, to: 216.4, currentTime: 200 }, current: 205, natural: 216.4 }),
    { action: 'resume', from: 146, to: 216.4, currentTime: 200, remember: 216.4 },
  );
});

test('depsAreSame compares position by position with Object.is', () => {
  assert.equal(depsAreSame(null, [1]), false);
  assert.equal(depsAreSame([1, 'a', null], [1, 'a', null]), true);
  assert.equal(depsAreSame([1, 'a'], [1, 'b']), false);
  assert.equal(depsAreSame([NaN], [NaN]), true);
  assert.equal(depsAreSame([1], [1, 2]), false);
});

/**
 * A settle carries a datum that lands late on a page the reader is already
 * looking at. While the route transition is still moving the page, the page
 * itself is the displacement and a settle is a second owner of it. Measured
 * 2026-09-07 stepping back from an author to the institution it was opened
 * from: four settles inside 76ms, each restarting a full 360ms clock under a
 * reveal that was still running, with the tab strip dipping 16px instead of
 * being where it was left.
 */
test('a suspended commit starts nothing, whatever the heights say', () => {
  assert.deepEqual(
    planHeightSettle({ remembered: 114, depsChanged: true, running: null, current: null, natural: 237.9, suspended: true }),
    { action: 'none', remember: 237.9 },
  );
});

test('a suspended commit still remembers the box, so the first change after the page lands settles from the right height', () => {
  const plan = planHeightSettle({ remembered: 114, depsChanged: true, running: null, current: null, natural: 316.8, suspended: true });
  assert.equal(plan.remember, 316.8);
  // And that memory is what the next, unsuspended commit animates FROM.
  assert.deepEqual(
    planHeightSettle({ remembered: plan.remember, depsChanged: true, running: null, current: null, natural: 380, suspended: false }),
    { action: 'animate', from: 316.8, to: 380, remember: 380 },
  );
});

test('suspension is not the same as no change: without it the same commit animates', () => {
  const args = { remembered: 114, depsChanged: true, running: null, current: null, natural: 237.9 };
  assert.equal(planHeightSettle({ ...args, suspended: true }).action, 'none');
  assert.equal(planHeightSettle({ ...args, suspended: false }).action, 'animate');
  assert.equal(planHeightSettle(args).action, 'animate', 'and omitting it keeps the old behaviour');
});

/**
 * SOURCE: the hook is the half of this that node cannot run — it needs a DOM,
 * a layout and a running animation. These pin the two decisions it makes on its
 * own, both of which a passing pure suite would otherwise leave free.
 */
const hookSource = async () => (await readFile(new URL('./useHeightSettle.js', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');

test('SOURCE: the hook asks whether it is suspended, and hands the answer to the plan', async () => {
  const code = await hookSource();
  assert.match(code, /const standDown = typeof suspended === 'function' && suspended\(\);/,
    'the predicate is called inside the layout effect, where the DOM is current');
  assert.match(code, /planHeightSettle\(\{[^}]*suspended: standDown[^}]*\}\)/,
    'and the plan is the one that decides, so the decision stays testable');
});

/**
 * Suspension was briefly a second thing as well — a latch a child raised while
 * animating its own height — and the hook grew a `resync` for it: the memory
 * taken while suspended was a frame of THAT animation, so the first commit
 * after it re-synced instead of animating. Measured 2026-09-09, it also fired
 * for the route arrival, where the memory was honest (the page travels by
 * transform), and snapped the skeleton→hero handover on every forward or back
 * navigation. There is one suspender again, and the memory it keeps is true,
 * so nothing re-syncs: the first change after the page lands animates from it.
 */
test('there is no resync: the first change after a suspended commit animates from the memory it kept', () => {
  const suspended = planHeightSettle({ remembered: 114, depsChanged: true, running: null, current: null, natural: 316.8, suspended: true });
  assert.deepEqual(
    planHeightSettle({ remembered: suspended.remember, depsChanged: true, running: null, current: null, natural: 380, suspended: false, resync: true }),
    { action: 'animate', from: 316.8, to: 380, remember: 380 },
    'a stray `resync: true` must change nothing — the option is gone',
  );
});

test('SOURCE: the hook keeps no memory between commits beyond the height and the deps', async () => {
  const code = await hookSource();
  assert.doesNotMatch(code, /staleMemoryRef/, 'no stale flag');
  assert.doesNotMatch(code, /resync/, 'no resync');
  assert.doesNotMatch(code, /if \(standDown && inFlight\)/, 'no hand-over branch: with the route arrival as the only suspender there is never a settle in flight to hand over');
  assert.match(code, /const plan = planHeightSettle\(\{ remembered: lastHeightRef\.current, depsChanged, running, current, natural, suspended: standDown \}\);/);
});
