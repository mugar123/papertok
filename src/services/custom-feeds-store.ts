/**
 * Firestore wiring for an account's custom feeds: one document,
 * `users/{uid}/settings/customFeeds`, holding `feeds` and `updatedAt`. What
 * makes a feed well formed belongs to utils/custom-feeds.ts; this module reads
 * the document through it and writes only what it would read back.
 */
import { doc, onSnapshot, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase.ts';
import { settleWithin } from '../utils/async-timing.ts';
import { documentIsAuthoritative } from '../utils/cache-authority.ts';
import { CustomFeedError, ingredientKey, parseCustomFeeds, type CustomFeed } from '../utils/custom-feeds.ts';

export const CUSTOM_FEEDS_WRITE_MS = 8_000;

const FEED_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const FEED_ID_LENGTH = 12;

const customFeedsRef = (uid: string) => doc(db, 'users', uid, 'settings', 'customFeeds');

/**
 * Calls `onFeeds` with the account's feeds each time Firestore answers. A
 * snapshot from the local cache saying the document does not exist is not an
 * answer (the server may hold feeds the cache never saw), so it is skipped and
 * the server's snapshot is awaited.
 */
export function subscribeCustomFeeds(uid: string, onFeeds: (feeds: CustomFeed[]) => void, onError: (error: unknown) => void): () => void {
  // With metadata changes, so the server confirming an absence the cache
  // already reported still reaches the callback.
  return onSnapshot(customFeedsRef(uid), { includeMetadataChanges: true }, (snapshot) => {
    if (!documentIsAuthoritative(snapshot)) return;
    onFeeds(parseCustomFeeds(snapshot.data()?.feeds));
  }, onError);
}

/** Reads the stored list, applies `change` and writes the result, in one transaction. Rejects after CUSTOM_FEEDS_WRITE_MS. */
export type TransactFeeds = (apply: (stored: unknown) => CustomFeed[]) => Promise<CustomFeed[]>;

function firestoreTransact(uid: string): TransactFeeds {
  const ref = customFeedsRef(uid);
  return apply => runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const feeds = apply(snapshot.data()?.feeds);
    transaction.set(ref, { feeds, updatedAt: serverTimestamp() });
    return feeds;
  });
}

/** What a list of feeds says, independent of the key order of its objects. */
const fingerprint = (feeds: CustomFeed[]) => JSON.stringify(feeds.map(feed => [
  feed.id,
  feed.name,
  feed.order,
  feed.ingredients.map(ingredient => [ingredientKey(ingredient), 'label' in ingredient ? ingredient.label : null]),
]));

/**
 * Counts the listener's answers, so a write that resolves late can tell
 * whether the listener has since shown a list newer than the one it wrote.
 */
export function createAnswerTracker() {
  let answers = 0;
  return {
    answered() { answers += 1; },
    /** Call when a write begins; the returned check is true while no answer has arrived since. */
    beginWrite() {
      const atStart = answers;
      return () => answers === atStart;
    },
  };
}

/**
 * Applies `change` to the list the server holds, which another device may
 * have changed since this one last read it, and resolves with the list
 * written. A `CustomFeedError` thrown by `change` rejects with nothing
 * written, and so does a change the model would not read back unaltered
 * (`CustomFeedError('invalid')`). A write that has not settled within the deadline rejects, though it
 * may still land; the subscription shows it if it does.
 */
export async function changeCustomFeeds(
  uid: string,
  change: (feeds: CustomFeed[]) => CustomFeed[],
  deps: { transact?: TransactFeeds; timeoutMs?: number } = {},
): Promise<CustomFeed[]> {
  const transact = deps.transact ?? firestoreTransact(uid);
  const settled = await settleWithin(transact((stored) => {
    const changed = change(parseCustomFeeds(stored));
    const feeds = parseCustomFeeds(changed);
    // Parsing also enforces the account-wide ceilings, trimming ingredients
    // from whichever feed comes later, possibly one nobody edited. A change
    // the parse would alter in any way is refused rather than written trimmed.
    if (fingerprint(feeds) !== fingerprint(changed)) throw new CustomFeedError('invalid');
    return feeds;
  }), deps.timeoutMs ?? CUSTOM_FEEDS_WRITE_MS);
  if (settled.status === 'fulfilled') return settled.value;
  if (settled.status === 'rejected') throw settled.reason;
  throw new Error('changeCustomFeeds: the write did not settle in time');
}

/** A feed id: 12 characters of [a-z0-9]. `random` returns a number in [0, 1), as `Math.random` does. */
export function newFeedId(random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32): string {
  let id = '';
  for (let index = 0; index < FEED_ID_LENGTH; index += 1) {
    id += FEED_ID_ALPHABET[Math.floor(random() * FEED_ID_ALPHABET.length)];
  }
  return id;
}
