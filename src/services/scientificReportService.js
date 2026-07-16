/**
 * Scientific Report Service
 * Orchestrates candidate fetching from arXiv, OpenAlex, and PubMed,
 * runs custom ranking and diversity scoring, and caches stable editions.
 */

import { fetchPapers as fetchArxivPapers } from './arxivService.js';
import { PubmedAdapter } from './adapters/PubmedAdapter.js';
import { PaperBuilder } from './PaperBuilder.js';
import { CATEGORIES, getCategoryLabel, getCategoryArea } from '../data/categories.js';
import { openAlexJson } from './openAlexClient.js';
import { normalizeScientificMarkup } from '../utils/latex.js';

// Global cache for stable editions (TTL: 1 hour)
const REPORT_CACHE = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper to get date thresholds based on timeframe
 */
export function getDateThresholds(timeframe, currentDate = new Date()) {
  if (typeof timeframe === 'object' && timeframe.type === 'custom') {
    const fromDate = new Date(`${timeframe.from}T00:00:00`);
    const toDate = new Date(`${timeframe.to}T00:00:00`);
    const difference = Math.floor((toDate - fromDate) / (1000 * 60 * 60 * 24));
    return {
      fromStr: timeframe.from,
      toStr: timeframe.to,
      days: Number.isFinite(difference) ? Math.max(1, difference + 1) : 1
    };
  }

  const today = currentDate instanceof Date ? new Date(currentDate) : new Date(currentDate);
  const inclusiveDays = {
    '24h': 2, // Provider dates have day precision, so this edition is today + yesterday.
    '7d': 7,
    '30d': 30,
    '1y': 365,
    '10y': 3650,
  }[timeframe] || 7;
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - (inclusiveDays - 1));
  
  return {
    fromStr: formatDate(fromDate),
    toStr: formatDate(today),
    days: inclusiveDays
  };
}

/**
 * Normalizes OpenAlex raw works to standard PaperTok Paper objects
 */
/**
 * Helper to check if a paper matches a selected category key
 */
