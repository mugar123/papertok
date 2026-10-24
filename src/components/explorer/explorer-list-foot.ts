/**
 * The foot of the Explorer's lists: the sentinel whose coming into view asks
 * for the next page.
 *
 * A visitor gets no sentinel: it IS the request for page 2, so leaving it on
 * the page would make the two-row preview a coat of paint over a list that
 * kept loading itself. Once the papers list's allowance runs out
 * (`explorerPageAllowance`) the sentinel gives way to "Keep looking".
 */
export function papersSentinelMounted({ publicMode, awaitingReader, hasMore, rowsSettled, rows, isFetchingMore }: {
  publicMode: boolean; awaitingReader: boolean; hasMore: boolean; rowsSettled: boolean; rows: number; isFetchingMore: boolean;
}) {
  return !publicMode && !awaitingReader && hasMore && rowsSettled && (rows > 0 || isFetchingMore);
}

export function authorsSentinelMounted({ publicMode, hasMore, rows, isFetchingMore }: {
  publicMode: boolean; hasMore: boolean; rows: number; isFetchingMore: boolean;
}) {
  return !publicMode && hasMore && (rows > 0 || isFetchingMore);
}

/**
 * What the papers sentinel's report means: `left` when it went off screen
 * while no page loads (the skeleton of a new list pushes the old foot off
 * screen without the reader moving), `reader` or `list` when it asks for the
 * next page and on whose behalf, or null. A new observer reports the foot
 * where it already is, so a page that left it on screen asks again at once:
 * that request is the list's own, and the reader's only once the foot had
 * gone.
 */
export function papersFootReport({ isIntersecting, hasMore, isLoading, isFetchingMore, footHidden }: {
  isIntersecting: boolean; hasMore: boolean; isLoading: boolean; isFetchingMore: boolean; footHidden: boolean;
}): 'left' | 'reader' | 'list' | null {
  if (!isIntersecting) return !isLoading && !isFetchingMore ? 'left' : null;
  if (hasMore && !isLoading && !isFetchingMore) return footHidden ? 'reader' : 'list';
  return null;
}
