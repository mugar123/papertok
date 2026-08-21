/**
 * Scientific Report Service
 * Orchestrates candidate fetching from arXiv, OpenAlex, and PubMed,
 * runs custom ranking and diversity scoring, and caches stable editions.
 */

import { fetchPapers as fetchArxivPapers } from './arxivService.js';
import { PubmedAdapter } from './adapters/PubmedAdapter.js';
import { PaperBuilder } from './PaperBuilder.js';
import { CATEGORIES, getCategoryArea } from '../data/categories.js';
import { openAlexJson } from './openAlexClient.js';
import { REPORT_OPENALEX_FIELDS } from './openAlexReportQuery.js';
import { normalizeScientificMarkup } from '../utils/latex.js';
import { getDateThresholds } from '../utils/scientificReportPeriods.js';
import {
  buildScientificReportEditions,
  extractFeaturedConcepts,
  scoreScientificPaper,
} from '../utils/scientificReportRanking.js';

const CORPUS_CACHE = new Map();
const MAX_CORPUS_CACHE_ENTRIES = 24;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms
const DEGRADED_CACHE_TTL = 5 * 60 * 1000;
// Must exceed the arXiv chain's worst case (worker 4s in prod; worker 4s + direct
// 5s in dev, where the Vite proxy still backs the Worker up), or this deadline
// marks the source "unavailable" while a later layer was about to succeed and the
// degraded status then gets pinned in the corpus cache. The proxy cascade that
// used to add 4.5s to both numbers is gone.
const REPORT_SOURCE_TIMEOUT_MS = 10_000;

const DEFAULT_ARXIV_REPORT_CATEGORIES = ['cs.AI', 'quant-ph', 'q-bio.NC', 'stat.ML', 'math.PR', 'eess.SP'];
const REPORT_ARXIV_CATEGORIES = Object.freeze({
  physics: Object.keys(CATEGORIES.physics.subcategories),
  cs: Object.keys(CATEGORIES.cs.subcategories),
  math: Object.keys(CATEGORIES.math.subcategories),
  stat: Object.keys(CATEGORIES.stat.subcategories),
  econ: Object.keys(CATEGORIES.econ.subcategories),
  'q-fin': Object.keys(CATEGORIES['q-fin'].subcategories),
  eess: Object.keys(CATEGORIES.eess.subcategories).filter(category => category.startsWith('eess.')),
  mech: ['physics.flu-dyn', 'cs.RO'],
  civil: ['physics.geo-ph', 'eess.SY'],
  chemeng: ['cond-mat.mtrl-sci', 'physics.chem-ph'],
  med: [],
  bio: ['q-bio.BM', 'q-bio.CB', 'q-bio.GN', 'q-bio.MN', 'q-bio.NC', 'q-bio.OT', 'q-bio.PE', 'q-bio.QM', 'q-bio.SC', 'q-bio.TO'],
});

function withSourceDeadline(promise, timeoutMs = REPORT_SOURCE_TIMEOUT_MS) {
  const unavailable = { papers: [], status: 'unavailable' };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result || unavailable);
    };
    const timeoutId = setTimeout(() => finish(unavailable), timeoutMs);
    Promise.resolve(promise).then(finish).catch(() => finish(unavailable));
  });
}

export { getDateThresholds, extractFeaturedConcepts };
export const scorePaper = scoreScientificPaper;

/**
 * Normalizes OpenAlex raw works to standard PaperTok Paper objects
 */
/**
 * Helper to check if a paper matches a selected category key
 */
function normalizeCategoryText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function paperMatchesCategory(paper, categoryKey) {
  const area = CATEGORIES[categoryKey];
  if (!area) return false;
  
  const prim = (paper.primaryCategory || '').toLowerCase();
  const key = categoryKey.toLowerCase();
  if (prim === key) return true;
  
  if (prim.startsWith(key + '.') || prim.startsWith(key + '-')) return true;
  
  const areaFromArxiv = getCategoryArea(paper.primaryCategory);
  if (areaFromArxiv === categoryKey) return true;

  const rawPaperCategories = [
    ...(paper.categories || []),
    ...(paper.allCategories || []),
  ].filter(category => typeof category === 'string');
  if (rawPaperCategories.some(category => getCategoryArea(category) === categoryKey)) return true;

  const labelsToMatch = new Set([
    normalizeCategoryText(area.label),
    normalizeCategoryText(area.labelEn),
    ...Object.values(area.subcategories).flatMap(sub => [
      normalizeCategoryText(sub.label),
      normalizeCategoryText(sub.labelEn),
    ]),
  ]);
  const paperCats = rawPaperCategories.map(normalizeCategoryText).filter(Boolean);
  if (paperCats.some(category => labelsToMatch.has(category))) return true;

  const primaryFieldId = String(paper.primaryTopic?.field?.id || '').split('/').pop();
  if (!primaryFieldId || !REPORT_OPENALEX_FIELDS[categoryKey]?.includes(primaryFieldId)) return false;

  const fieldOwners = Object.entries(REPORT_OPENALEX_FIELDS)
    .filter(([, fields]) => fields.includes(primaryFieldId))
    .map(([owner]) => owner);
  return fieldOwners.length === 1 && fieldOwners[0] === categoryKey;
}

