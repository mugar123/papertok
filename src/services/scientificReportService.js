/**
 * Scientific Report Service
 * Orchestrates candidate fetching from arXiv, OpenAlex, and PubMed,
 * runs custom ranking and diversity scoring, and caches stable editions.
 */

import { fetchPapers as fetchArxivPapers } from './arxivService';
import { PubmedAdapter } from './adapters/PubmedAdapter';
import { PaperBuilder } from './PaperBuilder';
import { CATEGORIES } from '../data/categories';

// Global cache for stable editions (TTL: 1 hour)
const REPORT_CACHE = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour in ms

/**
 * Fetch a URL with a timeout helper
 */
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Helper to get date thresholds based on timeframe
 */
function getDateThresholds(timeframe) {
  if (typeof timeframe === 'object' && timeframe.type === 'custom') {
    const fromDate = new Date(timeframe.from);
    const toDate = new Date(timeframe.to);
    return {
      fromStr: timeframe.from,
      toStr: timeframe.to,
      days: Math.ceil((toDate - fromDate) / (1000 * 60 * 60 * 24)) || 1
    };
  }

  const today = new Date();
  let fromDate = new Date();
  
  if (timeframe === '24h') {
    fromDate.setDate(today.getDate() - 1);
  } else if (timeframe === '7d') {
    fromDate.setDate(today.getDate() - 7);
  } else if (timeframe === '30d') {
    fromDate.setDate(today.getDate() - 30);
  } else if (timeframe === '1y') {
    fromDate.setDate(today.getDate() - 365);
  } else if (timeframe === '10y') {
    fromDate.setDate(today.getDate() - 3650);
  }
  
  return {
    fromStr: formatDate(fromDate),
    toStr: formatDate(today),
    days: Math.ceil((today - fromDate) / (1000 * 60 * 60 * 24)) || 1
  };
}

/**
 * Normalizes OpenAlex raw works to standard PaperTok Paper objects
 */
function formatOpenAlexWork(work) {
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
  
  return PaperBuilder.create({
    id: `openalex:${openAlexId}`,
    sources: { primary: 'openalex', enrichedBy: [] },
    title: work.title || 'No Title',
    abstract: summary || 'No summary available.',
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
    keywords: concepts
  });
}

/**
 * Fetch candidates from OpenAlex across multiple concept domains
 */
async function fetchOpenAlexCandidates(fromStr, toStr, timeframe, shouldRandomize = false) {
  // Concept mapping: Medicine (C14213010), CS (C41008148), Physics (C121332964), Bio (C86803240)
  const concepts = [
    'concepts.id:C14213010', // Medicine
    'concepts.id:C41008148|C121332964|C33923547', // CS / Physics / Math
    'concepts.id:C86803240|C43617362', // Bio / Chem
    '' // General (no concept filter)
  ];
  
  const sort = 'cited_by_count:desc';
  const page = shouldRandomize ? Math.floor(Math.random() * 3) + 1 : 1;
  
  const promises = concepts.map(async (conceptFilter) => {
    let filter = `from_publication_date:${fromStr},to_publication_date:${toStr},type:article,has_doi:true`;
    if (conceptFilter) {
      filter += `,${conceptFilter}`;
    }
    const url = `https://api.openalex.org/works?filter=${filter}&sort=${sort}&per-page=60&page=${page}&mailto=app@papertok.io`;
    try {
      const res = await fetchWithTimeout(url, 10000);
      if (res.ok) {
        const data = await res.json();
        return data.results || [];
      }
    } catch (e) {
      console.warn(`OpenAlex concept query failed: ${conceptFilter}`, e);
    }
    return [];
  });
  
  const results = await Promise.allSettled(promises);
  const rawWorks = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  
  // Deduplicate by work ID and map to standard
  const seen = new Set();
  const papers = [];
  rawWorks.forEach(work => {
    if (work && work.id && !seen.has(work.id)) {
      seen.add(work.id);
      papers.push(formatOpenAlexWork(work));
    }
  });
  
  return papers;
}

/**
 * Fetch recent preprints from arXiv
 */
