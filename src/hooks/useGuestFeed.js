import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchPapers } from '../services/arxivService.js';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.js';
import { PubmedAdapter } from '../services/adapters/PubmedAdapter.js';
import { PaperBuilder } from '../services/PaperBuilder.js';
import { fetchDomainPapers } from '../services/domainSourceService.js';
import { settleSourcesForFirstPaint, fulfilledPaperLists } from '../utils/asyncTiming.js';
import { GUEST_CATEGORIES, buildGuestDiscoveryQuery } from '../utils/guestFeedPlan.js';
import { enrichPapersBatch } from '../services/openAlexService.js';
import {
  getOpenAlexEnrichmentId,
  mergeOpenAlexEnrichment,
} from '../utils/feedEnrichment.js';

const GUEST_PAGE_SIZE = 12;
const GUEST_EARLY_PAINT_COUNT = 4;
// Per-source cap. The slowest healthy source measured 2.4 s (OpenAlex, cold
// edge); the only thing ever seen above 4 s is OpenReview's cold upstream at
// 5.2 s, which no realistic budget saves. Waiting 5 s for it bought nothing.
const GUEST_SOURCE_BUDGET_MS = 4_000;

function startGuestCandidateRequests({ refresh = false } = {}) {
  const query = buildGuestDiscoveryQuery();
  const openAlex = new OpenAlexAdapter();
  const pubmed = new PubmedAdapter();
  return [
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

function mergeKeepingShownOrder(shown, incoming, pageSize) {
  const seen = new Set(shown.map((paper) => String(paper?.doi || paper?.arxivId || paper?.id || '').toLowerCase()).filter(Boolean));
  const extra = incoming.filter((paper) => {
    const key = String(paper?.doi || paper?.arxivId || paper?.id || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...shown, ...extra].slice(0, pageSize);
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
      const { first, all } = settleSourcesForFirstPaint(
        startGuestCandidateRequests({ refresh }),
        GUEST_SOURCE_BUDGET_MS,
        (papers) => PaperBuilder.deduplicate(papers).length >= GUEST_EARLY_PAINT_COUNT,
      );

      const enrichVisible = (batch) => {
        const ids = batch.map(getOpenAlexEnrichmentId).filter(Boolean);
        if (ids.length === 0) return;
        enrichPapersBatch(ids, { timeoutMs: 6_500 }).catch(() => ({})).then((lateEnrichment) => {
          if (requestId !== requestIdRef.current || !lateEnrichment || !Object.keys(lateEnrichment).length) return;
          setPapers((current) => mergeOpenAlexEnrichment(current, lateEnrichment));
        });
      };

      const early = dedupePapers(
        PaperBuilder.deduplicate(fulfilledPaperLists(await first)),
      ).slice(0, GUEST_PAGE_SIZE);
      if (requestId !== requestIdRef.current) return;

      if (early.length > 0) {
        setPapers(early);
        setLoading(false);
        setIsRefreshing(false);
        enrichVisible(early);
      }

      const late = dedupePapers(
        PaperBuilder.deduplicate(fulfilledPaperLists(await all)),
      );
      if (requestId !== requestIdRef.current) return;
      if (early.length === 0 && late.length === 0) {
        throw new Error('Guest discovery returned no papers.');
      }
      if (early.length === 0) {
        setPapers(late.slice(0, GUEST_PAGE_SIZE));
        enrichVisible(late);
      } else {
        setPapers((current) => mergeKeepingShownOrder(current, late, GUEST_PAGE_SIZE));
        enrichVisible(late);
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
