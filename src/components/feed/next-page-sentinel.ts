import { AUTO_RETRY_PAUSE_MS } from '../../context/feed-load-failure.ts';

/** The longest a failed next page waits before the scroll sentinel asks for it again by itself. */
const NEXT_PAGE_RETRY_CAP_MS = 120_000;

/**
 * The automatic retries of a failed next page. FeedContainer keeps one for
 * the feed's lifetime, because each load makes a new sentinel. `failedAt` is
 * when the current failure happened, on the page's monotonic clock
 * (`performance.now`), so a corrected system clock cannot stretch or skip a
 * pause; `used` counts the automatic retries that started since a page last
 * landed.
 */
export interface NextPageRetries { failedAt: number | null; used: number }

/**
 * Whether the feed's scroll sentinel asks for the next page. FeedContainer
 * makes one per IntersectionObserver, and a new observer each time a load
 * starts or ends. A new observer reports at once that the sentinel is in
 * range, so a reader near the end used to ask for a failed page again as soon
 * as each attempt ended, for as long as the failure lasted (ENG-183).
 *
 * `failed` is the feed's error, the one that also turns the feed's tail into
 * its failure and Try again. A failed page waits until the reader comes back
 * toward the end (the sentinel leaves range and enters it again) or until its
 * pause has passed since the failure, and is then asked for once. The pause is
 * the feed's retry pause, doubled for each automatic retry already used, up to
 * NEXT_PAGE_RETRY_CAP_MS, so an outage gets fewer requests the longer it
 * lasts. A page that lands starts the pauses again from the shortest. A hidden
 * page sends nothing: a retry that falls due while it is hidden waits until it
 * is shown, since the observer does not report while the page is hidden and
 * the reader cannot see the page arrive. A pause that ends before the
 * observer's first report, which a hidden page holds back, still asks as the
 * automatic retry when that report finds the sentinel in range. Without a
 * failure, every report in range asks.
 */
export function createNextPageSentinel({ failed, hasMore, loading, loadMore, retries, page }: {
  failed: boolean; hasMore: boolean; loading: boolean; retries: NextPageRetries;
  /**
   * Asks for the next page; `automatic_retry` when the pause, not the reader,
   * asks. Says whether a load started: a refused one is not counted.
   */
  loadMore: (attempt?: 'automatic_retry') => boolean;
  page: Pick<Document, 'hidden'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}) {
  if (failed) {
    retries.failedAt ??= performance.now();
  } else {
    retries.failedAt = null;
    if (!loading) retries.used = 0;
  }
  let waiting = failed;
  // Null until the observer's first report.
  let inRange: boolean | null = null;
  // The pause ended before that report.
  let owed = false;
  // Whether `loadMore` refused a request that was otherwise due.
  const ask = (attempt?: 'automatic_retry') => {
    if (!inRange || waiting || !hasMore || loading) return false;
    const started = loadMore(attempt);
    if (started && attempt) retries.used += 1;
    return !started;
  };
  const pause = Math.min(AUTO_RETRY_PAUSE_MS * 2 ** retries.used, NEXT_PAGE_RETRY_CAP_MS);
  let retry: ReturnType<typeof setTimeout> | null = null;
  const due = () => {
    if (page.hidden) {
      page.addEventListener('visibilitychange', due, { once: true });
      return;
    }
    waiting = false;
    owed = inRange === null;
    // A retry the feed refuses (a load is on its way, or a retry is due) is
    // armed again a pause later, at the same spacing, so it is not lost.
    if (ask('automatic_retry')) retry = setTimeout(due, pause);
  };
  retry = retries.failedAt === null ? null : setTimeout(due, Math.max(0, retries.failedAt + pause - performance.now()));
  return {
    /** The observer's report: whether the sentinel is in range now. */
    report(isIntersecting: boolean) {
      inRange = isIntersecting;
      if (!isIntersecting) waiting = false;
      const attempt = owed ? 'automatic_retry' : undefined;
      owed = false;
      ask(attempt);
    },
    stop() {
      if (retry !== null) clearTimeout(retry);
      page.removeEventListener('visibilitychange', due);
    },
  };
}
