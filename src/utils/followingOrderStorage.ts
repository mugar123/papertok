/**
 * Where the Following feed keeps the order it left with.
 *
 * The key lives here rather than inside the page because two modules need to
 * agree on it: the page that writes it, and `utils/appReload.js`, which clears
 * it when the reader asks for a reload. A string duplicated across those two
 * would go stale silently — the feed would come back in its old order after a
 * reload that was supposed to refresh it, and nothing would fail.
 */
export const FOLLOWING_ORDER_STORAGE_KEY = 'papertok_following_order';
