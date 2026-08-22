import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPapers } from '../services/arxivService.js';
import { CATEGORIES } from '../data/categories.js';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.js';
import { PubmedAdapter } from '../services/adapters/PubmedAdapter.js';
import { PaperBuilder } from '../services/PaperBuilder.js';
import { fetchDomainPapers } from '../services/domainSourceService.js';
import { settleWithin } from '../utils/asyncTiming.js';
import { enrichPapersBatch } from '../services/openAlexService.js';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
  waitForInitialEnrichment,
} from '../utils/feedEnrichment.js';

const GUEST_CATEGORIES = Object.freeze([
  'astro-ph.CO',
  'quant-ph',
  'cs.AI',
  'q-bio.NC',
  'math.PR',
  'econ.GN',
]);
const GUEST_PAGE_SIZE = 12;
// How long the first paint may wait for OpenAlex metadata. Enrichment lands in
// 0.2–0.9 s when the Worker edge is warm (measured 2026-08-22), so this budget
// covers the common case; anything slower merges into the visible cards via
// the late-enrichment path below instead of holding the skeleton hostage —
// the old 4.5 s budget was most of the measured 9.5 s worst case.
const INITIAL_ENRICHMENT_BUDGET_MS = 900;
// Per-source cap. The slowest healthy source measured 2.4 s (OpenAlex, cold
// edge); the only thing ever seen above 4 s is OpenReview's cold upstream at
// 5.2 s, which no realistic budget saves. Waiting 5 s for it bought nothing.
const GUEST_SOURCE_BUDGET_MS = 4_000;

function categoryLabel(categoryId) {
  for (const area of Object.values(CATEGORIES)) {
    const category = area.subcategories?.[categoryId];
    if (category) return category.labelEn || category.label || categoryId;
  }
  return categoryId;
}

async function fetchGuestCandidates({ refresh = false } = {}) {
  const query = GUEST_CATEGORIES.map(category => `"${categoryLabel(category)}"`).join(' OR ');
  const openAlex = new OpenAlexAdapter();
  const pubmed = new PubmedAdapter();
  const requests = [
    fetchPapers(
      GUEST_CATEGORIES,
      0,
      GUEST_PAGE_SIZE,
      'recent',
      'submittedDate',
      { forceRefresh: refresh },
    ),
    openAlex.search(query, 1, { internalCategories: GUEST_CATEGORIES })
      .then(result => result.papers),
    pubmed.search('neuroscience OR bioinformatics', 1, {
      internalCategories: ['bio.neuro', 'bio.comp'],
    }).then(result => result.papers),
    fetchDomainPapers(GUEST_CATEGORIES, 1, GUEST_PAGE_SIZE, 'recent'),
  ];
  const settled = await Promise.all(requests.map(request => settleWithin(request, GUEST_SOURCE_BUDGET_MS)));
  return PaperBuilder.deduplicate(
    settled.flatMap(result => result.status === 'fulfilled' ? result.value : []),
  ).slice(0, GUEST_PAGE_SIZE);
}

function dedupePapers(papers) {
  const seen = new Set();
  return papers.filter((paper) => {
    const key = String(paper?.doi || paper?.arxivId || paper?.id || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function useGuestFeed() {
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestIdRef = useRef(0);

  const load = useCallback(async ({ refresh = false } = {}) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const discovered = dedupePapers(await fetchGuestCandidates({ refresh }));
      if (requestId !== requestIdRef.current) return;
      if (discovered.length === 0) throw new Error('Guest discovery returned no papers.');

      const ids = discovered.map(getOpenAlexEnrichmentId).filter(Boolean);
      const enrichmentRequest = enrichPapersBatch(ids, { timeoutMs: 6_500 }).catch(() => ({}));
      const initialEnrichment = await waitForInitialEnrichment(
        enrichmentRequest,
        INITIAL_ENRICHMENT_BUDGET_MS,
      );
      if (requestId !== requestIdRef.current) return;
      setPapers(initialEnrichment
        ? mergeOpenAlexEnrichment(discovered, initialEnrichment)
        : discovered);

      if (!initialEnrichment) {
        enrichmentRequest.then((lateEnrichment) => {
          if (requestId !== requestIdRef.current || !Object.keys(lateEnrichment).length) return;
          setPapers(current => mergeOpenAlexEnrichment(current, lateEnrichment));
        });
      }
    } catch (loadError) {
      if (requestId === requestIdRef.current) {
        console.error('Guest feed could not be loaded', loadError);
        setError('FEED_LOAD_FAILED');
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) load();
    });
    return () => {
      active = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  return {
    papers,
    loading,
    error,
    hasMore: false,
    isRefreshing,
    refresh: () => load({ refresh: true }),
  };
}
