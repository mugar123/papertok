import type { PositiveExample } from '../utils/interaction-profile.ts';
import type { OrcidConnection } from './orcid-connection-service.ts';

import type { OrcidWorkDecisions } from './orcid-work-decisions-service.ts';

import { doc, getDoc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase.ts';
import { arrangeOrcidWorks, loadOrcidPublications, readerPapers, unmatchedWorkKeys, type OrcidListedWork } from './orcid-service.ts';
import { decisionsForConnection } from './orcid-work-decisions-service.ts';
import { feedSeedsFrom, feedSeedsStale, OWN_WORK_KEYS_MAX, PUBLICATION_SEEDS_MAX, sameFeedSeeds } from '../utils/publication-seeds.ts';

/**
 * The reader's publications For you ranks by and the names of every work it
 * leaves out (ENG-251, src/utils/publication-seeds.ts), kept in the document
 * of the reader's decisions about their works, users/{uid}/orcid/works:
 * `feedSeeds`, up to PUBLICATION_SEEDS_MAX `{ id, category }`, `feedKeys`,
 * up to OWN_WORK_KEYS_MAX names (`doi:`, `arxiv:`, `openalex:`), and
 * `feedAt`, when they were read from ORCID. Like the decisions they are kept
 * for one connection (`connectedAt`), and the Worker deletes the document
 * when ORCID is disconnected or connected again, and with the account.
 */
export interface FeedSeeds { seeds: PositiveExample[]; keys: string[]; keptAt: number | null }

const NO_SEEDS: FeedSeeds = { seeds: [], keys: [], keptAt: null };

function worksDoc(uid: string) {
  return doc(db, 'users', uid, 'orcid', 'works');
}

function seedsOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): PositiveExample[] => {
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
  if (connectedAt === null || snapshot.get('connectedAt') !== connectedAt) return NO_SEEDS;
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
export function feedSeedsWrite(connectedAt: string, { seeds, keys }: { seeds: PositiveExample[]; keys: string[] }) {
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
export async function saveFeedSeeds(uid: string, connectedAt: string, seeds: { seeds: PositiveExample[]; keys: string[] }, basis: OrcidWorkDecisions) {
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

/** What the account keeps of the reader's publications (`publications`, arrangeOrcidWorks) under `decisions`. */
export function feedSeedsOf(publications: OrcidListedWork[], decisions: OrcidWorkDecisions) {
  return feedSeedsFrom(readerPapers(publications, decisions), unmatchedWorkKeys(publications));
}

/**
 * Keeps the reader's publications for the connection, unless the account
 * already keeps the same ones and they are not stale. Returns what is kept
 * now, or `kept` when nothing was written because the decisions changed.
 */
export async function keepFeedSeeds(
  uid: string, connectedAt: string, publications: OrcidListedWork[], decisions: OrcidWorkDecisions,
  kept: FeedSeeds | null, isStale: (keptAt: number | null) => boolean,
) {
  const next = feedSeedsOf(publications, decisions);
  if (kept && sameFeedSeeds(kept, next) && !isStale(kept.keptAt)) return kept;
  if (!await saveFeedSeeds(uid, connectedAt, next, decisions)) return kept;
  return { ...next, keptAt: Date.now() };
}

/**
 * Reads the reader's works as My profile does and keeps their publications.
 * For a reader who connected ORCID and has not opened My profile since, or
 * whose kept publications are stale. Rejects when ORCID, OpenAlex's list of
 * the iD's works or the account cannot be read, so nothing partial is kept.
 * Resolves null when the decisions changed while ORCID was answering.
 */
export async function refreshFeedSeeds(uid: string, orcid: Pick<OrcidConnection, 'id' | 'host' | 'connectedAt'>) {
  const connectedAt = orcid.connectedAt;
  if (!connectedAt) return null;
  const snapshot = await getDoc(worksDoc(uid));
  // Another tab, or My profile, may have kept fresh ones since the feed read them.
  const current = feedSeedsForConnection(snapshot, connectedAt);
  if (!feedSeedsStale(current.keptAt)) return current;
  const loaded = await loadOrcidPublications(orcid.id, orcid.host, Promise.resolve(decisionsForConnection(snapshot, connectedAt)));
  if (loaded.attributed.failed || loaded.details === 'failed') throw new Error('The works of the ORCID iD could not all be read');
  const { publications } = arrangeOrcidWorks(loaded, loaded.decisions);
  const next = feedSeedsOf(publications, loaded.decisions);
  if (!await saveFeedSeeds(uid, connectedAt, next, loaded.decisions)) return null;
  return { ...next, keptAt: Date.now() };
}
