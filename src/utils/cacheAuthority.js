/**
 * When a Firestore answer is worth acting on, and when it only looks like one.
 *
 * `getDocs` and `getDoc` do not reject when the backend is unreachable. They
 * resolve against the local cache, and this app keeps Firestore's in-memory
 * cache on purpose (see firebase.js), so on a freshly loaded page that answer
 * is an *empty success*. Measured against the live backend with the connection
 * down and a query target the page had not asked for before: 0 documents,
 * `fromCache: true`, in 0.5 ms, no rejection.
 *
 * Every bug in this family is the same mistake — treating that as knowledge:
 *
 * - The save-and-organize modal told an account with four lists it had none.
 * - The lists page dropped a custom list from the grid with no error shown.
 * - A public list that exists rendered as "not found".
 *
 * So the rule, in one place: **data in hand is data; an absence has to come
 * from the server.** A snapshot that *has* content is always worth using,
 * cached or not — stale data beats a spinner and the revalidation behind it
 * corrects it. Only emptiness needs the server to vouch for it.
 *
 * A caller that gets `false` must treat it as retryable — never as a confirmed
 * absence, and never as a failure it blames on the user.
 */

/** True when a query snapshot's contents can be acted on. */
export function queryIsAuthoritative(snapshot) {
  if (!snapshot) return false;
  const empty = snapshot.empty ?? snapshot.size === 0;
  if (!empty) return true;
  return snapshot.metadata?.fromCache !== true;
}

/**
 * True when a document snapshot's existence — or non-existence — can be acted
 * on. A document that is present is present; only "this document does not
 * exist" needs the server to have said so.
 */
export function documentIsAuthoritative(snapshot) {
  if (!snapshot) return false;
  if (typeof snapshot.exists === 'function' ? snapshot.exists() : snapshot.exists) return true;
  return snapshot.metadata?.fromCache !== true;
}
