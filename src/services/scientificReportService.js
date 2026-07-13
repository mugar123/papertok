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
async function fetchOpenAlexCandidates(fromStr, toStr, timeframe) {
  // Concept mapping: Medicine (C14213010), CS (C41008148), Physics (C121332964), Bio (C86803240)
  const concepts = [
    'concepts.id:C14213010', // Medicine
    'concepts.id:C41008148|C121332964|C33923547', // CS / Physics / Math
    'concepts.id:C86803240|C43617362', // Bio / Chem
    '' // General (no concept filter)
  ];
  
  const sort = 'cited_by_count:desc';
  const promises = concepts.map(async (conceptFilter) => {
    let filter = `from_publication_date:${fromStr},to_publication_date:${toStr},type:article,has_doi:true`;
    if (conceptFilter) {
      filter += `,${conceptFilter}`;
    }
    const url = `https://api.openalex.org/works?filter=${filter}&sort=${sort}&per-page=60&mailto=app@papertok.io`;
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
async function fetchArxivCandidates(timeframe) {
  try {
    // Broad set of categories to query
    const categories = ['cs.AI', 'physics.quant-ph', 'q-bio.NC', 'stat.ML', 'math.PR', 'eess.SP'];
    // For 24h/7d/30d get recent papers. For 1y/10y we can get up to 100 papers
    const maxResults = (timeframe === '24h' || timeframe === '7d') ? 40 : 100;
    const papers = await fetchArxivPapers(categories, 0, maxResults, 'submittedDate');
    return papers || [];
  } catch (err) {
    console.warn("Failed to fetch arXiv candidates for report", err);
    return [];
  }
}

/**
 * Fetch candidates from PubMed
 */
async function fetchPubmedCandidates(timeframe) {
  try {
    const adapter = new PubmedAdapter();
    // Query medicine and health related terms
    const query = 'medicine[journal] OR biology[journal] OR science[journal] OR Nature[journal]';
    const response = await adapter.search(query, 1);
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
 *   1. Citation Impact (age-normalized)  — dominant signal
 *   2. Recency within the window         — tiebreaker / freshness
 *   3. Category Diversity penalty        — prevents monoculture
 *   4. Abstract quality                  — papers without abstracts are less useful
 */
function scorePaper(paper, timeframe, seenCategories, daysThreshold) {
  let score = 0;
  
  const now = new Date();
  const pubDate = new Date(paper.publishedDate || paper.published || now);
  const diffDays = Math.max(1, Math.ceil(Math.abs(now - pubDate) / (1000 * 60 * 60 * 24)));
  
  // ── 1. Citation Impact (dominant factor) ──
  // Age-normalize so a 1-month-old paper with 50 cites beats a 5-year-old paper with 200.
  const citations = paper.citationCount || 0;
  const yearsOld = Math.max(0.05, diffDays / 365); // min 0.05 to avoid division explosion
  const citationsPerYear = citations / yearsOld;
  
  if (typeof timeframe === 'string') {
    if (timeframe === '24h' || timeframe === '7d') {
      // Very recent papers rarely have citations. Any citation at all is a strong signal.
      // But raw count matters more than per-year here since the window is tiny.
      score += Math.min(30, citations * 4);
    } else if (timeframe === '30d') {
      // Mix of raw citations and velocity
      score += Math.min(30, Math.log10(citations + 1) * 8 + citations * 0.5);
    } else if (timeframe === '1y') {
      // Citation velocity becomes meaningful
      score += Math.min(35, Math.log10(citationsPerYear + 1) * 14);
    } else {
      // 10y — total accumulated impact, but age-normalized to avoid ancient papers dominating
      score += Math.min(40, Math.log10(citationsPerYear + 1) * 16);
    }
  } else {
    // Custom range — use a balanced approach
    const rangeDays = daysThreshold || 30;
    if (rangeDays <= 31) {
      score += Math.min(30, Math.log10(citations + 1) * 8 + citations * 0.5);
    } else {
      score += Math.min(35, Math.log10(citationsPerYear + 1) * 14);
    }
  }
  
  // ── 2. Recency Score ──
  // Within the requested window, prefer more recent papers as a tiebreaker.
  // Max 10 points, decaying proportionally to the window size.
  const windowDays = typeof timeframe === 'string'
    ? { '24h': 1, '7d': 7, '30d': 30, '1y': 365, '10y': 3650 }[timeframe] || 30
    : (daysThreshold || 30);
  
  const recencyRatio = Math.max(0, 1 - (diffDays / windowDays));
  score += recencyRatio * 10;
  
  // ── 3. Abstract Quality ──
  // Papers with a real abstract are more valuable to the user.
  const abstract = (paper.abstract || '').trim();
  if (abstract.length > 100 && !abstract.startsWith('Resumen no disponible') && !abstract.startsWith('No summary')) {
    score += 3;
  }
  
  // ── 4. Category Diversity Penalty ──
  // Dynamically penalize categories already represented in the selection.
  const cat = (paper.categories && paper.categories[0]) || paper.primaryCategory || '';
  const prefix = cat.split('.')[0].split('-')[0].toLowerCase();
  
  if (prefix) {
    const seenCount = seenCategories.get(prefix) || 0;
    if (seenCount > 0) {
      score -= seenCount * 6; // grows with each paper of the same type
    }
  }
  
  return score;
}

/**
 * Core orchestrator function to build, deduplicate, score, and rank candidates
 */
export async function getScientificReport(timeframe = '7d') {
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
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[ScientificReport] Returning cached stable edition for: ${cacheKey}`);
    return cached.data;
  }
  
  const { fromStr, toStr, days } = getDateThresholds(tf);
  
  console.log(`[ScientificReport] Generating stable report for: ${cacheKey} (from ${fromStr} to ${toStr})`);
  
  // 1. Fetch Candidates from all sources in parallel
  const [arxivCandidates, openAlexCandidates, pubmedCandidates] = await Promise.all([
    fetchArxivCandidates(tf),
    fetchOpenAlexCandidates(fromStr, toStr, tf),
    fetchPubmedCandidates(tf)
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
  
  // Select up to 11 papers (1 Main Discovery + 10 Highlights)
  const maxToSelect = Math.min(11, candidates.length);
  while (selected.length < maxToSelect && candidates.length > 0) {
    // Re-score remaining candidates based on current diversity state
    candidates.forEach(paper => {
      paper._tempScore = scorePaper(paper, tf, seenCategories, days);
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
  }
  
  const mainDiscovery = selected[0] || null;
  const highlights = selected.slice(1);
  
  const reportData = { mainDiscovery, highlights };
  
  // Update cache
  REPORT_CACHE.set(cacheKey, { timestamp: Date.now(), data: reportData });
  
  return reportData;
}
