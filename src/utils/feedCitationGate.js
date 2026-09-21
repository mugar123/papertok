/**
 * The wait that keeps the citation count from appearing after the feed.
 *
 * The feed paints before its enrichment on purpose — `// Paint now.` in
 * FeedContext — and OpenAlex, iCite and Europe PMC all arrive later carrying
 * `citationCount`. The `N Citas` chip in a card's metadata row (PaperCard)
 * therefore used to be inserted into a row that was already on screen. On a
 * phone, where that row wraps, that is not a chip appearing: it is a line
 * appearing, and everything under it moves. Reported 2026-09-20.
 *
 * So the first paint of a feed waits for those requests — but under a
 * ceiling, and the ceiling is the whole point. OpenAlex alone is allowed
 * 6500ms (`OPENALEX_FEED_REQUEST_TIMEOUT_MS`), so an ungated wait would turn
 * a bad upstream day into six seconds of loading veil. This waits for what a
 * normal response takes and then gives up and paints, and whatever was still
 * in flight merges late exactly as it did before.
 *
 * This is only for a feed's FIRST paint. Pagination must never come through
 * here: the reader is mid-feed looking at a card, there is no veil to hold,
 * and waiting would only stall the infinite scroll.
 */

/**
 * How long the veil may be held for citations.
 *
 * 1200ms is a little over twice the median enrichment response and well under
 * the point where a loading screen stops reading as loading. The trade is
 * deliberately asymmetric: the cost of waiting too long is a slower start the
 * reader can see, and the cost of waiting too little is the chip landing late
 * — which still has the fade in PaperCard.css under it, so it degrades into
 * the old behaviour made gentler rather than into a bug.
 */
export const CITATION_GATE_MAX_WAIT_MS = 1200;

/**
 * Settles `promises`, or gives up at `maxWaitMs`, whichever comes first.
 *
 * Resolves to one entry per promise, in order: its value if it arrived in
 * time, `null` if it did not. A rejection is a miss, not a throw — a source
 * being down is a feed without that source's numbers, never a feed that
 * fails to paint.
 *
 * The returned array is a snapshot. A value that lands after the cap does not
 * appear in it, because the caller has already painted with it by then; that
 * value reaches the reader through the late merge instead.
 *
 * An empty list resolves immediately rather than sitting out the timer, and
 * the timer is always cleared — a pending one would keep the process (and a
 * test run) alive past its work.
 */
export async function awaitWithinGate(promises, { maxWaitMs = CITATION_GATE_MAX_WAIT_MS } = {}) {
  const list = Array.isArray(promises) ? promises : [];
  if (list.length === 0) return [];

  const slots = list.map((promise) => {
    const slot = { value: null, settled: false };
    slot.done = Promise.resolve(promise).then(
      (value) => { if (!slot.closed) { slot.value = value; slot.settled = true; } },
      () => { slot.settled = true; },
    );
    return slot;
  });

  let timer;
  const cap = new Promise((resolve) => { timer = setTimeout(resolve, maxWaitMs); });
  try {
    await Promise.race([Promise.all(slots.map((slot) => slot.done)), cap]);
  } finally {
    clearTimeout(timer);
  }

  // Close the slots before reading them, so a value resolving in the same
  // microtask queue as this read cannot half-land in the snapshot.
  slots.forEach((slot) => { slot.closed = true; });
  return slots.map((slot) => slot.value);
}
