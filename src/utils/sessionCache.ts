/**
 * A small keep-while-the-tab-lives cache for screens that unmount and remount
 * constantly (profile ⇄ settings, the comments sheet opening and closing).
 *
 * Every one of those remounts used to start from nothing and re-read
 * everything it had shown two seconds earlier — each pass a fresh set of
 * uncancellable round trips, and the user staring at a skeleton for data the
 * page had just had in its hands. A component seeds its state from here and
 * paints immediately; the fresh read still runs and replaces both the state
 * and the cache, so the cost of a remount drops from "wait for the network"
 * to "one quiet revalidation behind data already on screen".
 *
 * Recency-bounded: `set` and `get` refresh an entry's position and the oldest
 * entry falls out past `maxEntries`. Module-scoped by design — this is a
 * per-tab session cache, not storage; nothing here survives a reload.
 */
export function createSessionCache({ maxEntries = 16 } = {}) {
  const entries = new Map();

  return {
    get(key) {
      if (!entries.has(key)) return undefined;
      const value = entries.get(key);
      // Re-insert so recently used entries are the last to be evicted.
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      if (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    delete(key) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
