/**
 * Map over items with a ceiling on how many run at once.
 *
 * `Promise.all(items.map(...))` has no ceiling: it starts everything, and the
 * width of the burst is whatever the data happens to be. That is fine for a
 * handful of items and wrong for a fan-out that scales with an account — the
 * reading library issues one `in` query per ten paper ids, so a full library
 * fired sixty Firestore reads in a single burst down one WebChannel, and the
 * screen's own reads queued behind them.
 *
 * Returns settled results in input order — `{ status: 'fulfilled', value }` or
 * `{ status: 'rejected', reason }` — so one failure cannot abandon the workers
 * that are still running. Callers that want the first failure to win re-throw
 * it themselves.
 *
 * Lifted out of followingUpdatesService, which has bounded its own fan-out this
 * way since it shipped; this is the same helper, not a second one.
 */
export async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    worker,
  ));
  return results;
}
