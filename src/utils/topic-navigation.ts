export interface TopicInput {
  id?: string; openAlexId?: string; display_name?: string; displayName?: string; name?: string; label?: string;
  categoryId?: string; categoryIds?: string[]; topicSource?: string; provider?: string; source?: string; query?: string;
  metadata?: { query?: string; source?: string; categoryIds?: string[] };
}
export interface TopicTarget extends TopicInput {
  id: string; label: string; type: string; reliable: boolean; _queryTopic?: boolean;
}

import { CATEGORIES } from '../data/categories.ts';
import { isTechnicalClassification } from './scientific-classification.ts';

const QUERY_TOPIC_PREFIX = 'query-';
export const MAX_QUERY_TOPIC_LENGTH = 180;
export const MAX_QUERY_TOPIC_SOURCE_LENGTH = 48;
export const MAX_QUERY_TOPIC_CATEGORY_IDS = 12;

function cleanTopicText(value: unknown = '') {
  return String(value)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(value: unknown = '') {
  return cleanTopicText(value)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const GENERIC_TOPIC_LABELS = new Set([
  'article',
  'articulo',
  'articulo de investigacion',
  'de',
  'el',
  'en',
  'in',
  'journal',
  'la',
  'no abstract available',
  'of',
  'paper',
  'research paper',
  'revista',
  'sin categoria',
  'to',
  'unknown',
  'unknown journal',
  'untitled',
].map(normalizeLabel));

/**
 * The taxonomy with its labels already normalised, built once.
 *
 * `findLocalTopic` used to walk every area and every subcategory and run
 * `normalizeLabel` — NFKD plus two Unicode regexes — over the label of each,
 * on EVERY call. That is a few hundred normalisations per lookup, and a feed
 * card asks for one per topic it shows.
 *
 * Measured 2026-09-11 (production build, real session, CPU profile of leaving
 * Following with 60 mounted cards for another tab): 41ms of the ~100ms before
 * the transition could draw its first frame was inside this module, which is
 * why leaving Following took 99-106ms to start moving while leaving Research
 * took 30-40ms.
 *
 * A label is matched against every subcategory before any area: the AI area
 * and its `cs.AI` leaf are both "Artificial Intelligence", and a concept of
 * that name stands for the leaf.
 */
let taxonomyIndex: Array<{ areaId: string; area: { label: string }; areaKeys: string[]; subcategories: Array<{ categoryId: string; category: { label: string }; keys: string[] }> }> | null = null;
function getTaxonomyIndex() {
  if (taxonomyIndex) return taxonomyIndex;
  taxonomyIndex = Object.entries(CATEGORIES).map(([areaId, area]) => ({
    areaId,
    area,
    areaKeys: [normalizeLabel(area.label)],
    subcategories: Object.entries(area.subcategories || {}).map(([categoryId, category]) => ({
      categoryId,
      category,
      keys: [normalizeLabel(category.label)],
    })),
  }));
  return taxonomyIndex;
}

function findLocalTopic(value: string|undefined) {
  if (!value) return null;
  if (CATEGORIES[value as keyof typeof CATEGORIES]) {
    const area = CATEGORIES[value as keyof typeof CATEGORIES];
    return {
      id: value,
      label: area.label,
      type: 'topic',
      reliable: true,
    };
  }

  const normalized = normalizeLabel(value);
  const index = getTaxonomyIndex();
  for (const { subcategories } of index) {
    for (const { categoryId, category, keys } of subcategories) {
      if (categoryId === value || keys.some(label => label === normalized)) {
        return {
          id: categoryId,
          label: category.label,
          type: 'topic',
          reliable: true,
        };
      }
    }
  }
  for (const { areaId, area, areaKeys } of index) {
    if (areaKeys.some(label => label === normalized)) {
      return {
        id: areaId,
        label: area.label,
        type: 'topic',
        reliable: true,
      };
    }
  }
  return null;
}

export function isScientificCategoryId(value: string|undefined) {
  if (!value) return false;
  if (CATEGORIES[value as keyof typeof CATEGORIES]) return true;
  if (Object.values(CATEGORIES).some(area => Boolean((area.subcategories as Record<string, { label: string }>)?.[value]))) return true;
  return /^[a-z][a-z-]*(?:\.[A-Za-z][A-Za-z-]*)+$/.test(value) || /^(?:astro|cond|hep|nucl|nlin)-[a-z-]+$/i.test(value);
}

export function isQueryTopicId(value: string|undefined) {
  return /^query-[a-f0-9]{8}$/i.test(cleanTopicText(value));
}

export function isOpaqueQueryTopicText(value: string|undefined) {
  return /^query(?:-|$)/i.test(cleanTopicText(value));
}

function isMeaningfulTopicText(value: string|undefined) {
  const text = cleanTopicText(value);
  const normalized = normalizeLabel(text);
  if (!text || text.length > MAX_QUERY_TOPIC_LENGTH || GENERIC_TOPIC_LABELS.has(normalized)) return false;
  if (isTechnicalClassification(text) || /^https?:\/\//i.test(text)) return false;
  if (/^(?:doi\s*:\s*)?10\.\d{4,9}\/\S+$/i.test(text)) return false;
  if (/^(?:arxiv|isbn|issn|openalex|pmcid|pmid)\s*[:#]\s*\S+$/i.test(text)) return false;
  if (isOpaqueQueryTopicText(text) || /^(?:[CT]\d+|[a-z][a-z0-9._-]*:\S+)$/i.test(text)) return false;

  const compact = normalized.replace(/\s/g, '');
  return compact.length >= 2 && /\p{L}/u.test(compact);
}

function stableTopicHash(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function queryTopicSource(value: TopicInput, rawId = '') {
  const explicitSource = value?.metadata?.source
    || value?.topicSource
    || value?.provider
    || (typeof value?.source === 'string' && value.source !== 'query' ? value.source : '');
  const idSource = String(rawId).includes(':') ? String(rawId).split(':')[0] : '';
  return cleanTopicText(explicitSource || idSource || 'free-text')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_QUERY_TOPIC_SOURCE_LENGTH) || 'free-text';
}

function queryTopicCategoryIds(value: TopicInput, query: string) {
  const candidates = [
    ...(Array.isArray(value?.metadata?.categoryIds) ? value.metadata.categoryIds : []),
    ...(Array.isArray(value?.categoryIds) ? value.categoryIds : []),
    value?.categoryId,
    typeof value === 'string' && isScientificCategoryId(query) ? query : '',
  ];
  return [...new Set(candidates
    .map(categoryId => cleanTopicText(categoryId))
    .filter(categoryId => categoryId && isScientificCategoryId(categoryId)))].sort()
    .slice(0, MAX_QUERY_TOPIC_CATEGORY_IDS);
}

export function getQueryTopicMetadata(value: TopicInput | string | null = {}) {
  const data = typeof value === 'object' && value !== null ? value : {};
  const displayName = cleanTopicText(
    data.display_name || data.displayName || data.name || data.label || '',
  );
  const categoryQuery = data.categoryId && isScientificCategoryId(data.categoryId)
    ? data.categoryId
    : '';
  const query = cleanTopicText(data.metadata?.query || data.query || categoryQuery || displayName);
  return {
    query: isMeaningfulTopicText(query) ? query : '',
    source: queryTopicSource(data, data.id || data.openAlexId || ''),
    categoryIds: queryTopicCategoryIds(data, query),
  };
}

export function createQueryTopic(value: TopicInput | string | null | undefined): TopicTarget | null {
  const data = typeof value === 'object' && value !== null ? value : null;
  const displayName = cleanTopicText(
    data?.display_name || data?.displayName || data?.name || data?.label || (data ? '' : value),
  );
  const metadata = getQueryTopicMetadata(data || {
    displayName,
    query: value as string,
    source: 'free-text',
  });
  const query = metadata.query;
  if (!isMeaningfulTopicText(query) || !isMeaningfulTopicText(displayName)) return null;

  const normalizedQuery = normalizeLabel(query);
  return {
    id: `${QUERY_TOPIC_PREFIX}${stableTopicHash(normalizedQuery)}`,
    display_name: displayName,
    label: displayName,
    query,
    source: 'query',
    categoryIds: metadata.categoryIds,
    metadata,
    type: 'topic',
    reliable: false,
    _queryTopic: true,
  };
}

function toSearchParams(searchParams: URLSearchParams | string | undefined) {
  if (searchParams instanceof URLSearchParams) return searchParams;
  return new URLSearchParams(searchParams || '');
}

export function resolveQueryTopicRoute(id: string, searchParams?: URLSearchParams | string) {
  if (!isQueryTopicId(id)) return null;
  const params = toSearchParams(searchParams);
  const query = params.get('q') || params.get('name') || '';
  const topic = createQueryTopic({
    display_name: params.get('name') || query,
    metadata: {
      query,
      source: params.get('source') || 'free-text',
      categoryIds: params.getAll('category'),
    },
  });
  return topic?.id === id ? topic : null;
}

export function resolvePaperTopic(value: TopicInput | string | null | undefined): TopicTarget | null {
  const concept = typeof value === 'object' && value !== null ? value : null;
  const label = cleanTopicText(
    concept?.display_name || concept?.displayName || concept?.name || concept?.label || value,
  );
  // An OpenAlex topic ID carries more evidence than a coincidentally matching local name.
  const rawId = concept?.id || concept?.openAlexId || '';
  const externalId = String(rawId).split('/').pop()!;
  if (/^T\d+$/i.test(externalId) && isMeaningfulTopicText(label)) {
    return { id: externalId, label, type: 'topic', reliable: false };
  }
  const local = findLocalTopic(concept?.categoryId || label)
    || (typeof value === 'string' ? findLocalTopic(value) : null);
  if (local) return local;

  if (/^C\d+$/i.test(externalId) && isMeaningfulTopicText(label)) {
    return { id: externalId, label, type: 'concept', reliable: false };
  }
  const queryTopic = createQueryTopic(concept || label);
  if (isOpaqueQueryTopicText(rawId)) {
    return isQueryTopicId(externalId) && queryTopic?.id === externalId ? queryTopic : null;
  }
  return queryTopic;
}

export function topicExplorerPath(topic: TopicTarget | null | undefined, publicMode = false) {
  if (!topic) return null;
  const basePath = `${publicMode ? '/public/entity' : '/explorer'}/${topic.type}/${encodeURIComponent(topic.id)}`;
  if (!topic._queryTopic) return basePath;

  const query = cleanTopicText(topic.metadata?.query || topic.query);
  const displayName = cleanTopicText(topic.display_name || topic.label || query);
  if (!query || !displayName) return null;

  const params = new URLSearchParams({ q: query });
  if (displayName !== query) params.set('name', displayName);
  params.set('source', topic.metadata?.source || 'free-text');
  (topic.metadata?.categoryIds || topic.categoryIds || [])
    .forEach(categoryId => params.append('category', categoryId));
  return `${basePath}?${params.toString()}`;
}
