import type { Paper } from '../models/paper.ts';
import { applyKnownPublicationTypes } from '../services/feed-publication-service.ts';
import { isFeedPublication } from '../services/feed-publication-rules.ts';
import { keepNotablePlaces } from '../utils/feed-enrichment.ts';
import { resumeIndex } from '../utils/feed-mount-window.ts';
import { feedResumeMemory, forYouScrollKey } from '../utils/feed-resume-memory.ts';
import { PAGE_SIZE } from './feed-pagination.ts';

// `savedAt` is set only on a snapshot read back from storage. `notableAfter`
// is the card just before a notable card the reader met and dismissed: the
// next page counts its notable place from there (notablePlaceAfterDismissal).
// `excludedIds` is the exclusion snapshot the list's pages were asked with.
export interface FeedSnapshot { papers: Paper[]; page: number; hasMore: boolean; savedAt?: number; notableAfter?: string | null; excludedIds?: string[] }

type SnapshotStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type ResumeMemory = Pick<typeof feedResumeMemory, 'get' | 'remember' | 'persist'>;

const FEED_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const FEED_SNAPSHOT_MAX_PAPERS = PAGE_SIZE * 2;

function feedSnapshotKey(userId: string | null | undefined, signature: string) {
  return `papertok_feed_snapshot_${encodeURIComponent(userId || 'guest')}_${encodeURIComponent(signature)}`;
}

// The card the account's For You opens on in this tab, from the place
// FeedContainer keeps across a reload (feedResumeMemory): -1 when the tab has
// none there and For You opens on the first card, and null when the reader
// left it past every card of `papers`.
function resumedCardIndex(userId: string | null | undefined, papers: Paper[], memory: Pick<ResumeMemory, 'get'>) {
  const place = memory.get(forYouScrollKey(userId));
  if (!place.paperId) return -1;
  if (place.index >= papers.length && !papers.some(paper => paper.id === place.paperId)) return null;
  return resumeIndex({ papers, savedPaperId: place.paperId, savedIndex: place.index });
}

/**
 * The card a restored snapshot puts the reader on until the feed reports one:
 * the card For You will open on, or none, the first card. Only the feed
 * reports the card the reader is on, and a reload can open another page.
 */
export function restoredReaderCardId(userId: string | null, papers: Paper[], memory: Pick<ResumeMemory, 'get'> = feedResumeMemory) {
  return papers[resumedCardIndex(userId, papers, memory) ?? -1]?.id ?? null;
}

export function readFeedSnapshot(
  userId: string | null | undefined,
  signature: string,
  { storage, resumeMemory = feedResumeMemory }: { storage?: SnapshotStorage; resumeMemory?: ResumeMemory } = {},
): (FeedSnapshot & { savedAt: number }) | null {
  if (!userId || !signature) return null;
  // With no snapshot to restore, For You loads its first page again, and the
  // place the reader left would open that new page past its first cards.
  const withoutPlace = () => {
    resumeMemory.remember(forYouScrollKey(userId));
    resumeMemory.persist(forYouScrollKey(userId));
    return null;
  };
  try {
    const target = storage ?? localStorage;
    const snapshot = JSON.parse(target.getItem(feedSnapshotKey(userId, signature)) || 'null');
    if (!snapshot || snapshot.publicationPolicy !== 3 || Date.now() - snapshot.savedAt > FEED_SNAPSHOT_TTL_MS || !Array.isArray(snapshot.papers)) {
      return withoutPlace();
    }
    // A card can be saved before Crossref answered, or kept because the reader
    // was on it. The reader comes back to their card (resumedCardIndex), and
    // as with a late answer (dropUnreachedPublications), only a book after it
    // leaves: the next card takes its place (keepNotablePlaces). The cards
    // they met stay, books included, so their card keeps its id and index.
    const papers = applyKnownPublicationTypes(snapshot.papers);
    const reader = resumedCardIndex(userId, papers, resumeMemory);
    // The snapshot keeps the list's first cards (FEED_SNAPSHOT_MAX_PAPERS), and
    // the reader left past them: it would open on one they met. It goes, with
    // their place, and For You loads again from its first card.
    if (reader === null) {
      target.removeItem(feedSnapshotKey(userId, signature));
      return withoutPlace();
    }
    const met = reader + 1;
    const ahead = papers.slice(met).filter(isFeedPublication);
    return {
      ...snapshot,
      notableAfter: typeof snapshot.notableAfter === 'string' ? snapshot.notableAfter : null,
      excludedIds: Array.isArray(snapshot.excludedIds) ? snapshot.excludedIds.filter((id: unknown) => typeof id === 'string').slice(0, 200) : [],
      papers: [
        ...papers.slice(0, met),
        ...keepNotablePlaces(papers.slice(met), ahead.filter(paper => !paper._notable), ahead.filter(paper => paper._notable)),
      ],
    };
  } catch {
    return withoutPlace();
  }
}

export function writeFeedSnapshot(userId: string | null | undefined, signature: string, snapshot: FeedSnapshot, storage?: SnapshotStorage) {
  if (!userId || !signature || !snapshot?.papers?.length) return;
  try {
    const papers = snapshot.papers.slice(0, FEED_SNAPSHOT_MAX_PAPERS).map(paper => {
      const snapshotPaper = { ...paper };
      delete snapshotPaper.raw;
      return snapshotPaper;
    });
    (storage ?? localStorage).setItem(feedSnapshotKey(userId, signature), JSON.stringify({
      ...snapshot,
      papers,
      publicationPolicy: 3,
      // A restored page updated by late answers keeps its expiry: the
      // fifteen minutes count from when its page was loaded.
      savedAt: snapshot.savedAt ?? Date.now(),
    }));
  } catch {
    // A full browser storage quota must never block the feed.
  }
}
