// What one `POST /store/papers` request spent its time on, written to Workers
// Logs only when the request took longer than SLOW_FEED_MS on the Worker
// (worker/README.md, "Slow feed requests"). The line names no reader, paper,
// lane, interest or query: only the route, step durations and counts.

const SLOW_FEED_MS = 1_500;

type FeedStep =
  | 'auth' | 'body' | 'quota' | 'follows' | 'ids' | 'likesWait' | 'cacheRead' | 'keys' | 'wave1' | 'notableCheck'
  | 'vectors' | 'rankCpu' | 'walk' | 'works' | 'cacheWrite';
type FeedCount = 'lanes' | 'groups' | 'candidates' | 'notable' | 'vectors' | 'vectorRounds';

/**
 * Durations in milliseconds by `Date.now()`, summed when a step runs more than
 * once. On Workers the clock moves only when I/O completes, so CPU work between
 * two reads is counted in the step that waits on the next read.
 */
export class FeedTimings {
  private readonly steps: Partial<Record<FeedStep, number>> = {};
  private readonly counts: Partial<Record<FeedCount, number>> = {};
  private kept?: 'hit' | 'miss';
  private ended = false;

  /** Adds the time since `started` to `step`. */
  since(step: FeedStep, started: number) {
    this.steps[step] = (this.steps[step] ?? 0) + Date.now() - started;
  }

  count(name: FeedCount, value: number) {
    this.counts[name] = value;
  }

  /** Whether a later page found the order kept in this location's cache. */
  keptOrder(found: boolean) {
    this.kept = found ? 'hit' : 'miss';
  }

  /**
   * Ends the request: answered with the Worker's `status` and error `code` (a
   * fixed number and code, never the reader's data), or `aborted` by a client
   * that went away first. Only the first call can write a line.
   */
  logIfSlow(route: string, totalMs: number, outcome: { status: number; code?: string } | { aborted: true }) {
    if (this.ended) return;
    this.ended = true;
    if (totalMs <= SLOW_FEED_MS) return;
    console.log(JSON.stringify({
      event: 'slow_feed_request',
      route,
      ...('aborted' in outcome ? { aborted: true } : { status: outcome.status, ...(outcome.code ? { code: outcome.code } : {}) }),
      totalMs,
      steps: this.steps,
      counts: this.counts,
      ...(this.kept ? { cache: this.kept } : {}),
    }));
  }
}
