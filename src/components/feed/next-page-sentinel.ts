/** How long a failed next page waits before the scroll sentinel asks for it again by itself. */
export const NEXT_PAGE_RETRY_MS = 10_000;

/**
 * Whether the feed's scroll sentinel asks for the next page. FeedContainer
 * makes one per IntersectionObserver, and a new observer each time a load
 * starts or ends. A new observer reports at once that the sentinel is in
 * range, so a reader near the end used to ask for a failed page again as soon
 * as each attempt ended, for as long as the failure lasted (ENG-183).
 *
 * `failed` is the feed's error, the one that also removes the feed's tail. A
 * failed page waits until the reader comes back toward the end (the sentinel
 * leaves range and enters it again) or until NEXT_PAGE_RETRY_MS have passed
 * since this sentinel was made, and is then asked for once. A change to the
 * list makes a new sentinel, so it starts the pause again. Without a failure,
 * every report in range asks.
 */
export function createNextPageSentinel({ failed, hasMore, loading, loadMore }: {
  failed: boolean; hasMore: boolean; loading: boolean; loadMore: () => void;
}) {
  let waiting = failed;
  let inRange = false;
  const ask = () => {
    if (inRange && !waiting && hasMore && !loading) loadMore();
  };
  const retry = failed ? setTimeout(() => { waiting = false; ask(); }, NEXT_PAGE_RETRY_MS) : null;
  return {
    /** The observer's report: whether the sentinel is in range now. */
    report(isIntersecting: boolean) {
      inRange = isIntersecting;
      if (!isIntersecting) waiting = false;
      ask();
    },
    stop() {
      if (retry !== null) clearTimeout(retry);
    },
  };
}
