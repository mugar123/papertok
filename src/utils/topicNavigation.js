import { CATEGORIES } from '../data/categories.js';
import { isTechnicalClassification } from './scientificClassification.js';

const QUERY_TOPIC_PREFIX = 'query-';
export const MAX_QUERY_TOPIC_LENGTH = 180;
export const MAX_QUERY_TOPIC_SOURCE_LENGTH = 48;
export const MAX_QUERY_TOPIC_CATEGORY_IDS = 12;

function cleanTopicText(value = '') {
  return String(value)
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(value = '') {
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

function findLocalTopic(value, language = 'es') {
  if (!value) return null;
  if (CATEGORIES[value]) {
    const area = CATEGORIES[value];
    return {
      id: value,
      label: language === 'en' ? area.labelEn || area.label : area.label,
      type: 'topic',
      reliable: true,
    };
  }

  const normalized = normalizeLabel(value);
  for (const [areaId, area] of Object.entries(CATEGORIES)) {
    if ([area.label, area.labelEn].some(label => normalizeLabel(label) === normalized)) {
      return {
        id: areaId,
        label: language === 'en' ? area.labelEn || area.label : area.label,
        type: 'topic',
        reliable: true,
      };
    }
    for (const [categoryId, category] of Object.entries(area.subcategories || {})) {
      if (categoryId === value || [category.label, category.labelEn].some(label => normalizeLabel(label) === normalized)) {
        return {
          id: categoryId,
          label: language === 'en' ? category.labelEn || category.label : category.label,
          type: 'topic',
          reliable: true,
        };
      }
    }
  }
  return null;
}

export function isScientificCategoryId(value) {
  if (!value) return false;
  if (CATEGORIES[value]) return true;
  if (Object.values(CATEGORIES).some(area => Boolean(area.subcategories?.[value]))) return true;
  return /^[a-z][a-z-]*(?:\.[A-Za-z][A-Za-z-]*)+$/.test(value) || /^(?:astro|cond|hep|nucl|nlin)-[a-z-]+$/i.test(value);
}

export function isQueryTopicId(value) {
  return /^query-[a-f0-9]{8}$/i.test(cleanTopicText(value));
}

export function isOpaqueQueryTopicText(value) {
  return /^query(?:-|$)/i.test(cleanTopicText(value));
}

function isMeaningfulTopicText(value) {
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

function stableTopicHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function queryTopicSource(value, rawId = '') {
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

function queryTopicCategoryIds(value, query) {
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

export function getQueryTopicMetadata(value = {}) {
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

export function createQueryTopic(value) {
  const data = typeof value === 'object' && value !== null ? value : null;
  const displayName = cleanTopicText(
    data?.display_name || data?.displayName || data?.name || data?.label || (data ? '' : value),
  );
  const metadata = getQueryTopicMetadata(data || {
    displayName,
    query: value,
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

function toSearchParams(searchParams) {
  if (searchParams instanceof URLSearchParams) return searchParams;
  return new URLSearchParams(searchParams || '');
}

export function resolveQueryTopicRoute(id, searchParams) {
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

export function resolvePaperTopic(value, language = 'es') {
  const concept = typeof value === 'object' && value !== null ? value : null;
  const label = cleanTopicText(
    concept?.display_name || concept?.displayName || concept?.name || concept?.label || value,
  );
  const local = findLocalTopic(concept?.categoryId || label, language)
    || (typeof value === 'string' ? findLocalTopic(value, language) : null);
  if (local) return local;

  const rawId = concept?.id || concept?.openAlexId || '';
  const externalId = String(rawId).split('/').pop();
  if (/^C\d+$/i.test(externalId) && isMeaningfulTopicText(label)) {
    return { id: externalId, label, type: 'concept', reliable: false };
  }
  if (/^T\d+$/i.test(externalId) && isMeaningfulTopicText(label)) {
    return { id: externalId, label, type: 'topic', reliable: false };
  }
  const queryTopic = createQueryTopic(concept || label);
  if (isOpaqueQueryTopicText(rawId)) {
    return isQueryTopicId(externalId) && queryTopic?.id === externalId ? queryTopic : null;
  }
  return queryTopic;
}

export function topicExplorerPath(topic) {
  if (!topic) return null;
  const basePath = `/explorer/${topic.type}/${encodeURIComponent(topic.id)}`;
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

export function paperMatchesLocalTopic(paper, topic) {
  const categoryIds = topic?.categoryIds || [];
  const explicitCategories = (paper?.categories || []).filter(isScientificCategoryId);
  if (explicitCategories.length > 0 && categoryIds.includes(explicitCategories[0])) return true;
  if (explicitCategories.length === 0 && categoryIds.includes(paper?.primaryCategory)) return true;

  const paperCategories = [paper?.primaryCategory, ...(paper?.categories || [])].filter(Boolean);

  const topicLabels = [topic?.display_name, topic?.labelEn]
    .map(normalizeLabel)
    .filter(label => label.length >= 4);
  if (topicLabels.length === 0) return false;

  const conceptLabels = (paper?.concepts || []).map(concept => concept?.display_name || concept?.name || '');
  const searchableText = normalizeLabel([
    paper?.title,
    paper?.abstract,
    paper?.summary,
    ...paperCategories,
    ...conceptLabels,
  ].filter(Boolean).join(' '));

  return topicLabels.some(label => searchableText.includes(label));
}
