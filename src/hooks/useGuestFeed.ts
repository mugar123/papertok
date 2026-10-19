import type { Paper } from '../models/Paper.ts';
import type { GuestFeedPlan } from '../utils/guestFeedPlan.ts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchPapers } from '../services/arxivService.ts';
import { OpenAlexAdapter } from '../services/adapters/OpenAlexAdapter.ts';
import { PubmedAdapter } from '../services/adapters/PubmedAdapter.ts';
import { PaperBuilder } from '../services/PaperBuilder.ts';
import { fetchDomainPapers } from '../services/domainSourceService.ts';
import { settleSourcesForFirstPaint, fulfilledPaperLists } from '../utils/asyncTiming.ts';
import { buildGuestFeedPlan } from '../utils/guestFeedPlan.ts';
import { composeGuestPage, extendGuestPage, guestPageReady } from '../utils/guestFeedComposition.ts';
import { enrichPapersBatch } from '../services/openAlexService.ts';
import { enrichPubmedIds, mergeEuropePmcEnrichment } from '../services/europePmcService.ts';
import { recoverFeedAbstracts } from '../services/feedAbstractService.ts';
import { awaitWithinGate, CITATION_GATE_MAX_WAIT_MS } from '../utils/feedCitationGate.ts';
import {
  applyKnownPublicationTypes,
  classifyFeedPublications,
  dropUnreachedPublications,
  isFeedPublication,
} from '../services/feedPublicationService.ts';
import {
  abstractsInFlight,
  getOpenAlexEnrichmentId,
  mergeFeedAbstracts,
  mergeOpenAlexEnrichment,
  preserveFeedAbstracts,
  needsOpenAlexEnrichment,
} from '../utils/feedEnrichment.ts';
import { abstractWaitIds, openAbstractWait, type AbstractWaits } from '../utils/feedAbstractWait.ts';

const GUEST_PAGE_SIZE = 12;
// Per-source cap. The slowest healthy source measured 2.4 s (OpenAlex, cold
// edge); the only thing ever seen above 4 s is OpenReview's cold upstream at
// 5.2 s, which no realistic budget saves. Waiting 5 s for it bought nothing.
const GUEST_SOURCE_BUDGET_MS = 4_000;

// A source the plan has nothing for is not asked at all, rather than asked for
// nothing: an empty arXiv list returns [] on its own, but a PubMed search for
// '' would be a real request for whatever PubMed makes of an empty string.
function startGuestCandidateRequests(plan: GuestFeedPlan, { refresh = false } = {}) {
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
  // Types this browser already knows exclude a paper before display; the
  // Crossref lookup for the shown batch runs after it is on screen.
  return requests.map(request => request.then(papers => applyKnownPublicationTypes(papers).filter(isFeedPublication)));
}

