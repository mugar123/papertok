/** Under this many pixels a change is not worth a movement. */
const SAME_HEIGHT_PX = 1;

/**
 * What a height settle should do on this commit. Pure: the hook measures and
 * animates, this decides.
 *
 * - `remembered`: the natural height remembered from the previous commit, or
 *   null on the first one.
 * - `depsChanged`: whether the pieces of state declared to change the height
 *   changed on this commit.
 * - `running`: the settle already in flight, read BEFORE cancelling it —
 *   `{ from, to, currentTime }` — or null.
 * - `current`: the box's animated height right now (meaningful only with a
 *   settle in flight).
 * - `natural`: the box's height with nothing holding it, measured on this
 *   commit.
 * - `resync`: the first commit after something else has been owning the box.
 *   The memory kept while it was suspended is a frame of SOMEONE ELSE'S
 *   animation — a height read half way through a fold's unfold — and animating
 *   from it drops the box to that stale value in one frame before easing back
 *   up. Down, then up, with nothing on screen having caused the drop. So this
 *   commit re-syncs and animates nothing; the box is already where it belongs.
 * - `suspended`: whether something outside the box owns its displacement on
 *   this commit — the route transition still moving the whole page. Then there
 *   is nothing to carry: a settle under a page that is itself travelling is a
 *   second animation of the same content on a different clock. The memory is
 *   still kept, so the first change after the page lands settles from the right
 *   height.
 *
 * `remember` is always the natural height. The memory follows the box on
 * EVERY commit, so a height that changed without a declared dep — a toggle
 * mounting a frame late, the reader folding a panel — can never make the next
 * settle start from a height the box is no longer at (measured before this:
 * the list jumped 27px up and slid back down when a thumbnail loaded 1.4s
 * after the paragraph).
 *
 * A settle in flight is read every commit too. If its target still stands,
 * it resumes on the same keyframes and clock; if the target moved under it
 * (the toggle landing a frame after the paragraph it belongs to), it is
 * re-aimed from where the box is, so the box never eases to a height that is
 * already wrong and snaps the difference at the end.
 */
export function planHeightSettle({ remembered, depsChanged, running, current, natural, suspended, resync }) {
  const remember = natural;
  // Both checked before the in-flight branch: neither decides anything about an
  // animation that is already running, they simply do not start one.
  if (suspended || resync) return { action: 'none', remember };
  if (running) {
    if (Math.abs(natural - running.to) < SAME_HEIGHT_PX) {
      return { action: 'resume', from: running.from, to: running.to, currentTime: running.currentTime, remember };
    }
    return { action: 'animate', from: current, to: natural, remember };
  }
  if (remembered == null || !depsChanged || Math.abs(natural - remembered) < SAME_HEIGHT_PX) {
    return { action: 'none', remember };
  }
  return { action: 'animate', from: remembered, to: natural, remember };
}

/** Whether two dependency lists are the same, the way React compares them. */
export function depsAreSame(previous, next) {
  if (previous == null || next == null) return false;
  if (previous.length !== next.length) return false;
  return previous.every((value, index) => Object.is(value, next[index]));
}
