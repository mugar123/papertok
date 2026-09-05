import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPapers } from '../services/arxivService.js';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.js';
import { PubmedAdapter } from '../services/adapters/PubmedAdapter.js';
import { PaperBuilder } from '../services/PaperBuilder.js';
import { fetchDomainPapers } from '../services/domainSourceService.js';
import { settleSourcesForFirstPaint, fulfilledPaperLists } from '../utils/asyncTiming.js';
import { buildGuestFeedPlan } from '../utils/guestFeedPlan.js';
import { enrichPapersBatch } from '../services/openAlexService.js';
import { enrichPubmedIds, mergeEuropePmcEnrichment } from '../services/europePmcService.js';
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

// A source the plan has nothing for is not asked at all, rather than asked for
// nothing: an empty arXiv list returns [] on its own, but a PubMed search for
// '' would be a real request for whatever PubMed makes of an empty string.
function startGuestCandidateRequests(plan, { refresh = false } = {}) {
  const openAlex = new OpenAlexAdapter();
  const requests = [
    plan.arxivCategories.length > 0
      ? fetchPapers(
        plan.arxivCategories,
        0,
        GUEST_PAGE_SIZE,
        'recent',
        'submittedDate',
        { forceRefresh: refresh },
      )
      : Promise.resolve([]),
    openAlex.search(plan.discoveryQuery, 1, { internalCategories: plan.categories })
      .then(result => result.papers),
    fetchDomainPapers(plan.categories, 1, GUEST_PAGE_SIZE, 'recent'),
  ];
  if (plan.pubmedQuery) {
    const pubmed = new PubmedAdapter();
    requests.push(pubmed.search(plan.pubmedQuery, 1, {
      internalCategories: plan.pubmedCategories,
    }).then(result => result.papers));
  }
  return requests;
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

/**
 * The guest feed, built for `areas` — the interests a visitor picked, or the
 * fixed sample when they picked none. The plan is derived here so the caller
 * only holds the answer; a re-render with the same areas is the same plan and
 * loads nothing (`plan.key`).
 */
export function useGuestFeed({ areas = [] } = {}) {
  const [papers, setPapers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const plan = useMemo(() => buildGuestFeedPlan(areas), [areas]);
  const planKey = plan.key;

  // `refresh` is the reader's pull-to-refresh: the shown papers stay until
  // the new ones land, and arXiv is asked past its cache. `forceRefresh` is
  // what that second part is called at the source.
  const load = useCallback(async (requestedPlan, { refresh = false, forceRefresh = refresh } = {}) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const { first, all } = settleSourcesForFirstPaint(
        startGuestCandidateRequests(requestedPlan, { refresh: forceRefresh }),
        GUEST_SOURCE_BUDGET_MS,
        (papers) => PaperBuilder.deduplicate(papers).length >= GUEST_EARLY_PAINT_COUNT,
      );

      // Europe PMC has no in-flight map, and the early and late batches
      // overlap: each pmid is asked for once per load.
      const askedPmids = new Set();
      const enrichVisible = (batch) => {
        const ids = batch.map(getOpenAlexEnrichmentId).filter(Boolean);
        if (ids.length > 0) {
          enrichPapersBatch(ids, { timeoutMs: 6_500 }).catch(() => ({})).then((lateEnrichment) => {
            if (requestId !== requestIdRef.current || !lateEnrichment || !Object.keys(lateEnrichment).length) return;
            setPapers((current) => mergeOpenAlexEnrichment(current, lateEnrichment));
          });
        }
        // The guest feed shows PubMed cards too, and they carry the same debt
        // ade641a left behind: no open access, no PMC PDF, no citations until
        // Europe PMC answers. Asked for after the batch is on screen.
        const pmids = [...new Set(batch.map(paper => paper?.pmid).filter(pmid => pmid && !askedPmids.has(pmid)))];
        if (pmids.length > 0) {
          pmids.forEach(pmid => askedPmids.add(pmid));
          enrichPubmedIds(pmids).catch(() => new Map()).then((lateRecords) => {
            if (requestId !== requestIdRef.current || !lateRecords || lateRecords.size === 0) return;
            setPapers((current) => mergeEuropePmcEnrichment(current, lateRecords));
          });
        }
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

  // The first load, and one more each time the plan changes. A changed plan
  // is a rebuilt feed, not a refresh: the papers on screen were chosen for
  // interests the guest just replaced, so they go, and the atom veil covers
  // the wait ("gathering" — FeedContainer reads an emptied feed that is
  // refreshing as exactly that). Left in place, the old cards would have sat
  // there for the two seconds the sources take and then swapped under the
  // reader's thumb.
  // The reset happens in render, not in the effect: between the plan
  // changing and an effect emptying the state there is one committed frame,
  // and in that frame the page would report "ready" with the old cards and
  // the consent banner would mount for it, only to leave again. Storing the
  // key the papers belong to and comparing it here is React's own pattern
  // for state that depends on the previous render.
  const [shownKey, setShownKey] = useState(planKey);
  if (shownKey !== planKey) {
    setShownKey(planKey);
    setPapers([]);
    setIsRefreshing(true);
  }
  // Keyed by the plan, not by the array it came from: a caller re-rendering
  // with an equal list is the same plan, and must not start a load that
  // would show up as a skeleton under the cards already on screen.
  const loadedKeyRef = useRef(null);
  useEffect(() => {
    const previousKey = loadedKeyRef.current;
    if (previousKey === plan.key) return undefined;
    let active = true;
    let started = false;
    loadedKeyRef.current = plan.key;
    queueMicrotask(() => {
      if (!active) return;
      started = true;
      load(plan, previousKey !== null ? { refresh: true, forceRefresh: false } : {});
    });
    return () => {
      active = false;
      // A load cancelled before it began (StrictMode's mount, unmount, mount)
      // has not loaded anything: the key goes back, so the effect's second
      // run is not turned away as "already loaded" and the feed then never
      // asks a single source.
      if (!started) loadedKeyRef.current = previousKey;
    };
  }, [load, plan]);

  // Anything still in flight when the page unmounts is dropped, not applied.
  useEffect(() => () => {
    requestIdRef.current += 1;
  }, []);

  return {
    papers,
    loading,
    error,
    hasMore: false,
    isRefreshing,
    areas: plan.areas,
    refresh: () => load(plan, { refresh: true }),
  };
}