async function fetchArxivCandidates(timeframe, shouldRandomize = false) {
  try {
    // Broad set of categories to query
    const categories = ['cs.AI', 'physics.quant-ph', 'q-bio.NC', 'stat.ML', 'math.PR', 'eess.SP'];
    // For 24h/7d/30d get recent papers. For 1y/10y we can get up to 100 papers
    const maxResults = (timeframe === '24h' || timeframe === '7d') ? 40 : 100;
    const offset = shouldRandomize ? Math.floor(Math.random() * 100) : 0;
    const papers = await fetchArxivPapers(categories, offset, maxResults, 'submittedDate');
    return papers || [];
  } catch (err) {
    console.warn("Failed to fetch arXiv candidates for report", err);
    return [];
  }
}

/**
 * Fetch candidates from PubMed
 */
async function fetchPubmedCandidates(timeframe, shouldRandomize = false) {
  try {
    const adapter = new PubmedAdapter();
    const page = shouldRandomize ? Math.floor(Math.random() * 4) + 1 : 1;
    // Query medicine and health related terms
    const query = 'medicine[journal] OR biology[journal] OR science[journal] OR Nature[journal]';
    const response = await adapter.search(query, page);
    return response.papers || [];
  } catch (err) {
    console.warn("Failed to fetch PubMed candidates for report", err);
    return [];
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
function scorePaper(paper, timeframe, seenCategories, daysThreshold, seenSources) {
  let score = 0;
  
  const now = new Date();
  const pubDate = new Date(paper.publishedDate || paper.published || now);
  const diffDays = Math.max(1, Math.ceil(Math.abs(now - pubDate) / (1000 * 60 * 60 * 24)));
  
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

/**
 * Core orchestrator function to build, deduplicate, score, and rank candidates
 */
export async function getScientificReport(timeframe = '7d', forceRefresh = false) {
  let tf = '7d';
  let cacheKey = '7d';
  
  if (typeof timeframe === 'object' && timeframe.type === 'custom') {
    tf = timeframe;
    cacheKey = `custom_${timeframe.from}_${timeframe.to}`;
  } else {
    const validTimeframes = ['24h', '7d', '30d', '1y', '10y'];
    tf = validTimeframes.includes(timeframe) ? timeframe : '7d';
    cacheKey = tf;
  }
  
  // Check global cache
  const cached = REPORT_CACHE.get(cacheKey);
  if (cached && !forceRefresh && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[ScientificReport] Returning cached stable edition for: ${cacheKey}`);
    return cached.data;
  }
  
  const { fromStr, toStr, days } = getDateThresholds(tf);
  
  console.log(`[ScientificReport] Generating stable report for: ${cacheKey} (from ${fromStr} to ${toStr})`);
  
  const isLongTerm = days >= 365;
  const shouldRandomize = isLongTerm && forceRefresh;
  
  // 1. Fetch Candidates from all sources in parallel
  const [arxivCandidates, openAlexCandidates, pubmedCandidates] = await Promise.all([
    fetchArxivCandidates(tf, shouldRandomize),
    fetchOpenAlexCandidates(fromStr, toStr, tf, shouldRandomize),
    fetchPubmedCandidates(tf, shouldRandomize)
  ]);
  
  // 2. Combine and Deduplicate
  const allCandidates = PaperBuilder.deduplicate([
    ...arxivCandidates,
    ...openAlexCandidates,
    ...pubmedCandidates
  ]);
  
  if (allCandidates.length === 0) {
    return { mainDiscovery: null, highlights: [] };
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
  
  // Extract Trending Concepts for all timeframes
  const conceptCounts = new Map();
  // Count concepts across top candidates
  allCandidates.slice(0, 80).forEach(p => {
    if (p.concepts && Array.isArray(p.concepts)) {
      p.concepts.forEach(c => {
        if (c && c.length > 3) {
          conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
        }
      });
    }
  });
  // Fallback to categories if no concepts
  if (conceptCounts.size < 3) {
    allCandidates.slice(0, 80).forEach(p => {
      const cat = (p.categories && p.categories[0]) || p.primaryCategory;
      if (cat) conceptCounts.set(cat, (conceptCounts.get(cat) || 0) + 1);
    });
  }
  // Sort and take top 5
  const trendingConcepts = Array.from(conceptCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => entry[0]);
  
  const reportData = { mainDiscovery, highlights, trendingConcepts };
  
  // Update cache
  REPORT_CACHE.set(cacheKey, { timestamp: Date.now(), data: reportData });
  
  return reportData;
}
