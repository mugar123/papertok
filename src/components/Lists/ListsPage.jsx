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
import { getIcon, AVAILABLE_ICONS } from '../../utils/icons';
import ScientificText from '../ScientificText.js';
import { paperLegacyAdapter } from '../../models/Paper';
import { AlertTriangle, Check, Download, Globe2, Library, Lock, Pencil, Plus, Share2, Unlink, X } from 'lucide-react';
import { shareOrCopyLink } from '../../utils/shareLink.js';
import { downloadCitationFile } from '../../utils/readingLibrary';
import { settleWithin } from '../../utils/asyncTiming';
import { getUiErrorMessage } from '../../utils/errorMessages';
import { useAnalyticsConsent } from '../../context/AnalyticsContext';
import {
  publishPublicList,
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
import { getPublicListUrl, getPublicPaperPath } from '../../utils/publicNavigation.js';
import { OWN_LISTS_PAGE_SIZE } from '../../services/userProfileService.js';
import { snapshotIsAuthoritative } from '../../utils/ownLists.js';
import './ListsPage.css';

const LISTS_LOAD_DEADLINE_MS = 2_500;
const PAPER_METADATA_LOAD_DEADLINE_MS = 4_000;
const PAPER_METADATA_BATCH_SIZE = 10;
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


export default function ListsPage({ onOpenPdf, onEditPaper }) {
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
  const [lists, setLists] = useState([]);
  const [savedPapers, setSavedPapers] = useState({});
  const [expandedList, setExpandedList] = useState(null);
  // True while the expanded list is the one a profile card navigated to: its
  // back control then returns to the profile instead of collapsing to the
  // index the visitor never asked for.
  const [openedFromRoute, setOpenedFromRoute] = useState(false);
  const [loading, setLoading] = useState(false);
  const [metadataLoadingListId, setMetadataLoadingListId] = useState(null);
  const [metadataError, setMetadataError] = useState(null);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [shareFeedback, setShareFeedback] = useState(null);
  // What the sync engine is doing, keyed by list. It is not this page's state
  // to own: the save-and-organize modal queues syncs too, and they have to
  // outlive whichever screen started them, so the page subscribes instead.
  const [syncStates, setSyncStates] = useState({});
  // The inline create form on the index: nothing else in the app can create a
  // list outside the save modal, and an index of lists needs its own door.
  const [creating, setCreating] = useState(false);
  const [newListName, setNewListName] = useState('');
  const [newListIcon, setNewListIcon] = useState('Folder');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(false);
  const metadataRequestId = useRef(0);
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
    const libraryPaper = personalLibrary[paperId]?.paper;
    const savedPaper = savedPapers[paperId];
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
  }, [personalLibrary, savedPapers]);

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
    }
  }), []);

  useEffect(() => {
    let active = true;

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
       * The deadline below covers a slow read. It does not cover a read that
       * answers instantly with nothing: with the backend unreachable `getDocs`
       * resolves against the in-memory cache, so `settleWithin` sees a
       * perfectly `fulfilled` empty success and this painted an account's
       * custom lists out of existence — measured at 0 documents in 0.3 ms,
       * with no error state shown at all. Records in hand are records; an
       * *absence* only counts when the server is the one reporting it.
       */
      const applySnapshot = (snapshot) => {
        if (!active) return false;
        if (!snapshotIsAuthoritative(snapshot)) return false;
        const customLists = [];
        snapshot.forEach((item) => customLists.push({ id: item.id, ...item.data() }));
        setLists(customLists);
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

        const networkRequest = getDocs(listsRef);
        const snapshot = await settleWithin(networkRequest, LISTS_LOAD_DEADLINE_MS);
        if (snapshot.status !== 'fulfilled') {
          if (snapshot.status === 'timed_out') {
            // Keep the original request alive. A late response can still refresh
            // the cards without making the user press Retry.
            networkRequest.then((lateSnapshot) => {
              if (!active) return;
              if (applySnapshot(lateSnapshot)) setError(null);
            }).catch(() => {});
          }
          throw snapshot.status === 'timed_out'
            ? new Error('The list request exceeded its deadline.')
            : (snapshot.reason || new Error('Custom lists could not be loaded.'));
        }
        if (!applySnapshot(snapshot.value)) {
          // Answered, but only by the cache, and with nothing in it. That is
          // "could not load", not "you have no lists".
          throw new Error('Custom lists could not be loaded.');
        }
        if (active) setError(null);
      } catch (err) {
        console.error('Error loading lists:', err);
        if (active) setError('LISTS_LOAD_FAILED');
      } finally {
        if (active) setLoading(false);
      }
    };

    loadData();
    return () => { active = false; };
  }, [user, reloadToken]);

  const openList = useCallback(async (list, retryFailedOnly = false) => {
    const requestId = ++metadataRequestId.current;
    setExpandedList(list.id);
    setMetadataError(null);

    const paperIds = [...new Set(
      (list.paperIds || []).filter((paperId) => typeof paperId === 'string' && paperId),
    )];
    const missingIds = paperIds.filter(
      (paperId) => !savedPapers[paperId] && !personalLibrary[paperId]?.paper,
    );
    if (missingIds.length === 0) {
      failedMetadataRequests.current.delete(list.id);
      setMetadataLoadingListId(null);
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
      setMetadataLoadingListId(null);
      return;
    }

    if (!user) {
      setMetadataLoadingListId(null);
      return;
    }
    setMetadataLoadingListId(list.id);

    try {
      const missingIdSet = new Set(missingIds);
      const retryRequests = retryFailedOnly
        ? (failedMetadataRequests.current.get(list.id) || [])
        : [];
      failedMetadataRequests.current.delete(list.id);

      const requestDefinitions = retryRequests.length > 0
        ? retryRequests
          .map((request) => ({
            ...request,
            paperIds: request.paperIds.filter((paperId) => missingIdSet.has(paperId)),
          }))
          .filter((request) => request.paperIds.length > 0)
        : (() => {
            const batches = [];
            for (let index = 0; index < missingIds.length; index += PAPER_METADATA_BATCH_SIZE) {
              batches.push(missingIds.slice(index, index + PAPER_METADATA_BATCH_SIZE));
            }
            return batches.flatMap((paperIds) => [
              { source: 'interaction', paperIds },
              { source: 'saved', paperIds },
            ]);
          })();

      const resolvedIds = new Set();
      const mergeSnapshot = (source, snapshot) => {
        if (metadataRequestId.current !== requestId) return;
        const loadedPapers = {};
        snapshot.forEach((item) => {
          const data = item.data();
          const rawPaper = source === 'saved'
            ? { id: item.id, ...data }
            : data.paper
              ? { id: item.id, ...data.paper }
              : {
                  id: item.id,
                  title: data.paperTitle || item.id,
                  authors: data.paperAuthors || [],
                  primaryCategory: data.paperCategory || '',
                  published: data.timestamp,
                  arxivId: item.id,
                };
          const paper = paperLegacyAdapter(rawPaper);
          loadedPapers[item.id] = paper;
          if (paper.title && paper.title !== item.id) {
            resolvedIds.add(item.id);
          }
        });

        if (Object.keys(loadedPapers).length === 0) return;
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
          where(documentId(), 'in', requestDefinition.paperIds),
        );

        const cachedRequest = settleWithin(
          getDocsFromCache(metadataQuery),
          500,
        ).then((cachedResult) => {
          if (cachedResult.status === 'fulfilled') {
            mergeSnapshot(requestDefinition.source, cachedResult.value);
          }
        });

        const networkRequest = getDocs(metadataQuery);
        const networkResultRequest = settleWithin(
          networkRequest,
          PAPER_METADATA_LOAD_DEADLINE_MS,
        ).then((networkResult) => {
          if (networkResult.status === 'fulfilled') {
            mergeSnapshot(requestDefinition.source, networkResult.value);
            return networkResult;
          }

          if (networkResult.status === 'timed_out') {
            networkRequest.then((lateSnapshot) => {
              mergeSnapshot(requestDefinition.source, lateSnapshot);
              if (
                metadataRequestId.current === requestId
                && missingIds.every((paperId) => resolvedIds.has(paperId))
              ) {
                failedMetadataRequests.current.delete(list.id);
                setMetadataError(null);
              }
            }).catch(() => {});
          }
          return networkResult;
        });

        const [, networkOutcome] = await Promise.allSettled([
          cachedRequest,
          networkResultRequest,
        ]);
        if (networkOutcome.status === 'rejected') {
          throw networkOutcome.reason;
        }
        return networkOutcome.value;
      };

      // Every source/batch has its own deadline and paints as soon as it
      // resolves. One slow Firestore query can no longer hold back the others.
      const requestResults = await Promise.allSettled(
        requestDefinitions.map((requestDefinition) => runRequest(requestDefinition)),
      );
      if (metadataRequestId.current !== requestId) return;

      const failedRequests = requestResults.flatMap((result, index) => {
        if (result.status === 'rejected' || result.value?.status !== 'fulfilled') {
          return [requestDefinitions[index]];
        }
        return [];
      });
      const unresolvedIds = missingIds.filter((paperId) => !resolvedIds.has(paperId));

      if (failedRequests.length > 0 && unresolvedIds.length > 0) {
        failedMetadataRequests.current.set(list.id, failedRequests);
        setMetadataError('LIST_METADATA_LOAD_FAILED');
      } else {
        failedMetadataRequests.current.delete(list.id);
        setMetadataError(null);
      }
    } catch (metadataLoadError) {
      console.error('Error loading list paper metadata:', metadataLoadError);
      if (metadataRequestId.current === requestId) {
        setMetadataError('LIST_METADATA_LOAD_FAILED');
      }
    } finally {
      if (metadataRequestId.current === requestId) {
        setMetadataLoadingListId(null);
      }
    }
  }, [personalLibrary, savedPapers, user]);

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
    const path = getPublicPaperPath(paper) || getPublicPaperPath(paper.id);
    if (!path) {
      // No canonical key (legacy id shapes): the PDF is still better than a
      // click that does nothing.
      onOpenPdf?.({ ...paper, arxivId: paper.arxivId || paper.id });
      return;
    }
    if (expandedList) {
      navigate(location.pathname, {
        replace: true,
        state: { openListId: expandedList, fromRoute: openedFromRoute },
      });
    }
    navigate(path, { state: { paper } });
  };

  const closeExpandedList = () => {
    metadataRequestId.current += 1;
    setOpenedFromRoute(false);
    setExpandedList(null);
    // Drop the restore marker, or a later visit would reopen a list the user
    // has explicitly closed.
    if (location.state?.openListId) {
      navigate(location.pathname, { replace: true, state: null });
    }
    setMetadataLoadingListId(null);
    setMetadataError(null);
    setShareFeedback(null);
  };

  const handleCreateList = async () => {
    const name = newListName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError(false);
    const listId = `list_${Date.now()}`;
    const newList = { id: listId, name, emoji: newListIcon, paperIds: [], createdAt: new Date().toISOString() };
    if (IS_DEMO) {
      const allLists = demoGet('lists', []);
      allLists.push(newList);
      demoSet('lists', allLists);
    } else {
      try {
        await setDoc(doc(db, 'users', user.uid, 'lists', listId), newList);
      } catch (err) {
        console.error('Error creating list:', err);
        setCreateError(true);
        setCreateBusy(false);
        return;
      }
    }
    setLists((prev) => [...prev, newList]);
    setCreating(false);
    setNewListName('');
    setNewListIcon('Folder');
    setCreateBusy(false);
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
    setLists(current => current.map(list => {
      if (list.id !== listId) return list;
      // `publicSyncedAt` too: publishing wrote the public document in the same
      // commit, so without it the freshness check would read a fresh
      // `updatedAt` against nothing and queue a sync of what was just written.
      if (publicShareId) return { ...list, publicShareId, publicSyncedAt: new Date() };
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
  const queuedSyncs = useRef(new Map());
  useEffect(() => {
    if (IS_DEMO || !user || !expandedList) return;
    const list = lists.find((entry) => entry.id === expandedList);
    if (!listNeedsPublicSync(list)) return;
    if (metadataLoadingListId === list.id || metadataError) return;

    // One request per edit, however many renders that edit causes.
    const editedAt = toEpochMillis(list.updatedAt);
    if (queuedSyncs.current.get(list.id) === editedAt) return;
    queuedSyncs.current.set(list.id, editedAt);

    queuePublicListSync({
      key: publicListSyncKey(user.uid, list.id),
      shareId: list.publicShareId,
      listId: list.id,
      title: list.name,
      description: list.description,
      language: language === 'en' ? 'en' : 'es',
      paperIds: list.paperIds || [],
      papers: (list.paperIds || [])
        .map((paperId) => {
          const paper = getPaper(paperId);
          // `listPaperId` ALONGSIDE the paper's own id, never over it: the
          // membership and the published copy are joined on the stored id
          // (R8), but the paper's identity lives in its own id — the legacy
          // adapter folds the arXiv id in there and emits no `arxivId`, so
          // overwriting it strips the paper's identity on the way out. A
          // paper whose metadata never arrived has no title to publish and is
          // left to the merge.
          return paper?.title && paper.title !== paperId
            ? { ...paper, listPaperId: paperId }
            : null;
        })
        .filter(Boolean),
    });
  }, [expandedList, getPaper, language, lists, metadataError, metadataLoadingListId, user]);

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
  const targetOpenId = location.state?.openListId;
  const pendingOpen = Boolean(
    targetOpenId
    && !expandedList
    && (loading || displayLists.some((entry) => entry.id === targetOpenId)),
  );

  return (
    <div className="lists-page">
      {loading && (
        <div className="lists-inline-status" aria-live="polite">
          <div className="lists-loading-spinner" />
          <span>{isEnglish ? 'Updating personal lists...' : 'Actualizando listas personales...'}</span>
        </div>
      )}
      {error && (
        <div className="lists-inline-status is-error" role="alert">
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
            const publicPapers = (list.paperIds || [])
              .map(paperId => ({ paperId, paper: getPaper(paperId) }))
              .filter(({ paperId, paper }) => paper?.title && paper.title !== paperId)
              .map(({ paper }) => paper);
            const isCustomList = !PRIVATE_LIST_IDS.has(list.id);
            const listShareFeedback = shareFeedback?.listId === list.id ? shareFeedback : null;
            const shareBusy = listShareFeedback?.state === 'loading';
            const syncKey = user && isCustomList ? publicListSyncKey(user.uid, list.id) : null;
            const syncState = syncKey ? syncStates[syncKey] : null;
            const badgeState = publicBadgeState(syncState?.status);
            const badgeLabel = {
              public: isEnglish ? 'Public' : 'Pública',
              syncing: isEnglish ? 'Updating…' : 'Actualizando…',
              synced: isEnglish ? 'Up to date' : 'Al día',
              stale: isEnglish ? 'Out of date' : 'Sin actualizar',
            }[badgeState];
            return (
              <>
                <header className="lists-expanded-header">
                  <div className="lists-expanded-titleblock">
                    <span className="lists-expanded-icon" aria-hidden="true">
                      {(() => {
                        const Icon = getIcon(list.emoji);
                        return <Icon size={22} strokeWidth={2} />;
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
                          disabled={shareBusy || metadataLoadingListId === list.id}
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
                {isCustomList && ((list.paperIds || []).length > 20 || publicPapers.length < (list.paperIds || []).length) && (
                  <p className="lists-share-limit-note">
                    {isEnglish
                      ? 'Public links include up to 50 papers with available details.'
                      : 'Los enlaces públicos incluyen hasta 50 papers con datos disponibles.'}
                  </p>
                )}
                {(exportPapers.length > 0 || (isCustomList && !IS_DEMO && list.publicShareId)) && (
                  <div className="lists-expanded-tools">
                    {exportPapers.length > 0 && (
                      <div className="lists-export-actions">
                        <span className="lists-tools-label">{isEnglish ? 'Export citation' : 'Exportar cita'}</span>
                        <button type="button" onClick={() => downloadCitationFile(exportPapers, 'bibtex', `papertok-${list.name}`)}><Download size={14} /> BibTeX</button>
                        <button type="button" onClick={() => downloadCitationFile(exportPapers, 'ris', `papertok-${list.name}`)}><Download size={14} /> RIS</button>
                      </div>
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
                {metadataLoadingListId === list.id && (
                  <div className="lists-metadata-status" aria-live="polite">
                    <div className="lists-loading-spinner" />
                    <span>{isEnglish ? 'Loading papers in this list...' : 'Cargando los papers de esta lista...'}</span>
                  </div>
                )}
                {metadataError && (
                  <div className="lists-metadata-status is-error" role="alert">
                    <span>{getUiErrorMessage(metadataError, language, 'LIST_METADATA_LOAD_FAILED')}</span>
                    <button className="lists-retry-btn" onClick={() => openList(list, true)}>
                      {isEnglish ? 'Try again' : 'Reintentar'}
                    </button>
                  </div>
                )}
                <div className="lists-expanded-papers">
                  {(list.paperIds || []).map((paperId, paperIndex) => {
                    const paper = getPaper(paperId);
                    const record = personalLibrary[paperId];
                    if (!paper) return (
                      // While metadata is in flight the row is a shimmer with
                      // the finished row's silhouette; the status line above
                      // carries the accessible announcement.
                      <div
                        key={paperId}
                        className="lists-paper-item lists-paper-item--skeleton"
                        style={{ '--stagger-index': Math.min(paperIndex, 8) }}
                        aria-hidden={metadataLoadingListId === list.id ? 'true' : undefined}
                      >
                        {metadataLoadingListId === list.id ? (
                          <div className="lists-paper-skeleton">
                            <span className="lists-skeleton-bar lists-skeleton-bar--wide" />
                            <span className="lists-skeleton-bar" />
                          </div>
                        ) : (
                          <p className="lists-paper-title lists-paper-placeholder">{paperId}</p>
                        )}
                      </div>
                    );
                    return (
                      <div key={paperId} className="lists-paper-item"
                        style={{ '--stagger-index': Math.min(paperIndex, 8) }}
                        onClick={() => openPaperCard(paper)}>
                        <div className="lists-paper-item-content">
                          {paper.categories && paper.categories.length > 0 && (
                            <span className="lists-paper-cat">{getCategoryLabel(paper.categories[0], language)}</span>
                          )}
                          <p className="lists-paper-title"><ScientificText>{paper.title}</ScientificText></p>
                          {paper.authors && (
                            <p className="lists-paper-authors">
                              {paper.authors.slice(0, 3).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(', ')}{paper.authors.length > 3 && ' et al.'}
                            </p>
                          )}
                          {paper.year && <span className="lists-paper-date">{paper.year}</span>}
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
          <div className="lists-skeleton-row" />
          <div className="lists-skeleton-row" />
          <div className="lists-skeleton-row" />
          <div className="lists-skeleton-row" />
        </motion.div>
      ) : (
        <motion.div key="index" {...viewMotion}>
          <header className="lists-header">
            <p className="lists-eyebrow">{isEnglish ? 'Personal library' : 'Biblioteca personal'}</p>
            <h1>{isEnglish ? 'My lists' : 'Mis listas'}</h1>
            <p className="lists-subtitle">
              {isEnglish
                ? 'Organize, annotate and share the papers you keep.'
                : 'Organiza, anota y comparte los papers que guardas.'}
            </p>
          </header>
          <div className="lists-grid">
            {displayLists.map((list, idx) => (
              <div key={list.id} className="list-card glass" onClick={() => { setOpenedFromRoute(false); openList(list); }} style={{ '--stagger-index': idx }}>
                <div className="list-card-top">
                  <span className="list-card-emoji">
                    {(() => {
                      const Icon = getIcon(list.emoji);
                      return <Icon size={32} strokeWidth={1.5} />;
                    })()}
                  </span>
                  {!['__favorites__', '__read__', '__read_later__'].includes(list.id) && (
                    <button className="list-card-delete" onClick={(e) => { e.stopPropagation(); handleDeleteList(list.id); }}
                      title={isEnglish ? 'Delete list' : 'Eliminar lista'}>✕</button>
                  )}
                </div>
                <h3 className="list-card-name">{list.name}</h3>
                <div className="list-card-footer">
                  <span className="list-card-count">{papersCount(list.paperIds?.length || 0)}</span>
                  {/* The profile card says Public; its twin here said nothing. */}
                  {list.publicShareId && (
                    <span className="lists-badge lists-badge--public">
                      <Globe2 size={11} aria-hidden="true" /> {isEnglish ? 'Public' : 'Pública'}
                    </span>
                  )}
                </div>
                {list.paperIds?.some((paperId) => getPaper(paperId)) && (
                  <div className="list-card-preview">
                    {list.paperIds
                      .map((paperId) => getPaper(paperId))
                      .filter(Boolean)
                      .slice(0, 2)
                      .map((paper) => <p key={paper.id} className="list-card-preview-title"><ScientificText>{paper.title}</ScientificText></p>)}
                  </div>
                )}
              </div>
            ))}
            {creating ? (
              <div className="list-card list-card--create-form" style={{ '--stagger-index': displayLists.length }}>
                <p className="list-card-form-label" id="lists-icon-picker-label">{isEnglish ? 'Icon' : 'Icono'}</p>
                <div className="list-card-icon-picker" role="radiogroup" aria-labelledby="lists-icon-picker-label">
                  {AVAILABLE_ICONS.map((iconName) => {
                    const OptionIcon = getIcon(iconName);
                    return (
                      <button
                        key={iconName}
                        type="button"
                        role="radio"
                        aria-checked={newListIcon === iconName}
                        aria-label={iconName}
                        className={`list-card-icon-btn${newListIcon === iconName ? ' is-active' : ''}`}
                        onClick={() => setNewListIcon(iconName)}
                      >
                        <OptionIcon size={16} strokeWidth={1.75} />
                      </button>
                    );
                  })}
                </div>
                <input
                  className="list-card-name-input"
                  autoFocus
                  value={newListName}
                  maxLength={80}
                  placeholder={isEnglish ? 'List name...' : 'Nombre de la lista...'}
                  onChange={(e) => setNewListName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateList();
                    if (e.key === 'Escape') { setCreating(false); setNewListName(''); }
                  }}
                />
                {createError && (
                  <p className="list-card-create-error" role="alert">
                    {isEnglish ? 'It could not be created. Try again.' : 'No se pudo crear. Inténtalo de nuevo.'}
                  </p>
                )}
                <div className="list-card-form-actions">
                  <button
                    type="button"
                    className="list-card-create-confirm"
                    onClick={handleCreateList}
                    disabled={!newListName.trim() || createBusy}
                  >
                    {createBusy ? (isEnglish ? 'Creating...' : 'Creando...') : (isEnglish ? 'Create' : 'Crear')}
                  </button>
                  <button
                    type="button"
                    className="list-card-create-cancel"
                    onClick={() => { setCreating(false); setNewListName(''); }}
                  >
                    {isEnglish ? 'Cancel' : 'Cancelar'}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="list-card list-card--create"
                onClick={() => { setCreating(true); setCreateError(false); }}
                style={{ '--stagger-index': displayLists.length }}
              >
                <span className="list-card-create-icon" aria-hidden="true"><Plus size={22} /></span>
                <span>{isEnglish ? 'New list' : 'Nueva lista'}</span>
              </button>
            )}
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
