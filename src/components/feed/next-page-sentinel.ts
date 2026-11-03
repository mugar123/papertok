import { AUTO_RETRY_PAUSE_MS } from '../../context/feed-load-failure.ts';

/** The longest a failed next page waits before the scroll sentinel asks for it again by itself. */
const NEXT_PAGE_RETRY_CAP_MS = 120_000;

/**
 * The automatic retries of a failed next page. FeedContainer keeps one for
 * the feed's lifetime, because each load makes a new sentinel. `failedAt` is
 * when the current failure happened; `used` counts the automatic retries
 * since a page last landed.
 */
export interface NextPageRetries { failedAt: number | null; used: number }

/**
 * Whether the feed's scroll sentinel asks for the next page. FeedContainer
 * makes one per IntersectionObserver, and a new observer each time a load
 * starts or ends. A new observer reports at once that the sentinel is in
 * range, so a reader near the end used to ask for a failed page again as soon
 * as each attempt ended, for as long as the failure lasted (ENG-183).
 *
 * `failed` is the feed's error, the one that also removes the feed's tail. A
 * failed page waits until the reader comes back toward the end (the sentinel
 * leaves range and enters it again) or until its pause has passed since the
 * failure, and is then asked for once. The pause is the feed's retry pause,
 * doubled for each automatic retry already used, up to NEXT_PAGE_RETRY_CAP_MS,
 * so an outage gets fewer requests the longer it lasts. A page that lands
 * starts the pauses again from the shortest. A hidden page sends nothing: a
 * retry that falls due while it is hidden waits until it is shown, since the
 * observer does not report while the page is hidden and the reader cannot see
 * the page arrive. Without a failure, every report in range asks.
 */
export function createNextPageSentinel({ failed, hasMore, loading, loadMore, retries, page }: {
  failed: boolean; hasMore: boolean; loading: boolean; loadMore: () => void; retries: NextPageRetries;
  page: Pick<Document, 'hidden'> & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}) {
  if (failed) {
    retries.failedAt ??= Date.now();
  } else {
    retries.failedAt = null;
    if (!loading) retries.used = 0;
  }
  let waiting = failed;
  let inRange = false;
  const ask = (automatic = false) => {
    if (!inRange || waiting || !hasMore || loading) return;
    if (automatic) retries.used += 1;
    loadMore();
  };
  const due = () => {
    if (page.hidden) {
      page.addEventListener('visibilitychange', due, { once: true });
      return;
    }
    waiting = false;
    ask(true);
  };
  const pause = Math.min(AUTO_RETRY_PAUSE_MS * 2 ** retries.used, NEXT_PAGE_RETRY_CAP_MS);
  const retry = retries.failedAt === null ? null : setTimeout(due, Math.max(0, retries.failedAt + pause - Date.now()));
  return {
    /** The observer's report: whether the sentinel is in range now. */
    report(isIntersecting: boolean) {
      inRange = isIntersecting;
      if (!isIntersecting) waiting = false;
      ask();
    },
    stop() {
      if (retry !== null) clearTimeout(retry);
      page.removeEventListener('visibilitychange', due);
    },
  };
}
