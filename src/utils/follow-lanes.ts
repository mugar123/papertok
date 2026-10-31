import { getAllLeafCategories } from '../data/category-taxonomy.ts';
import { MAX_FOLLOWED_JOURNALS } from './following.ts';

// The lane a followed entity is served from, shared by the Worker, which
// files and reads the lanes (worker/paper-store.ts), and the app, which sends
// a page's request only the follows the Worker reads.

/** How many follows other than journals a page of the corpus reads (`parseFeedRequest`). */
export const FEED_MAX_FOLLOWS = 20;

const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));
const FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project', 'journal']);
const OPENALEX_ENTITY = /^https?:\/\/openalex\.org\/([AITCS]\d+)$|^([AITCS]\d+)$/i;
const ENTITY_LANE_KINDS: Record<string, string> = { A: 'author', I: 'institution', T: 'topic', C: 'concept', S: 'source' };

const text = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The lane of an OpenAlex author, institution, topic, concept or source id, or '' for anything else. */
export function entityLane(value: unknown) {
  const match = text(value).match(OPENALEX_ENTITY);
  const id = (match?.[1] || match?.[2] || '').toUpperCase();
  return id ? `${ENTITY_LANE_KINDS[id[0]]}:${id}` : '';
}

type FollowLaneInput = { type?: unknown; canonicalId?: unknown; displayName?: unknown; metadata?: { query?: unknown; funder?: unknown } | null };

/**
 * The lane a followed entity is served from: the OpenAlex entity a paper
 * names (a journal is its OpenAlex source), a search for a followed query or
 * an author known by name only, or a funded project. A topic that is one of
 * the app's categories is asked for as that category instead, and gets no
 * lane here.
 */
export function followLane(follow: FollowLaneInput) {
  const type = text(follow?.type);
  const canonicalId = text(follow?.canonicalId).split('/').pop()!.slice(0, 200);
  if (!FOLLOW_TYPES.has(type) || !canonicalId) return '';
  if (type === 'project') {
    const funder = text(follow.metadata?.funder).slice(0, 80);
    return `project:${funder ? `${funder}|` : ''}${canonicalId}`;
  }
  const entity = entityLane(canonicalId);
  // By its source id alone: a journal's name is no search for its papers.
  if (type === 'journal') return entity.startsWith('source:') ? entity : '';
  if (entity && (type === 'topic' ? /^(topic|concept):/.test(entity) : entity.startsWith(`${type}:`))) return entity;
  if (LEAF_IDS.has(canonicalId)) return '';
  const query = text(type === 'topic' ? follow.metadata?.query || follow.displayName : follow.displayName).toLowerCase().slice(0, 120);
  if (!query) return '';
  return type === 'author' ? `author-name:${query}` : type === 'topic' ? `query:${query}` : '';
}

/**
 * The follows a page of the corpus reads, in their order, each with its lane:
 * the first MAX_FOLLOWED_JOURNALS journals, whatever a client stored, since
 * each is a lane the nightly harvest lists, and on top of them the first
 * FEED_MAX_FOLLOWS other follows with a lane.
 */
export function servedFollows<T extends FollowLaneInput>(follows: readonly T[]) {
  const served = follows.map(follow => ({ follow, lane: followLane(follow) })).filter(({ lane }) => lane);
  const isJournal = ({ lane }: { lane: string }) => lane.startsWith('source:');
  const journals = new Set(served.filter(isJournal).slice(0, MAX_FOLLOWED_JOURNALS));
  const others = new Set(served.filter(entry => !isJournal(entry)).slice(0, FEED_MAX_FOLLOWS));
  return served.filter(entry => journals.has(entry) || others.has(entry));
}