export function buildOpenAlexTopicFilters(categories = []) {
  const selected = [...new Set(categories)].filter(category => REPORT_OPENALEX_FIELDS[category]);
  if (selected.length === 0) {
    return [
      'primary_topic.field.id:27|24|28|29|30|35|36',
      'primary_topic.field.id:17|31|26|18',
      'primary_topic.field.id:11|13|16',
      '',
    ];
  }

  return [...new Set(selected.map(category => (
    `primary_topic.field.id:${[...new Set(REPORT_OPENALEX_FIELDS[category])].join('|')}`
  )))];
}

export function getArxivCategoriesForReport(categories = []) {
  const selected = [...new Set(categories)].filter(category => CATEGORIES[category]);
  if (selected.length === 0) return DEFAULT_ARXIV_REPORT_CATEGORIES;
  return [...new Set(selected.flatMap(category => REPORT_ARXIV_CATEGORIES[category] || []))];
}

export function getPubmedCategoriesForReport(categories = []) {
  return [...new Set(categories
    .filter(category => category === 'med' || category === 'bio')
    .flatMap(category => Object.keys(CATEGORIES[category]?.subcategories || {})))];
}

function cacheCorpus(cacheKey, entry) {
  CORPUS_CACHE.delete(cacheKey);
  while (CORPUS_CACHE.size >= MAX_CORPUS_CACHE_ENTRIES) {
    CORPUS_CACHE.delete(CORPUS_CACHE.keys().next().value);
  }
  CORPUS_CACHE.set(cacheKey, entry);
}

