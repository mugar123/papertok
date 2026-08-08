import { CATEGORIES, getCategoryLabel } from '../data/categories.js';
import { filterRelevantQueryTopicPapers } from '../utils/queryTopicSearch.js';
import {
  createQueryTopic,
  isOpaqueQueryTopicText,
  isQueryTopicId,
  isScientificCategoryId,
} from '../utils/topicNavigation.js';
import { settleWithin } from '../utils/asyncTiming.js';
import { fetchDomainPapers } from './domainSourceService.js';
import { PaperBuilder } from './PaperBuilder.js';
import { fetchPapers, searchPapers } from './arxivService.js';
import { getWorksByEntity } from './openAlexService.js';
import { OpenAlexAdapter } from './adapters/OpenAlexAdapter.js';
import { PubmedAdapter } from './adapters/PubmedAdapter.js';

const ARXIV_CATEGORY_PREFIXES = [
  'cs', 'math', 'physics', 'eess', 'q-bio', 'q-fin', 'stat', 'econ',
  'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph',
  'hep-th', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph', 'math-ph',
];
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAPERS = 60;

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanOpenAlexId(value) {
  return cleanText(value, 300).split('/').pop();
}

function meaningfulQuery(value) {
  const query = cleanText(value);
  if (!query || isOpaqueQueryTopicText(query)) return '';
  return createQueryTopic({ displayName: query, query })?.query || '';
}

function nativeArxivCategory(value) {
  const category = cleanText(value, 80);
  return ARXIV_CATEGORY_PREFIXES.some(prefix => (
    category === prefix || category.startsWith(`${prefix}.`)
  ));
}

function categoryIdsFromCanonical(canonicalId) {
  if (CATEGORIES[canonicalId]) return Object.keys(CATEGORIES[canonicalId].subcategories || {});
  return isScientificCategoryId(canonicalId) ? [canonicalId] : [];
}

function categorySearchQuery(categoryIds, canonicalId) {
  if (CATEGORIES[canonicalId]) return getCategoryLabel(canonicalId, 'en');
  return categoryIds.length ? getCategoryLabel(categoryIds[0], 'en') : '';
}

function normalizedCategoryIds(topic, canonicalId) {
  return [...new Set([
    ...(Array.isArray(topic?.metadata?.categoryIds) ? topic.metadata.categoryIds : []),
    ...(Array.isArray(topic?.categoryIds) ? topic.categoryIds : []),
    ...categoryIdsFromCanonical(canonicalId),
  ].map(categoryId => cleanText(categoryId, 80)).filter(isScientificCategoryId))].slice(0, 12);
}

function displayNameForTopic(topic) {
  return cleanText(
    topic?.displayName || topic?.display_name || topic?.name || topic?.label,
  );
}

export function resolveTopicRetrievalPlan(topic = {}, { allowLegacyDisplayName = false } = {}) {
  const canonicalId = cleanOpenAlexId(topic.canonicalId || topic.id);
  const malformedQueryId = isOpaqueQueryTopicText(canonicalId) && !isQueryTopicId(canonicalId);
  const queryTopicId = isQueryTopicId(canonicalId);
  const openAlexId = /^[TC]\d+$/i.test(canonicalId) ? canonicalId : '';
  const categoryIds = malformedQueryId ? [] : normalizedCategoryIds(topic, canonicalId);
  const rawStoredQuery = topic.metadata?.query || (topic._queryTopic ? topic.query : '');
  const storedCandidate = malformedQueryId ? '' : meaningfulQuery(rawStoredQuery);
  const storedQuery = queryTopicId && storedCandidate
    && createQueryTopic({ displayName: storedCandidate, query: storedCandidate })?.id !== canonicalId
    ? ''
    : storedCandidate;
  const legacyCandidate = !openAlexId && categoryIds.length === 0 && !rawStoredQuery && allowLegacyDisplayName
    ? meaningfulQuery(displayNameForTopic(topic))
    : '';
  const legacyQuery = queryTopicId && legacyCandidate
    && createQueryTopic({ displayName: legacyCandidate, query: legacyCandidate })?.id !== canonicalId
    ? ''
    : legacyCandidate;
  const fallbackCategoryQuery = categorySearchQuery(categoryIds, canonicalId);

  return {
    canonicalId,
    openAlexId,
    categoryIds,
    query: openAlexId ? '' : storedQuery || legacyQuery || fallbackCategoryQuery,
    querySource: openAlexId
      ? 'exact-id'
      : storedQuery
        ? 'metadata'
        : legacyQuery
          ? 'legacy-display-name'
          : categoryIds.length ? 'category' : '',
    isQueryTopic: queryTopicId || Boolean(topic._queryTopic),
    valid: Boolean(!malformedQueryId && (openAlexId || categoryIds.length || storedQuery || legacyQuery)),
  };
}

export function getFollowedTopicCategoryIds(followedEntities = []) {
  return [...new Set((followedEntities || [])
    .filter(follow => follow?.type === 'topic')
    .flatMap(follow => resolveTopicRetrievalPlan(follow).categoryIds))];
}

