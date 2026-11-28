import type { OrcidWorkDecisions } from './orcid-work-decisions-service.ts';

import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase.ts';
import { decisionsForConnection } from './orcid-work-decisions-service.ts';
import { OWN_WORK_KEYS_MAX, PUBLICATION_SEEDS_MAX } from '../utils/publication-seed-limits.ts';

/**
 * The reader's publications For you ranks by and the names of every work it
 * leaves out (ENG-251, src/utils/publication-seeds.ts), kept in the document
 * of the reader's decisions about their works, users/{uid}/orcid/works:
 * `feedSeeds`, up to PUBLICATION_SEEDS_MAX `{ id, category }`, `feedKeys`,
 * up to OWN_WORK_KEYS_MAX names (`doi:`, `arxiv:`, `openalex:`), and
 * `feedAt`, when they were read from ORCID. Like the decisions they are kept
 * for one connection (`connectedAt`), and the Worker deletes the document
 * when ORCID is disconnected or connected again, and with the account.
 *
 * Only Firestore and the decisions' own module here, so the rules tests can
 * write as the app does without loading ORCID, OpenAlex or the taxonomy
 * (orcid-feed-seeds-service.ts works the publications out).
 */
export interface FeedSeed { id: string; category: string }
export interface FeedSeeds { seeds: FeedSeed[]; keys: string[]; keptAt: number | null }

const NO_FEED_SEEDS: FeedSeeds = { seeds: [], keys: [], keptAt: null };

export function worksDoc(uid: string) {
  return doc(db, 'users', uid, 'orcid', 'works');
}

function seedsOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): FeedSeed[] => {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const category = typeof entry?.category === 'string' ? entry.category : '';
    return id ? [{ id, category }] : [];
  }).slice(0, PUBLICATION_SEEDS_MAX);
}

function millisOf(value: unknown) {
  const toMillis = (value as { toMillis?: () => number } | null)?.toMillis;
  return typeof toMillis === 'function' ? toMillis.call(value) : null;
}

/** What `snapshot` keeps for the connection made at `connectedAt`; nothing for another connection. */
export function feedSeedsForConnection(snapshot: { get(field: string): unknown }, connectedAt: string | null): FeedSeeds {
  if (connectedAt === null || snapshot.get('connectedAt') !== connectedAt) return NO_FEED_SEEDS;
  const keys = snapshot.get('feedKeys');
  return {
    seeds: seedsOf(snapshot.get('feedSeeds')),
    keys: Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string').slice(0, OWN_WORK_KEYS_MAX) : [],
    keptAt: millisOf(snapshot.get('feedAt')),
  };
}

/** What the account keeps for the connection made at `connectedAt`. A failed read rejects. */
export async function readFeedSeeds(uid: string, connectedAt: string | null) {
  return feedSeedsForConnection(await getDoc(worksDoc(uid)), connectedAt);
}

/**
 * The write that keeps `seeds` for the connection made at `connectedAt`. It
 * leaves the decisions as they are; the rules refuse it once that is no
 * longer the account's connection.
 */
export function feedSeedsWrite(connectedAt: string, { seeds, keys }: { seeds: FeedSeed[]; keys: string[] }) {
  return {
    connectedAt,
    feedSeeds: seeds.map(({ id, category }) => ({ id, category })),
    feedKeys: keys,
    feedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function sameKeys(a: string[], b: string[]) {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(key => right.has(key));
}

/** Whether two sets of decisions name the same works, whatever their order. */
export function sameDecisions(a: OrcidWorkDecisions, b: OrcidWorkDecisions) {
  return sameKeys(a.mine, b.mine) && sameKeys(a.notMine, b.notMine);
}

/**
 * Keeps `seeds`, worked out from the decisions `basis`, unless the account's
 * decisions changed meanwhile (another tab, or this one while ORCID was
 * answering): then it writes nothing and resolves false, so a work the reader
 * just marked "Not mine" is never kept as theirs.
 */
export async function saveFeedSeeds(uid: string, connectedAt: string, seeds: { seeds: FeedSeed[]; keys: string[] }, basis: OrcidWorkDecisions) {
  const ref = worksDoc(uid);
  return runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.get('connectedAt');
    if (stored !== undefined && stored !== connectedAt) return false;
    if (!sameDecisions(decisionsForConnection(snapshot, connectedAt), basis)) return false;
    transaction.set(ref, feedSeedsWrite(connectedAt, seeds), { merge: true });
    return true;
  });
}
