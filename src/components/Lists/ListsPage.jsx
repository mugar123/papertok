import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { IS_DEMO, db } from '../../services/firebase';
import {
  collection,
  getDocs,
  getDocsFromCache,
  query,
  where,
  documentId,
  doc,
  deleteDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  arrayRemove,
  limit,
} from 'firebase/firestore';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAuth } from '../../context/AuthContext';
import { useFeed } from '../../context/FeedContext';
import { useLanguage } from '../../context/LanguageContext';
import { getCategoryLabel } from '../../data/categories';
import { getIcon } from '../../utils/icons';
import CreateListDialog from './CreateListDialog.jsx';
import { Button } from '../ui/button.jsx';
import { resolveListColor } from '../../utils/listColors.js';
import { areaAccentForPaper } from '../../utils/areaAccent.js';
import ScientificText from '../ScientificText.js';
import { paperLegacyAdapter } from '../../models/Paper';
import { AlertTriangle, Check, Download, Globe2, Library, Lock, Pencil, Plus, Share2, Unlink, X } from 'lucide-react';
import { shareOrCopyLink } from '../../utils/shareLink.js';
import { downloadCitationFile } from '../../utils/readingLibrary';
import { settleWithin } from '../../utils/asyncTiming';
import { decodeFirestoreDocId, encodeFirestoreDocId } from '../../utils/firestoreDocId.js';
import { hydrateLegacyArxivPapers } from '../../services/likedPaperRecords.js';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import {
  PUBLIC_LIST_LIMITS,
  publishPublicList,
  readPublicList,
  unpublishPublicList,
} from '../../services/publicListService.js';
import {
  cancelPublicListSync,
  queuePublicListSync,
  retryPublicListSync,
  subscribeToPublicListSync,
} from '../../services/publicListSync.js';
import {
  listNeedsPublicSync,
  publicListSyncKey,
  toEpochMillis,
} from '../../utils/publicListFreshness.js';
import { getPublicListUrl } from '../../utils/publicNavigation.js';
import { searchPaperDestination } from '../../utils/searchDestinations.js';
import { OWN_LISTS_PAGE_SIZE } from '../../services/userProfileService.js';
import { isReadTimeout, patientRead } from '../../utils/boundedRead.js';
import {
  ownListsCache,
  readListPapers,
  rememberListPapers,
  rememberOwnLists,
} from '../../utils/profileSessionCaches.js';
import { snapshotIsAuthoritative } from '../../utils/ownLists.js';
import { readStoredLists, saveStoredLists } from '../../utils/userScopedStorage.js';
import { queryIsAuthoritative } from '../../utils/cacheAuthority.js';
import {
  PAPER_METADATA_BATCH_SIZE,
  planMetadataRequests,
  planRetryRequests,
} from '../../utils/listPaperMetadataPlan.js';
import './ListsPage.css';

/**
 * How long a read may take before it is allowed to draw a placeholder.
 *
 * Under roughly a third of a second a wait reads as instantaneous, so a
 * placeholder that appears immediately is not a loading state — it is a flash
 * on every healthy visit, which is worse than the wait it describes.
 */
const LIST_PLACEHOLDER_DELAY_MS = 320;
const PAPER_METADATA_LOAD_DEADLINE_MS = 4_000;
/**
 * The ceiling on the whole open, as opposed to on one request.
 *
 * Every other deadline here bounds a single read, and a read that passes its
 * deadline deliberately keeps running so it can still paint the row when it
 * lands. That is right, and it left the fan-out as a whole bounded by nothing:
 * a request that never settles is a row that shimmers forever.
 *
 * Twenty seconds, because it must not fire on anything that is merely slow.
 * A healthy open measures under a third of a second, and Firestore reports a
 * stalled channel as `unavailable` at about ten — so this only ever bites when
 * something has gone wrong in a way the SDK itself has not noticed.
 *
 * What happens at expiry is the part that matters: the rows stop waiting AND
 * the banner appears. Stopping the wait without the banner is the bug this
 * screen just had — a row falling back to its raw id as though the answer were
 * "this paper has no metadata". The banner is what keeps it "we could not find
 * out", which is the one thing the rows alone cannot say.
 */
const PAPER_METADATA_TOTAL_BUDGET_MS = 20_000;
const PRIVATE_LIST_IDS = new Set(['__favorites__', '__read__', '__read_later__']);

function demoGet(key, fallback) {
  try { const v = localStorage.getItem(`papertok_${key}`); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}

function demoSet(key, value) {
  try { localStorage.setItem(`papertok_${key}`, JSON.stringify(value)); }
  catch (err) { console.error('Error in demoSet', err); }
}

async function copyText(value) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(value);
    return;
  }
  if (typeof document === 'undefined') throw new Error('Clipboard access is unavailable.');
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}


/**
 * The Public badge doubles as the sync indicator, and that is the whole
 * replacement for the Update button.
 *
 * The button answered one question — is the public link current? — by making
 * the owner press it and find out. The badge answers the same question without
 * ever asking for a click: it says what the background sync is doing, and goes
 * quiet again when there is nothing to say.
 */
function publicBadgeState(status) {
  if (status === 'pending' || status === 'syncing') return 'syncing';
  if (status === 'synced') return 'synced';
  if (status === 'error') return 'stale';
  return 'public';
}