function dedupePapers<T extends Partial<Paper>>(papers: T[]) {
  const seen = new Set<string>();
  return papers.filter((paper) => {
    const key = String(paper?.doi || paper?.arxivId || paper?.id || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The guest feed, built for `areas` — the interests a visitor picked, or the
 * fixed sample when they picked none. The plan is derived here so the caller
 * only holds the answer; a re-render with the same areas is the same plan and
 * loads nothing (`plan.key`).
 */
/**
 * Removes one paper from a shown list. Returns the SAME array when there is
 * nothing to remove, so a miss costs no re-render.
 */
export function dropPaperById<T extends Partial<Paper>>(papers: T[], paperId: string) {
  if (!Array.isArray(papers)) return [];
  if (!paperId) return papers;
  const next = papers.filter((paper) => paper?.id !== paperId);
  return next.length === papers.length ? papers : next;
}

/**
 * Whether the feed loads now, and how. Nothing loads while the feed is not
 * enabled — the guest page keeps it off while the welcome is up, where it used
 * to load six fields the visitor never chose (audit 2026-09-23, issue 11a):
 * the feed is built from the welcome's answer. The first load is a first load
 * even when it follows a change of plan, because nothing was on screen to
 * refresh; a later change of plan is a rebuild of what was shown. The same
 * plan twice loads nothing.
 */
export function guestFeedLoadDecision({ enabled, previousKey, planKey }: { enabled: boolean; previousKey: string | null; planKey: string }) {
  if (!enabled || previousKey === planKey) return null;
  return { refresh: previousKey !== null };
}

export function useGuestFeed({ areas = [], topics = [], enabled = true }: { areas?: readonly string[]; topics?: readonly string[]; enabled?: boolean } = {}) {
  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestIdRef = useRef(0);
  const visiblePaperIdRef = useRef<string | null>(null);
  const [abstractWaits, setAbstractWaits] = useState<AbstractWaits>([]);
  const loadingAbstractIds = useMemo(() => abstractWaitIds(abstractWaits), [abstractWaits]);
  const plan = useMemo(() => buildGuestFeedPlan(areas, topics), [areas, topics]);
  const planKey = plan.key;
  // `refresh` is the reader's pull-to-refresh: the shown papers stay until
  // the new ones land, and arXiv is asked past its cache. `forceRefresh` is
  // what that second part is called at the source.
  const load = useCallback(async (requestedPlan: GuestFeedPlan, { refresh = false, forceRefresh = refresh }: { refresh?: boolean; forceRefresh?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (refresh) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      // The first paint waits until every chosen area has answered (or the
      // per-source budget runs out), so the first page already shows the
      // choice instead of whichever branch a cache made fastest.
      const { first, all } = settleSourcesForFirstPaint(
        startGuestCandidateRequests(requestedPlan, { refresh: forceRefresh }),
        GUEST_SOURCE_BUDGET_MS,
        (papers) => guestPageReady(PaperBuilder.deduplicate(papers), requestedPlan, GUEST_PAGE_SIZE),
      );

      // The first batch may wait briefly for an abstract on its way; later
      // additions are shown at once. `follow` runs once the batch is on
      // screen: later responses update it, and fill only the cards that say
      // their abstract is loading.
      const preparePage = async (batch: Paper[], { firstPaint }: { firstPaint: boolean }) => {
        const ids = batch.filter(needsOpenAlexEnrichment).map(getOpenAlexEnrichmentId).filter(Boolean);
        const pmids = [...new Set(batch.map(paper => paper.pmid).filter(Boolean))] as string[];
        const openAlex = enrichPapersBatch(ids, { timeoutMs: 6_500 }).catch(() => ({}));
        const europePmc = enrichPubmedIds(pmids).catch(() => new Map<string, Partial<Paper> & { pmid: string }>());
        const recovery = recoverFeedAbstracts(batch);
        const publications = classifyFeedPublications(batch);
        const waitMs = firstPaint && abstractsInFlight(batch, { openAlex: true, europePmc: true, recovery: true }).size > 0
          ? CITATION_GATE_MAX_WAIT_MS : 0;
        const [gatedOpenAlex, gatedEuropePmc, recovered] = await awaitWithinGate([openAlex, europePmc, recovery], { maxWaitMs: waitMs });
        let papers = recovered ? mergeFeedAbstracts(batch, recovered) : batch;
        if (gatedOpenAlex) papers = mergeOpenAlexEnrichment(papers, gatedOpenAlex);
        if (gatedEuropePmc) papers = mergeEuropePmcEnrichment(papers, gatedEuropePmc);
        const abstractsComing = abstractsInFlight(papers, { openAlex: !gatedOpenAlex, europePmc: !gatedEuropePmc, recovery: !recovered });
        const follow = () => {
          const loadingAbstracts = openAbstractWait(setAbstractWaits, abstractsComing, [openAlex, europePmc, recovery]);
          const update = (change: (current: Paper[]) => Paper[]) => {
            if (requestId === requestIdRef.current) setPapers(change);
          };
          void openAlex.then(records => {
            const loading = loadingAbstracts();
            update(current => preserveFeedAbstracts(current, mergeOpenAlexEnrichment(current, records), loading));
          });
          void europePmc.then(records => {
            const loading = loadingAbstracts();
            update(current => preserveFeedAbstracts(current, mergeEuropePmcEnrichment(current, records), loading));
          });
          if (!recovered) void recovery.then(records => {
            const loading = loadingAbstracts();
            update(current => preserveFeedAbstracts(current, mergeFeedAbstracts(current, records), loading));
          });
          void publications.then(classified => {
            update(current => dropUnreachedPublications(current, classified, visiblePaperIdRef.current));
          });
        };
        return { papers, follow };
      };

      const early = await preparePage(composeGuestPage(
        dedupePapers(PaperBuilder.deduplicate(fulfilledPaperLists(await first))),
        requestedPlan,
        GUEST_PAGE_SIZE,
      ), { firstPaint: true });
      if (requestId !== requestIdRef.current) return;

      if (early.papers.length > 0) {
        // A replaced list is read from its first card: a refresh jumps there.
        // An old card's id would leave a late Crossref answer removing no book.
        visiblePaperIdRef.current = null;
        setPapers(early.papers);
        early.follow();
        setLoading(false);
        setIsRefreshing(false);
      }

      const late = dedupePapers(
        PaperBuilder.deduplicate(fulfilledPaperLists(await all)),
      );
      if (requestId !== requestIdRef.current) return;
      if (early.papers.length === 0 && late.length === 0) {
        throw new Error('Guest discovery returned no papers.');
      }
      const earlyIds = new Set(early.papers.map(paper => paper.id));
      const additions = extendGuestPage(early.papers, late, requestedPlan, GUEST_PAGE_SIZE)
        .filter(paper => !earlyIds.has(paper.id));
      const ready = await preparePage(additions, { firstPaint: early.papers.length === 0 });
      if (requestId !== requestIdRef.current) return;
      setPapers(current => extendGuestPage(current, ready.papers, requestedPlan, GUEST_PAGE_SIZE));
      ready.follow();

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
  // and in that frame the page would report "ready" with the old cards, and
  // anything keyed on that (the analytics consent banner was, while it
  // existed) would mount for it, only to leave again. Storing the key the
  // papers belong to and comparing it here is React's own pattern for state
  // that depends on the previous render.
  const [shownKey, setShownKey] = useState(planKey);
  if (shownKey !== planKey) {
    setShownKey(planKey);
    setPapers([]);
    setIsRefreshing(true);
  }
  // Keyed by the plan, not by the array it came from: a caller re-rendering
  // with an equal list is the same plan, and must not start a load that
  // would show up as a skeleton under the cards already on screen.
  const loadedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const previousKey = loadedKeyRef.current;
    const decision = guestFeedLoadDecision({ enabled, previousKey, planKey: plan.key });
    if (!decision) return undefined;
    let active = true;
    let started = false;
    loadedKeyRef.current = plan.key;
    queueMicrotask(() => {
      if (!active) return;
      started = true;
      load(plan, decision.refresh ? { refresh: true, forceRefresh: false } : {});
    });
    return () => {
      active = false;
      // A load cancelled before it began (StrictMode's mount, unmount, mount)
      // has not loaded anything: the key goes back, so the effect's second
      // run is not turned away as "already loaded" and the feed then never
      // asks a single source.
      if (!started) loadedKeyRef.current = previousKey;
    };
  }, [enabled, load, plan]);

  // Skip, for a reader with no account. The guest feed's papers only ever live
  // in this state, so dropping one is the whole action: nothing to write, no
  // profile to train, and nothing that outlives the page. A visitor pressing
  // Skip used to get a sign-in prompt instead, which read as a dead button.
  const dismissPaper = useCallback((paperId: string) => {
    setPapers((current) => {
      // The next card slides into the skipped one's place without a scroll
      // event, so it is reported here. A late Crossref answer reads the ref.
      const index = current.findIndex(paper => paper.id === paperId);
      if (index >= 0 && visiblePaperIdRef.current === paperId) {
        visiblePaperIdRef.current = current[index + 1]?.id ?? current[index - 1]?.id ?? null;
      }
      return dropPaperById(current, paperId);
    });
  }, []);

  // FeedContainer reports the card on screen, so a confirmed book is removed
  // only from the part of the page the reader has not reached.
  const reportVisiblePaper = useCallback((paperId: string | null) => {
    visiblePaperIdRef.current = paperId;
  }, []);

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
    dismissPaper,
    reportVisiblePaper,
    loadingAbstractIds,
  };
}
