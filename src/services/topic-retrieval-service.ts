import type { Paper } from '../models/paper.ts';
import type { PaperSearchResult } from './adapters/index.ts';
import type { TopicInput } from '../utils/topic-navigation.ts';
import type { FollowInput } from '../utils/following.ts';
type RetrievalTopic = TopicInput & { canonicalId?: string; _queryTopic?: boolean };
type TopicProvider<F extends (...args: never[]) => unknown> = (...args: Parameters<F>) => Paper[] | Pick<PaperSearchResult, 'papers'> | Promise<Paper[] | Pick<PaperSearchResult, 'papers'>>;
interface TopicProviders {
  fetchOpenAlexEntity: TopicProvider<typeof getWorksByEntity>;
  fetchArxivCategories: (categories: string[], ...options: Parameters<typeof fetchPapers> extends [unknown, ...infer R] ? R : never) => Paper[] | Promise<Paper[]>;
  fetchDomainCategories: TopicProvider<typeof fetchDomainPapers>;
  searchArxiv: TopicProvider<typeof searchPapers>;
  searchOpenAlex: TopicProvider<OpenAlexAdapter['search']>;
  searchPubmed: TopicProvider<PubmedAdapter['search']>;
}
interface TopicRequest { name: string; kind: string; promise: Promise<Paper[] | Pick<PaperSearchResult, 'papers'>>; relevanceTopic?: TopicInput; }
export interface TopicRetrievalOptions {
  allowLegacyDisplayName?: boolean; filters?: Parameters<typeof getWorksByEntity>[5]; maxPapers?: number; mode?: string;
  page?: number; pageSize?: number; providers?: Partial<TopicProviders>; searchQuery?: string; sortBy?: string;
  timeoutMs?: number; excludeProviders?: string[];
}

import { CATEGORIES, getCategoryLabel } from '../data/categories.ts';
import { filterRelevantQueryTopicPapers } from '../utils/query-topic-search.ts';
import {
  createQueryTopic,
  isOpaqueQueryTopicText,
  isQueryTopicId,
  isScientificCategoryId,
} from '../utils/topic-navigation.ts';
import { settleWithin } from '../utils/async-timing.ts';
import { fetchDomainPapers } from './domain-source-service.ts';
import { PaperBuilder } from './paper-builder.ts';
import { fetchPapers, searchPapers } from './arxiv-service.ts';
import { getWorksByEntity } from './open-alex-service.ts';
import { OpenAlexAdapter } from './adapters/open-alex-adapter.ts';
import { PubmedAdapter } from './adapters/pubmed-adapter.ts';

const ARXIV_CATEGORY_PREFIXES = [
  'cs', 'math', 'physics', 'eess', 'q-bio', 'q-fin', 'stat', 'econ',
  'astro-ph', 'cond-mat', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph',
  'hep-th', 'nlin', 'nucl-ex', 'nucl-th', 'quant-ph', 'math-ph',
];
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PAPERS = 60;

