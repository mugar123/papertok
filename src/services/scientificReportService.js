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
    days: Math.ceil((today - fromDate) / (1000 * 60 * 60 * 24))
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
 * Score a candidate paper using our editorial relevance metrics
 */
function scorePaper(paper, timeframe, seenCategories, daysThreshold) {
  let score = 10; // Base score
  
  const now = new Date();
  const pubDate = new Date(paper.publishedDate || paper.published || now);
  const diffTime = Math.abs(now - pubDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  // 1. Recency Score (favoring papers closer to the target timeframe boundary)
  if (timeframe === '24h') {
    score += Math.max(0, 10 - diffDays * 5); // heavily prefer < 1 day
  } else if (timeframe === '7d') {
    score += Math.max(0, 10 - diffDays * 1.5);
  } else if (timeframe === '30d') {
    score += Math.max(0, 10 - diffDays * 0.3);
  } else if (timeframe === '1y') {
    score += Math.max(0, 10 - (diffDays / 30) * 0.8);
  } else if (timeframe === '10y') {
    score += Math.max(0, 10 - (diffDays / 365) * 1.0);
  }
  
  // 2. Citation Score (Age-Normalized)
  const citations = paper.citationCount || 0;
  const yearsOld = Math.max(0.1, diffDays / 365);
  const citationsPerYear = citations / yearsOld;
  
  if (timeframe === '10y') {
    // In a 10 year span, total impact is crucial, but age normalization prevents 10-year-old works from winning automatically
    score += Math.min(25, Math.log10(citationsPerYear + 1) * 10);
  } else if (timeframe === '1y') {
    score += Math.min(18, Math.log10(citationsPerYear + 1) * 8);
  } else if (timeframe === '30d') {
    score += Math.min(12, Math.log10(citations + 1) * 5);
  } else {
    // 24h & 7d: citations are extremely rare, so any citation is a powerful boost
    score += Math.min(10, citations * 3);
  }
  
  // 3. Open Access Bonus (aesthetics & immediate usability)
  if (paper.openAccess) {
    score += 4;
  }
  
  // 4. Quality of Publication (Peer Reviewed / Journal publication)
  if (paper.publicationType === 'article' || paper.publicationStatus === 'published' || paper.journal) {
    score += 3;
  }
  
  // 5. Diversity Penalty (Dynamic based on categories already seen in current ranking process)
  const cat = (paper.categories && paper.categories[0]) || paper.primaryCategory || '';
  const prefix = cat.split('.')[0].split('-')[0].toLowerCase();
  
  if (prefix) {
    const seenCount = seenCategories.get(prefix) || 0;
    if (seenCount > 0) {
      score -= seenCount * 5; // dynamic penalty grows with each selected paper of this type
    }
  }
  
  return score;
}

/**
 * Core orchestrator function to build, deduplicate, score, and rank candidates
 */
export async function getScientificReport(timeframe = '7d') {
  // Validate timeframe
  const validTimeframes = ['24h', '7d', '30d', '1y', '10y'];
  const tf = validTimeframes.includes(timeframe) ? timeframe : '7d';
  
  // Check global cache
  const cached = REPORT_CACHE.get(tf);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    console.log(`[ScientificReport] Returning cached stable edition for: ${tf}`);
    return cached.data;
  }
  
  const { fromStr, toStr, days } = getDateThresholds(tf);
  
  console.log(`[ScientificReport] Generating stable report for: ${tf} (from ${fromStr} to ${toStr})`);
  
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
  
  // Save to cache
  REPORT_CACHE.set(tf, { data: reportData, timestamp: Date.now() });
  
  return reportData;
}