function paperMatchesCategory(paper, categoryKey) {
  const area = CATEGORIES[categoryKey];
  if (!area) return false;
  
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
  const concepts = (work.concepts || []).filter(c => c.score > 0.3).map(c => c.display_name);
  const openAlexId = work.id.split('/').pop();
  
  // Extract unique country codes from all author institutions
  const countrySet = new Set();
  (work.authorships || []).forEach(a => {
    (a.institutions || []).forEach(inst => {
      if (inst.country_code) countrySet.add(inst.country_code);
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
    concepts: work.concepts || [],
    categories: concepts,
    keywords: concepts,
    countryCodes: Array.from(countrySet),
    published: work.publication_date || ''
  });
}

async function fetchOpenAlexCandidates(fromStr, toStr, timeframe, page = 1, filters = {}, options = {}) {
  const AREA_TO_OPENALEX = {
    med: 'C14213010',
    bio: 'C86803240',
    cs: 'C41008148',
    physics: 'C121332964',
    math: 'C33923547',
    stat: 'C33923547', // Maps to Math/Stat in OpenAlex
    econ: 'C162324750',
    'q-fin': 'C162324750',
    eess: 'C127413603', // Engineering
    mech: 'C127413603',
    civil: 'C127413603',
    chemeng: 'C185592680' // Chemistry
  };

  const concepts = filters.categories && filters.categories.length > 0
    ? [...new Set(filters.categories.map(category => AREA_TO_OPENALEX[category]).filter(Boolean))]
      .map(concept => `concepts.id:${concept}`)
    : [
       'concepts.id:C14213010', // Medicine
       'concepts.id:C41008148|C121332964|C33923547', // CS / Physics / Math
       'concepts.id:C86803240|C43617362', // Bio / Chem
       '' // General (no concept filter)
      ];
  
  const sort = 'cited_by_count:desc';
  
  // Build country filter for OpenAlex API
  const countryFilter = filters.countries?.length > 0
    ? `,authorships.institutions.country_code:${filters.countries.join('|')}`
    : '';
  
  const promises = concepts.map(async (conceptFilter) => {
    let filter = `from_publication_date:${fromStr},to_publication_date:${toStr},type:article,has_doi:true${countryFilter}`;
    if (conceptFilter) {
      filter += `,${conceptFilter}`;
    }
    const url = `https://api.openalex.org/works?filter=${filter}&sort=${sort}&per-page=60&page=${page}&mailto=app@papertok.io`;
    try {
      const data = await openAlexJson(url, {
        timeoutMs: 10000,
        cacheTtlMs: options.forceRefresh ? 0 : 60 * 60 * 1000,
        staleIfError: true,
      });
      return { works: data.results || [], ok: true };
    } catch (e) {
      console.warn(`OpenAlex concept query failed: ${conceptFilter}`, e);
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
 * Score a candidate paper — pure scientific impact ranking.
 * 
 * Philosophy: The report should surface the most impactful papers
 * in each time window, regardless of publisher, access model, or source.
 * 
 * Factors (in order of weight):
 *   1. Citation Impact (log-scaled, NO cap)  — dominant signal
 *   2. Recency within the window             — tiebreaker / freshness
 *   3. Abstract quality                      — papers without abstracts are less useful
 *   4. Category Diversity penalty            — prevents monoculture
 *   5. Source Diversity penalty              — prevents one journal flooding results
 */
export function scorePaper(paper, timeframe, seenCategories, daysThreshold, seenSources, currentDate = new Date()) {
  let score = 0;
  
  const now = currentDate instanceof Date ? currentDate : new Date(currentDate);
  const rawPublicationDate = paper.publishedDate || paper.published;
  const publicationTimestamp = rawPublicationDate ? Date.parse(rawPublicationDate) : Number.NaN;
  const pubDate = Number.isFinite(publicationTimestamp) ? new Date(publicationTimestamp) : now;
  const diffDays = Math.max(1, Math.ceil(Math.max(0, now - pubDate) / (1000 * 60 * 60 * 24)));
  
  // ── 1. Citation Impact (dominant factor, NO hard cap) ──
  // Use log scale so differences always matter: 293 cites >> 8 cites >> 0 cites.
  // The log curve prevents a single mega-cited paper from completely dominating,
  // while still preserving meaningful ranking differences at every level.
  const citations = paper.citationCount || 0;
  const yearsOld = Math.max(0.05, diffDays / 365);
  const citationsPerYear = citations / yearsOld;
  
  if (typeof timeframe === 'string') {
    if (timeframe === '24h' || timeframe === '7d') {
      // Very short window: raw citations are rare, so log(1 + c) * high multiplier.
      // log10(1) = 0, log10(2) = 0.3, log10(9) = 0.95, log10(40) = 1.6, log10(300) = 2.5
      score += Math.log10(citations + 1) * 20;
    } else if (timeframe === '30d') {
      // Mix: raw citations + velocity
      score += Math.log10(citations + 1) * 15;
    } else if (timeframe === '1y') {
      // Citation velocity (per year) becomes the main metric
      score += Math.log10(citationsPerYear + 1) * 16;
    } else {
      // 10y — age-normalized impact
      score += Math.log10(citationsPerYear + 1) * 18;
    }
  } else {
    // Custom range
    const rangeDays = daysThreshold || 30;
    if (rangeDays <= 31) {
      score += Math.log10(citations + 1) * 15;
    } else {
      score += Math.log10(citationsPerYear + 1) * 16;
    }
  }
  
  // ── 2. Recency Score ──
  // Within the requested window, prefer more recent papers as a tiebreaker.
  // Max 8 points, decaying proportionally to the window size.
  const windowDays = typeof timeframe === 'string'
    ? { '24h': 1, '7d': 7, '30d': 30, '1y': 365, '10y': 3650 }[timeframe] || 30
    : (daysThreshold || 30);
  
  const recencyRatio = Math.max(0, 1 - (diffDays / windowDays));
  score += recencyRatio * 8;
  
  // ── 3. Abstract Quality ──
  const abstract = (paper.abstract || '').trim();
  const abstractLen = abstract.length;
  if (abstractLen > 100 && !abstract.startsWith('Resumen no disponible') && !abstract.startsWith('No summary')) {
    score += 2;
  }
  
  // ── 3b. Anticipated Impact (For 24h & 7d) ──
  // Proxy for impact when citations haven't had time to accrue.
  if (typeof timeframe === 'string' && (timeframe === '24h' || timeframe === '7d')) {
    // Collaboration Bonus: Proxy for large consortiums or important labs
    const authorCount = paper.authors ? paper.authors.length : 0;
    if (authorCount >= 10) score += 4;
    else if (authorCount >= 5) score += 2;
    else if (authorCount >= 2) score += 1;
    
    // Venue / Peer-review proxy: Boost if already in a peer-reviewed journal vs a preprint
    const source = (paper.journal || paper.publisher || '').toLowerCase();
    if (source && source !== 'arxiv' && source !== 'biorxiv' && source !== 'medrxiv') {
      score += 3;
    }
    
    // Content richness penalty
    if (abstractLen < 150) {
      score -= 5; // Penalize stub abstracts heavily in daily feed
    } else if (abstractLen > 600) {
      score += 1; // Good comprehensive abstract
    }
  }
  
  // ── 4. Category Diversity Penalty ──
  const cat = (paper.categories && paper.categories[0]) || paper.primaryCategory || '';
  const prefix = cat.split('.')[0].split('-')[0].toLowerCase();
  
  if (prefix) {
    const seenCount = seenCategories.get(prefix) || 0;
    if (seenCount > 0) {
      score -= seenCount * 6;
    }
  }
  
  // ── 5. Source Diversity Penalty ──
  // Prevents a single journal/venue from filling all slots (e.g. 7 "Nuclear Fusion" papers).
  if (seenSources) {
    const source = (paper.journal || paper.publisher || '').toLowerCase().trim();
    if (source) {
      const sourceCount = seenSources.get(source) || 0;
      if (sourceCount > 0) {
        score -= sourceCount * 4;
      }
    }
  }
  
  return score;
}

export function extractFeaturedConcepts(papers, limit = 5) {
  const conceptScores = new Map();

  (papers || []).forEach((paper, paperIndex) => {
    const concepts = Array.isArray(paper.concepts) && paper.concepts.length > 0
      ? paper.concepts
      : (paper.categories || []);
    const seenInPaper = new Set();

    concepts
      .filter(concept => typeof concept !== 'object' || concept?.level !== 0)
      .slice(0, 6)
      .forEach((concept, conceptIndex) => {
        const rawName = typeof concept === 'string' ? concept : concept?.display_name;
        const name = rawName?.trim();
        if (!name || name.length <= 3) return;

        const label = getCategoryLabel(name);
        const normalizedLabel = label.toLocaleLowerCase('es');
        if (seenInPaper.has(normalizedLabel)) return;
        seenInPaper.add(normalizedLabel);

        const relevance = typeof concept?.score === 'number' ? Math.max(0.1, concept.score) : 1;
        const positionWeight = 1 / (1 + conceptIndex * 0.2);
        const selectionWeight = 1 / (1 + paperIndex * 0.05);
        conceptScores.set(label, (conceptScores.get(label) || 0) + relevance * positionWeight * selectionWeight);
      });
  });

  return Array.from(conceptScores.entries())
    .sort(([labelA, scoreA], [labelB, scoreB]) => scoreB - scoreA || labelA.localeCompare(labelB, 'es'))
    .map(([label]) => label)
    .slice(0, limit);
}

/**
 * Core orchestrator function to build, deduplicate, score, and rank candidates
 */
export async function getScientificReport(timeframe = '7d', page = 1, filters = {}, options = {}) {
  const normalizedPage = Number.isInteger(page) && page > 0 ? page : 1;
  const forceRefresh = Boolean(options.forceRefresh);
  let tf = '7d';
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
  
  // Check global cache
  const cached = REPORT_CACHE.get(cacheKey);
  if (!forceRefresh && cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[ScientificReport] Returning cached stable edition for: ${cacheKey}`);
    return cached.data;
  }
  
  const { fromStr, toStr, days } = getDateThresholds(tf);
  
  console.log(`[ScientificReport] Generating report for: ${cacheKey} (from ${fromStr} to ${toStr})`);
  
  const hasCountryFilter = filters.countries?.length > 0;
  
  // 1. Fetch Candidates from all sources in parallel
  // When country filter is active, only use OpenAlex (only source with country data)
  const excludedSource = { papers: [], status: 'excluded' };
  const [arxivResult, openAlexResult, pubmedResult] = await Promise.all([
    hasCountryFilter ? Promise.resolve(excludedSource) : fetchArxivCandidates(tf, normalizedPage, filters, { forceRefresh }),
    fetchOpenAlexCandidates(fromStr, toStr, tf, normalizedPage, filters, { forceRefresh }),
    hasCountryFilter ? Promise.resolve(excludedSource) : fetchPubmedCandidates(tf, normalizedPage, filters)
  ]);

  const coverage = {
    countryLimited: hasCountryFilter,
    sources: [
      { id: 'openalex', label: 'OpenAlex', status: openAlexResult.status, candidates: openAlexResult.papers.length },
      { id: 'arxiv', label: 'arXiv', status: arxivResult.status, candidates: arxivResult.papers.length },
      { id: 'pubmed', label: 'PubMed', status: pubmedResult.status, candidates: pubmedResult.papers.length },
    ],
  };
  
  // 2. Combine and Deduplicate
  let allCandidates = PaperBuilder.deduplicate([
    ...arxivResult.papers,
    ...openAlexResult.papers,
    ...pubmedResult.papers
  ]);
  
  // Apply strict client-side category filtering to prevent false positives from OpenAlex API queries
  if (filters.categories && filters.categories.length > 0) {
    allCandidates = allCandidates.filter(paper => {
      return filters.categories.some(catKey => paperMatchesCategory(paper, catKey));
    });
  }
  
  if (allCandidates.length === 0) {
    const emptyReport = { mainDiscovery: null, highlights: [], featuredConcepts: [], coverage };
    REPORT_CACHE.set(cacheKey, { timestamp: Date.now(), data: emptyReport });
    return emptyReport;
  }
  
  // 3. Dynamic Selection Loop with Diversity Penalties
  const selected = [];
  const candidates = [...allCandidates];
  const seenCategories = new Map();
  const seenSources = new Map();
  
  // Select up to 11 papers (1 Main Discovery + 10 Highlights)
  const maxToSelect = Math.min(11, candidates.length);
  while (selected.length < maxToSelect && candidates.length > 0) {
    // Re-score remaining candidates based on current diversity state
    candidates.forEach(paper => {
      paper._tempScore = scorePaper(paper, tf, seenCategories, days, seenSources);
    });
    
    // Sort by temporary score
    candidates.sort((a, b) => b._tempScore - a._tempScore);
    
    // Extract the top scoring paper
    const best = candidates.shift();
    selected.push(best);
    
    // Track its category to penalize subsequent papers in the same field
    const cat = (best.categories && best.categories[0]) || best.primaryCategory || '';
    const prefix = cat.split('.')[0].split('-')[0].toLowerCase();
    if (prefix) {
      seenCategories.set(prefix, (seenCategories.get(prefix) || 0) + 1);
    }
    
    // Track its source/journal to prevent one venue from dominating
    const source = (best.journal || best.publisher || '').toLowerCase().trim();
    if (source) {
      seenSources.set(source, (seenSources.get(source) || 0) + 1);
    }
  }
  
  const mainDiscovery = selected[0] || null;
  const highlights = selected.slice(1, 11);
  
  // These describe the final editorial selection. A real trend requires a
  // comparison baseline, so the UI deliberately labels them as featured topics.
  const featuredConcepts = extractFeaturedConcepts(selected);

  const reportData = { mainDiscovery, highlights, featuredConcepts, coverage };
  
  // Update cache
  REPORT_CACHE.set(cacheKey, { timestamp: Date.now(), data: reportData });
  
  return reportData;
}