function cleanText(value: unknown, maxLength = 180) {
  return String(value || '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanOpenAlexId(value: unknown) {
  return cleanText(value, 300).split('/').pop()!;
}

function meaningfulQuery(value: unknown) {
  const query = cleanText(value);
  if (!query || isOpaqueQueryTopicText(query)) return '';
  return createQueryTopic({ displayName: query, query })?.query || '';
}

function nativeArxivCategory(value: string) {
  const category = cleanText(value, 80);
  return ARXIV_CATEGORY_PREFIXES.some(prefix => (
    category === prefix || category.startsWith(`${prefix}.`)
  ));
}

function categoryIdsFromCanonical(canonicalId: string) {
  if (CATEGORIES[canonicalId as keyof typeof CATEGORIES]) return Object.keys(CATEGORIES[canonicalId as keyof typeof CATEGORIES].subcategories || {});
  return isScientificCategoryId(canonicalId) ? [canonicalId] : [];
}

function categorySearchQuery(categoryIds: string[], canonicalId: string) {
  if (CATEGORIES[canonicalId as keyof typeof CATEGORIES]) return getCategoryLabel(canonicalId);
  return categoryIds.length ? getCategoryLabel(categoryIds[0]) : '';
}

// An area's leaves come from the taxonomy, not from the ids a follow stored:
// those are the area as it was when it was followed.
function normalizedCategoryIds(topic: RetrievalTopic, canonicalId: string) {
  const isArea = Object.hasOwn(CATEGORIES, canonicalId);
  return [...new Set([
    ...(!isArea && Array.isArray(topic?.metadata?.categoryIds) ? topic.metadata.categoryIds : []),
    ...(!isArea && Array.isArray(topic?.categoryIds) ? topic.categoryIds : []),
    ...categoryIdsFromCanonical(canonicalId),
  ].map(categoryId => cleanText(categoryId, 80)).filter(isScientificCategoryId))].slice(0, 12);
}

function displayNameForTopic(topic: RetrievalTopic) {
  return cleanText(
    topic?.displayName || topic?.display_name || topic?.name || topic?.label,
  );
}

export function resolveTopicRetrievalPlan(topic: RetrievalTopic = {}, { allowLegacyDisplayName = false } = {}) {
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

export function getFollowedTopicCategoryIds(followedEntities: FollowInput[] = []) {
  return [...new Set((followedEntities || [])
    .filter(follow => follow?.type === 'topic')
    .flatMap(follow => resolveTopicRetrievalPlan(follow).categoryIds))];
}

const DEFAULT_PROVIDERS: Readonly<TopicProviders> = Object.freeze<TopicProviders>({
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

function papersFromResult(value: Paper[] | Pick<PaperSearchResult, 'papers'>) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.papers) ? value.papers : [];
}

function quotedQuery(query: string) {
  return `"${cleanText(query).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

function addRequest(requests: TopicRequest[], name: string, kind: string, promise: TopicRequest['promise']) {
  requests.push({ name, kind, promise });
}

function invokeProvider<Args extends unknown[], Result>(provider: (...args: Args) => Result | Promise<Result>, args: Args) {
  return Promise.resolve().then(() => provider(...args));
}

export async function fetchTopicPapers(topic: RetrievalTopic, options: TopicRetrievalOptions = {}) {
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
    // Names of providers this call must not ask, whatever the plan would do:
    // the Following inbox leaves the phrase searches out of a category topic
    // (followingUpdatesService). A provider excluded here is simply absent.
    excludeProviders = [],
  } = options;
  const excluded = new Set(excludeProviders);
  const provider = <K extends keyof TopicProviders>(name: K) => (excluded.has(name) ? null : providers[name]);
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

  const requests: TopicRequest[] = [];
  const offset = (safePage - 1) * safePageSize;
  if (plan.openAlexId && provider('fetchOpenAlexEntity')) {
    const entityType = plan.openAlexId.toUpperCase().startsWith('T') ? 'topic' : 'concept';
    addRequest(
      requests,
      'openalex-exact',
      'exact',
      invokeProvider(provider('fetchOpenAlexEntity')!, [
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
    if (arxivCategories.length && provider('fetchArxivCategories')) {
      addRequest(
        requests,
        'arxiv-categories',
        'exact',
        invokeProvider(provider('fetchArxivCategories')!, [arxivCategories, offset, safePageSize, mode]),
      );
    }
    if (plan.categoryIds.length && provider('fetchDomainCategories')) {
      addRequest(
        requests,
        'domain-categories',
        'exact',
        invokeProvider(provider('fetchDomainCategories')!, [
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
      if (provider('searchArxiv')) {
        addRequest(
          requests,
          'arxiv-query',
          'generic',
          invokeProvider(provider('searchArxiv')!, [combinedQuery, offset, safePageSize]),
        );
      }
      if (provider('searchOpenAlex')) {
        addRequest(
          requests,
          'openalex-query',
          'generic',
          invokeProvider(provider('searchOpenAlex')!, [
            quotedQuery(combinedQuery),
            safePage,
            { internalCategories: plan.categoryIds },
          ]),
        );
      }
      if (provider('searchPubmed')) {
        addRequest(
          requests,
          'pubmed-query',
          'generic',
          invokeProvider(provider('searchPubmed')!, [
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
      ? settleWithin(request.promise, timeoutMs!)
      : Promise.resolve(request.promise).then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )
  )));
  const successfulProviders: string[] = [];
  const failedProviders: string[] = [];
  let hasMore = false;
  const collected: Paper[] = [];

  settled.forEach((result, index) => {
    const request = requests[index];
    if (result.status !== 'fulfilled') {
      failedProviders.push(request.name);
      return;
    }
    successfulProviders.push(request.name);
    const rawPapers = papersFromResult(result.value).filter(Boolean);
    const total = Number((result.value as PaperSearchResult)?.total);
    hasMore ||= rawPapers.length >= safePageSize || (Number.isFinite(total) && total > safePage * safePageSize);
    collected.push(...(request.kind === 'generic'
      ? filterRelevantQueryTopicPapers(rawPapers, request.relevanceTopic!)
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