const DEFAULT_PROVIDERS = Object.freeze({
  fetchOpenAlexEntity: (type, id, sortBy, page, searchQuery, filters) => (
    getWorksByEntity(type, id, sortBy, page, searchQuery, filters)
  ),
  fetchArxivCategories: (categoryIds, start, limit, mode) => (
    fetchPapers(categoryIds, start, limit, mode)
  ),
  fetchDomainCategories: (categoryIds, page, limit, mode) => (
    fetchDomainPapers(categoryIds, page, limit, mode)
  ),
  searchArxiv: (query, start, limit) => searchPapers(query, start, limit),
  searchOpenAlex: (query, page, options) => new OpenAlexAdapter().search(query, page, options),
  searchPubmed: (query, page, options) => new PubmedAdapter().search(query, page, options),
});

function papersFromResult(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.papers) ? value.papers : [];
}

function quotedQuery(query) {
  return `"${cleanText(query).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

function addRequest(requests, name, kind, promise) {
  requests.push({ name, kind, promise });
}

function invokeProvider(provider, args) {
  return Promise.resolve().then(() => provider(...args));
}

export async function fetchTopicPapers(topic, options = {}) {
  const {
    allowLegacyDisplayName = false,
    filters = {},
    maxPapers = DEFAULT_MAX_PAPERS,
    mode = 'recent',
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
    providers = DEFAULT_PROVIDERS,
    searchQuery = '',
    sortBy = mode === 'recent' ? 'publication_date:desc' : 'cited_by_count:desc',
    timeoutMs,
  } = options;
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(30, Number(pageSize) || DEFAULT_PAGE_SIZE));
  const safeMaxPapers = Math.max(1, Math.min(90, Number(maxPapers) || DEFAULT_MAX_PAPERS));
  const plan = resolveTopicRetrievalPlan(topic, { allowLegacyDisplayName });
  if (!plan.valid) {
    return {
      papers: [],
      plan,
      successfulProviders: [],
      failedProviders: [],
      partial: false,
      allFailed: false,
      hasMore: false,
    };
  }

  const requests = [];
  const offset = (safePage - 1) * safePageSize;
  if (plan.openAlexId && providers.fetchOpenAlexEntity) {
    const entityType = plan.openAlexId.toUpperCase().startsWith('T') ? 'topic' : 'concept';
    addRequest(
      requests,
      'openalex-exact',
      'exact',
      invokeProvider(providers.fetchOpenAlexEntity, [
        entityType,
        plan.openAlexId,
        sortBy,
        safePage,
        searchQuery,
        filters,
      ]),
    );
  } else {
    const arxivCategories = plan.categoryIds.filter(nativeArxivCategory).slice(0, 6);
    if (arxivCategories.length && providers.fetchArxivCategories) {
      addRequest(
        requests,
        'arxiv-categories',
        'exact',
        invokeProvider(providers.fetchArxivCategories, [arxivCategories, offset, safePageSize, mode]),
      );
    }
    if (plan.categoryIds.length && providers.fetchDomainCategories) {
      addRequest(
        requests,
        'domain-categories',
        'exact',
        invokeProvider(providers.fetchDomainCategories, [
          plan.categoryIds,
          safePage,
          Math.min(10, safePageSize),
          mode,
        ]),
      );
    }

    const combinedQuery = [plan.query, cleanText(searchQuery)].filter(Boolean).join(' ');
    if (combinedQuery) {
      const relevanceTopic = { query: plan.query || combinedQuery, categoryIds: plan.categoryIds };
      if (providers.searchArxiv) {
        addRequest(
          requests,
          'arxiv-query',
          'generic',
          invokeProvider(providers.searchArxiv, [combinedQuery, offset, safePageSize]),
        );
      }
      if (providers.searchOpenAlex) {
        addRequest(
          requests,
          'openalex-query',
          'generic',
          invokeProvider(providers.searchOpenAlex, [
            quotedQuery(combinedQuery),
            safePage,
            { internalCategories: plan.categoryIds },
          ]),
        );
      }
      if (providers.searchPubmed) {
        addRequest(
          requests,
          'pubmed-query',
          'generic',
          invokeProvider(providers.searchPubmed, [
            quotedQuery(combinedQuery),
            safePage,
            { internalCategories: plan.categoryIds.slice(0, 3) },
          ]),
        );
      }
      requests.forEach((request) => {
        if (request.kind === 'generic') request.relevanceTopic = relevanceTopic;
      });
    }
  }

  const settled = await Promise.all(requests.map(request => (
    Number.isFinite(timeoutMs)
      ? settleWithin(request.promise, timeoutMs)
      : Promise.resolve(request.promise).then(
        value => ({ status: 'fulfilled', value }),
        reason => ({ status: 'rejected', reason }),
      )
  )));
  const successfulProviders = [];
  const failedProviders = [];
  let hasMore = false;
  const collected = [];

  settled.forEach((result, index) => {
    const request = requests[index];
    if (result.status !== 'fulfilled') {
      failedProviders.push(request.name);
      return;
    }
    successfulProviders.push(request.name);
    const rawPapers = papersFromResult(result.value).filter(Boolean);
    const total = Number(result.value?.total);
    hasMore ||= rawPapers.length >= safePageSize || (Number.isFinite(total) && total > safePage * safePageSize);
    collected.push(...(request.kind === 'generic'
      ? filterRelevantQueryTopicPapers(rawPapers, request.relevanceTopic)
      : rawPapers));
  });

  return {
    papers: PaperBuilder.deduplicate(collected).slice(0, safeMaxPapers),
    plan,
    successfulProviders,
    failedProviders,
    partial: successfulProviders.length > 0 && failedProviders.length > 0,
    allFailed: requests.length > 0 && successfulProviders.length === 0,
    hasMore,
  };
}