export default function ListsPage({ onEditPaper }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { trackEvent } = useAnalyticsConsent();
  const { language, isEnglish } = useLanguage();
  const {
    unmarkAsRead,
    toggleLike,
    personalLibrary,
    ensurePersonalLibrary,
    libraryPapers,
    toggleReadLater,
    likedPaperIds,
    readPaperIds,
  } = useFeed();

  // Notes, tags and read timestamps no longer ride along on every feed load;
  // this screen is the one that renders them, so it is the one that fetches
  // them.
  useEffect(() => {
    void ensurePersonalLibrary?.();
  }, [ensurePersonalLibrary]);
  /**
   * Seeded from the session cache, not from nothing.
   *
   * This screen wrote `rememberOwnLists` on every visit and never read it back,
   * which made it the one screen the cache was built for that did not use it.
   * The cost was visible: Favorites, Read later and Reading history are
   * synthesised from contexts already in memory, so three cards painted in the
   * first frame and the owner's own lists appeared seconds later when the read
   * resolved — the grid growing under someone already reading it.
   *
   * The save modal next door has seeded from this cache since it was written
   * (`useState(() => seededLists ?? [])`). Same cache, same key, same rule here.
   */
  /**
   * Two seeds, in order of freshness: the session cache first, then what this
   * device stored last time. The cache covers re-entry within a tab; storage
   * covers the first visit after a reload, which is the one where the seam
   * showed — three synthesised cards painting instantly and the owner's own
   * lists dropping in behind them.
   */
  const seededLists = user?.uid
    ? (ownListsCache.get(user.uid) ?? readStoredLists(user.uid))
    : null;
  const [lists, setLists] = useState(() => seededLists ?? []);
  // Seeded, for the same reason the lists are. Leaving a list to read a paper
  // and coming back used to re-fetch every document the tab had in its hands
  // seconds earlier — Firestore's own cache cannot cover it, because this app
  // deliberately runs the in-memory one with no persistence (firebase.js).
  const [savedPapers, setSavedPapers] = useState(
    () => (user?.uid ? readListPapers(user.uid) : null) ?? {},
  );
  const [expandedList, setExpandedList] = useState(null);
  // True while the expanded list is the one a profile card navigated to: its
  // back control then returns to the profile instead of collapsing to the
  // index the visitor never asked for.
  const [openedFromRoute, setOpenedFromRoute] = useState(false);
  const [loading, setLoading] = useState(false);
  // Placeholder tiles for the cold case, and only for it. Seeding from the
  // session cache covers a revisit and the IndexedDB read covers this device,
  // so what is left is a first visit — where three system cards alone look like
  // a finished grid right up until the owner's own lists shove them aside.
  const [placeholdersDue, setPlaceholdersDue] = useState(false);
  /**
   * The papers whose metadata is still on its way, by id.
   *
   * A single "is this list loading" flag could not express what actually
   * happens here. `openList` gives each request four seconds and then returns —
   * but a request that merely ran out of time is still running, and the handler
   * that merges it when it lands is deliberate (counting those as failures is
   * what used to put "some metadata could not be loaded" on screen for data
   * that arrived a second later). The flag was cleared at the deadline, so from
   * that moment every paper still in flight rendered the "nothing is coming"
   * placeholder: its raw arXiv id. On Favorites — the biggest list, ten
   * concurrent queries — that was the whole list.
   *
   * A row now waits while its own id is in this set, so the late window the
   * loader already supports is visible rather than contradicted.
   */
  const [pendingPaperIds, setPendingPaperIds] = useState(() => new Set());
  const [metadataError, setMetadataError] = useState(null);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [shareFeedback, setShareFeedback] = useState(null);
  // What the sync engine is doing, keyed by list. It is not this page's state
  // to own: the save-and-organize modal queues syncs too, and they have to
  // outlive whichever screen started them, so the page subscribes instead.
  const [syncStates, setSyncStates] = useState({});
  // What visitors actually see, per list. One read of the public document when
  // a published list is opened, and it earns its place twice: it is the only
  // honest source for "N papers are not in the public link yet", and it is
  // what lets a list damaged by an earlier sync repair itself on open — the
  // dirty stamp cannot, because a bad sync marks itself as done.
  const [publicSnapshots, setPublicSnapshots] = useState({});
  // The index needs its own door to a new list: the only other one in the app is
  // inside the save modal, and it opens the very same window (CreateListDialog).
  const [creating, setCreating] = useState(false);
  // The list the edit window is open on, or null. Holding the list rather than
  // its id keeps the window's preset off a lookup that can miss mid-refresh.
  const [editing, setEditing] = useState(null);
  // Whether this session has had one authoritative answer about which lists
  // exist. Until it has, `lists` is a seed or a guess, and persisting it could
  // overwrite what this device knew with an emptiness nobody confirmed.
  const listsHeardFromServer = useRef(false);
  const metadataRequestId = useRef(0);
  // The ceiling on the whole metadata fan-out; a new open cancels the last one's.
  const metadataBudgetTimer = useRef(null);
  const failedMetadataRequests = useRef(new Map());
  const prefersReducedMotion = useReducedMotion();

  const displayLists = useMemo(() => {
    const favoriteIds = Array.from(likedPaperIds || []);
    const readIds = Array.from(readPaperIds || [])
      .sort((a, b) => new Date(personalLibrary[b]?.readAt || 0) - new Date(personalLibrary[a]?.readAt || 0));
    const readLaterIds = Object.values(personalLibrary)
      .filter((record) => record.readLater)
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .map((record) => record.paperId);
    return [
      { id: '__favorites__', name: isEnglish ? 'Favorites' : 'Favoritos', emoji: 'Heart', paperIds: favoriteIds, createdAt: 'default' },
      { id: '__read_later__', name: isEnglish ? 'Read later' : 'Leer después', emoji: 'BookOpen', paperIds: readLaterIds, createdAt: 'default' },
      { id: '__read__', name: isEnglish ? 'Reading history' : 'Historial de lectura', emoji: 'Eye', paperIds: readIds, createdAt: 'default' },
      ...lists,
    ];
  }, [isEnglish, likedPaperIds, lists, personalLibrary, readPaperIds]);

  const getPaper = useCallback((paperId) => {
    // `libraryPapers` last of the three, because it is the broadest and the
    // least specific: it is whatever the mount's bounded read happened to
    // fetch, and either of the other two is a deliberate fetch of this paper.
    const libraryPaper = personalLibrary[paperId]?.paper;
    const savedPaper = savedPapers[paperId] ?? libraryPapers[paperId];
    if (!libraryPaper) return savedPaper;
    if (!savedPaper) return libraryPaper;
    const mergedPaper = {
      ...libraryPaper,
      ...savedPaper,
      doi: libraryPaper.doi || savedPaper.doi,
      arxivId: libraryPaper.arxivId || savedPaper.arxivId,
      openUrl: libraryPaper.openUrl || savedPaper.openUrl,
      landingPageUrl: libraryPaper.landingPageUrl || savedPaper.landingPageUrl,
      pdfUrl: libraryPaper.pdfUrl || savedPaper.pdfUrl,
      abstract: libraryPaper.abstract || savedPaper.abstract,
      summary: libraryPaper.summary || savedPaper.summary,
      concepts: libraryPaper.concepts?.length ? libraryPaper.concepts : savedPaper.concepts,
    };
    return mergedPaper.sources ? mergedPaper : paperLegacyAdapter(mergedPaper);
  }, [libraryPapers, personalLibrary, savedPapers]);

  useEffect(() => subscribeToPublicListSync((key, state) => {
    setSyncStates((current) => {
      if (!state) {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (current[key]?.status === state.status && current[key]?.code === state.code) {
        return current;
      }
      return { ...current, [key]: state };
    });
    // Record the sync on the local copy of the list. `publicSyncedAt` is the
    // Worker's field and the Worker has just written it — reading it back
    // would cost a document. Stamping it here keeps the freshness check
    // comparing two times from the SAME clock for the rest of the session,
    // instead of one from Firestore against one from Cloudflare.
    if (state?.status === 'synced' && state.listId) {
      setLists((current) => current.map((entry) => (
        entry.id === state.listId ? { ...entry, publicSyncedAt: new Date() } : entry
      )));
      // Straight from the Worker, so the note and the mismatch check do not
      // need a second read of the document that was just written.
      if (Number.isInteger(state.result?.paperCount)) {
        setPublicSnapshots((current) => ({
          ...current, [state.listId]: { paperCount: state.result.paperCount },
        }));
      }
    }
  }), []);

  // Only the turning-on is state, and it happens in the timer. Turning off is
  // derived below, because writing it here would set state synchronously in an
  // effect body and cascade a render on every load that beats the threshold —
  // which is most of them.
  useEffect(() => {
    if (!loading || lists.length > 0) return undefined;
    const timer = setTimeout(() => setPlaceholdersDue(true), LIST_PLACEHOLDER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading, lists.length]);

  useEffect(() => {
    let active = true;
    // The retry loop outlives the promise; leaving the screen must end it.
    const controller = new AbortController();

    const loadData = async () => {
      if (!user) {
        if (active) setLists([]);
        if (active) setLoading(false);
        return;
      }
      if (active) {
        setLoading(true);
        setError(null);
      }
      /**
       * Returns false when the snapshot is not worth believing.
       *
       * `patientRead` below covers a read that is slow or that never comes
       * back. It cannot cover a read that answers instantly with nothing:
       * with the backend unreachable `getDocs` resolves against the in-memory
       * cache, so a perfectly fulfilled empty success arrives — and believing
       * it painted an account's custom lists out of existence, measured at 0
       * documents in 0.3 ms, with no error state shown at all. Records in
       * hand are records; an *absence* only counts when the server is the one
       * reporting it.
       */
      const applySnapshot = (snapshot) => {
        if (!active) return false;
        if (!snapshotIsAuthoritative(snapshot)) return false;
        const customLists = [];
        snapshot.forEach((item) => customLists.push({ id: item.id, ...item.data() }));
        setLists(customLists);
        // The save modal paints from this same cache. Stamping it here means
        // a visit to Mis listas refreshes what the modal will show next.
        rememberOwnLists(user.uid, customLists);
        // The gate on persisting: from here on this session has heard from the
        // server at least once, so `lists` is worth writing to disk — including
        // after a create, a rename or a delete.
        listsHeardFromServer.current = true;
        return true;
      };

      try {
        if (IS_DEMO) {
          if (active) setLists(demoGet('lists', []));
          return;
        }

        // A bounded page, never the whole collection: this and the save modal
        // were the last two raw `collection(...)` reads in the client.
        const listsRef = query(
          collection(db, 'users', user.uid, 'lists'),
          limit(OWN_LISTS_PAGE_SIZE),
        );

        // FeedContext already owns Favorites, Read and Read later. Custom lists
        // paint from IndexedDB first while one network refresh runs behind them.
        try {
          const cached = await getDocsFromCache(listsRef);
          applySnapshot(cached);
        } catch {
          // First visit on this device: nothing cached yet.
        }

        // This screen used to bound the read itself: one 2.5-second deadline,
        // and a `throw` when it expired. That deadline was the banner. A read
        // that has not answered yet says nothing about whether it will, and
        // 2.5 seconds is well inside normal — the auth gate alone measures up
        // to 470 ms, and the first read after Firestore closes its idle
        // stream at sixty seconds pays a whole handshake. So the banner fired
        // on healthy accounts, then cleared itself when the answer landed a
        // moment later: a false alarm that argued with itself.
        //
        // `patientRead` replaces it. A timeout keeps the read alive and
        // re-asks; only a real refusal is an error, and the ceiling says
        // "still trying" rather than "could not be updated".
        const answered = await patientRead(() => getDocs(listsRef), {
          attempts: 3,
          label: 'custom lists',
          signal: controller.signal,
          onLateResult: (lateSnapshot) => {
            if (!active) return;
            if (applySnapshot(lateSnapshot)) {
              setError(null);
              setLoading(false);
            }
          },
        });
        if (!applySnapshot(answered)) {
          // Answered, but only by the cache, and with nothing in it. That is
          // "could not load", not "you have no lists".
          throw new Error('Custom lists could not be loaded.');
        }
        if (active) setError(null);
      } catch (err) {
        if (!active) return;
        if (isReadTimeout(err)) {
          // The budget is spent; the retry loop and `onLateResult` are not.
          console.warn('The custom lists did not answer in time', err);
          setError('LISTS_LOAD_STALLED');
          return;
        }
        console.error('Error loading lists:', err);
        setError('LISTS_LOAD_FAILED');
      } finally {
        if (active) setLoading(false);
      }
    };

    loadData();
    return () => {
      active = false;
      controller.abort();
    };
  }, [user, reloadToken]);

  const openList = useCallback(async (list, retryFailedOnly = false) => {
    const requestId = ++metadataRequestId.current;
    setExpandedList(list.id);
    setMetadataError(null);

    const paperIds = [...new Set(
      (list.paperIds || []).filter((paperId) => typeof paperId === 'string' && paperId),
    )];
    // The mount's library read now keeps what it fetches, so most lists open
    // with nothing missing at all — which is the difference between a list that
    // paints instantly and one that goes back out for every paper it holds.
    const missingIds = paperIds.filter(
      (paperId) => !savedPapers[paperId]
        && !personalLibrary[paperId]?.paper
        && !libraryPapers[paperId],
    );
    // Whatever the last list left waiting is not this list's business.
    setPendingPaperIds(new Set());

    if (missingIds.length === 0) {
      failedMetadataRequests.current.delete(list.id);
      return;
    }

    if (IS_DEMO) {
      const demoPapers = demoGet('savedPapersData', {});
      const requestedPapers = {};
      missingIds.forEach((paperId) => {
        if (demoPapers[paperId]) {
          requestedPapers[paperId] = paperLegacyAdapter({ id: paperId, ...demoPapers[paperId] });
        }
      });
      setSavedPapers((current) => ({ ...current, ...requestedPapers }));
      failedMetadataRequests.current.delete(list.id);
      return;
    }

    if (!user) return;
    setPendingPaperIds(new Set(missingIds));

    /**
     * The same set, in the closure.
     *
     * The budget below has to know whether anything is STILL waiting, and it
     * fires long after `openList` has returned — so it cannot ask React for the
     * current state, and an updater is no place to decide whether to raise a
     * banner. `dropPending` is the single funnel through which rows stop
     * waiting, so it keeps both copies in step.
     */
    const stillPending = new Set(missingIds);

    // Deliberately NOT cleared when openList returns: a request past its own
    // deadline is still running and can still paint its rows, and this is the
    // ceiling on that window too. A previous open's timer is cancelled by the
    // ref below, and a fire that finds nothing waiting does nothing.
    clearTimeout(metadataBudgetTimer.current);
    metadataBudgetTimer.current = setTimeout(() => {
      if (metadataRequestId.current !== requestId || stillPending.size === 0) return;
      stillPending.clear();
      setPendingPaperIds(new Set());
      setMetadataError('LIST_METADATA_LOAD_FAILED');
    }, PAPER_METADATA_TOTAL_BUDGET_MS);

    /** Stops a superseded open from clearing the rows of the current one. */
    const dropPending = (ids) => {
      if (metadataRequestId.current !== requestId || ids.length === 0) return;
      ids.forEach((paperId) => stillPending.delete(paperId));
      setPendingPaperIds((current) => {
        if (!ids.some((paperId) => current.has(paperId))) return current;
        const next = new Set(current);
        ids.forEach((paperId) => next.delete(paperId));
        return next;
      });
    };

    try {
      const retryRequests = retryFailedOnly
        ? (failedMetadataRequests.current.get(list.id) || [])
        : [];
      failedMetadataRequests.current.delete(list.id);

      // The batching lives in listPaperMetadataPlan.js, where it can be tested:
      // a batch one value over Firestore's cap is not caught by the SDK, and a
      // legacy arXiv id carrying a slash rejects the entire query it rides in.
      const { requests: requestDefinitions, unfetchable } = retryRequests.length > 0
        ? planRetryRequests({ failedRequests: retryRequests, missingIds })
        : planMetadataRequests({ missingIds, batchSize: PAPER_METADATA_BATCH_SIZE });

      // Nothing is ever going to answer for these, so they must not sit under a
      // skeleton waiting for a request that was never made.
      dropPending(unfetchable);

      /**
       * How many requests still cover each paper, so a row stops waiting only
       * when nothing is left that could answer for it.
       *
       * Every batch is asked of two collections. Dropping an id the moment one
       * of them came back empty would put the placeholder under a paper the
       * other request was about to deliver.
       */
      const outstanding = new Map();
      requestDefinitions.forEach((requestDefinition) => {
        requestDefinition.paperIds.forEach((paperId) => {
          outstanding.set(paperId, (outstanding.get(paperId) || 0) + 1);
        });
      });
      // Retrying re-asks only the batches that failed, so anything the retry
      // does not cover has nothing left coming for it. Without this those rows
      // would wait on a request that is never going to be made.
      dropPending(missingIds.filter((paperId) => !outstanding.has(paperId)));

      const settleRequest = (requestDefinition) => {
        const exhausted = [];
        requestDefinition.paperIds.forEach((paperId) => {
          const left = (outstanding.get(paperId) ?? 1) - 1;
          outstanding.set(paperId, left);
          if (left <= 0) exhausted.push(paperId);
        });
        dropPending(exhausted);
      };

      const resolvedIds = new Set();
      const mergeSnapshot = (source, snapshot) => {
        if (metadataRequestId.current !== requestId) return;
        const loadedPapers = {};
        snapshot.forEach((item) => {
          const data = item.data();
          // Decoded: the document is named by the encoded id, the row by the
          // paper id the list holds.
          const paperId = decodeFirestoreDocId(item.id);
          const rawPaper = source === 'saved'
            ? { id: paperId, ...data }
            : data.paper
              ? { id: paperId, ...data.paper }
              : {
                  id: paperId,
                  title: data.paperTitle || '',
                  authors: data.paperAuthors || [],
                  primaryCategory: data.paperCategory || '',
                  published: data.timestamp,
                  arxivId: paperId,
                };
          const paper = paperLegacyAdapter(rawPaper);
          loadedPapers[paperId] = paper;
          if (paper.title && paper.title !== paperId) {
            resolvedIds.add(paperId);
          }
        });

        if (Object.keys(loadedPapers).length === 0) return;
        // A row with data in hand stops waiting immediately; it does not sit
        // under a skeleton until the other collection also reports back.
        dropPending(Object.keys(loadedPapers));
        // Kept for the rest of the session, so leaving this list to read a
        // paper and coming back costs nothing.
        rememberListPapers(user.uid, loadedPapers);
        setSavedPapers((current) => {
          const next = { ...current };
          Object.entries(loadedPapers).forEach(([paperId, paper]) => {
            // savedPapers contains the canonical document and must win even if
            // the lighter interaction record finishes later.
            if (source === 'saved' || !next[paperId]) {
              next[paperId] = paper;
            }
          });
          return next;
        });
      };

      const runRequest = async (requestDefinition) => {
        const sourceCollection = requestDefinition.source === 'saved'
          ? 'savedPapers'
          : 'interactions';
        const metadataQuery = query(
          collection(db, 'users', user.uid, sourceCollection),
          where(documentId(), 'in', requestDefinition.paperIds.map(encodeFirestoreDocId)),
        );

        /**
         * No local-cache leg here, and it took two reversals to be sure.
         *
         * It was justified while the mount fetched paper documents and threw
         * most of them away: this read then found them still sitting in
         * Firestore's memory cache, which — measured against the emulator, not
         * assumed — does retain them, across other query traffic, for a
         * DIFFERENT `in` filter over a subset. That was a real hit rate.
         *
         * `ensurePersonalLibrary` now keeps what it fetches, so those documents
         * arrive as `libraryPapers` and never reach `missingIds` at all. What is
         * left for a cache leg to find is a document this session has never
         * fetched — which is exactly what a cache cannot have. It would only
         * buy a second `mergeSnapshot` racing the first.
         */
        const networkRequest = getDocs(metadataQuery);
        const networkResultRequest = settleWithin(
          networkRequest,
          PAPER_METADATA_LOAD_DEADLINE_MS,
        ).then((networkResult) => {
          if (networkResult.status === 'fulfilled') {
            // Documents in hand are documents whatever their provenance; it is
            // an ABSENCE that needs the server to have said so. Offline, this
            // read fulfils empty off the in-memory cache in a fraction of a
            // millisecond, and counting that as "these papers have no metadata"
            // is the lie the lists read one screen up already refuses to tell.
            mergeSnapshot(requestDefinition.source, networkResult.value);

            // Settling means "nothing more is coming for these rows", so it may
            // only happen on an answer worth believing. An EMPTY snapshot off
            // the local cache is not one: offline, `getDocs` fulfils in a
            // fraction of a millisecond with nothing in it, and settling on that
            // would put the raw arXiv id under every row — "this paper has no
            // metadata" — for a question that was never actually asked. The rows
            // keep waiting, the banner below says so, and the total budget is
            // what stops the wait being unbounded.
            if (!queryIsAuthoritative(networkResult.value)) {
              return { status: 'unauthoritative' };
            }
            // The early return here used to skip the `else` below, so a request
            // that came back WITHOUT a document for some id never decremented
            // that id's outstanding count and the row waited under a skeleton
            // for an answer already given. A server saying "no such document"
            // is an answer.
            settleRequest(requestDefinition);
            return networkResult;
          }

          if (networkResult.status === 'timed_out') {
            // Still running. The rows it covers keep waiting until it lands or
            // gives up — the deadline above bounds the caller, not the read.
            networkRequest.then((lateSnapshot) => {
              mergeSnapshot(requestDefinition.source, lateSnapshot);
              settleRequest(requestDefinition);
              if (
                metadataRequestId.current === requestId
                && missingIds.every((paperId) => resolvedIds.has(paperId))
              ) {
                failedMetadataRequests.current.delete(list.id);
                setMetadataError(null);
              }
            }).catch(() => settleRequest(requestDefinition));
          } else {
            settleRequest(requestDefinition);
          }
          return networkResult;
        });

        // `settleWithin` resolves rather than rejects, so this only throws if
        // the handler above did — the caller classifies everything else from
        // the value it returns.
        return networkResultRequest;
      };

      // Every source/batch has its own deadline and paints as soon as it
      // resolves. One slow Firestore query can no longer hold back the others.
      const requestResults = await Promise.allSettled(
        requestDefinitions.map((requestDefinition) => runRequest(requestDefinition)),
      );
      if (metadataRequestId.current !== requestId) return;

      // A batch that merely ran out of time is still in flight, and the
      // handler above already merges it when it lands. Counting it as a
      // failure is what put "some metadata could not be loaded" on screen for
      // data that arrived a second later.
      const failedRequests = requestResults.flatMap((result, index) => {
        const timedOut = result.status === 'fulfilled' && result.value?.status === 'timed_out';
        if (!timedOut && (result.status === 'rejected' || result.value?.status !== 'fulfilled')) {
          // `settleWithin` resolves with the reason rather than throwing it, so
          // without this every cause reaches the owner as the same sentence and
          // reaches the console as nothing at all. A batch one value over
          // Firestore's cap fails as `invalid-argument` on every attempt and is
          // otherwise indistinguishable from a flaky channel.
          const definition = requestDefinitions[index];
          const reason = result.status === 'rejected' ? result.reason : result.value?.reason;
          console.warn(
            `List metadata request failed (${definition.source}, ${definition.paperIds.length} ids):`,
            reason?.code ?? result.value?.status ?? 'unknown',
            reason?.message ?? '',
          );
          return [definition];
        }
        return [];
      });
      /**
       * The safety net under the per-id accounting.
       *
       * `outstanding` is a counter, and a counter that misses a decrement is a
       * row that shimmers forever — the failure mode with no natural end, and
       * the one worth being paranoid about. So after the burst the question is
       * asked the other way round: which ids could STILL be answered?
       *
       *   timed out      — the read is genuinely still running, and its late
       *                    handler will merge and settle when it lands.
       *   unauthoritative — an empty answer off the local cache. We did not
       *                    find out, so the row keeps waiting under the banner.
       *
       * Anything else has had its answer, whatever the answer was. If the
       * counter says otherwise, the counter is wrong and this frees the row.
       * The total budget is what bounds the two cases above.
       */
      const stillAnswerable = new Set(
        requestResults.flatMap((result, index) => {
          const status = result.status === 'fulfilled' ? result.value?.status : 'rejected';
          return status === 'timed_out' || status === 'unauthoritative'
            ? requestDefinitions[index].paperIds
            : [];
        }),
      );
      dropPending(missingIds.filter((paperId) => !stillAnswerable.has(paperId)));

      const unresolvedIds = missingIds.filter((paperId) => !resolvedIds.has(paperId));

      // A legacy arXiv id (`hep-th/0603001`) saved or liked before document
      // names were encoded has no document to answer for it. arXiv names it,
      // the way the profile's Liked tab does; a superseded open paints nothing.
      const legacyMissing = unresolvedIds.filter((paperId) => !stillAnswerable.has(paperId));
      if (legacyMissing.length > 0) {
        setPendingPaperIds((current) => {
          const next = new Set(current);
          legacyMissing.forEach((paperId) => next.add(paperId));
          return next;
        });
        hydrateLegacyArxivPapers(legacyMissing).then(({ records }) => {
          if (metadataRequestId.current !== requestId) return;
          const named = {};
          records.forEach(({ id, data }) => { named[id] = { ...data.paper, id }; });
          if (Object.keys(named).length > 0) {
            rememberListPapers(user.uid, named);
            setSavedPapers((current) => ({ ...named, ...current }));
          }
          dropPending(legacyMissing);
        }).catch(() => dropPending(legacyMissing));
      }

      if (failedRequests.length > 0 && unresolvedIds.length > 0) {
        failedMetadataRequests.current.set(list.id, failedRequests);
        setMetadataError('LIST_METADATA_LOAD_FAILED');
      } else {
        // Either everything resolved, or what is missing is merely late and
        // the merge handler above is still waiting for it. Neither is an error.
        failedMetadataRequests.current.delete(list.id);
        setMetadataError(null);
      }
    } catch (metadataLoadError) {
      console.error('Error loading list paper metadata:', metadataLoadError);
      if (metadataRequestId.current === requestId) {
        setMetadataError('LIST_METADATA_LOAD_FAILED');
        // Nothing is coming: a throw here means the requests were never
        // dispatched, and rows left in the pending set would wait forever.
        setPendingPaperIds(new Set());
      }
    }
  }, [libraryPapers, personalLibrary, savedPapers, user]);

  // A profile list card arrives with the list it wants opened. Once per id:
  // the state survives in the history entry, so coming back after closing the
  // list must not snap it open again.
  const autoOpenedListId = useRef(null);
  useEffect(() => {
    const targetId = location.state?.openListId;
    if (!targetId || autoOpenedListId.current === targetId) return undefined;
    // `displayLists`, not `lists`: Favorites, Read later and Reading history
    // are assembled here rather than stored, and they must restore too.
    const target = displayLists.find((entry) => entry.id === targetId);
    if (!target) return undefined;
    const timeoutId = setTimeout(() => {
      // Claimed here rather than before the timer: the contexts this list is
      // built from hydrate in several passes, and every pass re-runs this
      // effect and cancels the pending open. Marking it early meant the
      // retry was refused and the list never opened at all.
      autoOpenedListId.current = targetId;
      // A profile card sends only the id and means "you came from elsewhere";
      // a restore after visiting a paper sends the flag it had before.
      setOpenedFromRoute(location.state?.fromRoute !== false);
      openList(target);
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [displayLists, location.state, openList]);

  /**
   * A paper in a list opens its card, not the PDF: the card is the whole
   * paper (abstract, actions, related work) and carries a "Read article"
   * button of its own, so nothing is lost and everything else is gained.
   *
   * Before leaving, the current history entry is re-stamped with the open
   * list, so coming back restores the papers rather than the list index.
   * `fromRoute` rides along so the expanded view's back control keeps
   * pointing wherever it pointed before.
   */
  const openPaperCard = (paper) => {
    // The public paper page when the paper has an address there; otherwise
    // the search page carrying the title, where the same paper opens in an
    // overlay that needs no identifier. The fallback used to hand the PDF
    // viewer the raw id as an arXiv id (`openalex:W…`, a Semantic Scholar
    // hash), which built a PDF link nothing served.
    const destination = searchPaperDestination(paper);
    if (expandedList) {
      navigate(location.pathname, {
        replace: true,
        state: { openListId: expandedList, fromRoute: openedFromRoute },
      });
    }
    navigate(destination.path, { state: destination.state });
  };

  useEffect(() => () => clearTimeout(metadataBudgetTimer.current), []);

  /**
   * Keeps the stored copy in step with the screen.
   *
   * One write point rather than a call in every handler that mutates a list:
   * creating, renaming, recolouring, deleting and adding or removing a paper
   * all end at `setLists`, and a persisted copy that misses one of them is a
   * deleted list coming back to life on the next reload — which is worse than
   * not persisting at all.
   */
  useEffect(() => {
    if (IS_DEMO || !user?.uid || !listsHeardFromServer.current) return;
    saveStoredLists(user.uid, lists);
  }, [user?.uid, lists]);

  const closeExpandedList = () => {
    metadataRequestId.current += 1;
    setOpenedFromRoute(false);
    setExpandedList(null);
    // Drop the restore marker, or a later visit would reopen a list the user
    // has explicitly closed.
    if (location.state?.openListId) {
      navigate(location.pathname, { replace: true, state: null });
    }
    setPendingPaperIds(new Set());
    setMetadataError(null);
    setShareFeedback(null);
  };

  // The dialog owns the form and its busy/error states; this owns the write.
  // Letting the failure through is the contract: CreateListDialog keeps itself
  // open and says so, instead of the caller guessing what to render.
  const handleCreateList = async (name, icon, color) => {
    const listId = `list_${Date.now()}`;
    const newList = { id: listId, name, emoji: icon, color, paperIds: [], createdAt: new Date().toISOString() };
    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      allLists.push(newList);
      demoSet('lists', allLists);
    } else {
      await setDoc(doc(db, 'users', user.uid, 'lists', listId), newList);
    }
    setLists((prev) => [...prev, newList]);
  };

  /**
   * Renaming, re-icon-ing or recolouring a list the owner made.
   *
   * A partial update rather than a `setDoc`: the document also carries
   * `paperIds`, `createdAt` and the public-share bookkeeping, and rewriting it
   * whole from a form that knows about three fields would drop the rest. Left
   * to throw, so a failed save keeps the window open with its message instead of
   * closing over a change that never landed.
   *
   * `updatedAt` is not bookkeeping here: the published copy carries the list's
   * NAME, and the sync effect below rebuilds it only when `updatedAt` runs ahead
   * of `publicSyncedAt`. Renaming a published list without leaving that mark
   * would rename it everywhere except on the page strangers actually read.
   */
  const handleEditList = async (listId, fields) => {
    if (PRIVATE_LIST_IDS.has(listId)) return;
    const edit = { name: fields.name, emoji: fields.icon, color: fields.color };
    const editedAt = new Date();

    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      demoSet('lists', allLists.map(item => (
        item.id === listId ? { ...item, ...edit, updatedAt: editedAt.toISOString() } : item
      )));
    } else {
      await updateDoc(doc(db, 'users', user.uid, 'lists', listId), {
        ...edit,
        updatedAt: serverTimestamp(),
      });
    }

    setLists((prev) => prev.map(item => (
      item.id === listId ? { ...item, ...edit, updatedAt: editedAt } : item
    )));
  };

  const handleDeleteList = async (listId) => {
    if (PRIVATE_LIST_IDS.has(listId)) return;
    const list = lists.find(candidate => candidate.id === listId);
    // Deleting is irreversible and, for a published list, takes the public
    // link down with it; a hover-revealed ✕ is too easy to hit for that.
    const confirmed = globalThis.confirm?.(
      isEnglish
        ? `Delete "${list?.name ?? 'this list'}"? This cannot be undone.`
        : `¿Eliminar "${list?.name ?? 'esta lista'}"? No se puede deshacer.`,
    );
    if (confirmed === false) return;
    if (IS_DEMO) {
      const allLists = demoGet('lists', []).filter((l) => l.id !== listId);
      localStorage.setItem('papertok_lists', JSON.stringify(allLists));
    } else {
      if (list?.publicShareId) {
        await unpublishPublicList(list.publicShareId, list.id);
        cancelPublicListSync(publicListSyncKey(user.uid, listId));
      }
      await deleteDoc(doc(db, 'users', user.uid, 'lists', listId));
    }
    setLists((prev) => prev.filter((l) => l.id !== listId));
    if (expandedList === listId) setExpandedList(null);
  };

  const handleUnmarkAsRead = (e, paperId) => {
    e.stopPropagation();
    unmarkAsRead(paperId);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__read__') {
        return { ...list, paperIds: list.paperIds.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleUnlike = async (e, paperId, paper) => {
    e.stopPropagation();
    await toggleLike(paper);
    setLists((prev) => prev.map((list) => {
      if (list.id === '__favorites__') {
        return { ...list, paperIds: list.paperIds.filter((id) => id !== paperId) };
      }
      return list;
    }));
  };

  const handleRemoveFromCustomList = async (e, listId, paperId) => {
    e.stopPropagation();
    // Only a write the server accepted may claim an edit time. Stamping the
    // local copy after a failed write would tell the freshness check that a
    // removal happened, and the sync would publish a list the account never
    // agreed to.
    let editedAt = null;
    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      const idx = allLists.findIndex((l) => l.id === listId);
      if (idx !== -1) {
        allLists[idx].paperIds = (allLists[idx].paperIds || []).filter((id) => id !== paperId);
        demoSet('lists', allLists);
      }
    } else {
      try {
        const listRef = doc(db, 'users', user.uid, 'lists', listId);
        await updateDoc(listRef, {
          paperIds: arrayRemove(paperId),
          // The mark the background sync looks for (P25). Every edit leaves
          // it; nothing else here decides when the public copy is rebuilt.
          updatedAt: serverTimestamp(),
        });
        editedAt = new Date();
      } catch (err) {
        console.error('Error removing paper from custom list:', err);
      }
    }
    setLists((prev) => prev.map((list) => {
      if (list.id !== listId) return list;
      return {
        ...list,
        paperIds: list.paperIds.filter((id) => id !== paperId),
        ...(editedAt ? { updatedAt: editedAt } : {}),
      };
    }));
  };

  const setListShareId = (listId, publicShareId) => {
    setPublicSnapshots((current) => {
      if (!(listId in current)) return current;
      const next = { ...current };
      delete next[listId];
      return next;
    });
    setLists(current => current.map(list => {
      if (list.id !== listId) return list;
      // `publicSyncedAt` too: publishing wrote the public document in the same
      // commit, so without it the freshness check would read a fresh
      // `updatedAt` against nothing and queue a sync of what was just written.
      if (publicShareId) return { ...list, publicShareId, publicSyncedAt: new Date() };
      // Falls through to the private branch below; either way what we knew
      // about the public copy no longer describes anything.
      const privateList = { ...list };
      delete privateList.publicShareId;
      return privateList;
    }));
  };

  // The platform share sheet when there is one (phones, mostly), the
  // clipboard when there is not. A dismissed sheet ends silently: closing it
  // was a decision, not a failure.
  const shareListLink = async (listId, publicShareId, listName) => {
    const url = getPublicListUrl(publicShareId);
    if (!url) throw new Error('A public link could not be created.');
    const outcome = await shareOrCopyLink({ url, title: listName, copy: copyText });
    if (outcome === 'shared') {
      trackEvent('share', { method: 'native', content_type: 'list', surface: 'lists' });
      setShareFeedback({ listId, state: 'shared', url });
    } else if (outcome === 'copied') {
      trackEvent('share', { method: 'clipboard', content_type: 'list', surface: 'lists' });
      setShareFeedback({ listId, state: 'success', url, copied: true });
    } else {
      setShareFeedback(null);
    }
    return url;
  };

  const handlePublishList = async (list, papers) => {
    if (IS_DEMO) {
      setShareFeedback({ listId: list.id, state: 'unsupported' });
      return;
    }

    setShareFeedback({ listId: list.id, state: 'loading' });
    const input = {
      listId: list.id,
      title: list.name,
      description: list.description,
      language: language === 'en' ? 'en' : 'es',
      papers,
    };

    try {
      // Publishing only. Keeping an already-published list current is not a
      // button any more: it is the sync engine, driven by `updatedAt` (P25).
      const result = await publishPublicList(input);
      setListShareId(list.id, result.shareId);
      try {
        await shareListLink(list.id, result.shareId, list.name);
      } catch (clipboardError) {
        console.error('Public list link could not be shared:', clipboardError);
        setShareFeedback({
          listId: list.id,
          state: 'success',
          url: getPublicListUrl(result.shareId),
          copied: false,
        });
      }
    } catch (publishError) {
      console.error('Error publishing public list:', publishError);
      setShareFeedback({ listId: list.id, state: 'error' });
    }
  };

  const handleShareList = async (list) => {
    try {
      setShareFeedback({ listId: list.id, state: 'loading' });
      await shareListLink(list.id, list.publicShareId, list.name);
    } catch (shareError) {
      console.error('Public list link could not be shared:', shareError);
      setShareFeedback({
        listId: list.id,
        state: 'copy-error',
        url: getPublicListUrl(list.publicShareId),
      });
    }
  };

  const handleUnpublishList = async (list) => {
    const confirmed = globalThis.confirm?.(
      isEnglish
        ? 'Stop sharing this list? Its public link will no longer work.'
        : '¿Dejar de compartir esta lista? Su enlace público dejará de funcionar.',
    );
    if (confirmed === false) return;

    setShareFeedback({ listId: list.id, state: 'loading' });
    try {
      await unpublishPublicList(list.publicShareId, list.id);
      // Whatever was queued for this list is about a share id that no longer
      // exists; letting it fire would report a failure for a decision the
      // owner has already made.
      if (user) cancelPublicListSync(publicListSyncKey(user.uid, list.id));
      setListShareId(list.id, null);
      setShareFeedback({ listId: list.id, state: 'unpublished' });
    } catch (unpublishError) {
      console.error('Error unpublishing public list:', unpublishError);
      setShareFeedback({ listId: list.id, state: 'error' });
    }
  };

  /**
   * The only thing that starts a sync, and the reason the Update button could
   * go away without leaving a hole.
   *
   * Every edit does one thing: stamp `updatedAt`. This asks the list itself
   * whether the last edit is newer than the last sync the Worker committed,
   * and rebuilds the public copy when it is. That indirection is what makes
   * recovery free — a sync lost to a closed tab, a dead connection or a spent
   * daily quota leaves the list dirty in Firestore, and simply opening it
   * later reconciles it, which is exactly the job the button used to do by
   * hand.
   *
   * It waits for the papers and refuses to run on a metadata failure. The
   * Worker's merge preserves an already-published paper for every id the
   * payload does not hydrate — but only an already-published one, so syncing a
   * half-loaded list would quietly drop whatever was added while the load was
   * broken.
   */
  /**
   * What the public copy actually holds, read once when a published list is
   * opened. Best-effort: a failed read leaves the check to the dirty stamp.
   */
  useEffect(() => {
    if (IS_DEMO || !expandedList) return undefined;
    const list = lists.find((entry) => entry.id === expandedList);
    if (!list?.publicShareId || expandedList in publicSnapshots) return undefined;

    let active = true;
    readPublicList(list.publicShareId)
      .then((document) => {
        if (!active) return;
        setPublicSnapshots((current) => ({
          ...current,
          [list.id]: { paperCount: Number.isInteger(document?.paperCount) ? document.paperCount : null },
        }));
      })
      .catch((readError) => {
        // Not knowing is not the same as knowing it is wrong: leave the entry
        // absent so the check falls back to the dirty stamp alone.
        console.warn('The public copy of this list could not be checked:', readError);
      });
    return () => { active = false; };
  }, [expandedList, lists, publicSnapshots]);

  /**
   * The two things that start a sync.
   *
   * **The edit stamp.** Every edit sets `updatedAt` and stops there; this
   * compares it with the `publicSyncedAt` the Worker wrote and rebuilds the
   * public copy when the edit is newer. That is what makes recovery free: a
   * sync lost to a closed tab, a dead connection or a spent daily quota is
   * replayed the next time the list is opened, with no click.
   *
   * **The count.** The stamp alone is not enough, and that gap cost a real
   * shared list two papers: a sync that published the WRONG thing still marks
   * itself done, so the list looks clean for ever. When the public copy holds
   * fewer papers than this screen could publish, it is rebuilt. Holding more
   * is fine — those are papers published earlier that this device cannot
   * hydrate right now, and the merge keeps them.
   *
   * It waits for the papers and refuses to run on a metadata failure: syncing
   * a half-loaded list would republish it short.
   */
  const queuedSyncs = useRef(new Map());
  useEffect(() => {
    if (IS_DEMO || !user || !expandedList) return;
    // Never from a seed. A list read back from this device's storage carries
    // the name it had when the tab last closed, and republishing THAT would
    // push a stale title onto the page strangers read — the seed is for
    // painting, not for deciding what the world sees. The read that confirms
    // the lists sets this, and setting `lists` re-runs the effect.
    if (!listsHeardFromServer.current) return;
    const list = lists.find((entry) => entry.id === expandedList);
    if (!list?.publicShareId) return;
    // The pending set, not the loading flag. The flag went false when the
    // four-second deadline elapsed, not when the papers landed, so this guard
    // released while reads were still in flight — and a sync that fires then
    // republishes the list short, which is the thing the guard exists to stop.
    if (pendingPaperIds.size > 0 || metadataError) return;

    // `listPaperId` ALONGSIDE the paper's own id, never over it: the public
    // copy is joined on the stored id (R8), but the paper's identity lives in
    // its own id — the legacy adapter folds the arXiv id in there and emits no
    // `arxivId`, so overwriting it strips the identity on the way out. A paper
    // whose metadata never arrived has no title to publish.
    const papers = (list.paperIds || [])
      .map((paperId) => {
        const paper = getPaper(paperId);
        return paper?.title && paper.title !== paperId
          ? { ...paper, listPaperId: paperId }
          : null;
      })
      .filter(Boolean);

    const publishedCount = publicSnapshots[list.id]?.paperCount;
    const behind = Number.isInteger(publishedCount) && publishedCount < papers.length;
    if (!listNeedsPublicSync(list) && !behind) return;

    // One request per state of the list, however many renders it causes.
    const signature = `${toEpochMillis(list.updatedAt)}:${publishedCount ?? '?'}:${papers.length}`;
    if (queuedSyncs.current.get(list.id) === signature) return;
    queuedSyncs.current.set(list.id, signature);

    queuePublicListSync({
      key: publicListSyncKey(user.uid, list.id),
      shareId: list.publicShareId,
      listId: list.id,
      title: list.name,
      description: list.description,
      language: language === 'en' ? 'en' : 'es',
      // Advisory only — the Worker reads the membership from the private list.
      paperIds: list.paperIds || [],
      papers,
    });
  }, [
    expandedList, getPaper, language, lists, metadataError, pendingPaperIds,
    publicSnapshots, user,
  ]);

  const papersCount = (count) => `${count} ${count === 1 ? 'paper' : 'papers'}`;

  // One motion vocabulary for the two views of this page: the index and an
  // open list cross-fade with a small vertical step instead of swapping DOM in
  // a single frame.
  const viewMotion = {
    initial: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 },
    transition: { duration: prefersReducedMotion ? 0.1 : 0.2, ease: [0.16, 1, 0.3, 1] },
  };

  // Arriving from a profile card with { openListId }: until the effect above
  // opens it, hold a skeleton instead of flashing an index the visitor did not
  // ask for. Falls through to the index if the list never shows up; closing
  // the list clears the state, so this cannot re-trap a closed list.
  // Derived, never stored: the placeholders must vanish the instant real cards
  // exist, and a stale `true` left over from a failed load is harmless — by
  // then the wait is already known to be long.
  const showListPlaceholders = placeholdersDue && loading && lists.length === 0;

  const targetOpenId = location.state?.openListId;
  const pendingOpen = Boolean(
    targetOpenId
    && !expandedList
    && (loading || displayLists.some((entry) => entry.id === targetOpenId)),
  );

  return (
    <div className="lists-page">
      {/* Only on the index. This line reports the LIST COLLECTION refresh, and
          showing it over an open list put a second spinner on screen next to
          the one that was actually about the papers being looked at. */}
      {/* `lists.length === 0` as well: a revalidation running behind a grid the
          owner is already reading is not a loading state, and announcing it
          puts a spinner over a finished screen. Same rule as the save modal. */}
      {loading && !expandedList && lists.length === 0 && (
        <div className="lists-inline-status" aria-live="polite">
          <div className="lists-loading-spinner" />
          <span>{isEnglish ? 'Updating personal lists...' : 'Actualizando listas personales...'}</span>
        </div>
      )}
      {error && (
        // 'stalled' is not an alarm: the read behind it is still running and
        // can still refresh the cards on its own, so it keeps `aria-busy` and
        // stays out of `role="alert"`. Only a real refusal is an error.
        <div
          className={`lists-inline-status${error === 'LISTS_LOAD_STALLED' ? '' : ' is-error'}`}
          role={error === 'LISTS_LOAD_STALLED' ? 'status' : 'alert'}
          aria-busy={error === 'LISTS_LOAD_STALLED'}
        >
          <span>{getUiErrorMessage(error, language, 'LISTS_LOAD_FAILED')}</span>
          <button className="lists-retry-btn" onClick={() => setReloadToken(token => token + 1)}>
            {isEnglish ? 'Try again' : 'Reintentar'}
          </button>
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
      {expandedList ? (
        <motion.div className="lists-expanded" key="expanded" {...viewMotion}>
          <button
            className="lists-back-btn"
            onClick={openedFromRoute ? () => navigate(-1) : closeExpandedList}
          >
            {openedFromRoute
              ? (isEnglish ? '← Back' : '← Volver')
              : (isEnglish ? '← My lists' : '← Mis listas')}
          </button>
          {(() => {
            const list = displayLists.find((l) => l.id === expandedList);
            if (!list) return null;
            const exportPapers = (list.paperIds || []).map(getPaper).filter(Boolean);
            // `listPaperId` from the first publish onwards: it becomes
            // `sourceId` on the public paper, and it is what lets every later
            // sync recognise this paper as one it already published.
            const publicPapers = (list.paperIds || [])
              .map(paperId => ({ paperId, paper: getPaper(paperId) }))
              .filter(({ paperId, paper }) => paper?.title && paper.title !== paperId)
              .map(({ paperId, paper }) => ({ ...paper, listPaperId: paperId }));
            const isCustomList = !PRIVATE_LIST_IDS.has(list.id);
            const listShareFeedback = shareFeedback?.listId === list.id ? shareFeedback : null;
            const shareBusy = listShareFeedback?.state === 'loading';
            const syncKey = user && isCustomList ? publicListSyncKey(user.uid, list.id) : null;
            const syncState = syncKey ? syncStates[syncKey] : null;
            const badgeState = publicBadgeState(syncState?.status);
            // How many papers of this list the public link does NOT carry.
            // The Worker's own count when we have it, the hydration gap when
            // we do not — never a guess dressed as a fact.
            const listTotal = (list.paperIds || []).length;
            const publishedCount = publicSnapshots[list.id]?.paperCount;
            const missingFromPublic = list.publicShareId
              ? Math.max(0, listTotal - (Number.isInteger(publishedCount)
                ? publishedCount
                : publicPapers.length))
              : 0;
            const badgeLabel = {
              public: isEnglish ? 'Public' : 'Pública',
              syncing: isEnglish ? 'Updating…' : 'Actualizando…',
              synced: isEnglish ? 'Up to date' : 'Al día',
              stale: isEnglish ? 'Out of date' : 'Sin actualizar',
            }[badgeState];
            return (
              <>
                <header
                  className={`lists-expanded-header${resolveListColor(list) ? '' : ' lists-expanded-header--uncoloured'}`}
                  style={resolveListColor(list) ? { '--list-accent': resolveListColor(list) } : undefined}
                >
                  <div className="lists-expanded-titleblock">
                    <span className="lists-expanded-icon" aria-hidden="true">
                      {(() => {
                        const Icon = getIcon(list.emoji);
                        return <Icon size={22} strokeWidth={1.6} />;
                      })()}
                    </span>
                    <div className="lists-expanded-copy">
                      <h1 className="lists-expanded-title">{list.name}</h1>
                      <p className="lists-expanded-meta">
                        <span>{papersCount((list.paperIds || []).length)}</span>
                        {isCustomList && !IS_DEMO && (list.publicShareId ? (
                          <span
                            className={`lists-badge lists-badge--public is-${badgeState}`}
                            aria-live="polite"
                          >
                            {badgeState === 'syncing'
                              ? <span className="lists-badge-spinner" aria-hidden="true" />
                              : badgeState === 'synced'
                                ? <Check size={11} aria-hidden="true" />
                                : badgeState === 'stale'
                                  ? <AlertTriangle size={11} aria-hidden="true" />
                                  : <Globe2 size={11} aria-hidden="true" />}
                            {' '}{badgeLabel}
                          </span>
                        ) : (
                          <span className="lists-badge">
                            <Lock size={11} aria-hidden="true" /> {isEnglish ? 'Private' : 'Privada'}
                          </span>
                        ))}
                      </p>
                    </div>
                  </div>
                  {isCustomList && !IS_DEMO && (
                    <div className="lists-share-actions">
                      {list.publicShareId ? (
                        // Share, and nothing else. There is no Update button
                        // because there is nothing left for it to do: the
                        // public copy follows the list on its own (P25).
                        <button
                          type="button"
                          className="is-primary"
                          onClick={() => handleShareList(list)}
                          disabled={shareBusy}
                        >
                          <Share2 size={16} /> {isEnglish ? 'Share' : 'Compartir'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="is-primary"
                          onClick={() => handlePublishList(list, publicPapers)}
                          disabled={shareBusy || pendingPaperIds.size > 0}
                        >
                          <Globe2 size={16} /> {isEnglish ? 'Publish & share' : 'Publicar y compartir'}
                        </button>
                      )}
                    </div>
                  )}
                  {isCustomList && IS_DEMO && (
                    <span className="lists-share-demo-note">
                      {isEnglish ? 'Public sharing is unavailable in demo mode.' : 'No se pueden publicar listas en el modo demo.'}
                    </span>
                  )}
                </header>
                {listShareFeedback && (
                  <div
                    className={`lists-share-status ${['error', 'copy-error'].includes(listShareFeedback.state) ? 'is-error' : ''}`}
                    role={['error', 'copy-error'].includes(listShareFeedback.state) ? 'alert' : 'status'}
                    aria-live="polite"
                  >
                    {listShareFeedback.state === 'loading' && (
                      <><span className="lists-loading-spinner" /> {isEnglish ? 'Updating public link...' : 'Actualizando enlace público...'}</>
                    )}
                    {listShareFeedback.state === 'shared' && (
                      <span>{isEnglish ? 'Public link shared.' : 'Enlace público compartido.'}</span>
                    )}
                    {listShareFeedback.state === 'success' && (
                      <>
                        <span>{listShareFeedback.copied
                          ? (isEnglish ? 'Public link copied.' : 'Enlace público copiado.')
                          : (isEnglish ? 'Public link ready. Copy it from here:' : 'Enlace público listo. Cópialo desde aquí:')}</span>
                        {listShareFeedback.url && <a href={listShareFeedback.url} target="_blank" rel="noopener noreferrer">{listShareFeedback.url}</a>}
                      </>
                    )}
                    {listShareFeedback.state === 'copy-error' && (
                      <>
                        <span>{isEnglish ? 'The link is public, but it could not be copied automatically.' : 'El enlace es público, pero no se pudo copiar automáticamente.'}</span>
                        {listShareFeedback.url && <a href={listShareFeedback.url} target="_blank" rel="noopener noreferrer">{listShareFeedback.url}</a>}
                      </>
                    )}
                    {listShareFeedback.state === 'unpublished' && (
                      <span>{isEnglish ? 'The list is private again.' : 'La lista vuelve a ser privada.'}</span>
                    )}
                    {listShareFeedback.state === 'error' && (
                      <span>{isEnglish ? 'The public link could not be changed. Try again.' : 'No se pudo cambiar el enlace público. Inténtalo de nuevo.'}</span>
                    )}
                  </div>
                )}
                {/* A sync only surfaces once it has already retried itself.
                    Nothing was lost when it does: the edit is in Firestore and
                    the list stays marked dirty, so opening it later would fix
                    this on its own — the button is here to save the wait. */}
                {list.publicShareId && syncState?.status === 'error' && (
                  <div className="lists-share-status is-error" role="alert">
                    <span>{getUiErrorMessage(syncState.code, language, 'PUBLIC_LIST_SYNC_FAILED')}</span>
                    <button className="lists-retry-btn" onClick={() => retryPublicListSync(syncKey)}>
                      {isEnglish ? 'Try again' : 'Reintentar'}
                    </button>
                  </div>
                )}
                {/* The number the owner had to open a second account to
                    discover. A public copy shorter than the list is a fact
                    worth saying out loud, not a discrepancy to be found. */}
                {isCustomList && (list.publicShareId
                  ? missingFromPublic > 0 && (
                    <p className="lists-share-limit-note">
                      {isEnglish
                        ? `${missingFromPublic} of ${listTotal} papers are not in the public link yet.`
                        : `${missingFromPublic} de ${listTotal} papers aún no están en el enlace público.`}
                      {listTotal > PUBLIC_LIST_LIMITS.papers && (isEnglish
                        ? ` Public links include up to ${PUBLIC_LIST_LIMITS.papers} papers.`
                        : ` Los enlaces públicos incluyen hasta ${PUBLIC_LIST_LIMITS.papers} papers.`)}
                    </p>
                  )
                  : publicPapers.length < listTotal && (
                    <p className="lists-share-limit-note">
                      {isEnglish
                        ? `Publishing would include ${publicPapers.length} of ${listTotal} papers: the rest have no details saved yet.`
                        : `Al publicarla entrarían ${publicPapers.length} de ${listTotal} papers: del resto aún no hay datos guardados.`}
                    </p>
                  ))}
                {(exportPapers.length > 0 || isCustomList) && (
                  <div className="lists-expanded-tools">
                    {exportPapers.length > 0 && (
                      <div className="lists-export-actions">
                        <span className="lists-tools-label">{isEnglish ? 'Export citation' : 'Exportar cita'}</span>
                        <button type="button" onClick={() => downloadCitationFile(exportPapers, 'bibtex', `papertok-${list.name}`)}><Download size={14} /> BibTeX</button>
                        <button type="button" onClick={() => downloadCitationFile(exportPapers, 'ris', `papertok-${list.name}`)}><Download size={14} /> RIS</button>
                      </div>
                    )}
                    {isCustomList && (
                      <button
                        type="button"
                        className="lists-edit-btn"
                        onClick={() => setEditing(list)}
                      >
                        <Pencil size={14} aria-hidden="true" /> {isEnglish ? 'Edit list' : 'Editar lista'}
                      </button>
                    )}
                    {isCustomList && !IS_DEMO && list.publicShareId && (
                      <button
                        type="button"
                        className="lists-unpublish-btn"
                        onClick={() => handleUnpublishList(list)}
                        disabled={shareBusy}
                      >
                        <Unlink size={14} aria-hidden="true" /> {isEnglish ? 'Stop sharing' : 'Dejar de compartir'}
                      </button>
                    )}
                  </div>
                )}
                {/* No spinner here. The skeleton rows below ARE the loading
                    state — they say the same thing in the shape of the content
                    that is coming, and they do not move the layout when it
                    lands. The announcement they used to borrow from this line
                    now lives on the papers container itself. */}
                {metadataError && (
                  <div className="lists-metadata-status is-error" role="alert">
                    <span>{getUiErrorMessage(metadataError, language, 'LIST_METADATA_LOAD_FAILED')}</span>
                    <button className="lists-retry-btn" onClick={() => openList(list, true)}>
                      {isEnglish ? 'Try again' : 'Reintentar'}
                    </button>
                  </div>
                )}
                <div
                  className="lists-expanded-papers"
                  aria-busy={pendingPaperIds.size > 0 ? 'true' : undefined}
                  aria-label={pendingPaperIds.size > 0
                    ? (isEnglish ? 'Loading papers in this list...' : 'Cargando los papers de esta lista...')
                    : undefined}
                >
                  {(list.paperIds || []).map((paperId, idx) => {
                    // Capped: past the eighth row the stagger is delaying
                    // content nobody has scrolled to yet.
                    const stagger = Math.min(idx, 8);
                    const paper = getPaper(paperId);
                    const record = personalLibrary[paperId];
                    if (!paper) return (
                      // While metadata is in flight the row is a shimmer with
                      // the finished row's silhouette; the status line above
                      // carries the accessible announcement.
                      <div
                        key={paperId}
                        className="lists-paper-item lists-paper-item--skeleton"
                        style={{ '--stagger-index': stagger }}
                        aria-hidden={pendingPaperIds.has(paperId) ? 'true' : undefined}
                      >
                        {/* This paper's own id, not the list's loading flag.
                            The flag went false at the deadline while the read
                            behind it was still running, so every row still in
                            flight fell through to its raw id. */}
                        {pendingPaperIds.has(paperId) ? (
                          // Three bars, not two, and each the height of the line
                          // it stands in for: the field label, the title, the
                          // authors. The old two-bar silhouette measured ~79px
                          // against a finished row's ~100–140px, so the moment
                          // the metadata landed every row in the list grew at
                          // once and the page shoved itself down.
                          <div className="lists-paper-skeleton">
                            <span className="lists-skeleton-bar lists-skeleton-bar--cat" />
                            <span className="lists-skeleton-bar lists-skeleton-bar--title" />
                            <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
                          </div>
                        ) : (
                          <p className="lists-paper-title lists-paper-placeholder">
                            {isEnglish ? 'The title could not be loaded' : 'No se pudo cargar el título'}
                          </p>
                        )}
                      </div>
                    );
                    return (
                      <div key={paperId} className="lists-paper-item"
                        style={{ '--area-accent': areaAccentForPaper(paper), '--stagger-index': stagger }}
                        onClick={() => openPaperCard(paper)}>
                        <div className="lists-paper-item-content">
                          <div className="lists-paper-head">
                            {paper.categories && paper.categories.length > 0 && (
                              <span className="lists-paper-cat">{getCategoryLabel(paper.categories[0], language)}</span>
                            )}
                            {paper.year && <span className="lists-paper-date">{paper.year}</span>}
                          </div>
                          <p className="lists-paper-title" lang="en">
                            <button
                              type="button"
                              className="lists-paper-title-btn"
                              onClick={(e) => { e.stopPropagation(); openPaperCard(paper); }}
                            >
                              <ScientificText>{paper.title}</ScientificText>
                            </button>
                          </p>
                          {paper.authors && (
                            <p className="lists-paper-authors">
                              {paper.authors.slice(0, 3).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ')}{paper.authors.length > 3 && ' et al.'}
                            </p>
                          )}
                          {record?.tags?.length > 0 && (
                            <div className="lists-paper-tags">
                              {record.tags.map((tag) => <span key={tag}>{tag}</span>)}
                            </div>
                          )}
                          {record?.note && <p className="lists-paper-note">{record.note}</p>}
                        </div>
                        <div className="lists-paper-actions">
                          {/* The stored id, not the merged paper's: the list
                              and the library key this paper by `paperId`, and
                              the modal's membership check and note record
                              must look under the same key (R8: ids differ by
                              entry route). */}
                          <button className="lists-paper-edit-btn" onClick={(e) => { e.stopPropagation(); onEditPaper?.({ ...paper, id: paperId }); }} title={isEnglish ? 'Edit note and tags' : 'Editar nota y etiquetas'}>
                            <Pencil size={17} />
                          </button>
                          <button
                            className="lists-paper-unmark-btn"
                            onClick={(e) => {
                              if (list.id === '__read__') {
                                handleUnmarkAsRead(e, paperId);
                              } else if (list.id === '__favorites__') {
                                handleUnlike(e, paperId, paper);
                              } else if (list.id === '__read_later__') {
                                e.stopPropagation();
                                toggleReadLater(paper);
                              } else {
                                handleRemoveFromCustomList(e, list.id, paperId);
                              }
                            }}
                            title={isEnglish ? 'Remove from list' : 'Quitar de la lista'}
                          >
                            <X size={18} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {(!list.paperIds || list.paperIds.length === 0) && (
                    <div className="lists-empty-state lists-empty-state--inline">
                      <span className="lists-empty-icon" aria-hidden="true"><Library size={20} /></span>
                      <h3>{isEnglish ? 'This list is empty' : 'Esta lista está vacía'}</h3>
                      <p>
                        {isEnglish
                          ? 'Add papers to it from the feed with "Save and organize".'
                          : 'Añádele papers desde el feed con "Guardar y organizar".'}
                      </p>
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </motion.div>
      ) : pendingOpen ? (
        <motion.div
          className="lists-opening"
          key="opening"
          {...viewMotion}
          aria-busy="true"
          aria-label={isEnglish ? 'Opening list...' : 'Abriendo la lista...'}
        >
          {/* The same three-bar rhythm the finished rows have, so opening a
              list settles into its content instead of swapping silhouettes. */}
          {[0, 1, 2, 3].map((slot) => (
            <div key={slot} className="lists-skeleton-row" style={{ '--stagger-index': slot }}>
              <span className="lists-skeleton-bar lists-skeleton-bar--cat" />
              <span className="lists-skeleton-bar lists-skeleton-bar--title" />
              <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
            </div>
          ))}
        </motion.div>
      ) : (
        <motion.div key="index" {...viewMotion}>
          {/* A nameplate: mono kicker, serif masthead, standfirst. The `h1`
              used to be Inter with a clipped gradient over it, and the kicker
              and standfirst below rendered with no rule behind them at all.
              There used to be a double rule under the row as well; without it
              the standfirst carries the whole hierarchy, so it sits tight to
              the title. */}
          <header className="lists-header">
            <div className="lists-masthead-row">
              <div className="lists-masthead-block">
                <p className="lists-eyebrow">{isEnglish ? 'Personal library' : 'Biblioteca personal'}</p>
                <h1>{isEnglish ? 'My lists' : 'Mis listas'}</h1>
              </div>
              {/* The primary action rides the nameplate rather than trailing the
                  grid as a ghost tile, so it stays reachable however long the
                  grid gets. */}
              <Button className="lists-create-btn" onClick={() => setCreating(true)}>
                <Plus size={16} aria-hidden="true" />
                {isEnglish ? 'New list' : 'Nueva lista'}
              </Button>
            </div>
            <p className="lists-subtitle">
              {isEnglish
                ? 'Organize, annotate and share the papers you keep.'
                : 'Organiza, anota y comparte los papers que guardas.'}
            </p>
          </header>
          <div className="lists-grid">
            {displayLists.map((list, idx) => {
              const Icon = getIcon(list.emoji);
              const isCustomList = !PRIVATE_LIST_IDS.has(list.id);
              const accent = resolveListColor(list);
              return (
              <div
                key={list.id}
                className={`list-card${accent ? '' : ' list-card--uncoloured'}`}
                onClick={() => { setOpenedFromRoute(false); openList(list); }}
                style={{ '--stagger-index': idx, ...(accent ? { '--list-accent': accent } : {}) }}
              >
                <div className="list-card-top">
                  <span className="list-card-icon" aria-hidden="true">
                    <Icon size={19} strokeWidth={1.6} />
                  </span>
                  {isCustomList && (
                    <div className="list-card-tools">
                      <button
                        className="list-card-tool"
                        onClick={(e) => { e.stopPropagation(); setEditing(list); }}
                        aria-label={isEnglish ? `Edit ${list.name}` : `Editar ${list.name}`}
                        title={isEnglish ? 'Edit list' : 'Editar lista'}
                      >
                        <Pencil size={13} aria-hidden="true" />
                      </button>
                      <button
                        className="list-card-tool list-card-tool--danger"
                        onClick={(e) => { e.stopPropagation(); handleDeleteList(list.id); }}
                        aria-label={isEnglish ? `Delete ${list.name}` : `Eliminar ${list.name}`}
                        title={isEnglish ? 'Delete list' : 'Eliminar lista'}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                </div>
                <h3 className="list-card-name">
                  <button
                    type="button"
                    className="list-card-name-btn"
                    onClick={(e) => { e.stopPropagation(); setOpenedFromRoute(false); openList(list); }}
                  >
                    {list.name}
                  </button>
                </h3>
                <div className="list-card-footer">
                  {/* A count is machine data, so it is set in mono with tabular
                      figures. It used to say nothing but its own size in Inter. */}
                  <span className="list-card-count">{papersCount(list.paperIds?.length || 0)}</span>
                  {/* The profile card says Public; its twin here said nothing. */}
                  {list.publicShareId && (
                    <span className="lists-badge lists-badge--public">
                      <Globe2 size={11} aria-hidden="true" /> {isEnglish ? 'Public' : 'Pública'}
                    </span>
                  )}
                </div>
                {/* "Nothing saved yet" is about the LIST, never about what we
                    have managed to fetch. It used to key off whether any title
                    had resolved, so on a cold index every card said it — a list
                    of forty-six papers announcing itself as empty until the
                    metadata landed. A list with papers whose titles are not
                    here yet simply shows no preview. */}
                <div className="list-card-preview">
                  {(list.paperIds?.length ?? 0) === 0 ? (
                    <p className="list-card-preview-empty">
                      {isEnglish ? 'Nothing saved yet.' : 'Nada guardado todavía.'}
                    </p>
                  ) : (
                    list.paperIds
                      .map((paperId) => getPaper(paperId))
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((paper) => <p key={paper.id} className="list-card-preview-title"><ScientificText>{paper.title}</ScientificText></p>)
                  )}
                </div>
              </div>
              );
            })}
            {showListPlaceholders && [0, 1].map((slot) => (
              <div
                key={`list-placeholder-${slot}`}
                className="list-card list-card--placeholder"
                aria-hidden="true"
                style={{ '--stagger-index': displayLists.length + slot }}
              >
                <div className="list-card-top"><span className="list-card-icon" /></div>
                <span className="lists-skeleton-bar lists-skeleton-bar--title" />
                <span className="lists-skeleton-bar lists-skeleton-bar--meta" />
                <div className="list-card-preview">
                  <span className="lists-skeleton-bar" />
                </div>
              </div>
            ))}
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* Outside the AnimatePresence on purpose: Edit is reachable from a card
          in the grid AND from inside an open list, and a window that lived in
          one branch would unmount the moment the other took over. */}
      <CreateListDialog
        open={creating}
        isEnglish={isEnglish}
        onClose={() => setCreating(false)}
        onCreate={handleCreateList}
      />
      <CreateListDialog
        open={Boolean(editing)}
        isEnglish={isEnglish}
        list={editing}
        onClose={() => setEditing(null)}
        onSave={handleEditList}
      />
    </div>
  );
}
