import { getAllLeafCategories } from '../data/category-taxonomy.ts';

// The lane a followed entity is served from, shared by the Worker, which
// files and reads the lanes (worker/paper-store.ts), and the app, which sends
// a page's request only the follows the Worker reads.

/** How many follows a page of the corpus reads (`parseFeedRequest`). */
export const FEED_MAX_FOLLOWS = 20;

const LEAF_IDS = new Set(getAllLeafCategories().map(leaf => leaf.id));
const FOLLOW_TYPES = new Set(['author', 'topic', 'institution', 'project']);
const OPENALEX_ENTITY = /^https?:\/\/openalex\.org\/([AITC]\d+)$|^([AITC]\d+)$/i;
const ENTITY_LANE_KINDS: Record<string, string> = { A: 'author', I: 'institution', T: 'topic', C: 'concept' };

const text = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** The lane of an OpenAlex author, institution, topic or concept id, or '' for anything else. */
export function entityLane(value: unknown) {
  const match = text(value).match(OPENALEX_ENTITY);
  const id = (match?.[1] || match?.[2] || '').toUpperCase();
  return id ? `${ENTITY_LANE_KINDS[id[0]]}:${id}` : '';
}

/**
 * The lane a followed entity is served from: the OpenAlex entity a paper
 * names, a search for a followed query or an author known by name only, or
 * a funded project. A topic that is one of the app's categories is asked for
 * as that category instead, and gets no lane here.
 */
export function followLane(follow: { type?: unknown; canonicalId?: unknown; displayName?: unknown; metadata?: { query?: unknown; funder?: unknown } | null }) {
  const type = text(follow?.type);
  const canonicalId = text(follow?.canonicalId).split('/').pop()!.slice(0, 200);
  if (!FOLLOW_TYPES.has(type) || !canonicalId) return '';
  if (type === 'project') {
    const funder = text(follow.metadata?.funder).slice(0, 80);
    return `project:${funder ? `${funder}|` : ''}${canonicalId}`;
  }
  const entity = entityLane(canonicalId);
  if (entity && (type === 'topic' ? /^(topic|concept):/.test(entity) : entity.startsWith(`${type}:`))) return entity;
  if (LEAF_IDS.has(canonicalId)) return '';
  const query = text(type === 'topic' ? follow.metadata?.query || follow.displayName : follow.displayName).toLowerCase().slice(0, 120);
  if (!query) return '';
  return type === 'author' ? `author-name:${query}` : type === 'topic' ? `query:${query}` : '';
}
