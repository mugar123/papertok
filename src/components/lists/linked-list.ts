/**
 * What the lists page shows for the list its address names (`/lists/:listId`).
 *
 * The page's own read is one bounded page of the account's lists, and the copy
 * it starts from is the session's. Neither has to hold the list: an assistant
 * the reader connected may have made it a second ago, and an account with more
 * lists than a page holds reads only some. So a list the page does not hold is
 * asked for by itself before the page says it does not exist.
 *
 * - `none`: the address names no list, and the page is the index it was.
 * - `open`: the page holds the list, and opens it.
 * - `waiting`: the lists are still loading, or the list is being asked for.
 * - `missing`: the account has no such list.
 * - `unavailable`: the list could not be asked for.
 */
export type LinkedListView = 'none' | 'open' | 'waiting' | 'missing' | 'unavailable';

/** What asking for the list by itself found, once it has answered. */
export type LinkedListAnswer = 'missing' | 'failed';

/**
 * Whether `id` can name a list's document. An address can carry any text, and
 * the Firestore client throws on a name with a slash; `.`, `..` and `__…__`
 * are names Firestore refuses.
 */
function canNameList(id: string) {
  return id !== '' && id.length <= 160 && !id.includes('/') && id !== '.' && id !== '..' && !/^__.*__$/.test(id);
}

export function linkedListView({ listId, held, loading, answer }: {
  listId: string | undefined;
  /** The page holds a list with this id, one of its own three included. */
  held: boolean;
  loading: boolean;
  answer: LinkedListAnswer | null;
}): LinkedListView {
  if (listId === undefined) return 'none';
  if (held) return 'open';
  if (!canNameList(listId)) return 'missing';
  if (loading || answer === null) return 'waiting';
  return answer === 'missing' ? 'missing' : 'unavailable';
}

/** Whether the list is to be asked for by itself now: the page's own read has ended without it. */
export function linkedListNeedsRead(view: LinkedListView, loading: boolean) {
  return view === 'waiting' && !loading;
}
