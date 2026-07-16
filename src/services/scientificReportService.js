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
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms
const DEGRADED_CACHE_TTL = 5 * 60 * 1000;
const REPORT_SOURCE_TIMEOUT_MS = 6500;

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
function paperMatchesCategory(paper, categoryKey) {
  const area = CATEGORIES[categoryKey];
  if (!area) return false;

  const primaryFieldId = String(paper.primaryTopic?.field?.id || '').split('/').pop();
  if (primaryFieldId && REPORT_OPENALEX_FIELDS[categoryKey]?.includes(primaryFieldId)) return true;
  
  const prim = (paper.primaryCategory || '').toLowerCase();
  const key = categoryKey.toLowerCase();
  if (prim === key) return true;
  
  if (prim.startsWith(key + '.') || prim.startsWith(key + '-')) return true;
  
  const areaFromArxiv = getCategoryArea(paper.primaryCategory);
  if (areaFromArxiv === categoryKey) return true;
  
  const labelsToMatch = [
    area.label.toLowerCase(),
    area.labelEn.toLowerCase(),
    ...Object.values(area.subcategories).flatMap(sub => [
      sub.label.toLowerCase(),
      sub.labelEn.toLowerCase()
    ])
  ];
  
  const paperCats = (paper.categories || []).map(c => c.toLowerCase());
  if (paper.primaryCategory) paperCats.push(paper.primaryCategory.toLowerCase());
  
  return paperCats.some(cat => labelsToMatch.includes(cat));
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
  const topicFilters = filters.categories && filters.categories.length > 0
    ? [...new Set(filters.categories.flatMap(category => REPORT_OPENALEX_FIELDS[category] || []))]
      .map(field => `primary_topic.field.id:${field}`)
    : [
       'primary_topic.field.id:27|24|28|29|30|35|36',
       'primary_topic.field.id:17|31|26|18',
       'primary_topic.field.id:11|13|16',
       '',
      ];
  
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
    const AREA_TO_ARXIV = {
      cs: 'cs.AI',
      physics: 'quant-ph',
      bio: 'q-bio.NC',
      stat: 'stat.ML',
      math: 'math.PR',
      eess: 'eess.SP',
      econ: 'econ.EM',
      'q-fin': 'q-fin.ST'
    };
    
    let categories = [];
    if (filters.categories && filters.categories.length > 0) {
      categories = filters.categories.map(c => AREA_TO_ARXIV[c]).filter(Boolean);
      if (categories.length === 0) return { papers: [], status: 'not-applicable' };
    } else {
      categories = ['cs.AI', 'quant-ph', 'q-bio.NC', 'stat.ML', 'math.PR', 'eess.SP'];
    }

    const { fromStr, toStr } = getDateThresholds(timeframe);
    const fromDate = fromStr.replaceAll('-', '');
    const toDate = toStr.replaceAll('-', '');
    const categoryQuery = categories.map(category => `cat:${category}`).join(' OR ');
    const query = `(${categoryQuery}) AND submittedDate:[${fromDate}0000 TO ${toDate}2359]`;

    // A date-range query is necessary for long and custom editions. Sorting alone
    // only returns the newest records and does not guarantee the requested window.
    const maxResults = (timeframe === '24h' || timeframe === '7d') ? 80 : 200;
    const offset = (page - 1) * maxResults;
    const papers = await fetchArxivPapers(
      query,
      offset,
      maxResults,
      'submittedDate',
      'submittedDate',
      { forceRefresh: options.forceRefresh },
    );
    return { papers: papers || [], status: 'active' };
  } catch (err) {
    console.warn("Failed to fetch arXiv candidates for report", err);
    return { papers: [], status: 'unavailable' };
  }
}

/**
 * Fetch candidates from PubMed
 */
async function fetchPubmedCandidates(timeframe, page = 1, filters = {}) {
  try {
    if (filters.categories && filters.categories.length > 0) {
      const isMedOrBio = filters.categories.some(c => ['med', 'bio'].includes(c));
      if (!isMedOrBio) return { papers: [], status: 'not-applicable' };
    }

    const adapter = new PubmedAdapter();
    const { fromStr, toStr } = getDateThresholds(timeframe);
    // PubMed accepts publication-date ranges directly in the query. Without this,
    // a daily or weekly edition can accidentally surface older articles.
    const dateRange = `("${fromStr}"[Date - Publication] : "${toStr}"[Date - Publication])`;
    const query = `(medicine[journal] OR biology[journal] OR science[journal] OR Nature[journal]) AND ${dateRange}`;
    const response = await adapter.search(query, page);
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
  
  // Include page and filters in cache key
  cacheKey += `_p${normalizedPage}`;
  
  const filterKey = JSON.stringify({
    categories: [...new Set(filters.categories || [])].sort(),
    countries: [...new Set(filters.countries || [])].sort()
  });
  if (filterKey !== '{"categories":[],"countries":[]}') cacheKey += `_f:${filterKey}`;
  
  const { fromStr, toStr, days } = getDateThresholds(tf);
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
        : withSourceDeadline(fetchArxivCandidates(tf, normalizedPage, filters, { forceRefresh })),
      withSourceDeadline(fetchOpenAlexCandidates(fromStr, toStr, tf, normalizedPage, filters, { forceRefresh })),
      hasCountryFilter
        ? Promise.resolve(excludedSource)
        : withSourceDeadline(fetchPubmedCandidates(tf, normalizedPage, filters)),
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
    CORPUS_CACHE.set(cacheKey, {
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
