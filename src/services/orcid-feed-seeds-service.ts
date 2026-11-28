import type { OrcidConnection } from './orcid-connection-service.ts';
import type { OrcidWorkDecisions } from './orcid-work-decisions-service.ts';
import type { FeedSeeds } from './orcid-feed-seeds-store.ts';

import { getDoc } from 'firebase/firestore';
import { arrangeOrcidWorks, loadOrcidPublications, readerPapers, unmatchedWorkKeys, type OrcidListedWork } from './orcid-service.ts';
import { decisionsForConnection } from './orcid-work-decisions-service.ts';
import { feedSeedsForConnection, saveFeedSeeds, worksDoc } from './orcid-feed-seeds-store.ts';
import { feedSeedsFrom, feedSeedsStale, sameFeedSeeds } from '../utils/publication-seeds.ts';

/**
 * Works out, from the reader's ORCID works, the publications For you ranks by
 * and the names of every work it leaves out (ENG-251), and keeps them in the
 * account (orcid-feed-seeds-store.ts).
 */

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