export function formatOpenAlexWork(work) {
  let summary = 'Resumen no disponible.';
  if (work.abstract_inverted_index) {
    const words = [];
    for (const [word, positions] of Object.entries(work.abstract_inverted_index)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
    summary = words.join(' ').replace(/\s+/g, ' ').trim();
  }
  
  const authors = work.authorships?.map(a => ({ name: a.author?.display_name || 'Unknown Author', id: a.author?.id })) || [{ name: 'Unknown Author' }];
  const topics = work.topics || [];
  const concepts = work.concepts || [];
  const categoryLabels = (topics.length > 0 ? topics : concepts)
    .filter(item => (item.score ?? 1) > 0.3)
    .map(item => item.display_name)
    .filter(Boolean);
  const openAlexId = work.id.split('/').pop();
  
  // Extract unique country codes from all author institutions
  const countrySet = new Set();
  const institutionSet = new Set();
  (work.authorships || []).forEach(a => {
    (a.institutions || []).forEach(inst => {
      if (inst.country_code) countrySet.add(inst.country_code);
      if (inst.id) institutionSet.add(inst.id);
    });
  });
  
  return PaperBuilder.create({
    id: `openalex:${openAlexId}`,
    sources: { primary: 'openalex', enrichedBy: [] },
    title: normalizeScientificMarkup(work.title || 'No Title'),
    abstract: normalizeScientificMarkup(summary || 'No summary available.'),
    authors,
    year: work.publication_date ? new Date(work.publication_date).getFullYear() : new Date().getFullYear(),
    publicationType: work.primary_location?.source?.type || 'journal',
    publicationStatus: work.primary_location?.is_published ? 'published' : 'preprint',
    openAccess: work.open_access?.is_oa || false,
    pdfUrl: work.open_access?.oa_url || null,
    landingPageUrl: work.primary_location?.landing_page_url || work.id,
    doi: work.doi || null,
    journal: work.primary_location?.source?.display_name || null,
    publisher: work.primary_location?.source?.host_organization_name || null,
    citationCount: work.cited_by_count || 0,
    concepts,
    topics,
    primaryTopic: work.primary_topic || topics[0] || null,
    categories: categoryLabels,
    keywords: (work.keywords || []).map(keyword => keyword.display_name).filter(Boolean),
    countryCodes: Array.from(countrySet),
    institutionCount: institutionSet.size,
    fwci: work.fwci ?? null,
    citationNormalizedPercentile: work.citation_normalized_percentile || null,
    citedByPercentileYear: work.cited_by_percentile_year || null,
    countsByYear: work.counts_by_year || [],
    published: work.publication_date || '',
  });
}

async function fetchOpenAlexCandidates(fromStr, toStr, timeframe, page = 1, filters = {}, options = {}) {
  const topicFilters = buildOpenAlexTopicFilters(filters.categories);
  
  const sort = 'cited_by_count:desc';
  
  // Build country filter for OpenAlex API
  const countryFilter = filters.countries?.length > 0
    ? `,authorships.institutions.country_code:${filters.countries.join('|')}`
    : '';
  
  const promises = topicFilters.map(async (topicFilter) => {
    let filter = `from_publication_date:${fromStr},to_publication_date:${toStr},type:article,has_doi:true${countryFilter}`;
    if (topicFilter) {
      filter += `,${topicFilter}`;
    }
    const url = `https://api.openalex.org/works?filter=${filter}&sort=${sort}&per_page=60&page=${page}&mailto=app@papertok.io`;
    try {
      const data = await openAlexJson(url, {
        timeoutMs: 10000,
        cacheTtlMs: options.forceRefresh ? 0 : 60 * 60 * 1000,
        staleIfError: true,
      });
      return { works: data.results || [], ok: true };
    } catch (e) {
      console.warn(`OpenAlex topic query failed: ${topicFilter}`, e);
    }
    return { works: [], ok: false };
  });
  
  const results = await Promise.allSettled(promises);
  const queryResults = results.map(result => result.status === 'fulfilled'
    ? result.value
    : { works: [], ok: false });
  const rawWorks = queryResults.flatMap(result => result.works);
  const successfulQueries = queryResults.filter(result => result.ok).length;
  const status = successfulQueries === queryResults.length
    ? 'active'
    : successfulQueries > 0 ? 'partial' : 'unavailable';
  
  // Deduplicate by work ID and map to standard
  const seen = new Set();
  const papers = [];
  rawWorks.forEach(work => {
    if (work && work.id && !seen.has(work.id)) {
      seen.add(work.id);
      papers.push(formatOpenAlexWork(work));
    }
  });
  
  return { papers, status };
}

/**
 * Fetch recent preprints from arXiv
 */
async function fetchArxivCandidates(timeframe, page = 1, filters = {}, options = {}) {
  try {
    const categories = getArxivCategoriesForReport(filters.categories);
    if (categories.length === 0) return { papers: [], status: 'not-applicable' };

    const { fromStr, toStr } = options.period || getDateThresholds(timeframe);
    const categoryQuery = categories.map(category => `cat:${category}`).join(' OR ');

    // arXiv answers newest-first queries in well under a second, but a
    // submittedDate range makes the same query take 10-20s and blow through
    // every proxy timeout — which is what kept flagging the source as
    // unavailable. Short editions therefore fetch newest-first and trim to the
    // window client-side (six popular categories produce far more than 50
    // papers a week, so the window stays fully covered). Long and custom
    // editions still need the range to sample the window at all.
    // The Worker proxy also caps max_results at 50 and silently DROPS larger
    // values (arXiv then defaults to 10), so 50 is the real upper bound.
    const isShortWindow = timeframe === '24h' || timeframe === '7d';
    const maxResults = 50;
    const offset = (page - 1) * maxResults;
    const query = isShortWindow
      ? `(${categoryQuery})`
      : `(${categoryQuery}) AND submittedDate:[${fromStr.replaceAll('-', '')}0000 TO ${toStr.replaceAll('-', '')}2359]`;

    const papers = await fetchArxivPapers(
      query,
      offset,
      maxResults,
      'submittedDate',
      'submittedDate',
      { forceRefresh: options.forceRefresh },
    );
    const windowFrom = new Date(`${fromStr}T00:00:00Z`).getTime();
    const windowTo = new Date(`${toStr}T23:59:59Z`).getTime();
    const withinWindow = (papers || []).filter((paper) => {
      const published = Date.parse(paper.published || '');
      return !Number.isFinite(published) || (published >= windowFrom && published <= windowTo);
    });
    return { papers: withinWindow, status: 'active' };
  } catch (err) {
    console.warn("Failed to fetch arXiv candidates for report", err);
    return { papers: [], status: 'unavailable' };
  }
}

/**
 * Fetch candidates from PubMed
 */
async function fetchPubmedCandidates(timeframe, page = 1, filters = {}, options = {}) {
  try {
    if (filters.categories && filters.categories.length > 0) {
      const isMedOrBio = filters.categories.some(c => ['med', 'bio'].includes(c));
      if (!isMedOrBio) return { papers: [], status: 'not-applicable' };
    }

    const adapter = new PubmedAdapter();
    const { fromStr, toStr } = options.period || getDateThresholds(timeframe);
    // PubMed accepts publication-date ranges directly in the query. Without this,
    // a daily or weekly edition can accidentally surface older articles.
    const dateRange = `("${fromStr}"[Date - Publication] : "${toStr}"[Date - Publication])`;
    const query = `(medicine[journal] OR biology[journal] OR science[journal] OR Nature[journal]) AND ${dateRange}`;
    const internalCategories = getPubmedCategoriesForReport(filters.categories);
    const response = await adapter.search(query, page, { internalCategories });
    return { papers: response.papers || [], status: 'active' };
  } catch (err) {
    console.warn("Failed to fetch PubMed candidates for report", err);
    return { papers: [], status: 'unavailable' };
  }
}

/**
 * Core orchestrator function to build, deduplicate, score, and rank candidates
 */
export async function getScientificReport(timeframe = '7d', page = 1, filters = {}, options = {}) {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const forceRefresh = Boolean(options.forceRefresh);
  let tf;
  let cacheKey;
  
  if (typeof timeframe === 'object' && timeframe.type === 'custom') {
    tf = timeframe;
    cacheKey = `custom_${timeframe.from}_${timeframe.to}`;
  } else {
    const validTimeframes = ['24h', '7d', '30d', '1y', '10y'];
    tf = validTimeframes.includes(timeframe) ? timeframe : '7d';
    cacheKey = tf;
  }
  
  const period = getDateThresholds(tf);
  const { fromStr, toStr, days } = period;

  // Concrete dates prevent a preset edition from reusing yesterday's corpus.
  cacheKey += `_${fromStr}_${toStr}_p${normalizedPage}`;
  
  const filterKey = JSON.stringify({
    categories: [...new Set(filters.categories || [])].sort(),
    countries: [...new Set(filters.countries || [])].sort()
  });
  if (filterKey !== '{"categories":[],"countries":[]}') cacheKey += `_f:${filterKey}`;
  
  const cached = CORPUS_CACHE.get(cacheKey);
  let corpus = !forceRefresh && cached && (Date.now() - cached.timestamp < (cached.ttlMs || CACHE_TTL))
    ? cached.data
    : null;

  if (!corpus) {
    console.log(`[ScientificReport] Fetching corpus for: ${cacheKey} (from ${fromStr} to ${toStr})`);
    const hasCountryFilter = filters.countries?.length > 0;
    const excludedSource = { papers: [], status: 'excluded' };
    const [arxivResult, openAlexResult, pubmedResult] = await Promise.all([
      hasCountryFilter
        ? Promise.resolve(excludedSource)
        : withSourceDeadline(fetchArxivCandidates(tf, normalizedPage, filters, { forceRefresh, period })),
      withSourceDeadline(fetchOpenAlexCandidates(fromStr, toStr, tf, normalizedPage, filters, { forceRefresh })),
      hasCountryFilter
        ? Promise.resolve(excludedSource)
        : withSourceDeadline(fetchPubmedCandidates(tf, normalizedPage, filters, { period })),
    ]);

    const coverage = {
      countryLimited: hasCountryFilter,
      sources: [
        { id: 'openalex', label: 'OpenAlex', status: openAlexResult.status, candidates: openAlexResult.papers.length },
        { id: 'arxiv', label: 'arXiv', status: arxivResult.status, candidates: arxivResult.papers.length },
        { id: 'pubmed', label: 'PubMed', status: pubmedResult.status, candidates: pubmedResult.papers.length },
      ],
    };
    let candidates = PaperBuilder.deduplicate([
      ...arxivResult.papers,
      ...openAlexResult.papers,
      ...pubmedResult.papers,
    ]);

    if (filters.categories?.length > 0) {
      candidates = candidates.filter(paper => (
        filters.categories.some(categoryKey => paperMatchesCategory(paper, categoryKey))
      ));
    }

    corpus = { candidates, coverage };
    const hasUnavailableSource = coverage.sources.some(source => source.status === 'unavailable');
    cacheCorpus(cacheKey, {
      timestamp: Date.now(),
      ttlMs: hasUnavailableSource ? DEGRADED_CACHE_TTL : CACHE_TTL,
      data: corpus,
    });
  } else {
    console.log(`[ScientificReport] Reusing cached corpus for: ${cacheKey}`);
  }

  const editions = buildScientificReportEditions(corpus.candidates, {
    timeframe: tf,
    days,
    profile: options.profile,
    trends: options.trends,
  });

  return {
    ...editions.panorama,
    editions,
    coverage: corpus.coverage,
    corpusSize: corpus.candidates.length,
  };
}
